import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';
import { afterAll } from 'vitest';
import { ImageProcessor } from './helpers/imageProcessor.ts';
import { IDBFactory } from 'fake-indexeddb';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Node 26 exposes an experimental process-level localStorage that throws unless
// --localstorage-file is provided. Tests run in jsdom, so route unqualified
// localStorage access to jsdom's Storage implementation instead.
if (typeof window !== 'undefined' && window.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
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
