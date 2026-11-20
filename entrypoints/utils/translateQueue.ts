/**
 * Bounded translation queue with explicit cancellation.
 *
 * Queued promises used to be discarded by `clearTranslationQueue`, leaving
 * every caller awaiting forever. Active requests also had no signal, so a
 * restore could be followed by a late DOM write. Each task now owns an
 * AbortController; clearing the queue rejects both pending and active callers
 * and lets the API layer stop its timers/ports.
 */

import { config } from './config';
import { servicesType } from './option';

export class TranslationCancelledError extends Error {
  constructor(message = '翻译已取消') {
    super(message);
    this.name = 'TranslationCancelledError';
  }
}

type TranslationTask<T> = (signal: AbortSignal) => Promise<T>;

interface QueueEntry<T> {
  execute: TranslationTask<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController;
  settled: boolean;
  weight: number;
}

const PREFIX_WARMUP_MAX_WAIT_MS = 1500;
const PREFIX_CACHE_IDLE_RESET_MS = 3 * 60 * 1000;

const pendingTranslations: Array<QueueEntry<unknown>> = [];
const activeTranslations = new Set<QueueEntry<unknown>>();
let prefixCacheWarm = false;
let prefixWarmupInFlight = false;
let prefixWarmupTimer: ReturnType<typeof setTimeout> | undefined;
let lastQueueActivityAt = 0;

function getMaxConcurrentTranslations(): number {
  const configured = Number(config.maxConcurrentTranslations);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : 6;
}

function getEffectiveMaxConcurrent(): number {
  const maxConcurrent = getMaxConcurrentTranslations();
  if (!servicesType.isUseModel(config.service) || maxConcurrent <= 1) {
    return maxConcurrent;
  }
  if (
    activeTranslations.size === 0 &&
    lastQueueActivityAt > 0 &&
    Date.now() - lastQueueActivityAt > PREFIX_CACHE_IDLE_RESET_MS
  ) {
    prefixCacheWarm = false;
  }
  return prefixCacheWarm ? maxConcurrent : 1;
}

/** Mark the API prompt prefix cache as warmed so remaining queued requests fan out concurrently. */
export function markPrefixCacheWarm(): void {
  if (prefixWarmupTimer) {
    clearTimeout(prefixWarmupTimer);
    prefixWarmupTimer = undefined;
  }
  prefixWarmupInFlight = false;
  if (!prefixCacheWarm) {
    prefixCacheWarm = true;
    processQueue();
  }
}

/** Reset prefix cache warmup state (e.g. when cancelling or restoring a page). */
export function resetPrefixCacheWarm(): void {
  if (prefixWarmupTimer) {
    clearTimeout(prefixWarmupTimer);
    prefixWarmupTimer = undefined;
  }
  prefixCacheWarm = false;
  prefixWarmupInFlight = false;
}

function settle<T>(entry: QueueEntry<T>, error?: unknown, value?: T): void {
  if (entry.settled) return;
  entry.settled = true;
  if (error !== undefined) entry.reject(error);
  else entry.resolve(value as T);
}

function runEntry<T>(entry: QueueEntry<T>): void {
  activeTranslations.add(entry as QueueEntry<unknown>);
  lastQueueActivityAt = Date.now();

  if (servicesType.isUseModel(config.service) && !prefixCacheWarm && !prefixWarmupInFlight) {
    prefixWarmupInFlight = true;
    prefixWarmupTimer = setTimeout(() => {
      markPrefixCacheWarm();
    }, PREFIX_WARMUP_MAX_WAIT_MS);
  }

  Promise.resolve()
    .then(() => {
      if (entry.controller.signal.aborted) {
        throw entry.controller.signal.reason instanceof Error
          ? entry.controller.signal.reason
          : new TranslationCancelledError();
      }
      return entry.execute(entry.controller.signal);
    })
    .then((value) => settle(entry, undefined, value))
    .catch((error) => settle(entry, error))
    .finally(() => {
      activeTranslations.delete(entry as QueueEntry<unknown>);
      lastQueueActivityAt = Date.now();
      if (!entry.controller.signal.aborted) {
        markPrefixCacheWarm();
      }
      processQueue();
    });
}

function processQueue(): void {
  while (pendingTranslations.length > 0 && activeTranslations.size < getEffectiveMaxConcurrent()) {
    const next = pendingTranslations.shift();
    if (!next || next.settled) continue;
    runEntry(next);
  }
}

/** Add a task to the bounded queue. */
export function enqueueTranslation<T>(translationTask: TranslationTask<T>, weight = 1): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const normalizedWeight = Number.isFinite(weight) ? Math.max(1, Math.floor(weight)) : 1;
    const entry: QueueEntry<T> = {
      execute: translationTask,
      resolve,
      reject,
      controller: new AbortController(),
      settled: false,
      weight: normalizedWeight,
    };

    if (activeTranslations.size < getEffectiveMaxConcurrent()) runEntry(entry);
    else pendingTranslations.push(entry as QueueEntry<unknown>);
  });
}

/**
 * Cancel all queued and active tasks. Active task bookkeeping remains until
 * their promise finally settles, preventing a new request from exceeding the
 * concurrency cap while an underlying transport is still unwinding.
 */
export function clearTranslationQueue(reason = new TranslationCancelledError()): void {
  resetPrefixCacheWarm();

  while (pendingTranslations.length > 0) {
    const entry = pendingTranslations.shift();
    if (entry) {
      entry.controller.abort(reason);
      settle(entry, reason);
    }
  }

  activeTranslations.forEach((entry) => {
    entry.controller.abort(reason);
    settle(entry, reason);
  });
}

export function getQueueStatus() {
  const maxConcurrent = getMaxConcurrentTranslations();
  let activeParagraphs = 0;
  activeTranslations.forEach((entry) => {
    activeParagraphs += entry.weight;
  });
  let pendingParagraphs = 0;
  for (const entry of pendingTranslations) {
    pendingParagraphs += entry.weight;
  }
  return {
    activeTranslations: activeParagraphs,
    pendingTranslations: pendingParagraphs,
    maxConcurrent,
    isQueueFull: activeTranslations.size >= maxConcurrent,
    totalTasksInProcess: activeParagraphs + pendingParagraphs,
  };
}

export function canAcceptMoreTasks(): boolean {
  return pendingTranslations.length < getMaxConcurrentTranslations() * 3;
}
