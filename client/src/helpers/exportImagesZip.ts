import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { CardOption } from "../../../shared/types";
import { type Image } from "@/db";
import { hasAdvancedOverrides, overridesToRenderParams, renderCardWithOverridesWorker } from "./cardCanvasWorker";
import { useSettingsStore } from "@/store/settings";
import { getLocalBleedImageUrl } from "./imageHelper";
import { setEffectCacheEntryWithDpi } from "./effectCache";

// Sanitize filename helper (simple local version sufficient for now, or could move to utils)
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/?%*:|"<>]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "card"
  );
}

// Scryfall thumbs sometimes come as .jpg; prefer .png for fewer artifacts
function preferPng(url: string) {
  try {
    const u = new URL(url);
    if (
      u.hostname.endsWith("scryfall.io") &&
      u.pathname.match(/\.(jpg|jpeg)$/i)
    ) {
      u.pathname = u.pathname.replace(/\.(jpg|jpeg)$/i, ".png");
      return u.toString();
    }
  } catch {
    /* noop */
  }
  return url;
}

type ExportOpts = {
  cards: CardOption[];
  images: Image[];
  fileBaseName?: string; // default: card_images_YYYY-MM-DD
  concurrency?: number; // default: 6
};

// Result of processing a single card
type ExportResult = {
  blob: Blob;
  filename: string;
} | null;

function preassignFilenamePrefixes(cards: CardOption[]): string[] {
  const usedNames = new Map<string, number>();

  return cards.map((card, index) => {
    const baseName = sanitizeFilename(card.name || `Card ${index + 1}`);
    const count = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, count);
    const suffix = count > 1 ? ` (${count})` : "";
    const idx = String(index + 1).padStart(3, "0");

    return `${idx} - ${baseName}${suffix}`;
  });
}

/**
 * Shared logic to process a card: resolve image, apply overrides, and generate filename.
 */
async function processCardForExport(
  c: CardOption,
  index: number,
  imagesById: Map<string, Image>,
  usedNames: Map<string, number>,
  preassignedFilenamePrefix?: string,
  cacheWriteSettlements?: Array<Promise<void>>
): Promise<ExportResult> {
  const image = c.imageId ? imagesById.get(c.imageId) : undefined;
  let url = image?.sourceUrl || "";

  // Prefer exportBlob (has bleed/processing applied) over originalBlob
  // Then select the appropriate darken mode version
  const darkenMode = useSettingsStore.getState().darkenMode;
  const cardDarkenMode = c.overrides?.darkenMode ?? darkenMode;

  // Select the right export blob based on darken mode
  let selectedBlob: Blob | undefined;
  if (cardDarkenMode === 'none') {
    selectedBlob = image?.exportBlob;
  } else if (cardDarkenMode === 'darken-all') {
    selectedBlob = image?.exportBlobDarkenAll ?? image?.exportBlobDarkened ?? image?.exportBlob;
  } else if (cardDarkenMode === 'contrast-edges') {
    selectedBlob = image?.exportBlobContrastEdges ?? image?.exportBlobDarkened ?? image?.exportBlob;
  } else if (cardDarkenMode === 'contrast-full') {
    selectedBlob = image?.exportBlobContrastFull ?? image?.exportBlobDarkened ?? image?.exportBlob;
  } else {
    selectedBlob = image?.exportBlob;
  }

  if (!url && !image?.originalBlob && !selectedBlob) {
    return null; // empty slot
  }

  // If it’s not a user upload, run it through the proxy to get the bleed version
  if (!c.isUserUpload && url) {
    url = getLocalBleedImageUrl(preferPng(url));
  }

  const baseName = sanitizeFilename(c.name || `Card ${index + 1}`);
  const idx = String(index + 1).padStart(3, "0");

  let blob: Blob;

  if (selectedBlob) {
    blob = selectedBlob;

    // Apply advanced overrides (brightness, contrast, etc.) if present
    if (hasAdvancedOverrides(c.overrides)) {
      const params = overridesToRenderParams(c.overrides!, cardDarkenMode);
      const bitmap = await createImageBitmap(blob);
      blob = await renderCardWithOverridesWorker(bitmap, params);
      bitmap.close();
      // Cache for future exports (fire-and-forget)
      // Use setEffectCacheEntry from helper instead of reimplementing logic
      if (c.imageId && c.overrides) {
        const dpi = useSettingsStore.getState().dpi;
        const cacheWrite = setEffectCacheEntryWithDpi(c.imageId, c.overrides, blob, dpi)
          .catch((error) => {
            console.error("[ExportImagesZip] Optional effect-cache write failed:", error);
          });
        cacheWriteSettlements?.push(cacheWrite);
      }
    }
  } else if (image?.originalBlob) {
    blob = image.originalBlob;
  } else {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) {
        console.warn(`[Export skipped] Could not fetch: ${url}`);
        return null;
      }
      blob = await res.blob();
    } catch (err) {
      console.warn(`[Export skipped] Error fetching ${url}`, err);
      return null;
    }
  }

  // De-dupe names during individual exports; ZIP prefixes are assigned before preparation starts.
  let filenamePrefix = preassignedFilenamePrefix;
  if (!filenamePrefix) {
    const count = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, count);
    const suffix = count > 1 ? ` (${count})` : "";
    filenamePrefix = `${idx} - ${baseName}${suffix}`;
  }

  // Try to keep the right extension if we know it; default to .png
  const ext =
    blob.type === "image/jpeg"
      ? "jpg"
      : blob.type === "image/webp"
        ? "webp"
        : "png";

  const filename = `${filenamePrefix}.${ext}`;
  return { blob, filename };
}

// Simple concurrency limiter
async function runWithConcurrency<T>(
  jobs: Array<() => Promise<T>>,
  limit: number
) {
  const results: T[] = [];
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const cur = next++;
      results[cur] = await jobs[cur]();
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, worker);
  await Promise.all(workers);
  return results;
}

export async function ExportImagesZip(opts: ExportOpts) {
  const { cards, images, fileBaseName, concurrency = 6 } = opts;

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const zipFilenamePrefixes = preassignFilenamePrefixes(cards);
  const imagesById = new Map(images.map((img) => [img.id, img]));
  const cacheWriteSettlements: Array<Promise<void>> = [];

  try {
    // Prepare in parallel but retain results at their source indexes so JSZip insertion is deterministic.
    const preparationTasks = cards.map((c, i) => () =>
      processCardForExport(
        c,
        i,
        imagesById,
        usedNames,
        zipFilenamePrefixes[i],
        cacheWriteSettlements
      )
    );
    const preparedBySourceIndex = await runWithConcurrency(preparationTasks, concurrency);

    // JSZip preserves file insertion order. Add successful preparations sequentially in input order.
    for (const result of preparedBySourceIndex) {
      if (result) {
        zip.file(result.filename, result.blob);
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const outName = `${fileBaseName || "card_images"}_${date}.zip`;
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, outName);
  } finally {
    await Promise.all(cacheWriteSettlements);
  }
}

/**
 * Export images individually (one file per card).
 * Downloads each image as a separate file.
 */
export async function ExportImagesIndividual(opts: ExportOpts) {
  const { cards, images, concurrency = 3 } = opts;

  const usedNames = new Map<string, number>();
  const imagesById = new Map(images.map((img) => [img.id, img]));

  const tasks = cards.map((c, i) => async () => {
    const result = await processCardForExport(c, i, imagesById, usedNames);
    if (result) {
      saveAs(result.blob, result.filename);
      // Small delay between downloads to prevent browser issues
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });

  await runWithConcurrency(tasks, concurrency);
}
