import { loadImage } from "./imageProcessing";
import { toProxied } from "./imageHelper";
import type { MpcHarvestedSourceExample } from "./mpcPreferenceBootstrap";
import type { MpcCalibrationFrozenCandidate } from "@/db";
import type { MpcPreferenceModel } from "./mpcPreferenceModel";

export interface MpcImageDescriptor {
  meanLuma: number;
  variance: number;
  edgeDensity: number;
}

export interface MpcSourceVisualProfile {
  sourceName: string;
  descriptor: MpcImageDescriptor;
  sampleCount: number;
}

// This is module-global so concurrent profile builds share one decoder budget.
const MAX_CONCURRENT_MPC_PROFILE_DECODES = 2;

type ProfileDecodeRelease = () => void;
type ProfileDecodeWaiter = {
  signal?: AbortSignal;
  resolve: (release: ProfileDecodeRelease | null) => void;
  onAbort?: () => void;
};

let activeMpcProfileDecodes = 0;
const mpcProfileDecodeWaiters: ProfileDecodeWaiter[] = [];

function releaseMpcProfileDecodeSlot(): void {
  while (mpcProfileDecodeWaiters.length > 0) {
    const waiter = mpcProfileDecodeWaiters.shift()!;
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.resolve(null);
      continue;
    }
    waiter.resolve(releaseMpcProfileDecodeSlot);
    return;
  }
  activeMpcProfileDecodes -= 1;
}

function acquireMpcProfileDecodeSlot(
  signal?: AbortSignal
): Promise<ProfileDecodeRelease | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (activeMpcProfileDecodes < MAX_CONCURRENT_MPC_PROFILE_DECODES) {
    activeMpcProfileDecodes += 1;
    return Promise.resolve(releaseMpcProfileDecodeSlot);
  }
  return new Promise((resolve) => {
    const waiter: ProfileDecodeWaiter = { signal, resolve };
    if (signal) {
      waiter.onAbort = () => {
        const index = mpcProfileDecodeWaiters.indexOf(waiter);
        if (index !== -1) mpcProfileDecodeWaiters.splice(index, 1);
        resolve(null);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    mpcProfileDecodeWaiters.push(waiter);
  });
}

export async function buildMpcVisualPreferenceScoreMap(
  candidates: Pick<
    MpcCalibrationFrozenCandidate,
    "identifier" | "smallThumbnailUrl" | "mediumThumbnailUrl"
  >[],
  profiles: Record<string, MpcSourceVisualProfile>,
  model: Pick<MpcPreferenceModel, "sourceWeights">,
  signal?: AbortSignal
): Promise<Record<string, number>> {
  const results = await Promise.all(
    candidates.map(async (candidate): Promise<[string, number] | null> => {
      const imageUrl =
        candidate.smallThumbnailUrl || candidate.mediumThumbnailUrl;
      if (!imageUrl) return null;

      const descriptor = await extractMpcImageDescriptor(imageUrl, signal);
      if (!descriptor) return null;

      const score = scoreMpcVisualSourcePreference(
        descriptor,
        profiles,
        model.sourceWeights
      );
      return [candidate.identifier, score];
    })
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, number] => entry !== null)
  );
}

function descriptorDistance(a: MpcImageDescriptor, b: MpcImageDescriptor) {
  return (
    Math.abs(a.meanLuma - b.meanLuma) +
    Math.abs(a.variance - b.variance) +
    Math.abs(a.edgeDensity - b.edgeDensity)
  );
}

function createCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

export async function extractMpcImageDescriptor(
  imageUrl: string,
  signal?: AbortSignal
): Promise<MpcImageDescriptor | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await loadImage(
      toProxied(imageUrl),
      signal ? { signal } : undefined,
      1
    );
  } catch {
    return null;
  }
  try {
    const size = 32;
    const canvas = createCanvas(size);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(bitmap, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    const pixels = new Float32Array(size * size);

    for (let i = 0; i < pixels.length; i += 1) {
      const offset = i * 4;
      const r = data[offset] / 255;
      const g = data[offset + 1] / 255;
      const b = data[offset + 2] / 255;
      pixels[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
    const variance =
      pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      pixels.length;

    let edgeSum = 0;
    for (let y = 1; y < size - 1; y += 1) {
      for (let x = 1; x < size - 1; x += 1) {
        const index = y * size + x;
        const dx = pixels[index + 1] - pixels[index - 1];
        const dy = pixels[index + size] - pixels[index - size];
        edgeSum += Math.sqrt(dx * dx + dy * dy);
      }
    }

    return {
      meanLuma: mean,
      variance,
      edgeDensity: edgeSum / ((size - 2) * (size - 2)),
    };
  } finally {
    bitmap.close();
  }
}

export async function buildMpcSourceVisualProfiles(
  examples: MpcHarvestedSourceExample[],
  signal?: AbortSignal
): Promise<Record<string, MpcSourceVisualProfile>> {
  const tasks: Array<{ index: number; sourceName: string; imageUrl: string }> = [];
  for (const example of examples) {
    for (const candidate of example.candidates) {
      if (!candidate.imageUrl) continue;
      tasks.push({
        index: tasks.length,
        sourceName: example.sourceName,
        imageUrl: candidate.imageUrl,
      });
    }
  }

  if (signal?.aborted || tasks.length === 0) return {};

  const descriptors: Array<MpcImageDescriptor | null> = Array(tasks.length).fill(
    null
  );
  let nextTaskIndex = 0;

  async function runWorker(): Promise<void> {
    while (!signal?.aborted) {
      const task = tasks[nextTaskIndex++];
      if (!task) return;

      const release = await acquireMpcProfileDecodeSlot(signal);
      if (!release || signal?.aborted) {
        release?.();
        return;
      }

      try {
        const descriptor = await extractMpcImageDescriptor(task.imageUrl, signal);
        if (!signal?.aborted) {
          descriptors[task.index] = descriptor;
        }
      } finally {
        // Extraction owns bitmap.close() and must settle before this permit moves.
        release();
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_MPC_PROFILE_DECODES, tasks.length) },
      runWorker
    )
  );

  if (signal?.aborted) return {};

  const grouped = new Map<string, MpcImageDescriptor[]>();
  for (const task of tasks) {
    const descriptor = descriptors[task.index];
    if (!descriptor) continue;
    const sourceDescriptors = grouped.get(task.sourceName) ?? [];
    sourceDescriptors.push(descriptor);
    grouped.set(task.sourceName, sourceDescriptors);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([sourceName, sourceDescriptors]) => {
      const sampleCount = sourceDescriptors.length;
      const descriptor = sourceDescriptors.reduce(
        (acc, value) => ({
          meanLuma: acc.meanLuma + value.meanLuma / sampleCount,
          variance: acc.variance + value.variance / sampleCount,
          edgeDensity: acc.edgeDensity + value.edgeDensity / sampleCount,
        }),
        { meanLuma: 0, variance: 0, edgeDensity: 0 }
      );

      return [sourceName, { sourceName, descriptor, sampleCount }];
    })
  );
}

export function scoreMpcVisualSourcePreference(
  candidateDescriptor: MpcImageDescriptor,
  profiles: Record<string, MpcSourceVisualProfile>,
  sourceWeights: Record<string, number>
): number {
  let bestScore = 0;

  for (const [sourceName, profile] of Object.entries(profiles)) {
    const weight = sourceWeights[sourceName] ?? 0;
    if (weight <= 0) continue;

    const similarity =
      1 / (1 + descriptorDistance(candidateDescriptor, profile.descriptor));
    bestScore = Math.max(bestScore, similarity * weight * 10);
  }

  return bestScore;
}
