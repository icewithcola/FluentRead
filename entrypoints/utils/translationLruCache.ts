/**
 * Persistent translation LRU stored in the extension origin (IndexedDB).
 *
 * Budget:
 * - 128MB total (values + reserved metadata)
 * - 100MB translation payloads
 * - 28MB metadata / indexes / other overhead
 * - 1 month validity from last access
 *
 * When the payload exceeds 100MB (or metadata / total exceeds its budget),
 * drop entries unused for 1 month, then the oldest remaining entries.
 */

export const TRANSLATION_CACHE_MESSAGE_TYPE = 'translation-cache';

export const TRANSLATION_CACHE_TOTAL_BYTES = 128 * 1024 * 1024;
export const TRANSLATION_CACHE_VALUE_BYTES = 100 * 1024 * 1024;
export const TRANSLATION_CACHE_META_BYTES = 28 * 1024 * 1024;
export const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DB_NAME = 'fluentread-translation-lru';
const DB_VERSION = 1;
const META_STORE = 'meta';
const VALUE_STORE = 'values';
const STATS_STORE = 'stats';
const STATS_KEY = 'totals';

export type TranslationCacheAction = 'get' | 'set' | 'touch' | 'remove' | 'clear' | 'evict';

export interface TranslationCacheRequest {
  type: typeof TRANSLATION_CACHE_MESSAGE_TYPE;
  action: TranslationCacheAction;
  hash?: string;
  value?: string;
}

export interface TranslationCacheGetResponse {
  value: string | null;
}

export interface TranslationCacheOkResponse {
  ok: true;
}

export interface EvictionCandidate {
  hash: string;
  lastAccessed: number;
  valueBytes: number;
  metaBytes: number;
}

interface MetaEntry extends EvictionCandidate {
  created: number;
}

interface CacheStats {
  valueBytes: number;
  metaBytes: number;
  count: number;
}

interface MemoryRecord extends MetaEntry {
  value: string;
}

const emptyStats = (): CacheStats => ({ valueBytes: 0, metaBytes: 0, count: 0 });

export function utf16Bytes(value: string): number {
  return value.length * 2;
}

/** Conservative per-entry overhead for the hash, numeric fields, and IDB indexes. */
export function estimateMetaBytes(hash: string): number {
  return utf16Bytes(hash) + 192;
}

export async function hashCacheKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function selectEntriesToEvict(
  entries: EvictionCandidate[],
  now: number,
  limits: {
    valueBytes?: number;
    metaBytes?: number;
    totalBytes?: number;
    ttlMs?: number;
  } = {},
): string[] {
  const valueLimit = limits.valueBytes ?? TRANSLATION_CACHE_VALUE_BYTES;
  const metaLimit = limits.metaBytes ?? TRANSLATION_CACHE_META_BYTES;
  const totalLimit = limits.totalBytes ?? TRANSLATION_CACHE_TOTAL_BYTES;
  const ttlMs = limits.ttlMs ?? TRANSLATION_CACHE_TTL_MS;
  const cutoff = now - ttlMs;

  const ordered = [...entries].sort((a, b) => a.lastAccessed - b.lastAccessed || a.hash.localeCompare(b.hash));
  const toDelete: string[] = [];
  const valid: EvictionCandidate[] = [];
  let valueBytes = 0;
  let metaBytes = 0;

  for (const entry of ordered) {
    if (entry.lastAccessed < cutoff) {
      toDelete.push(entry.hash);
      continue;
    }
    valid.push(entry);
    valueBytes += entry.valueBytes;
    metaBytes += entry.metaBytes;
  }

  const overLimit = () =>
    valueBytes > valueLimit || metaBytes > metaLimit || valueBytes + metaBytes > totalLimit;

  for (const entry of valid) {
    if (!overLimit()) break;
    toDelete.push(entry.hash);
    valueBytes -= entry.valueBytes;
    metaBytes -= entry.metaBytes;
  }

  return toDelete;
}

