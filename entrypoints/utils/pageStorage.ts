/**
 * Storage scoped to the current page.
 *
 * Some documents (for example sandboxed GitHub Raw responses) intentionally
 * deny access to window.localStorage. Content scripts still run on those
 * documents, so use a per-content-script in-memory fallback instead of
 * allowing the storage access to crash the script.
 */
const memoryStorage = new Map<string, string>();

function getNativeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPageStorageItem(key: string): string | null {
  const storage = getNativeStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      // Fall through to the in-memory cache.
    }
  }
  return memoryStorage.get(key) ?? null;
}

export function setPageStorageItem(key: string, value: string): void {
  const storage = getNativeStorage();
  if (storage) {
    try {
      storage.setItem(key, value);
      return;
    } catch {
      // Fall through to the in-memory cache.
    }
  }
  memoryStorage.set(key, value);
}

export function removePageStorageItem(key: string): void {
  const storage = getNativeStorage();
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {
      // The in-memory fallback may still hold a value from an earlier failure.
    }
  }
  memoryStorage.delete(key);
}

export function getPageStorageKeys(): string[] {
  const keys = new Set(memoryStorage.keys());
  const storage = getNativeStorage();
  if (!storage) return [...keys];

  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key) keys.add(key);
    }
  } catch {
    // Return the keys available in the in-memory fallback.
  }
  return [...keys];
}
