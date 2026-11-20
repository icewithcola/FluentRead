/**
 * Translation transport facade.
 *
 * Requests are queued, time-limited, retryable, and cancellable. The queue's
 * AbortSignal disconnects the runtime Port so background fetch() calls abort
 * when the user restores the page or stops translation.
 */

import {
  enqueueTranslation,
  clearTranslationQueue,
  getQueueStatus,
  markPrefixCacheWarm,
  TranslationCancelledError,
} from './translateQueue';
import browser from 'webextension-polyfill';
import { config } from './config';
import { cache } from './cache';
import { contentPostHandler } from './check';
import { detectlang, getCjkLanguageTag } from './common';
import { storage } from '@wxt-dev/storage';
import { servicesType } from './option';
import { buildPageContext, getCurrentPageSummary, warmUpPageSummary } from './pageSummary';
import { TRANSLATION_COUNT_KEY, normalizeTranslationCount } from './constant';

const isDev = process.env.NODE_ENV === 'development';

interface InFlightStreamEntry {
  promise: Promise<string>;
  listeners: Set<(accumulated: string) => void>;
  latestAccumulated: string;
}

const inFlightTranslations = new Map<string, Promise<string>>();
const inFlightStreamTranslations = new Map<string, InFlightStreamEntry>();

function buildInFlightKey(cacheKey: string): string {
  return `${config.service}:${config.to}:${cacheKey.replace(/\s+/g, ' ').trim()}`;
}

const TRUNCATION_CHECK_MIN_SOURCE_CHARS = 2000;
const TRUNCATION_MIN_LENGTH_RATIO = 0.25;
const MAX_TRANSLATION_CHUNK_CHARS = 3500;

const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface SentenceSegment {
  segment: string;
}

interface SentenceSegmenter {
  segment(text: string): Iterable<SentenceSegment>;
}

type SentenceSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'sentence' },
) => SentenceSegmenter;

function createSentenceSegmenter(): SentenceSegmenter | null {
  if (typeof Intl === 'undefined') return null;
  const segmenter = (Intl as typeof Intl & { Segmenter?: SentenceSegmenterConstructor }).Segmenter;
  if (!segmenter) return null;
  try {
    return new segmenter(undefined, { granularity: 'sentence' });
  } catch {
    return null;
  }
}

function plainTextLength(value: string): number {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function isTranslationTruncated(origin: string, translated: string): boolean {
  const sourceLen = plainTextLength(origin);
  if (sourceLen <= TRUNCATION_CHECK_MIN_SOURCE_CHARS) return false;
  const translatedLen = plainTextLength(translated);
  return translatedLen / sourceLen < TRUNCATION_MIN_LENGTH_RATIO;
}

function assertTranslationComplete(origin: string, translated: string): void {
  if (isTranslationTruncated(origin, translated)) {
    throw new Error('翻译结果不完整（疑似被模型截断），请重试');
  }
}

function splitOversizedSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) return [segment];
  const parts: string[] = [];
  let remaining = segment;
  const minSplit = Math.floor(maxChars * 0.4);

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    let splitIdx = -1;

    for (let i = slice.length - 1; i >= minSplit; i--) {
      if (/\s/.test(slice[i])) {
        splitIdx = i;
        break;
      }
    }
    if (splitIdx < 0) {
      for (let i = slice.length - 1; i >= minSplit; i--) {
        if (/[,;，；、]/.test(slice[i])) {
          splitIdx = i;
          break;
        }
      }
    }
    if (splitIdx < 0) {
      for (let i = minSplit - 1; i >= 1; i--) {
        if (/[\s,;，；、]/.test(slice[i])) {
          splitIdx = i;
          break;
        }
      }
    }

    const cut = splitIdx >= 0 ? splitIdx + 1 : maxChars;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function splitPlainTextSegments(text: string, maxChars: number): string[] {
  const segmenter = createSentenceSegmenter();
  const rawSegments: string[] = [];

  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      if (part.segment) rawSegments.push(part.segment);
    }
  } else {
    const matches = text.match(/[^.!?;。！？；\n]+[.!?;。！？；\n]*|[\n]+/g);
    if (matches) {
      let matchedLength = 0;
      for (const item of matches) {
        rawSegments.push(item);
        matchedLength += item.length;
      }
      if (matchedLength < text.length) rawSegments.push(text.slice(matchedLength));
    } else {
      rawSegments.push(text);
    }
  }

  return rawSegments.flatMap((segment) => splitOversizedSegment(segment, maxChars));
}

