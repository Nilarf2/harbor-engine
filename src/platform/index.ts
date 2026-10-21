export interface PlatformAdapter {
  readonly id: string;
  ready(): void;
  save(key: string, value: unknown): boolean;
  load<T>(key: string, validate: (value: unknown) => value is T): T | undefined;
  dispose(): void;
}
/** Standalone/iframe baseline. Host SDKs implement this interface in the game. */
export function createBrowserPlatform(namespace: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): PlatformAdapter {
  if (!/^[a-zA-Z0-9_.-]+$/.test(namespace)) throw new Error('Invalid save namespace');
  const memory = new Map<string, string>();
  let target = storage;
  if (!target) { try { target = globalThis.localStorage; } catch { /* Sandboxed storage may be unavailable. */ } }
  return {
    id: 'browser',
    ready() {},
    save(key, value) {
      const text = JSON.stringify({ version: 1, data: value });
      memory.set(key, text);
      try { if (!target) return false; target.setItem(`${namespace}:${key}`, text); return true; }
      catch { return false; }
    },
    load<T>(key: string, validate: (value: unknown) => value is T) {
      let text = memory.get(key);
      if (text === undefined) { try { text = target?.getItem(`${namespace}:${key}`) ?? undefined; } catch {} }
      if (!text) return undefined;
      try {
        const envelope = JSON.parse(text);
        if (envelope.version === 1 && validate(envelope.data)) return envelope.data as T;
      } catch {}
      return undefined;
    },
    dispose() { memory.clear(); },
  };
}
export { SaveStore } from './SaveStore.js';
export type { SaveStorage, SaveStoreOptions } from './SaveStore.js';
