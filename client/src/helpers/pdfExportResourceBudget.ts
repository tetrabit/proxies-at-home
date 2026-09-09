import type { CardOption } from "../../../shared/types";
import {
  getCardTargetBleed,
  usesCardbackInsetBorderBleed,
} from "./layout";
import type { WorkerPdfSettings } from "./serializeSettingsForWorker";

const RGBA8_BYTES_PER_PIXEL = 4;
const PDF_PAGE_CPU_SURFACES_PER_WORKER = 2;
const PDF_PAGE_CPU_SURFACE_BYTE_BUDGET = 1_077_120_000;
const PDF_CARD_PREPARATION_CONCURRENCY = 4;
const PDF_CARD_PREPARATION_SURFACES = 3;
const PDF_CARD_RETAINED_SURFACES = 1;
const PDF_CARD_WIDTH_MM = 63;
const PDF_CARD_HEIGHT_MM = 88;

/**
 * Conservative RGBA8-equivalent CPU capacity estimate for one PDF worker.
 *
 * It includes two full-page surfaces, a configured reusable card-guide surface,
 * each prepared card retained until phase two draws it, and the source/work/
 * final surfaces of the worker's current four-card preparation batch. Canvas
 * cache leases reference those retained canvases; they do not add a second
 * backing surface. This is admission arithmetic only: it neither measures nor
 * reserves browser decoder, encoder, driver, or GPU memory.
 */
export const PDF_EXPORT_CPU_ADMISSION_BYTE_BUDGET = Math.floor(
  2.25 * 1024 * 1024 * 1024
);

function assertFinitePositive(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("PDF export settings must be finite positive values");
  }
}

function assertFiniteNonNegative(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("PDF export settings must be finite non-negative values");
  }
}

function toPixelDimension(
  dimension: number,
  pixelsPerUnit: number,
  errorMessage: string
): number {
  const pixels = Math.ceil(dimension * pixelsPerUnit);
  if (!Number.isSafeInteger(pixels) || pixels < 1) {
    throw new Error(errorMessage);
  }
  return pixels;
}

function surfaceBytes(widthPx: number, heightPx: number): number {
  const pixels = widthPx * heightPx;
  const bytes = pixels * RGBA8_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
    throw new Error("PDF export CPU surface accounting overflow");
  }
  return bytes;
}

function addBytes(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Error("PDF export CPU surface accounting overflow");
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("PDF export CPU surface accounting overflow");
  }
  return sum;
}

function multiplyBytes(value: number, multiplier: number): number {
  const result = value * multiplier;
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(result)) {
    throw new Error("PDF export CPU surface accounting overflow");
  }
  return result;
}

function cardSurfaceBytes({
  card,
  image,
  settings,
  pixelsPerMillimetre,
}: {
  card: CardOption;
  image: import("../db").Image | undefined;
  settings: WorkerPdfSettings;
  pixelsPerMillimetre: number;
}): number {
  const guideBleedMm = settings.bleedEdge ? settings.bleedEdgeWidthMm : 0;
  const targetBleedMm = settings.bleedEdge
    ? getCardTargetBleed(
        card,
        settings.sourceSettings,
        settings.bleedEdgeWidthMm,
        image
      )
    : 0;

  assertFiniteNonNegative(targetBleedMm);

  // Regular cards normalize to their target bleed. Blank/missing cards instead
  // use the guide box, while inset cardbacks compose into that same guide box;
  // reserve the larger of the two legal final surfaces before worker startup.
  const renderBleedMm = usesCardbackInsetBorderBleed(card)
    ? guideBleedMm
    : Math.max(guideBleedMm, targetBleedMm);
  const widthPx = toPixelDimension(
    PDF_CARD_WIDTH_MM + renderBleedMm * 2,
    pixelsPerMillimetre,
    "PDF export card dimensions must produce finite positive pixel dimensions"
  );
  const heightPx = toPixelDimension(
    PDF_CARD_HEIGHT_MM + renderBleedMm * 2,
    pixelsPerMillimetre,
    "PDF export card dimensions must produce finite positive pixel dimensions"
  );
  return surfaceBytes(widthPx, heightPx);
}

/**
 * Rejects a request before effect-cache lookup or worker creation when the
 * configured page/card CPU RGBA8 capacity estimate cannot fit one worker.
 */
