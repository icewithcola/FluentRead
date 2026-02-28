// Page summary utilities: text extraction, caching, and summary request logic.
// The summary is used as context injected into translation prompts (not shown to users).
import { config } from "@/entrypoints/utils/config";
import { summaryMsgTemplate } from "@/entrypoints/utils/template";
import browser from "webextension-polyfill";

const SUMMARY_CACHE_PREFIX = "fr_summary_";

// --- Debug logging helper ---
// Controlled by config.debugMode; logs are prefixed with [FluentRead Debug]
function debugLog(...args: any[]): void {
    if (config.debugMode) {
        console.log("[FluentRead Debug]", ...args);
    }
}

function debugWarn(...args: any[]): void {
    if (config.debugMode) {
        console.warn("[FluentRead Debug]", ...args);
    }
}

function debugError(...args: any[]): void {
    if (config.debugMode) {
        console.error("[FluentRead Debug]", ...args);
    }
}

// Tags to skip when extracting page text
const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NAV", "HEADER", "FOOTER", "NOSCRIPT",
    "SVG", "IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME",
    "INPUT", "TEXTAREA", "SELECT", "BUTTON", "ASIDE",
    "FORM", "MENU", "MENUITEM",
]);

// Selectors to try for finding the main content area (ordered by priority)
const MAIN_CONTENT_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    ".post-content",
    ".article-content",
    ".article-body",
    ".entry-content",
    ".post-body",
    ".story-body",
    "#content",
    ".content",
];

const MAX_TEXT_LENGTH = 3000;
const MIN_TEXT_LENGTH = 50;
const MAX_RATE_LIMIT_RETRIES = 2; // Max auto-retries on 429 rate limit
const MAX_RETRY_WAIT_SECONDS = 120; // Don't wait more than 2 minutes

// --- Global state: current page summary for translation context injection ---
let currentPageSummary: string = "";

/**
 * Get the current page summary text.
 * This is used by the translation template (commonMsgTemplate) to enrich prompts.
 * Returns empty string if summary is not available yet or feature is disabled.
 */
export function getCurrentPageSummary(): string {
    return currentPageSummary;
}

/**
 * Clear the current page summary (e.g. when restoring original content).
 */
export function clearCurrentPageSummary(): void {
    currentPageSummary = "";
}

/**
 * Try to find the main content container using semantic selectors.
 * Returns the first matching element, or null if none found.
 */
function findMainContentRoot(): Element | null {
    for (const selector of MAIN_CONTENT_SELECTORS) {
        const el = document.querySelector(selector);
        if (el && el.textContent && el.textContent.trim().length >= MIN_TEXT_LENGTH) {
            debugLog("Found main content container:", selector, "| text length:", el.textContent.trim().length);
            return el;
        }
    }
    return null;
}

/**
 * Extract text from a given root element using TreeWalker.
 * Skips non-content tags and hidden elements.
 */
function extractTextFromRoot(root: Element): string {
    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node: Text): number {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;

                if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;

                const style = window.getComputedStyle(parent);
                if (style.display === "none" || style.visibility === "hidden") {
                    return NodeFilter.FILTER_REJECT;
                }

                const text = node.textContent?.trim();
                if (!text) return NodeFilter.FILTER_REJECT;

                return NodeFilter.FILTER_ACCEPT;
            },
        }
    );

    const parts: string[] = [];
    let totalLength = 0;

    while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim() || "";
        if (text) {
            parts.push(text);
            totalLength += text.length;
            if (totalLength >= MAX_TEXT_LENGTH) break;
        }
    }

    return parts.join(" ").slice(0, MAX_TEXT_LENGTH);
}

/**
 * Fallback: collect text from paragraph-like elements across the page,
 * sorted by text length (longest first), to approximate the main content.
 * This works well for pages without semantic <article>/<main> containers.
 */