function findClosingTagAngle(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '<') {
      return -1;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function splitHtmlAwareSegments(html: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let segStart = 0;

  for (let i = 0; i < html.length; i++) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const commentEnd = html.indexOf('-->', i + 4);
        if (commentEnd >= 0) {
          i = commentEnd + 2;
          continue;
        }
      }
      if (html[i + 1] && /[a-zA-Z/]/.test(html[i + 1])) {
        const gt = findClosingTagAngle(html, i);
        if (gt > i) {
          const tagStr = html.slice(i, gt + 1);
          const tagMatch = tagStr.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/);
          if (tagMatch) {
            const tagName = tagMatch[1].toLowerCase();
            if (tagStr.startsWith('</')) {
              depth = Math.max(0, depth - 1);
            } else if (!tagStr.endsWith('/>') && !HTML_VOID_TAGS.has(tagName)) {
              depth++;
            }
            i = gt;
            continue;
          }
        }
      }
    }

    if (depth !== 0) continue;

    const ch = html[i];
    if (ch === '\n') {
      segments.push(html.slice(segStart, i + 1));
      segStart = i + 1;
      continue;
    }

    if (ch === '。' || ch === '！' || ch === '？') {
      let end = i + 1;
      while (end < html.length && /[”」’"')） \t]/.test(html[end])) end++;
      segments.push(html.slice(segStart, end));
      segStart = end;
      i = end - 1;
      continue;
    }

    if (ch === '.' || ch === '!' || ch === '?') {
      let end = i + 1;
      while (end < html.length && /[”’"')）]/.test(html[end])) end++;
      if (end === html.length || /\s/.test(html[end])) {
        while (end < html.length && /[ \t]/.test(html[end])) end++;
        segments.push(html.slice(segStart, end));
        segStart = end;
        i = end - 1;
      }
    }
  }

  if (segStart < html.length) {
    segments.push(html.slice(segStart));
  }
  return segments;
}

function packSegmentsIntoChunks(segments: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const segment of segments) {
    if (!segment) continue;
    if (!current) {
      current = segment;
      continue;
    }
    if (current.length + segment.length <= maxChars) {
      current += segment;
    } else {
      if (current.trim()) chunks.push(current);
      else if (chunks.length > 0) chunks[chunks.length - 1] += current;
      current = segment;
    }
  }

  if (current) {
    if (current.trim() || chunks.length === 0) chunks.push(current);
    else chunks[chunks.length - 1] += current;
  }

  return chunks;
}

export function splitIntoTranslationChunks(
  origin: string,
  maxChars = MAX_TRANSLATION_CHUNK_CHARS,
): string[] {
  if (!origin || origin.length <= maxChars) return [origin];

  const hasHtmlMarkup =
    /<\/[a-zA-Z][a-zA-Z0-9-]*>/.test(origin) || /<(?:br|hr|img|wbr)\b[^>]*>/i.test(origin);
  const segments = hasHtmlMarkup
    ? splitHtmlAwareSegments(origin)
    : splitPlainTextSegments(origin, maxChars);
  const chunks = packSegmentsIntoChunks(segments, maxChars);
  return chunks.length > 0 ? chunks : [origin];
}

function appendTranslatedChunk(accumulated: string, nextChunk: string): string {
  if (!accumulated) return nextChunk;
  if (!nextChunk) return accumulated;
  if (/\s$/.test(accumulated) || /^\s/.test(nextChunk)) {
    return `${accumulated}${nextChunk}`;
  }
  if (getCjkLanguageTag(config.to)) {
    const needsAsciiSpace =
      /[A-Za-z0-9.!?]$/.test(accumulated) && /^[A-Za-z0-9]/.test(nextChunk);
    return needsAsciiSpace ? `${accumulated} ${nextChunk}` : `${accumulated}${nextChunk}`;
  }
  return `${accumulated} ${nextChunk}`;
}

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
        markPrefixCacheWarm();
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
      markPrefixCacheWarm();
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

let pendingCountIncrements = 0;
let persistingCount = false;

/** Count one successfully applied translation. Writes a dedicated key so settings saves cannot clobber it. */
export function incrementTranslationCount(): void {
  config.count = normalizeTranslationCount(config.count) + 1;
  pendingCountIncrements++;
  void flushTranslationCount();
}

async function flushTranslationCount(): Promise<void> {
  if (persistingCount) return;
  persistingCount = true;
  try {
    while (pendingCountIncrements > 0) {
      const batch = pendingCountIncrements;
      pendingCountIncrements = 0;
      const stored = await storage.getItem(TRANSLATION_COUNT_KEY);
      const next = normalizeTranslationCount(stored) + batch;
      config.count = Math.max(normalizeTranslationCount(config.count), next);
      await storage.setItem(TRANSLATION_COUNT_KEY, next);
    }
  } catch {
    // Persistence is best effort; a storage failure must not turn a successful
    // translation into a failed DOM update.
  } finally {
    persistingCount = false;
    if (pendingCountIncrements > 0) void flushTranslationCount();
  }
}

/** Unified non-streaming translation entry point. */
export async function translateText(
  origin: string,
  context: string = typeof document === 'undefined' ? '' : buildPageContext(),
  options: TranslateOptions = {},
): Promise<string> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = 45000,
    useCache = config.useCache,
    bypassCacheRead = false,
    cacheKey = origin,
    isListSlot = false,
  } = options;
  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.floor(Number(maxRetries)))
    : 0;
  const retryInterval = Number.isFinite(Number(retryDelay)) ? Math.max(0, Number(retryDelay)) : 0;

  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) return origin;

  const shouldDedupe = useCache && !bypassCacheRead;
  const inFlightKey = shouldDedupe ? buildInFlightKey(cacheKey) : '';
  if (shouldDedupe) {
    const existing = inFlightTranslations.get(inFlightKey);
    if (existing) return existing;
  }

  if (shouldDedupe) {
    const cachedResult = await cache.localGet(cacheKey);
    if (cachedResult) return cachedResult;

    const existingAfterCache = inFlightTranslations.get(inFlightKey);
    if (existingAfterCache) return existingAfterCache;
  }

  if (config.enablePageSummary && servicesType.isUseModel(config.service)) {
    warmUpPageSummary();
  }

  const chunks = splitIntoTranslationChunks(origin);

  const taskPromise = enqueueTranslation(async (signal) => {
    throwIfAborted(signal);

    const attempt = async (chunkOrigin: string, retryCount: number): Promise<string> => {
      throwIfAborted(signal);
      try {
        const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
        const result = await requestViaPort(
          { context, origin: chunkOrigin, pageSummary },
          signal,
          timeout,
          {
            timeout: '翻译请求超时',
            disconnect: '翻译连接意外断开',
            failure: '翻译失败',
            invalid: '翻译返回了无效的响应格式',
          },
        );
        if (!result) return '';
        assertTranslationComplete(chunkOrigin, result);
        return result;
      } catch (error) {
        if (isCancelled(signal, error)) throw error;
        if (retryCount >= retryLimit) throw error;
        if (isDev) {
          console.log(`[翻译API] 翻译失败，${retryCount + 1}/${retryLimit} 次重试，原因:`, error);
        }
        await wait(retryInterval, signal);
        return attempt(chunkOrigin, retryCount + 1);
      }
    };

    let combined = '';
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;
      const rawChunkResult = await attempt(chunk, 0);
      const chunkResult =
        i === 0 ? stripSpuriousListMarker(origin, rawChunkResult, isListSlot, false) : rawChunkResult;
      if (chunkResult) {
        combined = appendTranslatedChunk(combined, chunkResult);
      }
    }

    if (!combined || combined === origin) return '';
    assertTranslationComplete(origin, combined);

    if (useCache) void cache.localSet(cacheKey, combined);
    return combined;
  });

  if (!shouldDedupe) return taskPromise;

  const trackedPromise = taskPromise.finally(() => {
    if (inFlightTranslations.get(inFlightKey) === trackedPromise) {
      inFlightTranslations.delete(inFlightKey);
    }
  });
  inFlightTranslations.set(inFlightKey, trackedPromise);
  return trackedPromise;
}

