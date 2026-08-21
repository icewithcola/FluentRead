import { checkConfig, searchClassName, skipNode } from '../utils/check';
import { cache } from '../utils/cache';
import { options, servicesType } from '../utils/option';
import { insertFailedTip, insertLoadingSpinner } from '../utils/icon';
import { styles } from '@/entrypoints/utils/constant';
import {
  beautyHTML,
  grabNode,
  grabAllNode,
  LLMStandardHTML,
  getTranslatableText,
  sanitizeTranslationHTML,
  smashTruncationStyle,
  shouldTranslateContent,
} from '@/entrypoints/main/dom';
import { detectlang, throttle } from '@/entrypoints/utils/common';
import { getMainDomain, replaceCompatFn } from '@/entrypoints/main/compat';
import { config } from '@/entrypoints/utils/config';
import {
  translateText,
  translateTextStream,
  cancelAllTranslations,
} from '@/entrypoints/utils/translateApi';
import {
  requestPageSummary,
  cancelSummaryRequest,
  clearCurrentPageSummary,
} from '@/entrypoints/utils/pageSummary';

const TRANSLATED_ATTR = 'data-fr-translated';
const TRANSLATED_ID_ATTR = 'data-fr-node-id';
const OWNED_ATTR = 'data-fr-owned';
const BILINGUAL_CLASS = 'fluent-read-bilingual';
const BILINGUAL_CONTENT_CLASS = 'fluent-read-bilingual-content';
const RTL_TEXT_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

type RecordStatus = 'pending' | 'translating' | 'translated' | 'failed';

interface TranslationRecord {
  id: string;
  element: HTMLElement;
  originalHTML: string;
  originalOuterHTML: string;
  originalText: string;
  requestHTML: string;
  generation: number;
  status: RecordStatus;
  lastOwnedHTML: string;
  originalFragment?: DocumentFragment;
}

