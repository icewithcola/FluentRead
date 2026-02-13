// Page summary utilities: text extraction, caching, and summary request logic.
// The summary is used as context injected into translation prompts (not shown to users).
import { config } from "@/entrypoints/utils/config";
import { summaryMsgTemplate } from "@/entrypoints/utils/template";
import browser from "webextension-polyfill";

const SUMMARY_CACHE_PREFIX = "fr_summary_";

// Tags to skip when extracting page text
const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NAV", "HEADER", "FOOTER", "NOSCRIPT",
    "SVG", "IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME",
    "INPUT", "TEXTAREA", "SELECT", "BUTTON",
]);

const MAX_TEXT_LENGTH = 3000;
const MIN_TEXT_LENGTH = 50;

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
 * Extract visible text content from the page body.
 * Skips script, style, nav, header, footer, noscript and other non-content tags.
 * Truncates to MAX_TEXT_LENGTH characters.
 * Returns empty string if content is too short (< MIN_TEXT_LENGTH meaningful chars).
 */
export function extractPageText(): string {
    if (!document.body) return "";

    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node: Text): number {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;

                // Skip invisible elements
                if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;

                // Skip hidden elements
                const style = window.getComputedStyle(parent);
                if (style.display === "none" || style.visibility === "hidden") {
                    return NodeFilter.FILTER_REJECT;
                }

                // Skip empty text nodes
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

    const result = parts.join(" ").slice(0, MAX_TEXT_LENGTH);

    // Validity check: skip if too short
    if (result.replace(/\s+/g, "").length < MIN_TEXT_LENGTH) {
        return "";
    }

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
 * - Has a 30-second timeout.
 *
 * @returns The summary text, or empty string on failure/skip
 */
export async function requestPageSummary(): Promise<string> {
    // 1. Check cache
    const cached = getCachedSummary();
    if (cached) {
        currentPageSummary = cached;
        return cached;
    }

    // 2. Extract page text
    const pageText = extractPageText();
    if (!pageText) return "";

    // 3. Build request body using the fixed summary prompt template
    const body = summaryMsgTemplate(pageText);

    // 4. Create abort controller for cancellation support
    currentSummaryAbort = new AbortController();
    const abortSignal = currentSummaryAbort.signal;

    // 5. Send non-streaming request via background script with 30s timeout
    try {
        const result = await Promise.race<string>([
            sendSummaryRequest(body, abortSignal),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("Summary request timed out")), 30000)
            ),
        ]);

        // 6. Store and cache the result
        if (result) {
            currentPageSummary = result;
            setCachedSummary(result);
        }

        currentSummaryAbort = null;
        return result;
    } catch (error: any) {
        currentSummaryAbort = null;
        if (error.name === "AbortError") {
            console.log("[FluentRead] Summary request was cancelled");
        } else {
            console.error("[FluentRead] Summary request failed:", error);
        }
        return "";
    }
}

/**
 * Send the summary request to the background script via simple runtime messaging (non-streaming).
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

        browser.runtime
            .sendMessage({ type: "summary", body })
            .then((response: any) => {
                abortSignal?.removeEventListener("abort", onAbort);
                if (response && response.text) {
                    resolve(response.text);
                } else if (response && response.error) {
                    reject(new Error(response.error));
                } else {
                    resolve("");
                }
            })
            .catch((err: any) => {
                abortSignal?.removeEventListener("abort", onAbort);
                reject(err);
            });
    });
}