/** Cancel queued requests and abort active transports. */
export function cancelAllTranslations(): void {
  if (isDev) console.log('[翻译API] 取消所有等待中的翻译任务');
  inFlightTranslations.clear();
  inFlightStreamTranslations.clear();
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
  /** Optional cache namespace when the request format changes without changing its text. */
  cacheKey?: string;
  /** Whether this unit corresponds to a list/definition/table slot. */
  isListSlot?: boolean;
}

export interface BatchTranslationRequestItem {
  id: number;
  origin: string;
  cacheKey: string;
  isListSlot?: boolean;
  allowIdentity?: boolean;
  onChunk?: (accumulated: string) => void;
}

const SOURCE_BULLET_PREFIX_RE = /^[-*•·▪▫◦‣⁃]\s+/;
const SOURCE_ORDINAL_PREFIX_RE = /^(?:[1-9]\d?[.)、]\s+|（[1-9]\d?）\s*|\([1-9]\d?\)\s+|[a-zA-Z][.)]\s+)/;
const SPURIOUS_BULLET_PREFIX_RE = /^[-*•·▪▫◦‣⁃]\s+/;
const SPURIOUS_ORDINAL_PREFIX_RE = /^(?:[1-9]\d?[.)、]\s+|（[1-9]\d?）\s*|\([1-9]\d?\)\s+)/;
const SPURIOUS_SLOT_ECHO_RE =
  /^\[?(?:SEG_\d+|item\s+[\d.]+|sub-item\s+[\d.]+|term|definition)\]?\s*[:：]\s*/i;