const memoryRecords = new Map<string, MemoryRecord>();
let dbPromise: Promise<IDBDatabase> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = writeChain.then(work, work);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        const meta = db.createObjectStore(META_STORE, { keyPath: 'hash' });
        meta.createIndex('lastAccessed', 'lastAccessed');
      }
      if (!db.objectStoreNames.contains(VALUE_STORE)) {
        db.createObjectStore(VALUE_STORE, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(STATS_STORE)) {
        db.createObjectStore(STATS_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open translation cache'));
    };
  });
  return dbPromise;
}

async function getDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return null;
  try {
    return await openDb();
  } catch {
    dbPromise = null;
    return null;
  }
}

function clampStats(stats: CacheStats): CacheStats {
  return {
    valueBytes: Math.max(0, stats.valueBytes),
    metaBytes: Math.max(0, stats.metaBytes),
    count: Math.max(0, stats.count),
  };
}

function parseStats(stored: unknown): CacheStats {
  if (!stored || typeof stored !== 'object') return emptyStats();
  const stats = stored as CacheStats;
  if (
    !Number.isFinite(stats.valueBytes) ||
    !Number.isFinite(stats.metaBytes) ||
    !Number.isFinite(stats.count)
  ) {
    return emptyStats();
  }
  return clampStats(stats);
}

function subtractEntry(stats: CacheStats, entry: Pick<MetaEntry, 'valueBytes' | 'metaBytes'>): CacheStats {
  return clampStats({
    valueBytes: stats.valueBytes - entry.valueBytes,
    metaBytes: stats.metaBytes - entry.metaBytes,
    count: stats.count - 1,
  });
}

function addEntry(stats: CacheStats, entry: Pick<MetaEntry, 'valueBytes' | 'metaBytes'>): CacheStats {
  return {
    valueBytes: stats.valueBytes + entry.valueBytes,
    metaBytes: stats.metaBytes + entry.metaBytes,
    count: stats.count + 1,
  };
}

function overBudget(stats: CacheStats): boolean {
  return (
    stats.valueBytes > TRANSLATION_CACHE_VALUE_BYTES ||
    stats.metaBytes > TRANSLATION_CACHE_META_BYTES ||
    stats.valueBytes + stats.metaBytes > TRANSLATION_CACHE_TOTAL_BYTES
  );
}

function memoryEvict(now = Date.now(), skipHash?: string): void {
  const victims = new Set(
    selectEntriesToEvict(
      [...memoryRecords.values()].filter((entry) => entry.hash !== skipHash),
      now,
    ),
  );
  for (const hash of victims) memoryRecords.delete(hash);
}

function memoryGet(hash: string, touch: boolean): string | null {
  const record = memoryRecords.get(hash);
  if (!record) return null;
  const now = Date.now();
  if (now - record.lastAccessed > TRANSLATION_CACHE_TTL_MS) {
    memoryRecords.delete(hash);
    return null;
  }
  if (touch) {
    memoryRecords.delete(hash);
    memoryRecords.set(hash, { ...record, lastAccessed: now });
  }
  return record.value;
}

function memorySet(hash: string, value: string): void {
  const now = Date.now();
  const next: MemoryRecord = {
    hash,
    value,
    lastAccessed: now,
    created: memoryRecords.get(hash)?.created ?? now,
    valueBytes: utf16Bytes(value),
    metaBytes: estimateMetaBytes(hash),
  };
  if (next.valueBytes > TRANSLATION_CACHE_VALUE_BYTES) return;
  memoryRecords.set(hash, next);
  memoryEvict(now, hash);
}

function evictFromStores(
  metaStore: IDBObjectStore,
  valueStore: IDBObjectStore,
  stats: CacheStats,
  skipHash: string | undefined,
  onDone: (next: CacheStats) => void,
  onError: (error: unknown) => void,
): void {
  const cutoff = Date.now() - TRANSLATION_CACHE_TTL_MS;
  let next = { ...stats };
  const request = metaStore.index('lastAccessed').openCursor();
  request.onerror = () => onError(request.error);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      onDone(clampStats(next));
      return;
    }
    const entry = cursor.value as MetaEntry;
    const expired = entry.lastAccessed < cutoff;
    const overflow = overBudget(next);
    if ((expired || overflow) && entry.hash !== skipHash) {
      cursor.delete();
      valueStore.delete(entry.hash);
      next = subtractEntry(next, entry);
      cursor.continue();
      return;
    }
    if (!expired && !overflow) {
      onDone(clampStats(next));
      return;
    }
    cursor.continue();
  };
}

