/**
 * Bounded, content-derived identities for display renditions.
 *
 * Every byte is read, but only one fixed-size chunk is resident at a time.
 * The identity is a freshness hint at the Pixi texture boundary, not persisted
 * data or a collision-resistant security digest.
 */
export const RENDITION_IDENTITY_CHUNK_BYTES = 64 * 1024;
const MAX_CONCURRENT_RENDITION_IDENTITIES = 1;

interface IdentityTask {
  blob: Blob;
  resolve: (identity: string) => void;
  reject: (error: Error) => void;
}

function fnv1a64(bytes: Uint8Array, value = 0xcbf29ce484222325n): bigint {
  let hash = value;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

async function fullContentIdentity(blob: Blob): Promise<string> {
  const encoder = new TextEncoder();
  let hash = fnv1a64(encoder.encode(`${blob.size}\u0000${blob.type}\u0000`));

  for (let start = 0; start < blob.size; start += RENDITION_IDENTITY_CHUNK_BYTES) {
    const end = Math.min(start + RENDITION_IDENTITY_CHUNK_BYTES, blob.size);
    const chunk = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    hash = fnv1a64(chunk, hash);
  }

  return `rendition-probabilistic-full-fnv1a64-v2:${blob.size}:${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Serializes Blob reads so a large virtualized page cannot start unbounded
 * content reads while its cards are becoming visible.
 */
export class RenditionIdentityAdmission {
  private active = 0;
  private readonly queued: IdentityTask[] = [];
  private readonly identities = new WeakMap<Blob, Promise<string>>();
  private disposed = false;

  identify(blob: Blob): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error("Rendition identity admission is disposed"));
    }
    const existing = this.identities.get(blob);
    if (existing) return existing;

    const identity = new Promise<string>((resolve, reject) => {
      this.queued.push({ blob, resolve, reject });
      this.processQueue();
    });
    this.identities.set(blob, identity);
    void identity.catch(() => {
      if (this.identities.get(blob) === identity) {
        this.identities.delete(blob);
      }
    });
    return identity;
  }

  private processQueue(): void {
    if (this.disposed) return;
    while (this.active < MAX_CONCURRENT_RENDITION_IDENTITIES && this.queued.length > 0) {
      const task = this.queued.shift()!;
      this.active += 1;
      void fullContentIdentity(task.blob).then(task.resolve, (error: unknown) => {
        task.reject(error instanceof Error ? error : new Error("Unable to identify rendition content"));
      }).finally(() => {
        this.active -= 1;
        this.processQueue();
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("Rendition identity admission is disposed");
    while (this.queued.length > 0) {
      this.queued.shift()!.reject(error);
    }
  }
}

export function createRenditionIdentityAdmission(): RenditionIdentityAdmission {
  return new RenditionIdentityAdmission();
}