const PARTIAL_LIST_MARKER_ONLY_RE =
  /^(?:[-*•·▪▫◦‣⁃]|[1-9]\d?[.)、]?|（\d*）?|\(\d*\)?)$/;

export function stripSpuriousListMarker(
  source: string,
  translated: string,
  isListSlot: boolean,
  isPartialStream = false,
): string {
  if (!isListSlot || !translated) return translated;

  const sourcePlain = source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const sourceHasMarker =
    SOURCE_BULLET_PREFIX_RE.test(sourcePlain) || SOURCE_ORDINAL_PREFIX_RE.test(sourcePlain);
  if (sourceHasMarker) return translated;

  const trimmedStart = translated.trimStart();
  if (!trimmedStart) return '';

  if (isPartialStream && PARTIAL_LIST_MARKER_ONLY_RE.test(trimmedStart.trim())) {
    return '';
  }

  let result = trimmedStart;
  for (let pass = 0; pass < 2; pass++) {
    if (!SPURIOUS_SLOT_ECHO_RE.test(sourcePlain)) {
      const afterEcho = result.replace(SPURIOUS_SLOT_ECHO_RE, '');
      if (afterEcho !== result) {
        result = afterEcho.trimStart();
      }
    }
    const afterBullet = result.replace(SPURIOUS_BULLET_PREFIX_RE, '');
    if (afterBullet !== result) {
      result = afterBullet.trimStart();
      continue;
    }
    const afterOrdinal = result.replace(SPURIOUS_ORDINAL_PREFIX_RE, '');
    if (afterOrdinal !== result) {
      result = afterOrdinal.trimStart();
    }
  }

  if (isPartialStream && PARTIAL_LIST_MARKER_ONLY_RE.test(result.trim())) {
    return '';
  }
  return result;
}