async function idbReadEntry(
  db: IDBDatabase,
  hash: string,
): Promise<{ meta?: MetaEntry; value?: string }> {
  const tx = db.transaction([META_STORE, VALUE_STORE], 'readonly');
  const metaReq = tx.objectStore(META_STORE).get(hash);
  const valueReq = tx.objectStore(VALUE_STORE).get(hash);
  const [meta, stored] = await Promise.all([
    requestToPromise(metaReq) as Promise<MetaEntry | undefined>,
    requestToPromise(valueReq) as Promise<{ hash: string; value: string } | undefined>,
  ]);
  await transactionDone(tx);
  return { meta, value: typeof stored?.value === 'string' ? stored.value : undefined };
}

function settleOnce<T>(
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: unknown) => void,
): { resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let settled = false;
  return {
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    reject: (reason) => {
      if (settled) return;
      settled = true;
      reject(reason);
    },
  };
}

async function idbRemoveEntry(db: IDBDatabase, hash: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = settleOnce(resolve, reject);
    const tx = db.transaction([META_STORE, VALUE_STORE, STATS_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const valueStore = tx.objectStore(VALUE_STORE);
    const statsStore = tx.objectStore(STATS_STORE);
    tx.oncomplete = () => done.resolve();
    tx.onerror = () => done.reject(tx.error);

    const previousReq = metaStore.get(hash);
    const statsReq = statsStore.get(STATS_KEY);
    let pending = 2;
    let previous: MetaEntry | undefined;
    let stats = emptyStats();

    const finish = () => {
      if (--pending > 0) return;
      metaStore.delete(hash);
      valueStore.delete(hash);
      if (previous) statsStore.put(subtractEntry(stats, previous), STATS_KEY);
    };

    previousReq.onerror = () => done.reject(previousReq.error);
    statsReq.onerror = () => done.reject(statsReq.error);
    previousReq.onsuccess = () => {
      previous = previousReq.result as MetaEntry | undefined;
      finish();
    };
    statsReq.onsuccess = () => {
      stats = parseStats(statsReq.result);
      finish();
    };
  });
}

async function idbGet(db: IDBDatabase, hash: string, touch: boolean): Promise<string | null> {
  const { meta, value } = await idbReadEntry(db, hash);
  if (!meta) return null;

  const now = Date.now();
  if (now - meta.lastAccessed > TRANSLATION_CACHE_TTL_MS || value === undefined) {
    await idbRemoveEntry(db, hash);
    return null;
  }

  if (touch) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(META_STORE).put({ ...meta, lastAccessed: now });
    });
  }
  return value;
}

async function idbSet(db: IDBDatabase, hash: string, value: string): Promise<void> {
  const valueBytes = utf16Bytes(value);
  if (valueBytes > TRANSLATION_CACHE_VALUE_BYTES) return;

  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    const done = settleOnce(resolve, reject);
    const tx = db.transaction([META_STORE, VALUE_STORE, STATS_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const valueStore = tx.objectStore(VALUE_STORE);
    const statsStore = tx.objectStore(STATS_STORE);
    tx.oncomplete = () => done.resolve();
    tx.onerror = () => done.reject(tx.error);

    const previousReq = metaStore.get(hash);
    const statsReq = statsStore.get(STATS_KEY);
    let pending = 2;
    let previous: MetaEntry | undefined;
    let stats = emptyStats();

    const continueWrite = () => {
      if (--pending > 0) return;
      const nextMeta: MetaEntry = {
        hash,
        lastAccessed: now,
        created: previous?.created ?? now,
        valueBytes,
        metaBytes: estimateMetaBytes(hash),
      };
      if (previous) stats = subtractEntry(stats, previous);
      stats = addEntry(stats, nextMeta);
      metaStore.put(nextMeta);
      valueStore.put({ hash, value });

      const persist = (next: CacheStats) => {
        statsStore.put(clampStats(next), STATS_KEY);
      };
      if (overBudget(stats)) {
        evictFromStores(metaStore, valueStore, stats, hash, persist, (error) => done.reject(error));
        return;
      }
      persist(stats);
    };

    previousReq.onerror = () => done.reject(previousReq.error);
    statsReq.onerror = () => done.reject(statsReq.error);
    previousReq.onsuccess = () => {
      previous = previousReq.result as MetaEntry | undefined;
      continueWrite();
    };
    statsReq.onsuccess = () => {
      stats = parseStats(statsReq.result);
      continueWrite();
    };
  });
}