function extractTextByDensity(): string {
    const blocks: { el: Element; text: string }[] = [];

    // Collect all paragraph-like text blocks
    const allElements = document.body.querySelectorAll("p, li, blockquote, dd, td, th, figcaption, h1, h2, h3, h4, h5, h6");
    for (const el of allElements) {
        // Skip elements inside SKIP_TAGS containers
        if (el.closest("nav, header, footer, aside, form")) continue;

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        const text = el.textContent?.trim() || "";
        // Only keep blocks with meaningful text (>20 chars, likely real content)
        if (text.length > 20) {
            blocks.push({ el, text });
        }
    }

    // Sort by text length descending: longer paragraphs are more likely to be body content
    blocks.sort((a, b) => b.text.length - a.text.length);

    const parts: string[] = [];
    let totalLength = 0;

    for (const block of blocks) {
        parts.push(block.text);
        totalLength += block.text.length;
        if (totalLength >= MAX_TEXT_LENGTH) break;
    }

    return parts.join(" ").slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract the main body text content from the page.
 *
 * Strategy (in order):
 * 1. Look for semantic content containers (<article>, <main>, [role="main"], etc.)
 * 2. Fallback: collect text from paragraph-like elements sorted by text density
 * 3. Last resort: walk the entire document.body (original behavior)
 *
 * Truncates to MAX_TEXT_LENGTH characters.
 * Returns empty string if content is too short (< MIN_TEXT_LENGTH meaningful chars).
 */
export function extractPageText(): string {
    if (!document.body) return "";

    debugLog("Extracting page text from:", location.href);

    let result = "";

    // Strategy 1: Try semantic content containers
    const mainRoot = findMainContentRoot();
    if (mainRoot) {
        result = extractTextFromRoot(mainRoot);
        debugLog("Strategy 1 (semantic container) extracted length:", result.length);
    }

    // Strategy 2: Text density fallback (if Strategy 1 found too little)
    if (result.replace(/\s+/g, "").length < MIN_TEXT_LENGTH) {
        debugLog("Semantic container not found or too short, trying density-based extraction...");
        result = extractTextByDensity();
        debugLog("Strategy 2 (density-based) extracted length:", result.length);
    }

    // Strategy 3: Last resort — walk entire body
    if (result.replace(/\s+/g, "").length < MIN_TEXT_LENGTH) {
        debugLog("Density-based extraction too short, falling back to full body walk...");
        result = extractTextFromRoot(document.body);
        debugLog("Strategy 3 (full body walk) extracted length:", result.length);
    }

    // Final validity check
    if (result.replace(/\s+/g, "").length < MIN_TEXT_LENGTH) {
        debugWarn("Extracted text too short after all strategies, skipping. Length:", result.replace(/\s+/g, "").length);
        return "";
    }

    debugLog("Extracted text length:", result.length, "| Preview:", result.slice(0, 200) + "...");
    return result;
}

// --- Summary cache helpers ---

function getSummaryCacheKey(): string {
    return `${SUMMARY_CACHE_PREFIX}${location.href}`;
}

export function getCachedSummary(): string | null {
    if (!config.useCache) return null;
    return localStorage.getItem(getSummaryCacheKey());
}

export function setCachedSummary(summary: string): void {
    if (!config.useCache) return;
    localStorage.setItem(getSummaryCacheKey(), summary);
}

/**
 * Clean all summary caches from localStorage.
 * Called from cache.clean() extension.
 */
export function cleanSummaryCache(): void {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(SUMMARY_CACHE_PREFIX)) {
            keysToDelete.push(key);
        }
    }
    keysToDelete.forEach((key) => localStorage.removeItem(key));
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
}

/**
 * Request a page summary from the current translation service.
 * - Checks cache first.
 * - Extracts page text and sends a summary request via background script.
 * - Stores the result in `currentPageSummary` for use by translation prompts.
 * - Always non-streaming (we need the full result before translations begin).
 * - Has a 60-second timeout.
 *
 * @returns The summary text, or empty string on failure/skip
 */
