import type { DesignDocument } from "@lake/design-model";

export interface DesignDocumentStore {
  list(): DesignDocument[];
  get(id: string): DesignDocument | null;
  upsert(document: DesignDocument): void;
  remove(id: string): void;
  clear(): void;
}

export function createLocalDesignDocumentStore(
  storage: Storage = window.localStorage,
  key = "lanhu-bridge.design-documents.v1"
): DesignDocumentStore {
  function list() {
    try {
      const value = storage.getItem(key);
      if (!value) return [];
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as DesignDocument[] : [];
    } catch {
      return [];
    }
  }

  function write(documents: DesignDocument[]) {
    storage.setItem(key, JSON.stringify(documents));
  }

  return {
    list,
    get: (id) => list().find((document) => document.id === id) ?? null,
    upsert: (document) => write([document, ...list().filter((item) => item.id !== document.id)].slice(0, 20)),
    remove: (id) => write(list().filter((document) => document.id !== id)),
    clear: () => storage.removeItem(key)
  };
}
