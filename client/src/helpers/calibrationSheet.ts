import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";

const POINTS_PER_MM = 72 / 25.4;
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;
const CENTER_X_MM = 107.95;
const CENTER_Y_MM = 139.7;
const CENTER_X_PT = CENTER_X_MM * POINTS_PER_MM;
const CENTER_Y_PT = CENTER_Y_MM * POINTS_PER_MM;

function drawRulers(page: PDFPage, regularFont: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: LETTER_WIDTH_PT, y: 0 }, thickness: 0.3 });
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 0, y: LETTER_HEIGHT_PT }, thickness: 0.3 });

  for (let millimeters = 0; millimeters <= 215; millimeters += 1) {
    const x = millimeters * POINTS_PER_MM;
    const major = millimeters % 10 === 0;
    page.drawLine({
      start: { x, y: 0 },
      end: { x, y: (major ? 3 : 1.5) * POINTS_PER_MM },
      thickness: 0.3,
    });
    if (major && millimeters > 0) {
      page.drawText(String(millimeters), {
        x: x - regularFont.widthOfTextAtSize(String(millimeters), 6) / 2,
        y: 10,
        size: 6,
        font: regularFont,
      });
    }
  }

  for (let millimeters = 0; millimeters <= 279; millimeters += 1) {
    const y = millimeters * POINTS_PER_MM;
    const major = millimeters % 10 === 0;
    page.drawLine({
      start: { x: 0, y },
      end: { x: (major ? 3 : 1.5) * POINTS_PER_MM, y },
      thickness: 0.3,
    });
    if (major && millimeters > 0) {
      page.drawText(String(millimeters), {
        x: 10,
        y: y - 2,
        size: 6,
        font: regularFont,
      });
    }
  }
}

function drawCenteredText(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  page.drawText(text, {
    x: (LETTER_WIDTH_PT - font.widthOfTextAtSize(text, size)) / 2,
    y,
    size,
    font,
  });
}

function drawSheetPage(
  page: PDFPage,
  sideLabel: "FRONT" | "BACK",
  regularFont: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  boldFont: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  const black = rgb(0, 0, 0);
  drawRulers(page, regularFont);

  page.drawLine({
    start: { x: CENTER_X_PT - 10 * POINTS_PER_MM, y: CENTER_Y_PT },
    end: { x: CENTER_X_PT + 10 * POINTS_PER_MM, y: CENTER_Y_PT },
    thickness: 0.5,
    color: black,
  });
  page.drawLine({
    start: { x: CENTER_X_PT, y: CENTER_Y_PT - 10 * POINTS_PER_MM },
    end: { x: CENTER_X_PT, y: CENTER_Y_PT + 10 * POINTS_PER_MM },
    thickness: 0.5,
    color: black,
  });
  page.drawCircle({ x: CENTER_X_PT, y: CENTER_Y_PT, size: 1, color: black });

  const verificationHalf = 50 * POINTS_PER_MM;
  const horizontalY = CENTER_Y_PT - 20 * POINTS_PER_MM;
  const verticalX = CENTER_X_PT + 20 * POINTS_PER_MM;
  page.drawLine({
    start: { x: CENTER_X_PT - verificationHalf, y: horizontalY },
    end: { x: CENTER_X_PT + verificationHalf, y: horizontalY },
    thickness: 0.75,
    color: black,
  });
  page.drawLine({
    start: { x: verticalX, y: CENTER_Y_PT - verificationHalf },
    end: { x: verticalX, y: CENTER_Y_PT + verificationHalf },
    thickness: 0.75,
    color: black,
  });
  drawCenteredText(page, "100 mm verification line", horizontalY - 10, 6.5, regularFont);
  page.drawText("100 mm", { x: verticalX + 3, y: CENTER_Y_PT + verificationHalf + 2, size: 6.5, font: regularFont });

  const topY = LETTER_HEIGHT_PT - 20 * POINTS_PER_MM;
  drawCenteredText(page, "Print at Actual Size / 100%", topY, 8.5, boldFont);
  drawCenteredText(page, "Long-edge duplex", topY - 12, 8.5, regularFont);
  drawCenteredText(page, "Let sheet cool 3-5 minutes before measuring", topY - 24, 8.5, regularFont);
  page.drawText(sideLabel, {
    x: LETTER_WIDTH_PT - 12 - boldFont.widthOfTextAtSize(sideLabel, 9.5),
    y: topY - 36,
    size: 9.5,
    font: boldFont,
  });

  const instructionY = topY - 54;
  drawCenteredText(page, "How to Measure (each side independently):", instructionY, 8.5, boldFont);
  const measurements = [
    `1. Left edge to vertical center line (expected: ${CENTER_X_MM.toFixed(2)} mm)`,
    `2. Bottom edge to horizontal center line (expected: ${CENTER_Y_MM.toFixed(2)} mm)`,
    "Measure each printed side from its own visible edges.",
    "Record front and back values separately.",
  ];
  measurements.forEach((measurement, index) =>
    drawCenteredText(page, measurement, instructionY - 13 - index * 12, 8.5, regularFont),
  );
}

/** Creates the static, non-sensitive US Letter calibration template in the browser. */
export async function createCalibrationSheet(): Promise<Blob> {
  const pdf = await PDFDocument.create();
  const regularFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawSheetPage(pdf.addPage([LETTER_WIDTH_PT, LETTER_HEIGHT_PT]), "FRONT", regularFont, boldFont);
  drawSheetPage(pdf.addPage([LETTER_WIDTH_PT, LETTER_HEIGHT_PT]), "BACK", regularFont, boldFont);

  const bytes = await pdf.save();
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([data], { type: "application/pdf" });
}