async function idbClear(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META_STORE, VALUE_STORE, STATS_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(META_STORE).clear();
    tx.objectStore(VALUE_STORE).clear();
    tx.objectStore(STATS_STORE).put(emptyStats(), STATS_KEY);
  });
}

async function idbEvict(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = settleOnce(resolve, reject);
    const tx = db.transaction([META_STORE, VALUE_STORE, STATS_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const valueStore = tx.objectStore(VALUE_STORE);
    const statsStore = tx.objectStore(STATS_STORE);
    tx.oncomplete = () => done.resolve();
    tx.onerror = () => done.reject(tx.error);

    const statsReq = statsStore.get(STATS_KEY);
    statsReq.onerror = () => done.reject(statsReq.error);
    statsReq.onsuccess = () => {
      evictFromStores(
        metaStore,
        valueStore,
        parseStats(statsReq.result),
        undefined,
        (next) => {
          statsStore.put(next, STATS_KEY);
        },
        (error) => done.reject(error),
      );
    };
  });
}

export async function translationCacheGet(hash: string): Promise<string | null> {
  return enqueueWrite(async () => {
    const db = await getDb();
    if (db) {
      try {
        return await idbGet(db, hash, true);
      } catch {
        dbPromise = null;
      }
    }
    return memoryGet(hash, true);
  });
}

export async function translationCacheTouch(hash: string): Promise<void> {
  await enqueueWrite(async () => {
    const db = await getDb();
    if (db) {
      try {
        await idbGet(db, hash, true);
        return;
      } catch {
        dbPromise = null;
      }
    }
    memoryGet(hash, true);
  });
}

export async function translationCacheSet(hash: string, value: string): Promise<void> {
  if (!hash || typeof value !== 'string' || !value) return;
  await enqueueWrite(async () => {
    const db = await getDb();
    if (db) {
      try {
        await idbSet(db, hash, value);
        return;
      } catch {
        dbPromise = null;
      }
    }
    memorySet(hash, value);
  });
}

export async function translationCacheRemove(hash: string): Promise<void> {
  await enqueueWrite(async () => {
    memoryRecords.delete(hash);
    const db = await getDb();
    if (db) {
      try {
        await idbRemoveEntry(db, hash);
        return;
      } catch {
        dbPromise = null;
      }
    }
  });
}

export async function translationCacheClear(): Promise<void> {
  await enqueueWrite(async () => {
    memoryRecords.clear();
    const db = await getDb();
    if (db) {
      try {
        await idbClear(db);
      } catch {
        dbPromise = null;
      }
    }
  });
}

export async function translationCacheEvict(): Promise<void> {
  await enqueueWrite(async () => {
    memoryEvict();
    const db = await getDb();
    if (db) {
      try {
        await idbEvict(db);
      } catch {
        dbPromise = null;
      }
    }
  });
}

export async function handleTranslationCacheMessage(
  message: TranslationCacheRequest,
): Promise<TranslationCacheGetResponse | TranslationCacheOkResponse> {
  switch (message.action) {
    case 'get':
      return { value: message.hash ? await translationCacheGet(message.hash) : null };
    case 'touch':
      if (message.hash) await translationCacheTouch(message.hash);
      return { ok: true };
    case 'set':
      if (message.hash && typeof message.value === 'string') {
        await translationCacheSet(message.hash, message.value);
      }
      return { ok: true };
    case 'remove':
      if (message.hash) await translationCacheRemove(message.hash);
      return { ok: true };
    case 'clear':
      await translationCacheClear();
      return { ok: true };
    case 'evict':
      await translationCacheEvict();
      return { ok: true };
    default:
      return { ok: true };
  }
}