const BATCH_MARKER_RE = /(?:\[\[?\s*@?FR_SEG_(\d+)@?\s*\]?\]|@@\s*FR_SEG_(\d+)\s*@@)\s*:?\s*/gi;
const TRAILING_PARTIAL_MARKER_RE =
  /(?:\[\s*\[?\s*@?(?:F(?:R(?:_(?:S(?:E(?:G(?:_(?:\d+@?\s*\]?)?)?)?)?)?)?)?)?|@\s*@?\s*(?:F(?:R(?:_(?:S(?:E(?:G(?:_(?:\d+@?)?)?)?)?)?)?)?)?)$/i;

export function formatBatchPayload(
  items: ReadonlyArray<{ id: number; origin: string }>,
): string {
  return items
    .map((item) => `[[@FR_SEG_${item.id}@]]\n${item.origin.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

export function parseBatchOutput(raw: string, isPartialStream = false): Map<number, string> {
  const text = isPartialStream ? raw.replace(TRAILING_PARTIAL_MARKER_RE, '') : raw;
  const results = new Map<number, string>();
  const matches: Array<{ id: number; start: number; contentStart: number }> = [];

  const regex = new RegExp(BATCH_MARKER_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const id = Number(match[1] ?? match[2]);
    if (Number.isInteger(id)) {
      matches.push({
        id,
        start: match.index,
        contentStart: match.index + match[0].length,
      });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const segmentText = contentPostHandler(text.slice(current.contentStart, nextStart));
    if (segmentText) {
      results.set(current.id, segmentText);
    }
  }

  return results;
}

/** Streaming translation over a cancellable runtime Port. */
export async function translateTextStream(
  origin: string,
  context: string = typeof document === 'undefined' ? '' : buildPageContext(),
  onChunk: (accumulated: string) => void,
  options: TranslateOptions = {},
): Promise<string> {
  const {
    timeout = 60000,
    useCache = config.useCache,
    bypassCacheRead = false,
    cacheKey = origin,
    isListSlot = false,
  } = options;

  if (detectlang(origin.replace(/[\s\u3000]/g, '')) === config.to) return origin;

  const shouldDedupe = useCache && !bypassCacheRead;
  const inFlightKey = shouldDedupe ? buildInFlightKey(cacheKey) : '';
  const attachStreamListener = (entry: InFlightStreamEntry): Promise<string> => {
    entry.listeners.add(onChunk);
    if (entry.latestAccumulated) {
      try {
        onChunk(entry.latestAccumulated);
      } catch {
        // Ignore replay errors from detached callers
      }
    }
    return entry.promise;
  };

  if (shouldDedupe) {
    const existingStream = inFlightStreamTranslations.get(inFlightKey);
    if (existingStream) return attachStreamListener(existingStream);
    const existing = inFlightTranslations.get(inFlightKey);
    if (existing) return existing;
  }

  if (shouldDedupe) {
    const cachedResult = await cache.localGet(cacheKey);
    if (cachedResult) return cachedResult;

    const existingStreamAfterCache = inFlightStreamTranslations.get(inFlightKey);
    if (existingStreamAfterCache) return attachStreamListener(existingStreamAfterCache);
    const existingAfterCache = inFlightTranslations.get(inFlightKey);
    if (existingAfterCache) return existingAfterCache;
  }

  if (config.enablePageSummary && servicesType.isUseModel(config.service)) {
    warmUpPageSummary();
  }

  const chunks = splitIntoTranslationChunks(origin);
  const listeners = new Set<(accumulated: string) => void>([onChunk]);
  const streamEntry: InFlightStreamEntry = {
    promise: Promise.resolve(''),
    listeners,
    latestAccumulated: '',
  };

  const taskPromise = enqueueTranslation(async (signal) => {
    throwIfAborted(signal);
    const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;
    let combined = '';

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;
      throwIfAborted(signal);
      const prefix = combined;
      const isFirstChunk = i === 0;
      const rawChunkResult = await requestViaPort(
        { context, origin: chunk, pageSummary },
        signal,
        timeout,
        {
          timeout: '流式翻译请求超时',
          disconnect: '流式翻译连接意外断开',
          failure: '流式翻译失败',
          invalid: '流式翻译返回了无效的响应格式',
        },
        (chunkAccumulated) => {
          const sanitizedChunk = isFirstChunk
            ? stripSpuriousListMarker(origin, chunkAccumulated, isListSlot, true)
            : chunkAccumulated;
          if (!sanitizedChunk) return;
          const nextAccumulated = prefix
            ? appendTranslatedChunk(prefix, sanitizedChunk)
            : sanitizedChunk;
          streamEntry.latestAccumulated = nextAccumulated;
          for (const listener of streamEntry.listeners) {
            try {
              listener(nextAccumulated);
            } catch {
              // Isolate listener errors from other subscribers sharing this stream
            }
          }
        },
      );
      const chunkResult = isFirstChunk
        ? stripSpuriousListMarker(origin, rawChunkResult, isListSlot, false)
        : rawChunkResult;
      if (chunkResult) {
        assertTranslationComplete(chunk, chunkResult);
        combined = appendTranslatedChunk(combined, chunkResult);
      }
    }

    if (!combined) return '';
    assertTranslationComplete(origin, combined);
    if (useCache) void cache.localSet(cacheKey, combined);
    return combined;
  });

  if (!shouldDedupe) return taskPromise;

  const trackedPromise = taskPromise.finally(() => {
    if (inFlightStreamTranslations.get(inFlightKey) === streamEntry) {
      inFlightStreamTranslations.delete(inFlightKey);
    }
    if (inFlightTranslations.get(inFlightKey) === trackedPromise) {
      inFlightTranslations.delete(inFlightKey);
    }
  });
  streamEntry.promise = trackedPromise;
  inFlightStreamTranslations.set(inFlightKey, streamEntry);
  inFlightTranslations.set(inFlightKey, trackedPromise);
  return trackedPromise;
}

/** Translate multiple uncached page segments in a single LLM request and cache each result individually. */
export async function translateBatch(
  items: BatchTranslationRequestItem[],
  context: string = typeof document === 'undefined' ? '' : buildPageContext(undefined, { includePreceding: false }),
  options: TranslateOptions = {},
): Promise<Map<number, string>> {
  if (items.length === 0) return new Map();

  const useStream = config.useStream && servicesType.isCustom(config.service);
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = useStream ? 60000 : 45000,
    useCache = config.useCache,
  } = options;
  const retryLimit = Number.isFinite(Number(maxRetries))
    ? Math.max(0, Math.floor(Number(maxRetries)))
    : 0;
  const retryInterval = Number.isFinite(Number(retryDelay)) ? Math.max(0, Number(retryDelay)) : 0;

  if (config.enablePageSummary && servicesType.isUseModel(config.service)) {
    warmUpPageSummary();
  }

  const batchOrigin = formatBatchPayload(items);

  return enqueueTranslation(async (signal) => {
    throwIfAborted(signal);
    const pageSummary = config.enablePageSummary ? getCurrentPageSummary() : undefined;

    let rawResult = '';
    if (useStream) {
      const lastEmitted = new Map<number, string>();
      rawResult = await requestViaPort(
        { context, origin: batchOrigin, pageSummary },
        signal,
        timeout,
        {
          timeout: '流式翻译请求超时',
          disconnect: '流式翻译连接意外断开',
          failure: '流式翻译失败',
          invalid: '流式翻译返回了无效的响应格式',
        },
        (accumulated) => {
          const partialMap = parseBatchOutput(accumulated, true);
          for (const item of items) {
            if (!item.onChunk) continue;
            const rawSegText = partialMap.get(item.id);
            if (!rawSegText) continue;
            const segText = stripSpuriousListMarker(
              item.origin,
              rawSegText,
              Boolean(item.isListSlot),
              true,
            );
            if (segText && segText !== lastEmitted.get(item.id)) {
              lastEmitted.set(item.id, segText);
              try {
                item.onChunk(segText);
              } catch {
                // Isolate per-element stream preview error
              }
            }
          }
        },
      );
    } else {
      const attempt = async (retryCount: number): Promise<string> => {
        throwIfAborted(signal);
        try {
          return await requestViaPort(
            { context, origin: batchOrigin, pageSummary },
            signal,
            timeout,
            {
              timeout: '翻译请求超时',
              disconnect: '翻译连接意外断开',
              failure: '翻译失败',
              invalid: '翻译返回了无效的响应格式',
            },
          );
        } catch (error) {
          if (isCancelled(signal, error)) throw error;
          if (retryCount >= retryLimit) throw error;
          if (isDev) {
            console.log(`[翻译API] 批量翻译失败，${retryCount + 1}/${retryLimit} 次重试，原因:`, error);
          }
          await wait(retryInterval, signal);
          return attempt(retryCount + 1);
        }
      };
      rawResult = await attempt(0);
    }

    if (!rawResult) return new Map();

    const finalMap = parseBatchOutput(rawResult, false);
    const validatedMap = new Map<number, string>();
    const hasMissingSegments = finalMap.size < items.length;

    for (const item of items) {
      const rawSegText = finalMap.get(item.id);
      if (!rawSegText) continue;
      const segText = stripSpuriousListMarker(
        item.origin,
        rawSegText,
        Boolean(item.isListSlot),
        false,
      );
      if (!segText) continue;

      if (
        hasMissingSegments &&
        plainTextLength(segText) > Math.max(240, plainTextLength(item.origin) * 3.5) &&
        segText.includes('\n')
      ) {
        continue;
      }

      const normalizedItemOrigin = item.origin.replace(/\s+/g, ' ').trim();
      if (segText === item.origin || segText === normalizedItemOrigin) {
        if (item.allowIdentity && !hasMissingSegments && plainTextLength(item.origin) <= 30) {
          validatedMap.set(item.id, segText);
        }
        continue;
      }
      if (isTranslationTruncated(item.origin, segText)) continue;

      if (useCache) void cache.localSet(item.cacheKey, segText);
      validatedMap.set(item.id, segText);
    }

    return validatedMap;
  }, items.length);
}