interface TranslationContext {
  element: HTMLElement;
  record?: TranslationRecord;
  generation: number;
  sourceHTML: string;
  sourceOuterHTML: string;
  sourceText: string;
  requestHTML: string;
  lastOwnedHTML: string;
  spinner?: HTMLElement;
  originalFragment?: DocumentFragment;
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let nodeIdCounter = 0;
let isAutoTranslating = false;
let sessionGeneration = 0;
let observer: IntersectionObserver | null = null;
let mutationObserver: MutationObserver | null = null;
const inFlightNodes = new Set<Element>();
const records = new WeakMap<Element, TranslationRecord>();
const activeRecords = new Set<TranslationRecord>();

/** Kept for compatibility with callers that inspect the previous public map. */
export const originalContents = new Map<string, string>();

function markOwned(element: Element | null | undefined): void {
  element?.setAttribute(OWNED_ATTR, 'true');
}

function isOwnedElement(element: Element): boolean {
  return (
    element.hasAttribute(OWNED_ATTR) ||
    element.classList.contains('fluent-read-loading') ||
    element.classList.contains(BILINGUAL_CONTENT_CLASS) ||
    element.classList.contains('fluent-read-retry-wrapper')
  );
}

function removeOwnedDescendants(element: Element): void {
  element
    .querySelectorAll(
      `[${OWNED_ATTR}], .fluent-read-loading, .${BILINGUAL_CONTENT_CLASS}, .fluent-read-retry-wrapper`,
    )
    .forEach((owned) => owned.remove());
}

function stripOwnedHTML(value: string): string {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = value;
  removeOwnedDescendants(wrapper);
  return wrapper.innerHTML;
}

function contentMatches(context: TranslationContext): boolean {
  const current = context.element.innerHTML;
  return (
    current === context.lastOwnedHTML ||
    stripOwnedHTML(current) === stripOwnedHTML(context.lastOwnedHTML)
  );
}

function syncOwnedContent(context: TranslationContext): void {
  context.lastOwnedHTML = context.element.innerHTML;
  if (context.record) context.record.lastOwnedHTML = context.lastOwnedHTML;
}

/** Move the original live children out before replacing innerHTML. */
function captureOriginalChildren(context: TranslationContext): void {
  const record = context.record;
  if (record?.originalFragment || context.originalFragment || !context.element.firstChild) return;
  const fragment = document.createDocumentFragment();
  while (context.element.firstChild) fragment.appendChild(context.element.firstChild);
  if (record) record.originalFragment = fragment;
  else context.originalFragment = fragment;
}

/** Restore original child node identity, including listeners attached by page code. */
function restoreCapturedChildren(context: TranslationContext): boolean {
  const fragment = context.record?.originalFragment ?? context.originalFragment;
  if (!fragment || !fragment.firstChild || !context.element.isConnected) return false;
  while (context.element.firstChild) context.element.firstChild.remove();
  context.element.appendChild(fragment);
  context.lastOwnedHTML = context.element.innerHTML;
  if (context.record) context.record.lastOwnedHTML = context.lastOwnedHTML;
  return true;
}

function clearCapturedChildren(context: TranslationContext): void {
  if (context.record) context.record.originalFragment = undefined;
  context.originalFragment = undefined;
}

function restoreAfterApplyFailure(context: TranslationContext): void {
  if (!restoreCapturedChildren(context)) return;
  context.lastOwnedHTML = context.sourceHTML;
  if (context.record) context.record.lastOwnedHTML = context.lastOwnedHTML;
  clearCapturedChildren(context);
}

function recordIsCurrent(record: TranslationRecord): boolean {
  const element = record.element;
  return (
    records.get(element) === record &&
    activeRecords.has(record) &&
    record.generation === sessionGeneration &&
    element.isConnected &&
    element.getAttribute(TRANSLATED_ID_ATTR) === record.id
  );
}

function contextIsCurrent(context: TranslationContext): boolean {
  if (!context.element.isConnected || context.generation !== sessionGeneration) return false;
  if (context.record && !recordIsCurrent(context.record)) return false;
  return contentMatches(context);
}

function removeSpinner(context: TranslationContext): void {
  context.spinner?.remove();
  context.spinner = undefined;
}

function removeFailureMarker(element: Element): void {
  element.classList.remove('fluent-read-failure');
  removeOwnedDescendants(element);
}

function setRecordStatus(record: TranslationRecord, status: RecordStatus): void {
  record.status = status;
  if (!record.element.isConnected) return;
  record.element.setAttribute(TRANSLATED_ATTR, status === 'translated' ? 'true' : status);
}

function releaseRecord(record: TranslationRecord): void {
  activeRecords.delete(record);
  originalContents.delete(record.id);
  if (records.get(record.element) === record) records.delete(record.element);
  if (record.element.getAttribute(TRANSLATED_ID_ATTR) === record.id) {
    record.element.removeAttribute(TRANSLATED_ID_ATTR);
    record.element.removeAttribute(TRANSLATED_ATTR);
  }
}

function createRecord(element: Element, generation: number): TranslationRecord | null {
  if (!(element instanceof HTMLElement) || !element.isConnected) return null;
  if (element.hasAttribute(TRANSLATED_ID_ATTR) || element.hasAttribute(TRANSLATED_ATTR)) return null;
  if (!shouldTranslateContent(getTranslatableText(element))) return null;

  const record: TranslationRecord = {
    id: `fr-node-${nodeIdCounter++}`,
    element,
    originalHTML: element.innerHTML,
    originalOuterHTML: element.outerHTML,
    originalText: getTranslatableText(element),
    requestHTML: LLMStandardHTML(element),
    generation,
    status: 'pending',
    lastOwnedHTML: element.innerHTML,
  };
  records.set(element, record);
  activeRecords.add(record);
  originalContents.set(record.id, record.originalHTML);
  element.setAttribute(TRANSLATED_ID_ATTR, record.id);
  element.setAttribute(TRANSLATED_ATTR, 'pending');
  return record;
}

function beginContext(element: HTMLElement, forceRetry = false): TranslationContext | null {
  const record = records.get(element);
  // Manual hover calls can bypass DOM discovery, so apply the same cheap gate
  // before allocating request state. Existing records keep their captured
  // source, which also makes retries stable if the page changed meanwhile.
  if (!record && !shouldTranslateContent(getTranslatableText(element))) return null;
  if (record) {
    if (!recordIsCurrent(record)) return null;
    if (record.status === 'translating') return null;
    if (record.status === 'translated' && !forceRetry) return null;

    // A retry may remove only extension-owned failure UI. If the page changed
    // meanwhile, do not replace the user's current content.
    const beforeCleanup = element.innerHTML;
    if (stripOwnedHTML(beforeCleanup) !== stripOwnedHTML(record.lastOwnedHTML)) return null;
    removeFailureMarker(element);
    if (record.originalFragment?.firstChild) {
      while (element.firstChild) element.firstChild.remove();
      element.appendChild(record.originalFragment);
      record.originalFragment = undefined;
    }
    record.status = 'translating';
    record.lastOwnedHTML = record.originalHTML;
    element.setAttribute(TRANSLATED_ATTR, 'pending');
  } else {
    if (inFlightNodes.has(element)) return null;
    inFlightNodes.add(element);
  }

  const context: TranslationContext = {
    element,
    record,
    generation: sessionGeneration,
    sourceHTML: record?.originalHTML ?? element.innerHTML,
    sourceOuterHTML: record?.originalOuterHTML ?? element.outerHTML,
    sourceText: record?.originalText ?? getTranslatableText(element),
    requestHTML: record?.requestHTML ?? LLMStandardHTML(element),
    lastOwnedHTML: record?.originalHTML ?? element.innerHTML,
  };
  return context;
}

function finishWithoutTranslation(context: TranslationContext): void {
  removeSpinner(context);
  if (context.record) {
    restoreCapturedChildren(context);
    clearCapturedChildren(context);
    releaseRecord(context.record);
  } else {
    restoreCapturedChildren(context);
    clearCapturedChildren(context);
    inFlightNodes.delete(context.element);
  }
}

function invalidateContext(context: TranslationContext): void {
  removeSpinner(context);
  // A stale/cancelled stream may have replaced the live children. Restore
  // them only while the current DOM still matches our last applied output;
  // otherwise preserve an independent page mutation.
  const canRestore = context.element.isConnected && contentMatches(context);
  if (!canRestore || !restoreCapturedChildren(context)) {
    if (context.element.isConnected) removeOwnedDescendants(context.element);
  }
  clearCapturedChildren(context);
  if (context.record && activeRecords.has(context.record)) {
    releaseRecord(context.record);
  } else {
    inFlightNodes.delete(context.element);
  }
}

function finishTranslated(context: TranslationContext): void {
  removeSpinner(context);
  context.lastOwnedHTML = context.element.innerHTML;
  if (context.record) {
    context.record.lastOwnedHTML = context.lastOwnedHTML;
    setRecordStatus(context.record, 'translated');
  } else {
    clearCapturedChildren(context);
    inFlightNodes.delete(context.element);
  }
}

function finishFailed(context: TranslationContext, error: unknown): void {
  if (!contextIsCurrent(context)) {
    invalidateContext(context);
    return;
  }
  const spinner = context.spinner;
  removeSpinner(context);
  restoreAfterApplyFailure(context);
  clearBilingualOutput(context.element);
  insertFailedTip(context.element, String(error || '翻译失败'), spinner as HTMLElement);
  context.element.querySelectorAll('.fluent-read-retry-wrapper').forEach(markOwned);
  context.lastOwnedHTML = context.element.innerHTML;
  if (context.record) {
    context.record.lastOwnedHTML = context.lastOwnedHTML;
    setRecordStatus(context.record, 'failed');
  } else {
    inFlightNodes.delete(context.element);
  }
}

function appendBilingualContent(element: HTMLElement, text: string): HTMLElement {
  element.classList.add(BILINGUAL_CLASS);
  const content = document.createElement('span');
  content.className = BILINGUAL_CONTENT_CLASS;
  markOwned(content);
  const style = options.styles.find((item) => item.value === config.style && !item.disabled);
  if (style?.class) content.classList.add(style.class);
  setTranslationText(content, text);
  stabilizeTranslationPlacement(content, element);
  smashTruncationStyle(element);
  element.appendChild(content);
  return content;
}

function setTranslationText(content: HTMLElement, text: string): void {
  content.textContent = text;
  content.dir = RTL_TEXT_RE.test(text) ? 'rtl' : 'ltr';
}

function stabilizeTranslationPlacement(content: HTMLElement, host: HTMLElement): void {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
  const computed = window.getComputedStyle(host);
  if (computed.display !== 'flex' && computed.display !== 'inline-flex') return;

  // A reversed flex axis makes the last DOM child render before the source.
  // Use an extreme order in the opposite direction so the translation stays
  // visually after the original text on both normal and reversed hosts.
  const reverse = computed.flexDirection.endsWith('-reverse');
  content.style.setProperty('order', reverse ? '-1000000' : '1000000', 'important');
}

function clearBilingualOutput(element: HTMLElement): void {
  element.querySelectorAll(`.${BILINGUAL_CONTENT_CLASS}`).forEach((content) => content.remove());
  element.classList.remove(BILINGUAL_CLASS);
}

function applyCachedHTML(element: HTMLElement, cached: string, trustedSourceHTML: string): boolean {
  const safeCached = sanitizeTranslationHTML(cached, trustedSourceHTML);
  const replace = replaceCompatFn[getMainDomain(document.location.hostname)];
  const parsed = document.createElement('div');
  parsed.innerHTML = safeCached;
  const replacement = parsed.firstElementChild;
  const hasMatchingOuter =
    !!replacement &&
    replacement.tagName.toLowerCase() === element.tagName.toLowerCase() &&
    parsed.childNodes.length === 1;
  if (replace && hasMatchingOuter) {
    replace(element, safeCached);
    return !!element.innerHTML.trim();
  }

  // Cache entries historically contain the full outerHTML. Keep the live
  // element identity and update only its children; fall back to the raw value
  // for older/innerHTML-only cache entries.
  element.innerHTML =
    replacement && replacement.tagName.toLowerCase() === element.tagName.toLowerCase()
      ? replacement.innerHTML
      : safeCached;
  return !!element.innerHTML.trim();
}

function applyTranslatedHTML(context: TranslationContext, translated: string): boolean {
  if (!contextIsCurrent(context)) return false;
  const text = sanitizeTranslationHTML(beautyHTML(translated), context.sourceHTML);
  if (!text || text === context.sourceHTML) {
    finishWithoutTranslation(context);
    return true;
  }

  const element = context.element;
  const replace = replaceCompatFn[getMainDomain(document.location.hostname)];
  removeSpinner(context);
  captureOriginalChildren(context);
  const parsed = document.createElement('div');
  parsed.innerHTML = text;
  const matchingOuter =
    parsed.firstElementChild &&
    parsed.firstElementChild.tagName.toLowerCase() === element.tagName.toLowerCase() &&
    parsed.childNodes.length === 1;
  if (replace && matchingOuter) replace(element, text);
  else element.innerHTML = matchingOuter ? parsed.firstElementChild!.innerHTML : text;
  context.lastOwnedHTML = element.innerHTML;
  cache.localSet(context.sourceOuterHTML, element.outerHTML);
  finishTranslated(context);
  return true;
}

function runBilingualTranslation(context: TranslationContext, forceBypassCache: boolean): void {
  const element = context.element;
  const origin = context.sourceText;
  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) {
    finishWithoutTranslation(context);
    return;
  }

