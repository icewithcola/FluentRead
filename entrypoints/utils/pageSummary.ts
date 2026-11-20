// Page summary utilities: text extraction, caching, and summary request logic.
// The summary is used as context injected into translation prompts (not shown to users).
import { config } from '@/entrypoints/utils/config';
import { summaryMsgTemplate } from '@/entrypoints/utils/template';
import { buildSingleItemStructuredContext } from '@/entrypoints/main/structuredGroup';
import {
  getPageStorageItem,
  getPageStorageKeys,
  removePageStorageItem,
  setPageStorageItem,
} from '@/entrypoints/utils/pageStorage';
import browser from 'webextension-polyfill';

const SUMMARY_CACHE_PREFIX = 'fr_summary_';

// --- Debug logging helper ---
// Controlled by config.debugMode; logs are prefixed with [FluentRead Debug]
function debugLog(...args: any[]): void {
  if (config.debugMode) {
    console.log('[FluentRead Debug]', ...args);
  }
}

function debugWarn(...args: any[]): void {
  if (config.debugMode) {
    console.warn('[FluentRead Debug]', ...args);
  }
}

function debugError(...args: any[]): void {
  if (config.debugMode) {
    console.error('[FluentRead Debug]', ...args);
  }
}

// Tags to skip when extracting page text
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NAV',
  'HEADER',
  'FOOTER',
  'NOSCRIPT',
  'SVG',
  'IMG',
  'VIDEO',
  'AUDIO',
  'CANVAS',
  'IFRAME',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'ASIDE',
  'FORM',
  'MENU',
  'MENUITEM',
  'TEMPLATE',
]);

// Elements that separate independent pieces of prose.  We retain these
// boundaries as newlines in the plain-text prompt without sending any HTML.
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'UL',
]);

// Selectors to try for finding the main content area (ordered by priority)
const MAIN_CONTENT_SELECTORS = [
  'article',
  'main',
  "[role='main']",
  '.post-content',
  '.article-content',
  '.article-body',
  '.entry-content',
  '.post-body',
  '.story-body',
  '#content',
  '.content',
];

// Keep the input well below a 128K-token context window even for languages
// whose characters are tokenized nearly one-to-one, while still allowing a
// complete long-form article to contribute to the page context.
const MAX_TEXT_LENGTH = 120_000;
const MIN_TEXT_LENGTH = 50;
const MAX_RATE_LIMIT_RETRIES = 2; // Max auto-retries on 429 rate limit
const MAX_RETRY_WAIT_SECONDS = 120; // Don't wait more than 2 minutes

// --- Global state: current page summary for translation context injection ---
let currentPageSummary: string = '';
let inFlightSummaryPromise: Promise<string> | null = null;
let cachedMetaUrl = '';
let cachedMetaSummary = '';

/**
 * Get the current page summary text.
 * This is used by the translation template (commonMsgTemplate) to enrich prompts.
 * Returns empty string if summary is not available yet or feature is disabled.
 */
export function getCurrentPageSummary(): string {
  if (!currentPageSummary && config.enablePageSummary && config.useCache) {
    const cached = getCachedSummary();
    if (cached) currentPageSummary = cached;
  }
  return currentPageSummary;
}

/**
 * Clear the current page summary (e.g. when restoring original content).
 */
export function clearCurrentPageSummary(): void {
  currentPageSummary = '';
}

function extractCleanNodeText(node: Element): string {
  let text = '';
  const walk = (current: Node): void => {
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue) text += current.nodeValue;
      return;
    }
    if (!(current instanceof Element)) return;
    const tag = current.tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      current.hasAttribute('data-fr-owned') ||
      current.classList.contains('fluent-read-bilingual-content') ||
      current.classList.contains('fluent-read-loading') ||
      current.classList.contains('fluent-read-retry-wrapper')
    ) {
      return;
    }
    if (tag === 'br') {
      text += ' ';
      return;
    }
    current.childNodes.forEach(walk);
    if (BLOCK_TAGS.has(current.tagName)) text += ' ';
  };
  walk(node);
  return text.replace(/\s+/g, ' ').trim();
}

