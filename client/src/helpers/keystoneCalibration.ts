import { baseCardHeightMm, baseCardWidthMm } from "./layout";

export type KeystoneExtraTransform = {
  rot_deg: number; // rotation to apply to back content to match front (positive = clockwise)
  translation_mm: { x: number; y: number }; // translation to apply to back content (mm)
  // scale omitted for now (v1)
};

export type KeystoneApplySettings = {
  pageSizeUnit: "mm" | "in";
  pageWidth: number;
  pageHeight: number;
  columns: number;
  rows: number;
  cardSpacingMm: number;
  bleedEdge: boolean;
  bleedEdgeWidth: number;
  bleedEdgeUnit: "mm" | "in";
  cardPositionX: number;
  cardPositionY: number;
  useCustomBackOffset: boolean;
  cardBackPositionX: number;
  cardBackPositionY: number;
};

type Offset = { x: number; y: number; rotation: number };

function toMm(value: number, unit: "mm" | "in"): number {
  return unit === "mm" ? value : value * 25.4;
}

function rotMatrix(thetaDeg: number) {
  const t = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // Canvas / paper coords are +x right, +y down, so positive is clockwise.
  return { c, s };
}

function applyRigid(P: { x: number; y: number }, rotDeg: number, t: { x: number; y: number }) {
  const { c, s } = rotMatrix(rotDeg);
  return {
    x: c * P.x - s * P.y + t.x,
    y: s * P.x + c * P.y + t.y,
  };
}

/**
 * Convert a global back->front rigid transform (rotation+translation in paper coords)
 * into Proxxied's per-slot offsets:
 * - rotation is applied about each card center
 * - translation is chosen so the card center lands where the global transform would send it
 *
 * This yields exact alignment at card centers; content rotates correctly as a rigid body.
 */
export function keystoneTransformToPerCardOffsets(
  extra: KeystoneExtraTransform,
  settings: KeystoneApplySettings,
): Record<number, Offset> {
  const pageWidthMm = toMm(settings.pageWidth, settings.pageSizeUnit);
  const pageHeightMm = toMm(settings.pageHeight, settings.pageSizeUnit);

  const bleedMm = settings.bleedEdge
    ? toMm(settings.bleedEdgeWidth, settings.bleedEdgeUnit)
    : 0;

  const cardW = baseCardWidthMm + 2 * bleedMm;
  const cardH = baseCardHeightMm + 2 * bleedMm;

  const spacing = settings.cardSpacingMm || 0;

  const gridW = settings.columns * cardW + Math.max(0, settings.columns - 1) * spacing;
  const gridH = settings.rows * cardH + Math.max(0, settings.rows - 1) * spacing;

  const basePosX = settings.useCustomBackOffset ? settings.cardBackPositionX : settings.cardPositionX;
  const basePosY = settings.useCustomBackOffset ? settings.cardBackPositionY : settings.cardPositionY;

  const startX = (pageWidthMm - gridW) / 2 + (basePosX || 0);
  const startY = (pageHeightMm - gridH) / 2 + (basePosY || 0);

  const out: Record<number, Offset> = {};
  const total = Math.max(0, settings.columns * settings.rows);
  for (let idx = 0; idx < total; idx++) {
    const col = idx % settings.columns;
    const row = Math.floor(idx / settings.columns);

    const center = {
      x: startX + col * (cardW + spacing) + cardW / 2,
      y: startY + row * (cardH + spacing) + cardH / 2,
    };

    const moved = applyRigid(center, extra.rot_deg, extra.translation_mm);
    out[idx] = {
      x: moved.x - center.x,
      y: moved.y - center.y,
      rotation: extra.rot_deg,
    };
  }

  return out;
}

