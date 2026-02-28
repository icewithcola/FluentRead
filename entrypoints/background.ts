import {_service} from "@/entrypoints/service/_service";
import {config} from "@/entrypoints/utils/config";
import {CONTEXT_MENU_IDS} from "@/entrypoints/utils/constant";
import {services} from "@/entrypoints/utils/option";
import {method} from "@/entrypoints/utils/constant";

// 翻译状态管理
let translationStateMap = new Map<number, boolean>(); // tabId -> isTranslated

export default defineBackground({
    persistent: {
        safari: false,
    },
    main() {
        // 创建右键菜单项
        try {
            // 创建父菜单
            browser.contextMenus.create({
                id: 'fluentread-parent',
                title: 'FluentRead',
                contexts: ['page', 'selection'],
            });
            
            // 创建全文翻译子菜单
            browser.contextMenus.create({
                id: CONTEXT_MENU_IDS.TRANSLATE_FULL_PAGE,
                title: '全文翻译',
                parentId: 'fluentread-parent',
                contexts: ['page', 'selection'],
            });
            
            // 创建撤销翻译子菜单
            browser.contextMenus.create({
                id: CONTEXT_MENU_IDS.RESTORE_ORIGINAL,
                title: '撤销翻译',
                parentId: 'fluentread-parent',
                contexts: ['page', 'selection'],
                enabled: false, // 初始状态为禁用
            });
        } catch (error) {
            console.error('Error setting up context menu:', error);
        }

        // 监听右键菜单点击事件
        browser.contextMenus.onClicked.addListener((info: any, tab: any) => {
            if (!tab?.id) return;
            
            if (info.menuItemId === CONTEXT_MENU_IDS.TRANSLATE_FULL_PAGE) {
                // 发送消息到内容脚本触发全文翻译
                browser.tabs.sendMessage(tab.id, {
                    type: 'contextMenuTranslate',
                    action: 'fullPage'
                }).then(() => {
                    // 更新翻译状态
                    translationStateMap.set(tab.id!, true);
                    updateContextMenus(tab.id!);
                }).catch((error: any) => {
                    console.error('Failed to send message to content script:', error);
                });
            } else if (info.menuItemId === CONTEXT_MENU_IDS.RESTORE_ORIGINAL) {
                // 发送消息到内容脚本撤销翻译
                browser.tabs.sendMessage(tab.id, {
                    type: 'contextMenuTranslate',
                    action: 'restore'
                }).then(() => {
                    // 更新翻译状态
                    translationStateMap.set(tab.id!, false);
                    updateContextMenus(tab.id!);
                }).catch((error: any) => {
                    console.error('Failed to send message to content script:', error);
                });
            }
        });

        // 更新右键菜单状态
        const updateContextMenus = (tabId: number) => {
            const isTranslated = translationStateMap.get(tabId) || false;
            
            try {
                // 更新全文翻译菜单项
                browser.contextMenus.update(CONTEXT_MENU_IDS.TRANSLATE_FULL_PAGE, {
                    enabled: !isTranslated,
                    title: isTranslated ? '全文翻译 (已翻译)' : '全文翻译'
                });
                
                // 更新撤销翻译菜单项
                browser.contextMenus.update(CONTEXT_MENU_IDS.RESTORE_ORIGINAL, {
                    enabled: isTranslated,
                    title: isTranslated ? '撤销翻译' : '撤销翻译 (无翻译)'
                });
            } catch (error) {
                console.error('Failed to update context menus:', error);
            }
        };

        // 监听标签页切换事件，更新菜单状态
        browser.tabs.onActivated.addListener((activeInfo: any) => {
            updateContextMenus(activeInfo.tabId);
        });

        // 监听标签页更新事件（页面刷新等）
        browser.tabs.onUpdated.addListener((tabId: any, changeInfo: any) => {
            if (changeInfo.status === 'complete') {
                // 页面加载完成，重置翻译状态
                translationStateMap.set(tabId, false);
                updateContextMenus(tabId);
            }
        });

        // 监听标签页关闭事件，清理状态
        browser.tabs.onRemoved.addListener((tabId: any) => {
            translationStateMap.delete(tabId);
        });

        // 处理翻译请求
        browser.runtime.onMessage.addListener((message: any) => {
            // Skip messages intended for other listeners (e.g. offscreen document)
            if (message?.type === 'CHROME_TRANSLATE_OFFSCREEN') return;
            if (message?.type === 'stream-translate') return;

            // Handle non-streaming summary requests
            if (message?.type === 'summary') {
                return handleSummaryRequest(message.body, message.summaryApiKey, message.summaryApiUrl);
            }

            // Only handle translation requests (messages with 'origin' field)
            if (!message?.origin) return;

            return new Promise(async (resolve, reject) => {
                try {
                    // 处理普通翻译请求
                    _service[config.service](message)
                        .then(resp => resolve(resp))    // 成功
                        .catch(error => reject(error)); // 失败
                } catch (error) {
                    resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
                }
            });
        });

        // Handle streaming translation requests via Port connection
        browser.runtime.onConnect.addListener((port: any) => {
            if (port.name !== 'stream-translate') return;

            port.onMessage.addListener(async (message: any) => {
                try {
                    // Attach port to message so custom() can send chunks
                    message._port = port;
                    const result = await _service[config.service](message);
                    // Send final complete result
                    port.postMessage({type: 'stream-done', result});
                } catch (error) {
                    port.postMessage({
                        type: 'stream-error',
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            });
        });
    }
});

/**
 * Handle a non-streaming summary request.
 * Uses the pre-built body from pageSummary.ts (summaryMsgTemplate),
 * sends it to the same custom API endpoint, and returns the result text.
 */
// Debug logging helper for background script, controlled by config.debugMode
function bgDebugLog(...args: any[]): void {
    if (config.debugMode) console.log("[FluentRead BG Debug]", ...args);
}
function bgDebugError(...args: any[]): void {
    if (config.debugMode) console.error("[FluentRead BG Debug]", ...args);
}

/**
 * Parse retry delay (in seconds) from a 429 error response.
 * Checks Retry-After header first, then falls back to parsing the JSON response body
 * for retryDelay or "Please retry in Xs" patterns.
 */
function parseRetryAfterSeconds(resp: Response, errorBody: string): number | null {
    // 1. Check standard Retry-After header
    const retryAfterHeader = resp.headers.get('Retry-After');
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (!isNaN(seconds) && seconds > 0) {
            bgDebugLog("Parsed Retry-After header:", seconds, "seconds");
            return seconds;
        }
    }

    // 2. Try to parse retryDelay from JSON body (e.g. Google Gemini format: "retryDelay": "50s")
    const retryDelayMatch = errorBody.match(/"retryDelay"\s*:\s*"(\d+)s?"/i);
    if (retryDelayMatch) {
        const seconds = Number(retryDelayMatch[1]);
        if (!isNaN(seconds) && seconds > 0) {
            bgDebugLog("Parsed retryDelay from body:", seconds, "seconds");
            return seconds;
        }
    }

    // 3. Try to parse "Please retry in Xs" or "Please retry in X.XXs" from the message
    const retryInMatch = errorBody.match(/retry in\s+([\d.]+)s/i);
    if (retryInMatch) {
        const seconds = Math.ceil(Number(retryInMatch[1]));
        if (!isNaN(seconds) && seconds > 0) {
            bgDebugLog("Parsed 'retry in' from message:", seconds, "seconds");
            return seconds;
        }
    }

    return null;
}

async function handleSummaryRequest(
    body: string,
    summaryApiKey?: string,
    summaryApiUrl?: string
): Promise<{ text?: string; error?: string; retryAfter?: number; statusCode?: number }> {
    bgDebugLog("handleSummaryRequest() called");
    try {
        // Use custom summary API key/url if provided, otherwise fall back to translation settings
        const apiKey = summaryApiKey || config.token[config.service] || config.token[services.custom];
        const apiUrl = summaryApiUrl || config.custom;

        bgDebugLog("Summary API URL:", apiUrl);
        bgDebugLog("Summary API Key:", apiKey ? `${apiKey.slice(0, 6)}...` : "(empty)");
        bgDebugLog("Summary request body:", body);

        const headers = new Headers();
        headers.append('Content-Type', 'application/json');
        headers.append('Authorization', `Bearer ${apiKey}`);

        const resp = await fetch(apiUrl, {
            method: method.POST,
            headers,
            body,
        });

        bgDebugLog("Summary API response status:", resp.status, resp.statusText);

        if (!resp.ok) {
            const errorBody = await resp.text();
            bgDebugError("Summary API error response body:", errorBody);

            // For 429 rate limit errors, extract retry delay and pass it back
            if (resp.status === 429) {
                const retryAfter = parseRetryAfterSeconds(resp, errorBody);
                bgDebugLog("429 Rate Limited. retryAfter:", retryAfter, "seconds");
                return {
                    error: `Summary request failed: ${resp.status} ${resp.statusText} ${errorBody}`,
                    retryAfter: retryAfter ?? undefined,
                    statusCode: 429,
                };
            }

            return { error: `Summary request failed: ${resp.status} ${resp.statusText} ${errorBody}` };
        }

        const result = await resp.json();
        bgDebugLog("Summary API raw JSON response:", JSON.stringify(result));
        const text = result.choices?.[0]?.message?.content || "";
        bgDebugLog("Summary extracted text:", text);
        return { text };
    } catch (error: any) {
        bgDebugError("Summary fetch exception:", error.message, error.stack);
        return { error: error.message || String(error) };
    }
}