function getPageMetadataSummary(): string {
  if (typeof document === 'undefined') return '';
  const currentUrl = typeof location !== 'undefined' ? location.href : '';
  if (currentUrl && cachedMetaUrl === currentUrl) {
    return cachedMetaSummary;
  }

  const selectors = [
    'meta[name="citation_title"]',
    'meta[name="dc.subject"]',
    'meta[name="keywords"]',
    'meta[name="description"]',
    'meta[property="og:description"]',
  ];
  const seen = new Set<string>();
  const values: string[] = [];
  let totalLen = 0;

  for (const selector of selectors) {
    const content =
      document.querySelector(selector)?.getAttribute('content')?.replace(/\s+/g, ' ').trim() || '';
    if (!content || seen.has(content)) continue;
    seen.add(content);
    values.push(content);
    totalLen += content.length;
    if (totalLen >= 220) break;
  }

  const summary = values.join(' | ').slice(0, 220).trim();
  if (currentUrl) {
    cachedMetaUrl = currentUrl;
    cachedMetaSummary = summary;
  }
  return summary;
}

function findSectionBreadcrumb(element: Element): string {
  if (typeof document === 'undefined') return '';
  const selfText = extractCleanNodeText(element);
  const collected: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && current !== document.body && depth < 8) {
    let prev = current.previousElementSibling;
    let steps = 0;
    while (prev && steps < 12) {
      if (!shouldSkipElement(prev)) {
        const heading = /^H[1-4]$/i.test(prev.tagName)
          ? prev
          : !prev.querySelector('p, article, section, main')
            ? prev.querySelector('h1, h2, h3, h4')
            : null;
        if (heading && !shouldSkipElement(heading)) {
          const text = extractCleanNodeText(heading).slice(0, 80).trim();
          if (text && text !== selfText) {
            collected.push(text);
            break;
          }
        }
      }
      prev = prev.previousElementSibling;
      steps++;
    }
    current = current.parentElement;
    depth++;
  }

  const ordered = collected.reverse();
  const primaryH1 = document.querySelector('article h1, main h1, h1');
  if (primaryH1 && !shouldSkipElement(primaryH1)) {
    const h1Text = extractCleanNodeText(primaryH1).slice(0, 80).trim();
    if (h1Text && h1Text !== selfText && !ordered.includes(h1Text)) {
      ordered.unshift(h1Text);
    }
  }

  const deduped: string[] = [];
  for (const item of ordered) {
    if (!deduped.includes(item)) deduped.push(item);
    if (deduped.length >= 3) break;
  }

  return deduped.join(' > ').slice(0, 180).trim();
}

function findPrecedingSnippet(element: Element): string {
  const prev = element.previousElementSibling;
  if (!prev || shouldSkipElement(prev)) return '';
  if (!prev.matches('p, li, dd, dt, blockquote')) return '';
  const text = extractCleanNodeText(prev);
  if (text.length < 12) return '';
  return text.length > 180 ? text.slice(-180) : text;
}

/**
 * Build zero-latency structural context (title, site, meta, section breadcrumb,
 * and immediate preceding text) to help the LLM disambiguate terminology.
 */
