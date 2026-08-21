/**
 * Translation transport facade.
 *
 * Requests are queued, time-limited, retryable, and cancellable. The queue's
 * AbortSignal disconnects the runtime Port so background fetch() calls abort
 * when the user restores the page or stops translation.
 */

import { enqueueTranslation, clearTranslationQueue, getQueueStatus, TranslationCancelledError } from './translateQueue';
import browser from 'webextension-polyfill';
import { config } from './config';
import { cache } from './cache';
import { detectlang } from './common';
import { storage } from '@wxt-dev/storage';
import { getCurrentPageSummary } from './pageSummary';

const isDev = process.env.NODE_ENV === 'development';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new TranslationCancelledError();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isCancelled(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || error instanceof TranslationCancelledError || isAbortError(error);
}

function cancelledError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new TranslationCancelledError();
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  if (delay <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new TranslationCancelledError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const TRANSLATE_PORT = 'stream-translate';

/** Runtime Port used for both streaming and non-streaming translation. Disconnect aborts fetch(). */
function requestViaPort(
  payload: { context: string; origin: string; pageSummary?: string },
  signal: AbortSignal,
  timeout: number,
  labels: { timeout: string; disconnect: string; failure: string; invalid: string },
  onChunk?: (accumulated: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let port: browser.Runtime.Port | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      try {
        port?.onMessage.removeListener(onMessage);
        port?.onDisconnect.removeListener(onDisconnect);
      } catch {
        // Port may already be gone.
      }
    };

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        port?.disconnect();
      } catch {
        // The browser may already have disconnected the port.
      }
      action();
    };

    const onAbort = () => settle(() => reject(cancelledError(signal)));

    const onMessage = (message: any) => {
      if (message?.type === 'stream-chunk') {
        if (!onChunk) return;
        try {
          onChunk(message.accumulated);
        } catch (error) {
          settle(() => reject(error));
        }
        return;
      }

      if (message?.type === 'stream-error') {
        settle(() => reject(new Error(message.error || labels.failure)));
        return;
      }

      if (message?.type !== 'stream-done') return;
      const result = message.result;
      if (result && typeof result === 'object') {
        const response = result as any;
        if (response.success === false || response.error) {
          settle(() => reject(new Error(response.error || labels.failure)));
          return;
        }
      }
      if (typeof result !== 'string' || result.includes('[object Object]')) {
        settle(() => reject(new Error(labels.invalid)));
        return;
      }
      settle(() => resolve(result || ''));
    };

    const onDisconnect = () => {
      if (settled) return;
      settle(() => reject(signal.aborted ? cancelledError(signal) : new Error(labels.disconnect)));
    };

    try {
      throwIfAborted(signal);
      port = browser.runtime.connect({ name: TRANSLATE_PORT });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(() => settle(() => reject(new Error(labels.timeout))), timeout);
      port.postMessage(payload);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function incrementTranslationCount(): void {
  config.count++;
  // Persistence is best effort; a storage failure must not turn a successful
  // translation into a failed DOM update.
  void Promise.resolve(storage.setItem('local:config', JSON.stringify(config))).catch(() => undefined);
}

/** Unified non-streaming translation entry point. */
export async function translateText(
  origin: string,
  context: string = typeof document === 'undefined' ? '' : document.title,
  options: TranslateOptions = {},
): Promise<string> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = 45000,
    useCache = config.useCache,
    bypassCacheRead = false,
  } = options;
  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.floor(Number(maxRetries)))
    : 0;
  const retryInterval = Number.isFinite(Number(retryDelay)) ? Math.max(0, Number(retryDelay)) : 0;

  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) return origin;

  if (useCache && !bypassCacheRead) {
    const cachedResult = cache.localGet(origin);
    if (cachedResult) return cachedResult;
  }

  return enqueueTranslation(async (signal) => {
    throwIfAborted(signal);

    const attempt = async (retryCount: number): Promise<string> => {
      throwIfAborted(signal);
      try {
        const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
        const result = await requestViaPort({ context, origin, pageSummary }, signal, timeout, {
          timeout: '翻译请求超时',
          disconnect: '翻译连接意外断开',
          failure: '翻译失败',
          invalid: '翻译返回了无效的响应格式',
        });
        if (!result || result === origin) return '';

        incrementTranslationCount();
        if (useCache) cache.localSet(origin, result);
        return result;
      } catch (error) {
        if (isCancelled(signal, error)) throw error;
        if (retryCount >= retryLimit) throw error;
        if (isDev) {
          console.log(`[翻译API] 翻译失败，${retryCount + 1}/${retryLimit} 次重试，原因:`, error);
        }
        await wait(retryInterval, signal);
        return attempt(retryCount + 1);
      }
    };

    return attempt(0);
  });
}

/** Cancel queued requests and abort active transports. */
export function cancelAllTranslations(): void {
  if (isDev) console.log('[翻译API] 取消所有等待中的翻译任务');
  clearTranslationQueue();
}

export function getTranslationStatus() {
  return getQueueStatus();
}

export interface TranslateOptions {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  useCache?: boolean;
  bypassCacheRead?: boolean;
}

/** Streaming translation over a cancellable runtime Port. */
export async function translateTextStream(
  origin: string,
  context: string = typeof document === 'undefined' ? '' : document.title,
  onChunk: (accumulated: string) => void,
  options: TranslateOptions = {},
): Promise<string> {
  const { timeout = 60000, useCache = config.useCache, bypassCacheRead = false } = options;

  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) return origin;
  if (useCache && !bypassCacheRead) {
    const cachedResult = cache.localGet(origin);
    if (cachedResult) return cachedResult;
  }

  return enqueueTranslation(async (signal) => {
    throwIfAborted(signal);
    const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
    const result = await requestViaPort(
      { context, origin, pageSummary },
      signal,
      timeout,
      {
        timeout: '流式翻译请求超时',
        disconnect: '流式翻译连接意外断开',
        failure: '流式翻译失败',
        invalid: '流式翻译返回了无效的响应格式',
      },
      onChunk,
    );
    if (result) {
      incrementTranslationCount();
      if (useCache) cache.localSet(origin, result);
    }
    return result || '';
  });
}