  context.spinner = insertLoadingSpinner(element);
  markOwned(context.spinner);

  const onStreamChunk = (accumulated: string) => {
    if (!accumulated?.trim()) return;
    if (!contextIsCurrent(context)) return;
    let streamNode = element.querySelector<HTMLElement>(`.${BILINGUAL_CONTENT_CLASS}`);
    if (!streamNode) {
      removeSpinner(context);
      streamNode = appendBilingualContent(element, '');
    }
    setTranslationText(streamNode, accumulated);
    syncOwnedContent(context);
  };

  const request = config.useStream && servicesType.isCustom(config.service)
    ? translateTextStream(origin, document.title, onStreamChunk, { bypassCacheRead: forceBypassCache })
    : translateText(origin, document.title, { bypassCacheRead: forceBypassCache });

  request
    .then((text) => {
      if (!contextIsCurrent(context)) {
        invalidateContext(context);
        return;
      }
      if (!text?.trim()) {
        clearBilingualOutput(element);
        finishWithoutTranslation(context);
        return;
      }
      removeSpinner(context);
      if (!element.querySelector(`.${BILINGUAL_CONTENT_CLASS}`)) appendBilingualContent(element, text);
      else {
        const content = element.querySelector<HTMLElement>(`.${BILINGUAL_CONTENT_CLASS}`);
        if (content) setTranslationText(content, text);
      }
      finishTranslated(context);
    })
    .catch((error) => finishFailed(context, error));
}