export function buildPageContext(
  element?: Element | null,
  options: { includePreceding?: boolean } = {},
): string {
  if (typeof document === 'undefined') return '';
  const { includePreceding = true } = options;
  const lines: string[] = [];

  const title = document.title?.replace(/\s+/g, ' ').trim();
  if (title) lines.push(`Title: ${title.slice(0, 160)}`);

  if (typeof location !== 'undefined' && location.hostname) {
    lines.push(`Site: ${location.hostname}`);
  }

  const meta = getPageMetadataSummary();
  if (meta) lines.push(`Meta: ${meta}`);

  if (element) {
    const section = findSectionBreadcrumb(element);
    if (section) lines.push(`Section: ${section}`);
    if (includePreceding) {
      const structuredCtx = buildSingleItemStructuredContext(element);
      if (structuredCtx) {
        lines.push(structuredCtx);
      } else {
        const preceding = findPrecedingSnippet(element);
        if (preceding) lines.push(`Preceding text: ${preceding}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Try to find the main content container using semantic selectors.
 * Returns the first matching element, or null if none found.
 */
function findMainContentRoot(): Element | null {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && el.textContent && el.textContent.trim().length >= MIN_TEXT_LENGTH) {
      debugLog(
        'Found main content container:',
        selector,
        '| text length:',
        el.textContent.trim().length,
      );
      return el;
    }
  }
  return null;
}

/**
 * Returns whether an element belongs to page chrome or otherwise hidden UI.
 * Checking ancestors is important: a text node in a <span> inside <nav> must
 * not be included simply because its immediate parent is not a skipped tag.
 */
function shouldSkipElement(element: Element): boolean {
  return Boolean(
    element.closest(
      'script, style, nav, header, footer, noscript, svg, img, video, audio, canvas, iframe, input, textarea, select, button, aside, form, menu, menuitem, template, [hidden], [inert], [aria-hidden="true"], [id^="fluent-read-"], [class*="fluent-read-"]',
    ),
  );
}

function findBlockAncestor(element: Element, root: Element): Element | null {
  let current: Element | null = element;
  while (current && current !== root) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Extract text from a given root element using TreeWalker.
 * Skips non-content tags and hidden elements.
 */
function extractTextFromRoot(root: Element): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;

      if (SKIP_TAGS.has(parent.tagName) || shouldSkipElement(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      const style = window.getComputedStyle(parent);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.contentVisibility === 'hidden'
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = node.textContent?.trim();
      if (!text) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts: string[] = [];
  let totalLength = 0;
  const seenBlocks = new Set<Element>();

  while (walker.nextNode()) {
    const text = walker.currentNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (!text) continue;

    const parent = walker.currentNode.parentElement;
    const block = parent ? findBlockAncestor(parent, root) : null;
    const startsNewBlock = Boolean(block && !seenBlocks.has(block));
    if (block) seenBlocks.add(block);

    const separator = parts.length === 0 ? '' : startsNewBlock ? '\n\n' : ' ';
    const remaining = MAX_TEXT_LENGTH - totalLength - separator.length;
    if (remaining <= 0) break;

    parts.push(separator, text.slice(0, remaining));
    totalLength += separator.length + Math.min(text.length, remaining);
    if (text.length > remaining) break;
  }

  return parts.join('').trim();
}

/**
 * Fallback: collect text from paragraph-like elements across the page,
 * prioritizing headings and dense prose blocks while restoring their natural
 * document order so the summary preserves logical flow.
 */
function extractTextByDensity(): string {
  const blocks: { el: Element; text: string; index: number; isHeading: boolean }[] = [];

  // Collect all paragraph-like text blocks in DOM order
  const allElements = document.body.querySelectorAll(
    'p, li, blockquote, dd, td, th, figcaption, h1, h2, h3, h4, h5, h6',
  );
  let index = 0;
  for (const el of allElements) {
    // Skip page chrome, extension UI, and hidden containers at any depth.
    if (shouldSkipElement(el)) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const text = extractCleanNodeText(el);
    const isHeading = /^H[1-3]$/.test(el.tagName);
    if ((isHeading && text.length > 3) || text.length > 20) {
      blocks.push({ el, text, index: index++, isHeading });
    }
  }

  // Prioritize headings and early lead paragraphs, then longer body blocks
  const prioritized = [...blocks].sort((a, b) => {
    const aPriority = a.isHeading || a.index < 5 ? 1 : 0;
    const bPriority = b.isHeading || b.index < 5 ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return b.text.length - a.text.length;
  });

  const selected: typeof blocks = [];
  let totalLength = 0;

  for (const block of prioritized) {
    const separatorLen = selected.length === 0 ? 0 : 2;
    if (totalLength + separatorLen + block.text.length > MAX_TEXT_LENGTH && selected.length > 0) {
      break;
    }
    selected.push(block);
    totalLength += separatorLen + block.text.length;
    if (totalLength >= MAX_TEXT_LENGTH) break;
  }

  // Restore original DOM sequence so headings, intro, and definitions stay coherent
  selected.sort((a, b) => a.index - b.index);
  return selected
    .map((block) => block.text)
    .join('\n\n')
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract the main body text content from the page.
 *
 * Strategy (in order):
 * 1. Look for semantic content containers (<article>, <main>, [role="main"], etc.)
 * 2. Fallback: collect text from paragraph-like elements sorted by text density
 * 3. Last resort: walk the entire document.body (original behavior)
 *
 * Produces plain text only (no HTML tags) and limits it to MAX_TEXT_LENGTH
 * characters.
 * Returns empty string if content is too short (< MIN_TEXT_LENGTH meaningful chars).
 */
export function extractPageText(): string {
  if (!document.body) return '';

  debugLog('Extracting page text from:', location.href);

  let result = '';

  // Strategy 1: Try semantic content containers
  const mainRoot = findMainContentRoot();
  if (mainRoot) {
    result = extractTextFromRoot(mainRoot);
    debugLog('Strategy 1 (semantic container) extracted length:', result.length);
  }

  // Strategy 2: Text density fallback (if Strategy 1 found too little)
  if (result.replace(/\s+/g, '').length < MIN_TEXT_LENGTH) {
    debugLog('Semantic container not found or too short, trying density-based extraction...');
    result = extractTextByDensity();
    debugLog('Strategy 2 (density-based) extracted length:', result.length);
  }

  // Strategy 3: Last resort — walk entire body
  if (result.replace(/\s+/g, '').length < MIN_TEXT_LENGTH) {
    debugLog('Density-based extraction too short, falling back to full body walk...');
    result = extractTextFromRoot(document.body);
    debugLog('Strategy 3 (full body walk) extracted length:', result.length);
  }

  // Final validity check
  if (result.replace(/\s+/g, '').length < MIN_TEXT_LENGTH) {
    debugWarn(
      'Extracted text too short after all strategies, skipping. Length:',
      result.replace(/\s+/g, '').length,
    );
    return '';
  }

  const headerLines: string[] = [];
  const title = document.title?.replace(/\s+/g, ' ').trim();
  if (title) headerLines.push(`Title: ${title}`);
  const meta = getPageMetadataSummary();
  if (meta) headerLines.push(`Meta: ${meta}`);
  if (headerLines.length > 0) {
    result = `${headerLines.join('\n')}\n\n${result}`.slice(0, MAX_TEXT_LENGTH);
  }

  debugLog('Extracted text length:', result.length, '| Preview:', result.slice(0, 200) + '...');
  return result;
}

// --- Summary cache helpers ---

function getSummaryCacheKey(): string {
  const href = typeof location !== 'undefined' ? location.href : '';
  return `${SUMMARY_CACHE_PREFIX}${href}`;
}

export function getCachedSummary(): string | null {
  if (!config.useCache) return null;
  return getPageStorageItem(getSummaryCacheKey());
}

export function setCachedSummary(summary: string): void {
  if (!config.useCache) return;
  setPageStorageItem(getSummaryCacheKey(), summary);
}

/**
 * Clean all summary caches from localStorage.
 * Called from cache.clean() extension.
 */
export function cleanSummaryCache(): void {
  const keysToDelete: string[] = [];
  for (const key of getPageStorageKeys()) {
    if (key && key.startsWith(SUMMARY_CACHE_PREFIX)) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach((key) => removePageStorageItem(key));
}

// --- Summary request ---

// AbortController for cancelling in-flight summary requests
let currentSummaryAbort: AbortController | null = null;

/**
 * Cancel any in-flight summary request and clear current summary.
 */
export function cancelSummaryRequest(): void {
  if (currentSummaryAbort) {
    currentSummaryAbort.abort();
    currentSummaryAbort = null;
  }
  inFlightSummaryPromise = null;
}

/**
 * Trigger a background non-blocking page summary if enabled and not yet cached/running,
 * allowing hover and selection translations to benefit on subsequent requests.
 */
export function warmUpPageSummary(): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (!config.enablePageSummary || currentPageSummary || inFlightSummaryPromise) return;
  const cached = getCachedSummary();
  if (cached) {
    currentPageSummary = cached;
    return;
  }
  void requestPageSummary().catch(() => {});
}

/**
 * Request a page summary from the current translation service.
 * - Checks cache first and deduplicates concurrent requests.
 * - Extracts page text and sends a summary request via background script.
 * - Stores the result in `currentPageSummary` for use by translation prompts.
 * - Always non-streaming (we need the full result before translations begin).
 * - Has a 60-second timeout.
 *
 * @returns The summary text, or empty string on failure/skip
 */
export async function requestPageSummary(): Promise<string> {
  if (inFlightSummaryPromise) return inFlightSummaryPromise;

  const promise = runPageSummaryRequest().finally(() => {
    if (inFlightSummaryPromise === promise) {
      inFlightSummaryPromise = null;
    }
  });
  inFlightSummaryPromise = promise;
  return promise;
}

async function runPageSummaryRequest(): Promise<string> {
  debugLog(
    'requestPageSummary() called. enablePageSummary:',
    config.enablePageSummary,
    '| URL:',
    location.href,
  );

  // 1. Check cache
  const cached = getCachedSummary();
  if (cached) {
    debugLog(
      'Summary cache HIT. Cached summary:',
      cached.slice(0, 200) + (cached.length > 200 ? '...' : ''),
    );
    currentPageSummary = cached;
    return cached;
  }
  debugLog('Summary cache MISS.');

  // 2. Extract page text
  const pageText = extractPageText();
  if (!pageText) {
    debugWarn('No page text extracted, skipping summary request.');
    return '';
  }

  // 3. Build request body using the fixed summary prompt template
  const body = summaryMsgTemplate(pageText);
  debugLog('Summary request body:', body);

  // 4. Create abort controller for cancellation support
  currentSummaryAbort = new AbortController();
  const abortSignal = currentSummaryAbort.signal;

  // 5. Send non-streaming request via background script with timeout and 429 auto-retry
  let retryCount = 0;
  while (true) {
    try {
      const result = await Promise.race<string>([
        sendSummaryRequest(body, abortSignal),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Summary request timed out')), 60000),
        ),
      ]);

      // 6. Store and cache the result
      if (result) {
        debugLog('Summary raw output:', result);
        currentPageSummary = result;
        setCachedSummary(result);
      } else {
        debugWarn('Summary request returned empty result.');
      }

      currentSummaryAbort = null;
      return result;
    } catch (error: any) {
      // Handle 429 rate limit: auto-retry after waiting
      if (error instanceof RateLimitError && retryCount < MAX_RATE_LIMIT_RETRIES) {
        const waitSeconds = Math.min(
          error.retryAfter > 0 ? error.retryAfter : 30,
          MAX_RETRY_WAIT_SECONDS,
        );
        retryCount++;
        debugLog(
          `Rate limited (429). Waiting ${waitSeconds}s before retry ${retryCount}/${MAX_RATE_LIMIT_RETRIES}...`,
        );
        console.log(
          `[FluentRead] Summary rate limited. Retrying in ${waitSeconds}s (attempt ${retryCount}/${MAX_RATE_LIMIT_RETRIES})...`,
        );

        // Wait, but respect abort signal
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, waitSeconds * 1000);
          if (abortSignal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (abortSignal.aborted) {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
          }
        });
        continue; // Retry the request
      }

      currentSummaryAbort = null;
      if (error.name === 'AbortError') {
        console.log('[FluentRead] Summary request was cancelled');
        debugLog('Summary request was aborted by user/system.');
      } else {
        console.error('[FluentRead] Summary request failed:', error);
        debugError('Summary request error details:', error.message, error.stack);
      }
      return '';
    }
  }
}

/**
 * Custom error class for 429 rate limit responses.
 * Carries the retryAfter delay (in seconds) extracted from the API response.
 */
class RateLimitError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Send the summary request to the background script via simple runtime messaging (non-streaming).
 * Throws RateLimitError on 429 responses so the caller can auto-retry.
 */
async function sendSummaryRequest(body: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    debugLog('Sending summary request to background script...', {
      summaryApiKey: config.summaryApiKey ? '(set)' : '(empty)',
      summaryApiUrl: config.summaryApiUrl || '(default)',
    });

    browser.runtime
      .sendMessage({
        type: 'summary',
        body,
        // Pass custom summary API settings (if configured) to background
        summaryApiKey: config.summaryApiKey || '',
        summaryApiUrl: config.summaryApiUrl || '',
      })
      .then((response: any) => {
        abortSignal?.removeEventListener('abort', onAbort);
        debugLog('Background script response:', JSON.stringify(response));
        if (response && response.text) {
          resolve(response.text);
        } else if (response && response.error) {
          debugError('Background script returned error:', response.error);
          // If 429, throw RateLimitError with parsed retryAfter
          if (response.statusCode === 429) {
            const retryAfter = response.retryAfter ?? 0;
            debugLog('Received 429 from background. retryAfter:', retryAfter, 'seconds');
            reject(new RateLimitError(response.error, retryAfter));
          } else {
            reject(new Error(response.error));
          }
        } else {
          debugWarn('Background script returned unexpected response:', response);
          resolve('');
        }
      })
      .catch((err: any) => {
        abortSignal?.removeEventListener('abort', onAbort);
        debugError('browser.runtime.sendMessage failed:', err.message, err.stack);
        reject(err);
      });
  });
}
