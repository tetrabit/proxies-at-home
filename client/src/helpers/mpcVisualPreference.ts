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
  examples: MpcHarvestedSourceExample[]
): Promise<Record<string, MpcSourceVisualProfile>> {
  const grouped = new Map<string, MpcImageDescriptor[]>();

  const tasks: Array<Promise<{ sourceName: string; descriptor: MpcImageDescriptor } | null>> = [];
  for (const example of examples) {
    for (const candidate of example.candidates) {
      if (!candidate.imageUrl) continue;
      tasks.push(
        extractMpcImageDescriptor(candidate.imageUrl).then((descriptor) =>
          descriptor ? { sourceName: example.sourceName, descriptor } : null
        )
      );
    }
  }

  for (const result of await Promise.all(tasks)) {
    if (!result) continue;
    const descriptors = grouped.get(result.sourceName) ?? [];
    descriptors.push(result.descriptor);
    grouped.set(result.sourceName, descriptors);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([sourceName, descriptors]) => {
      const sampleCount = descriptors.length;
      const descriptor = descriptors.reduce(
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