function runSingleTranslation(context: TranslationContext, forceBypassCache: boolean): void {
  const element = context.element;
  // Always translate the captured source. A failed stream may have replaced
  // the live children with a partial result; serializing that result would
  // feed the model its own output on retry.
  const origin = context.requestHTML;
  if (detectlang(context.sourceText.replace(/[\s\u3000]/g, '')) === config.to) {
    finishWithoutTranslation(context);
    return;
  }

  context.spinner = insertLoadingSpinner(element);
  markOwned(context.spinner);

  const onStreamChunk = (accumulated: string) => {
    if (!contextIsCurrent(context)) return;
    removeSpinner(context);
    const safeChunk = sanitizeTranslationHTML(accumulated, context.sourceHTML);
    captureOriginalChildren(context);
    const parsed = document.createElement('div');
    parsed.innerHTML = safeChunk;
    const matchingOuter =
      parsed.firstElementChild &&
      parsed.firstElementChild.tagName.toLowerCase() === element.tagName.toLowerCase() &&
      parsed.childNodes.length === 1;
    element.innerHTML = matchingOuter ? parsed.firstElementChild!.innerHTML : safeChunk;
    syncOwnedContent(context);
  };

  const request = config.useStream && servicesType.isCustom(config.service)
    ? translateTextStream(origin, document.title, onStreamChunk, { bypassCacheRead: forceBypassCache })
    : translateText(origin, document.title, { bypassCacheRead: forceBypassCache });

  request
    .then((text) => {
      try {
        if (!applyTranslatedHTML(context, text)) invalidateContext(context);
      } catch (error) {
        restoreAfterApplyFailure(context);
        finishFailed(context, error);
      }
    })
    .catch((error) => finishFailed(context, error));
}