export async function requestPageSummary(): Promise<string> {
    debugLog("requestPageSummary() called. enablePageSummary:", config.enablePageSummary, "| URL:", location.href);

    // 1. Check cache
    const cached = getCachedSummary();
    if (cached) {
        debugLog("Summary cache HIT. Cached summary:", cached.slice(0, 200) + (cached.length > 200 ? "..." : ""));
        currentPageSummary = cached;
        return cached;
    }
    debugLog("Summary cache MISS.");

    // 2. Extract page text
    const pageText = extractPageText();
    if (!pageText) {
        debugWarn("No page text extracted, skipping summary request.");
        return "";
    }

    // 3. Build request body using the fixed summary prompt template
    const body = summaryMsgTemplate(pageText);
    debugLog("Summary request body:", body);

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
                    setTimeout(() => reject(new Error("Summary request timed out")), 60000)
                ),
            ]);

            // 6. Store and cache the result
            if (result) {
                debugLog("Summary raw output:", result);
                currentPageSummary = result;
                setCachedSummary(result);
            } else {
                debugWarn("Summary request returned empty result.");
            }

            currentSummaryAbort = null;
            return result;
        } catch (error: any) {
            // Handle 429 rate limit: auto-retry after waiting
            if (
                error instanceof RateLimitError &&
                retryCount < MAX_RATE_LIMIT_RETRIES
            ) {
                const waitSeconds = Math.min(
                    error.retryAfter > 0 ? error.retryAfter : 30,
                    MAX_RETRY_WAIT_SECONDS
                );
                retryCount++;
                debugLog(
                    `Rate limited (429). Waiting ${waitSeconds}s before retry ${retryCount}/${MAX_RATE_LIMIT_RETRIES}...`
                );
                console.log(
                    `[FluentRead] Summary rate limited. Retrying in ${waitSeconds}s (attempt ${retryCount}/${MAX_RATE_LIMIT_RETRIES})...`
                );

                // Wait, but respect abort signal
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, waitSeconds * 1000);
                    if (abortSignal) {
                        const onAbort = () => {
                            clearTimeout(timer);
                            reject(new DOMException("Aborted", "AbortError"));
                        };
                        if (abortSignal.aborted) {
                            clearTimeout(timer);
                            reject(new DOMException("Aborted", "AbortError"));
                            return;
                        }
                        abortSignal.addEventListener("abort", onAbort, { once: true });
                    }
                });
                continue; // Retry the request
            }

            currentSummaryAbort = null;
            if (error.name === "AbortError") {
                console.log("[FluentRead] Summary request was cancelled");
                debugLog("Summary request was aborted by user/system.");
            } else {
                console.error("[FluentRead] Summary request failed:", error);
                debugError("Summary request error details:", error.message, error.stack);
            }
            return "";
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
        this.name = "RateLimitError";
        this.retryAfter = retryAfter;
    }
}

/**
 * Send the summary request to the background script via simple runtime messaging (non-streaming).
 * Throws RateLimitError on 429 responses so the caller can auto-retry.
 */
async function sendSummaryRequest(
    body: string,
    abortSignal?: AbortSignal
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (abortSignal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }

        const onAbort = () => {
            reject(new DOMException("Aborted", "AbortError"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        debugLog("Sending summary request to background script...", {
            summaryApiKey: config.summaryApiKey ? "(set)" : "(empty)",
            summaryApiUrl: config.summaryApiUrl || "(default)",
        });

        browser.runtime
            .sendMessage({
                type: "summary",
                body,
                // Pass custom summary API settings (if configured) to background
                summaryApiKey: config.summaryApiKey || "",
                summaryApiUrl: config.summaryApiUrl || "",
            })
            .then((response: any) => {
                abortSignal?.removeEventListener("abort", onAbort);
                debugLog("Background script response:", JSON.stringify(response));
                if (response && response.text) {
                    resolve(response.text);
                } else if (response && response.error) {
                    debugError("Background script returned error:", response.error);
                    // If 429, throw RateLimitError with parsed retryAfter
                    if (response.statusCode === 429) {
                        const retryAfter = response.retryAfter ?? 0;
                        debugLog("Received 429 from background. retryAfter:", retryAfter, "seconds");
                        reject(new RateLimitError(response.error, retryAfter));
                    } else {
                        reject(new Error(response.error));
                    }
                } else {
                    debugWarn("Background script returned unexpected response:", response);
                    resolve("");
                }
            })
            .catch((err: any) => {
                abortSignal?.removeEventListener("abort", onAbort);
                debugError("browser.runtime.sendMessage failed:", err.message, err.stack);
                reject(err);
            });
    });
}