export function assertPdfExportCpuAdmission({
  cards,
  imagesById,
  settings,
}: {
  cards: CardOption[];
  imagesById: Map<string, import("../db").Image>;
  settings: WorkerPdfSettings;
}): void {
  assertFinitePositive(settings.dpi);
  assertFinitePositive(settings.pageWidth);
  assertFinitePositive(settings.pageHeight);
  assertFiniteNonNegative(settings.bleedEdgeWidthMm);
  assertFiniteNonNegative(settings.sourceSettings.withBleedTargetAmount);
  assertFiniteNonNegative(settings.sourceSettings.noBleedTargetAmount);
  if (
    !Number.isSafeInteger(settings.columns) ||
    !Number.isSafeInteger(settings.rows) ||
    settings.columns < 1 ||
    settings.rows < 1
  ) {
    throw new Error("PDF export settings must use positive integer grid dimensions");
  }

  const pixelsPerUnit =
    settings.dpi * (settings.pageSizeUnit === "in" ? 1 : 1 / 25.4);
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) {
    throw new Error("PDF export settings must be finite positive values");
  }
  const pageWidthPx = toPixelDimension(
    settings.pageWidth,
    pixelsPerUnit,
    "PDF export page dimensions must produce finite positive pixel dimensions"
  );
  const pageHeightPx = toPixelDimension(
    settings.pageHeight,
    pixelsPerUnit,
    "PDF export page dimensions must produce finite positive pixel dimensions"
  );
  const pageSurfaceBytes = surfaceBytes(pageWidthPx, pageHeightPx);
  const pageSurfacesBytes = multiplyBytes(
    pageSurfaceBytes,
    PDF_PAGE_CPU_SURFACES_PER_WORKER
  );
  if (pageSurfacesBytes > PDF_PAGE_CPU_SURFACE_BYTE_BUDGET) {
    throw new Error("PDF export page surfaces exceed the CPU admission budget");
  }

  const pixelsPerMillimetre = settings.dpi / 25.4;
  if (!Number.isFinite(pixelsPerMillimetre) || pixelsPerMillimetre <= 0) {
    throw new Error("PDF export settings must be finite positive values");
  }
  const perPage = settings.columns * settings.rows;
  if (!Number.isSafeInteger(perPage)) {
    throw new Error("PDF export settings must use positive integer grid dimensions");
  }

  for (let pageStart = 0; pageStart < cards.length; pageStart += perPage) {
    const pageCards = cards.slice(pageStart, pageStart + perPage);
    const pageCardBytes = pageCards
      .map((card) =>
        cardSurfaceBytes({
          card,
          image: card.imageId ? imagesById.get(card.imageId) : undefined,
          settings,
          pixelsPerMillimetre,
        })
      );
    const pageHasGuideEligibleCards = pageCards.some(
      (card) => !card.linkedFrontId
    );
    const hasPerCardGuideSurface =
      settings.perCardGuideStyle !== "none" &&
      settings.guideWidthCssPx > 0 &&
      (settings.showGuideLinesOnBackCards || pageHasGuideEligibleCards);
    const perCardGuideBytes = hasPerCardGuideSurface
      ? surfaceBytes(
          toPixelDimension(
            PDF_CARD_WIDTH_MM +
              2 * (settings.bleedEdge ? settings.bleedEdgeWidthMm : 0),
            pixelsPerMillimetre,
            "PDF export card dimensions must produce finite positive pixel dimensions"
          ),
          toPixelDimension(
            PDF_CARD_HEIGHT_MM +
              2 * (settings.bleedEdge ? settings.bleedEdgeWidthMm : 0),
            pixelsPerMillimetre,
            "PDF export card dimensions must produce finite positive pixel dimensions"
          )
        )
      : 0;
    const fixedPageBytes = addBytes(pageSurfacesBytes, perCardGuideBytes);

    let retainedCardBytes = 0;
    let peakBytes = fixedPageBytes;
    for (
      let preparationStart = 0;
      preparationStart < pageCardBytes.length;
      preparationStart += PDF_CARD_PREPARATION_CONCURRENCY
    ) {
      const preparationBytes = pageCardBytes
        .slice(
          preparationStart,
          preparationStart + PDF_CARD_PREPARATION_CONCURRENCY
        )
        .reduce(addBytes, 0);
      const activePreparationBytes = multiplyBytes(
        preparationBytes,
        PDF_CARD_PREPARATION_SURFACES
      );
      peakBytes = Math.max(
        peakBytes,
        addBytes(
          fixedPageBytes,
          addBytes(retainedCardBytes, activePreparationBytes)
        )
      );
      retainedCardBytes = addBytes(
        retainedCardBytes,
        multiplyBytes(preparationBytes, PDF_CARD_RETAINED_SURFACES)
      );
    }
    peakBytes = Math.max(peakBytes, addBytes(fixedPageBytes, retainedCardBytes));

    if (peakBytes > PDF_EXPORT_CPU_ADMISSION_BYTE_BUDGET) {
      throw new Error("PDF export CPU surfaces exceed the admission budget");
    }
  }
}
