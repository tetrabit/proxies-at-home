import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';
import { afterAll } from 'vitest';
import { ImageProcessor } from './helpers/imageProcessor.ts';
import { IDBFactory } from 'fake-indexeddb';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Node 26 exposes an experimental process-level localStorage that throws unless
// --localstorage-file is provided. Tests run in jsdom, so provide a stable
// jsdom-scoped Storage implementation for unqualified localStorage access.
if (typeof window !== 'undefined') {
  const entries = new Map<string, string>();
  const storagePrototype =
    typeof Storage !== 'undefined' ? Storage.prototype : Object.prototype;
  const testLocalStorage = Object.create(storagePrototype) as Storage;

  Object.defineProperties(storagePrototype, {
    getItem: {
      value: (key: string) => entries.get(String(key)) ?? null,
      configurable: true,
    },
    setItem: {
      value: (key: string, value: string) => {
        entries.set(String(key), String(value));
      },
      configurable: true,
    },
    removeItem: {
      value: (key: string) => {
        entries.delete(String(key));
      },
      configurable: true,
    },
    clear: {
      value: () => {
        entries.clear();
      },
      configurable: true,
    },
    key: {
      value: (index: number) => Array.from(entries.keys())[index] ?? null,
      configurable: true,
    },
    length: {
      get: () => entries.size,
      configurable: true,
    },
  });

  Object.defineProperty(globalThis, 'localStorage', {
    value: testLocalStorage,
    configurable: true,
  });
  Object.defineProperty(window, 'localStorage', {
    value: testLocalStorage,
    configurable: true,
  });
}

// JSDOM doesn't implement Blob.arrayBuffer(), so this polyfills it.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const buffer = new Uint8Array(fr.result as ArrayBuffer).buffer;
        resolve(buffer);
      };
      fr.onerror = () => {
        reject(fr.error);
      };
      fr.readAsArrayBuffer(this);
    });
  };
}

afterAll(() => {
  ImageProcessor.destroyAll();
  // eslint-disable-next-line no-global-assign
  indexedDB = new IDBFactory();
});
