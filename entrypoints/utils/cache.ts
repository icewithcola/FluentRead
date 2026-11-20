import { customModelString, defaultOption, servicesType } from './option';
import { config } from '@/entrypoints/utils/config';
import { cleanSummaryCache } from '@/entrypoints/utils/pageSummary';
import {
  getPageStorageKeys,
  removePageStorageItem,
} from '@/entrypoints/utils/pageStorage';
import {
  TRANSLATION_CACHE_MESSAGE_TYPE,
  TRANSLATION_CACHE_TTL_MS,
  hashCacheKey,
  utf16Bytes,
  type TranslationCacheAction,
  type TranslationCacheGetResponse,
  type TranslationCacheRequest,
} from '@/entrypoints/utils/translationLruCache';
import browser from 'webextension-polyfill';

const prefix = 'flcache_'; // fluent read cache
const LAST_SESSION_TIMESTAMP_KEY = 'flLastSessionTimestamp';
const SESSION_VALUE_LIMIT = 8 * 1024 * 1024;

interface SessionEntry {
  value: string;
  lastAccessed: number;
  valueBytes: number;
}

const sessionEntries = new Map<string, SessionEntry>();
let sessionValueBytes = 0;
const inFlightGets = new Map<string, Promise<string | null>>();

function buildKey(message: string) {
  const { service, model, to, customModel, system_role, user_role } = config;
  const selectedModel =
    model[service] === customModelString ? customModel[service] : model[service];
  const normalizedMessage = message.replace(/\s+/g, ' ').trim();
  const parts = [prefix, service, selectedModel, to];
  if (servicesType.isCustom(service)) {
    const systemPrompt = system_role?.[service] || defaultOption.system_role;
    const userPrompt = user_role?.[service] || defaultOption.user_role;
    parts.push(systemPrompt, userPrompt);
  }
  parts.push(normalizedMessage);
  return parts.join('_');
}

function sessionGet(hash: string): string | null {
  const entry = sessionEntries.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.lastAccessed > TRANSLATION_CACHE_TTL_MS) {
    sessionEntries.delete(hash);
    sessionValueBytes = Math.max(0, sessionValueBytes - entry.valueBytes);
    return null;
  }
  sessionEntries.delete(hash);
  sessionEntries.set(hash, { ...entry, lastAccessed: Date.now() });
  return entry.value;
}

function sessionSet(hash: string, value: string): void {
  const existing = sessionEntries.get(hash);
  if (existing) {
    sessionEntries.delete(hash);
    sessionValueBytes = Math.max(0, sessionValueBytes - existing.valueBytes);
  }
  const valueBytes = utf16Bytes(value);
  sessionEntries.set(hash, { value, lastAccessed: Date.now(), valueBytes });
  sessionValueBytes += valueBytes;
  while (sessionValueBytes > SESSION_VALUE_LIMIT && sessionEntries.size > 0) {
    const oldestKey = sessionEntries.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    const oldest = sessionEntries.get(oldestKey);
    sessionEntries.delete(oldestKey);
    if (oldest) sessionValueBytes = Math.max(0, sessionValueBytes - oldest.valueBytes);
  }
}

function sessionClear(): void {
  sessionEntries.clear();
  sessionValueBytes = 0;
}

function purgeLegacyPageCache(): void {
  for (const key of getPageStorageKeys()) {
    if (key && (key.startsWith(prefix) || key === LAST_SESSION_TIMESTAMP_KEY)) {
      removePageStorageItem(key);
    }
  }
}

async function hashOrigin(origin: string): Promise<string | null> {
  try {
    return await hashCacheKey(buildKey(origin));
  } catch {
    return null;
  }
}

async function sendCacheMessage(
  action: TranslationCacheAction,
  payload: Omit<TranslationCacheRequest, 'type' | 'action'> = {},
): Promise<unknown> {
  try {
    return await browser.runtime.sendMessage({
      type: TRANSLATION_CACHE_MESSAGE_TYPE,
      action,
      ...payload,
    } satisfies TranslationCacheRequest);
  } catch {
    return null;
  }
}

function readCachedValue(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const value = (response as TranslationCacheGetResponse).value;
  return typeof value === 'string' && value.trim() ? value : null;
}

async function persistGet(hash: string): Promise<string | null> {
  const pending = inFlightGets.get(hash);
  if (pending) return pending;
  const request = sendCacheMessage('get', { hash })
    .then(readCachedValue)
    .finally(() => {
      inFlightGets.delete(hash);
    });
  inFlightGets.set(hash, request);
  return request;
}

export const cache = {
  // 存入缓存并设置过期时间
  set(set: Set<any>, key: any, expire: number) {
    // 如果禁用缓存，则不执行任何操作
    if (!config.useCache) return;

    set.add(key);
    if (expire >= 0) {
      setTimeout(() => set.delete(key), expire);
    }
  },

  // local 系列为特化的缓存方法，用于操作翻译缓存
  async localSet(key: string, value: string): Promise<void> {
    // 如果禁用缓存，则不执行任何操作
    if (!config.useCache) return;

    // 确保 key 和 value 是非空字符串，且不包含 [object Object] 错误指示
    if (typeof key !== 'string' || typeof value !== 'string') return;
    if (!key.trim() || !value.trim()) return;
    if (key.includes('[object Object]') || value.includes('[object Object]')) return;

    const hash = await hashOrigin(key);
    if (!hash) return;
    sessionSet(hash, value);
    await sendCacheMessage('set', { hash, value });
  },

  async localGet(origin: string): Promise<string | null> {
    // 如果禁用缓存，则始终返回 null
    if (!config.useCache) return null;
    if (typeof origin !== 'string' || !origin.trim()) return null;

    const hash = await hashOrigin(origin);
    if (!hash) return null;

    const remembered = sessionGet(hash);
    if (remembered !== null) {
      void sendCacheMessage('touch', { hash });
      return remembered;
    }

    const persisted = await persistGet(hash);
    if (persisted) sessionSet(hash, persisted);
    return persisted;
  },

  async localRemove(origin: string): Promise<void> {
    const hash = await hashOrigin(origin);
    if (!hash) return;
    const remembered = sessionEntries.get(hash);
    if (remembered) {
      sessionEntries.delete(hash);
      sessionValueBytes = Math.max(0, sessionValueBytes - remembered.valueBytes);
    }
    await sendCacheMessage('remove', { hash });
  },

  // 打开页面时清理过期项，并丢掉旧版 localStorage 翻译缓存
  cleaner() {
    purgeLegacyPageCache();
    void sendCacheMessage('evict');
  },

  // 清除翻译缓存（持久 LRU、会话缓存、摘要缓存）
  async clean(): Promise<void> {
    sessionClear();
    purgeLegacyPageCache();
    cleanSummaryCache();
    await sendCacheMessage('clear');
  },
};

// 用于节点序列化
export function stringifyNode(node: any): string {
  const serializer = new XMLSerializer();
  let outerHTML = serializer.serializeToString(node);
  // 移除多余的空白符
  return outerHTML.replace(/\s{2,}/g, ' ').trim();
}
