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
}

const pendingTranslations: Array<QueueEntry<unknown>> = [];
const activeTranslations = new Set<QueueEntry<unknown>>();

function getMaxConcurrentTranslations(): number {
  const configured = Number(config.maxConcurrentTranslations);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : 6;
}

function settle<T>(entry: QueueEntry<T>, error?: unknown, value?: T): void {
  if (entry.settled) return;
  entry.settled = true;
  if (error !== undefined) entry.reject(error);
  else entry.resolve(value as T);
}

function runEntry<T>(entry: QueueEntry<T>): void {
  activeTranslations.add(entry as QueueEntry<unknown>);

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
      processQueue();
    });
}

function processQueue(): void {
  const maxConcurrent = getMaxConcurrentTranslations();
  while (pendingTranslations.length > 0 && activeTranslations.size < maxConcurrent) {
    const next = pendingTranslations.shift();
    if (!next || next.settled) continue;
    runEntry(next);
  }
}

/** Add a task to the bounded queue. */
export function enqueueTranslation<T>(translationTask: TranslationTask<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry<T> = {
      execute: translationTask,
      resolve,
      reject,
      controller: new AbortController(),
      settled: false,
    };

    if (activeTranslations.size < getMaxConcurrentTranslations()) runEntry(entry);
    else pendingTranslations.push(entry as QueueEntry<unknown>);
  });
}

/**
 * Cancel all queued and active tasks. Active task bookkeeping remains until
 * their promise finally settles, preventing a new request from exceeding the
 * concurrency cap while an underlying transport is still unwinding.
 */
export function clearTranslationQueue(reason = new TranslationCancelledError()): void {
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
  return {
    activeTranslations: activeTranslations.size,
    pendingTranslations: pendingTranslations.length,
    maxConcurrent,
    isQueueFull: activeTranslations.size >= maxConcurrent,
    totalTasksInProcess: activeTranslations.size + pendingTranslations.length,
  };
}

export function canAcceptMoreTasks(): boolean {
  return pendingTranslations.length < getMaxConcurrentTranslations() * 3;
}