export function restoreOriginalContent(): void {
  sessionGeneration++;
  isAutoTranslating = false;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = undefined;
  cancelAllTranslations();
  cancelSummaryRequest();
  clearCurrentPageSummary();

  observer?.disconnect();
  observer = null;
  mutationObserver?.disconnect();
  mutationObserver = null;

  Array.from(activeRecords).forEach((record) => {
    const element = record.element;
    const context: TranslationContext = {
      element,
      record,
      generation: record.generation,
      sourceHTML: record.originalHTML,
      sourceOuterHTML: record.originalOuterHTML,
      sourceText: record.originalText,
      requestHTML: record.requestHTML,
      lastOwnedHTML: record.lastOwnedHTML,
    };
    const canRestore = element.isConnected && contentMatches(context);
    removeOwnedDescendants(element);
    if (canRestore) {
      if (!restoreCapturedChildren(context) && element.innerHTML !== record.originalHTML) {
        element.innerHTML = record.originalHTML;
      }
      clearCapturedChildren(context);
    } else {
      // The page changed independently while translation was active. Do not
      // reinsert detached live children into an element we no longer own.
      clearCapturedChildren(context);
    }
    element.classList.remove(BILINGUAL_CLASS, 'fluent-read-failure');
    if (element.getAttribute(TRANSLATED_ID_ATTR) === record.id) {
      element.removeAttribute(TRANSLATED_ID_ATTR);
      element.removeAttribute(TRANSLATED_ATTR);
    }
    if (records.get(element) === record) records.delete(element);
  });
  activeRecords.clear();
  originalContents.clear();
  inFlightNodes.clear();

  // Clean markers from interrupted records and legacy extension markup that
  // predates the WeakMap state.
  document.querySelectorAll(`[${TRANSLATED_ATTR}], [${TRANSLATED_ID_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
    node.removeAttribute(TRANSLATED_ID_ATTR);
  });
  document
    .querySelectorAll(
      `[${OWNED_ATTR}], .fluent-read-loading, .fluent-read-bilingual-content, .fluent-read-retry-wrapper`,
    )
    .forEach((node) => node.remove());
  document.querySelectorAll(`.${BILINGUAL_CLASS}`).forEach((node) => node.classList.remove(BILINGUAL_CLASS));
  document.querySelectorAll('style[data-fr-temp-style]').forEach((node) => node.remove());
  nodeIdCounter = 0;
}

function dispatchAutoTranslation(element: HTMLElement, generation: number): void {
  if (!isAutoTranslating || generation !== sessionGeneration || !element.isConnected) return;
  if (element.hasAttribute(TRANSLATED_ATTR) || element.hasAttribute(TRANSLATED_ID_ATTR)) return;
  const record = createRecord(element, generation);
  if (!record) return;
  if (config.display === styles.bilingualTranslation) {
    handleBilingualTranslation(element, false);
  } else {
    handleSingleTranslation(element, false);
  }
}

function observeCandidate(element: Element, generation: number): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) return;
  if (element.hasAttribute(TRANSLATED_ATTR) || element.hasAttribute(TRANSLATED_ID_ATTR)) return;
  if (element.parentElement?.closest(`[${TRANSLATED_ATTR}], [${TRANSLATED_ID_ATTR}], [${OWNED_ATTR}]`)) {
    return;
  }
  observer?.observe(element);
}

function scanMutationRoots(roots: Set<Node>, generation: number): void {
  if (!isAutoTranslating || generation !== sessionGeneration) return;
  const candidates = new Set<Element>();
  roots.forEach((root) => grabAllNode(root).forEach((candidate) => candidates.add(candidate)));
  candidates.forEach((candidate) => {
    if (observer) observeCandidate(candidate, generation);
    else if (candidate instanceof HTMLElement) dispatchAutoTranslation(candidate, generation);
  });
}

/** Start lazy full-page translation with generation-guarded observers. */
export async function autoTranslateEnglishPage(): Promise<void> {
  if (isAutoTranslating) return;
  const nodes = grabAllNode(document.body);
  if (!nodes.length) return;

  isAutoTranslating = true;
  const generation = ++sessionGeneration;

  if (config.enablePageSummary && servicesType.isUseModel(config.service)) {
    try {
      await requestPageSummary();
    } catch (error) {
      if (config.debugMode) console.warn('[FluentRead] Page summary failed:', error);
    }
    if (!isAutoTranslating || generation !== sessionGeneration) return;
  }

  const processEntry = (element: Element) => {
    if (element instanceof HTMLElement) dispatchAutoTranslation(element, generation);
  };

  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || !isAutoTranslating || generation !== sessionGeneration) return;
        observer?.unobserve(entry.target);
        processEntry(entry.target);
      });
    }, { root: null, rootMargin: '100px', threshold: 0.01 });
    nodes.forEach((node) => observeCandidate(node, generation));
  } else {
    nodes.forEach(processEntry);
  }

  if (typeof MutationObserver !== 'undefined' && document.body) {
    mutationObserver = new MutationObserver((mutations) => {
      if (!isAutoTranslating || generation !== sessionGeneration) return;
      const roots = new Set<Node>();
      mutations.forEach((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (
          target &&
          (target.hasAttribute(TRANSLATED_ATTR) ||
            target.hasAttribute(TRANSLATED_ID_ATTR) ||
            isOwnedElement(target))
        ) {
          return;
        }
        if (mutation.type === 'characterData' && mutation.target.parentElement) {
          roots.add(mutation.target.parentElement);
        }
        mutation.addedNodes.forEach((added) => {
          if (added.nodeType === Node.ELEMENT_NODE && !isOwnedElement(added as Element)) roots.add(added);
          else if (added.nodeType === Node.TEXT_NODE && added.parentElement) roots.add(added.parentElement);
        });
      });
      scanMutationRoots(roots, generation);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

/** Translate the live element beneath a mouse/touch point. */
export function handleTranslation(mouseX: number, mouseY: number, delayTime = 0): void {
  if (!checkConfig()) return;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const node = grabNode(document.elementFromPoint(mouseX, mouseY));
    if (!(node instanceof HTMLElement) || skipNode(node)) return;
    if (config.display === styles.bilingualTranslation) {
      handleBilingualTranslation(node, delayTime > 0);
    } else {
      handleSingleTranslation(node, delayTime > 0);
    }
  }, delayTime);
}

export function handleBilingualTranslation(
  node: HTMLElement,
  slide: boolean,
  forceBypassCache = false,
): void {
  const bilingualNode = searchClassName(node, BILINGUAL_CLASS) as HTMLElement | null;
  if (bilingualNode) {
    if (slide) return;
    const spinner = insertLoadingSpinner(bilingualNode, true);
    markOwned(spinner);
    const toggleGeneration = sessionGeneration;
    const expectedHTML = bilingualNode.innerHTML;
    setTimeout(() => {
      if (
        toggleGeneration !== sessionGeneration ||
        !bilingualNode.isConnected ||
        stripOwnedHTML(bilingualNode.innerHTML) !== stripOwnedHTML(expectedHTML)
      ) {
        spinner.remove();
        return;
      }
      spinner.remove();
      bilingualNode.querySelector(`.${BILINGUAL_CONTENT_CLASS}`)?.remove();
      bilingualNode.classList.remove(BILINGUAL_CLASS);
    }, 250);
    return;
  }

  const context = beginContext(node, forceBypassCache);
  if (!context) return;
  const cached = forceBypassCache ? null : cache.localGet(node.textContent || '');
  if (cached) {
    context.spinner = insertLoadingSpinner(node, true);
    markOwned(context.spinner);
    setTimeout(() => {
      if (!contextIsCurrent(context)) {
        invalidateContext(context);
        return;
      }
      removeSpinner(context);
      try {
        appendBilingualContent(node, cached);
        finishTranslated(context);
      } catch (error) {
        finishFailed(context, error);
      }
    }, 250);
    return;
  }
  runBilingualTranslation(context, forceBypassCache);
}

export function handleSingleTranslation(
  node: HTMLElement,
  _slide: boolean,
  forceBypassCache = false,
): void {
  const context = beginContext(node, forceBypassCache);
  if (!context) return;
  const cached = forceBypassCache ? null : cache.localGet(context.sourceOuterHTML);
  if (cached) {
    context.spinner = insertLoadingSpinner(node, true);
    markOwned(context.spinner);
    setTimeout(() => {
      if (!contextIsCurrent(context)) {
        invalidateContext(context);
        return;
      }
      removeSpinner(context);
      try {
        captureOriginalChildren(context);
        if (!applyCachedHTML(node, cached, context.sourceHTML)) finishWithoutTranslation(context);
        else {
          context.lastOwnedHTML = node.innerHTML;
          finishTranslated(context);
        }
      } catch (error) {
        restoreAfterApplyFailure(context);
        finishFailed(context, error);
      }
    }, 250);
    return;
  }
  runSingleTranslation(context, forceBypassCache);
}

/** Legacy helper retained for callers; button controls are intentionally skipped. */
export const handleBtnTranslation = throttle((node: HTMLElement) => {
  if (node.tagName.toLowerCase() === 'button' || node.closest('button')) return;
  const origin = node.innerText;
  const generation = sessionGeneration;
  if (!shouldTranslateContent(origin)) return;
  const cached = cache.localGet(origin);
  if (cached) {
    if (node.isConnected && node.innerText === origin) node.innerText = cached;
    return;
  }

  translateText(origin, document.title)
    .then((text) => {
      if (generation === sessionGeneration && node.isConnected && node.innerText === origin && text) {
        node.innerText = text;
      }
    })
    .catch((error) => console.error('调用失败:', error));
}, 250);
