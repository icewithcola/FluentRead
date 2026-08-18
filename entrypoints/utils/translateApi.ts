/**
 * Translation transport facade.
 *
 * Requests are queued, time-limited, retryable, and cancellable. The queue's
 * AbortSignal is threaded through both ordinary runtime messages and stream
 * ports so a restore/session change cannot leave transports alive forever.
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

function isCancelled(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || error instanceof TranslationCancelledError;
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

async function withTimeout<T>(
  request: Promise<T> | PromiseLike<T>,
  timeout: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeout);
      abortListener = () => {
        reject(signal.reason instanceof Error ? signal.reason : new TranslationCancelledError());
      };
      signal.addEventListener('abort', abortListener, { once: true });
      Promise.resolve(request).then(resolve, reject);
      if (signal.aborted) abortListener();
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
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
    incrementTranslationCount();

    const attempt = async (retryCount: number): Promise<string> => {
      throwIfAborted(signal);
      try {
        const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
        const result = await withTimeout(
          browser.runtime.sendMessage({ context, origin, pageSummary }),
          timeout,
          signal,
          '翻译请求超时',
        );

        if (result && typeof result === 'object') {
          const response = result as any;
          if (response.success === false || response.error) {
            throw new Error(response.error || '翻译失败');
          }
        }
        if (typeof result !== 'string' || result.includes('[object Object]')) {
          throw new Error('翻译返回了无效的响应格式');
        }
        if (!result || result === origin) return '';

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

  return enqueueTranslation(
    (signal) =>
      new Promise<string>((resolve, reject) => {
        let port: browser.Runtime.Port;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          signal.removeEventListener('abort', onAbort);
          port?.onMessage.removeListener(onMessage);
          port?.onDisconnect.removeListener(onDisconnect);
        };

        const safeResolve = (value: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            port?.disconnect();
          } catch {
            // The browser may already have disconnected the port.
          }
          resolve(value);
        };

        const safeReject = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            port?.disconnect();
          } catch {
            // Ignore a duplicate disconnect during teardown.
          }
          reject(error);
        };

        const onAbort = () =>
          safeReject(signal.reason instanceof Error ? signal.reason : new TranslationCancelledError());

        const onMessage = (message: any) => {
          if (message?.type === 'stream-chunk') {
            try {
              onChunk(message.accumulated);
            } catch (error) {
              safeReject(error);
            }
            return;
          }

          if (message?.type === 'stream-error') {
            safeReject(new Error(message.error || '流式翻译失败'));
            return;
          }

          if (message?.type !== 'stream-done') return;
          const result = message.result;
          if (result && typeof result === 'object') {
            const response = result as any;
            if (response.success === false || response.error) {
              safeReject(new Error(response.error || '流式翻译失败'));
              return;
            }
          }
          if (typeof result !== 'string' || result.includes('[object Object]')) {
            safeReject(new Error('流式翻译返回了无效的响应格式'));
            return;
          }
          if (result && useCache) cache.localSet(origin, result);
          safeResolve(result || '');
        };

        const onDisconnect = () => {
          if (!settled) safeReject(new Error('流式翻译连接意外断开'));
        };

        try {
          throwIfAborted(signal);
          incrementTranslationCount();
          port = browser.runtime.connect({ name: 'stream-translate' });
          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(onDisconnect);
          signal.addEventListener('abort', onAbort, { once: true });
          timeoutId = setTimeout(() => safeReject(new Error('流式翻译请求超时')), timeout);
          const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
          port.postMessage({ context, origin, pageSummary });
        } catch (error) {
          safeReject(error);
        }
      }),
  );
}
