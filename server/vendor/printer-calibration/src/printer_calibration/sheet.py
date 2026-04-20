"""Generate duplex calibration sheet PDF for printer offset measurement."""

from __future__ import annotations

import os
from pathlib import Path

from reportlab.pdfgen.canvas import Canvas

from printer_calibration.constants import (
    CENTER_X_MM,
    CENTER_Y_MM,
    LETTER_HEIGHT_PT,
    LETTER_WIDTH_PT,
    MM_TO_PT,
)

# ---------------------------------------------------------------------------
# Layout constants (all in points unless noted)
# ---------------------------------------------------------------------------

_CROSSHAIR_ARM_PT: float = 10.0 * MM_TO_PT  # 10 mm each direction
_VERIF_LINE_LEN_PT: float = 100.0 * MM_TO_PT  # 100 mm verification lines
_VERIF_HORIZ_OFFSET_PT: float = 20.0 * MM_TO_PT  # 20 mm below crosshair
_VERIF_VERT_OFFSET_PT: float = 20.0 * MM_TO_PT  # 20 mm right of crosshair

_RULER_MINOR_TICK_PT: float = 1.5 * MM_TO_PT  # minor tick height (1.5 mm)
_RULER_MAJOR_TICK_PT: float = 3.0 * MM_TO_PT  # major tick height (3 mm)
_RULER_LABEL_FONT: str = "Helvetica"
_RULER_LABEL_SIZE: float = 6.0  # pt

_INSTRUCTION_FONT: str = "Helvetica"
_INSTRUCTION_BOLD_FONT: str = "Helvetica-Bold"
_INSTRUCTION_SIZE: float = 8.5  # pt

# Derived center in points
_CX: float = CENTER_X_MM * MM_TO_PT  # 306.0 pt
_CY: float = CENTER_Y_MM * MM_TO_PT  # 396.0 pt


def _draw_crosshair(c: Canvas) -> None:
    """Draw a centered crosshair at the page center."""
    arm = _CROSSHAIR_ARM_PT
    c.setLineWidth(0.5)
    c.setStrokeColorRGB(0, 0, 0)
    # Horizontal arm
    c.line(_CX - arm, _CY, _CX + arm, _CY)
    # Vertical arm
    c.line(_CX, _CY - arm, _CX, _CY + arm)
    # Small center dot (tiny circle)
    c.setFillColorRGB(0, 0, 0)
    c.circle(_CX, _CY, 1.0, fill=1, stroke=0)


def _draw_verification_lines(c: Canvas) -> None:
    """Draw the 100mm horizontal and vertical verification lines."""
    half = _VERIF_LINE_LEN_PT / 2.0
    c.setLineWidth(0.75)
    c.setStrokeColorRGB(0, 0, 0)

    # Horizontal line: centered horizontally, 20mm below crosshair
    hy = _CY - _VERIF_HORIZ_OFFSET_PT
    c.line(_CX - half, hy, _CX + half, hy)

    # Vertical line: centered vertically, 20mm right of crosshair
    vx = _CX + _VERIF_VERT_OFFSET_PT
    c.line(vx, _CY - half, vx, _CY + half)

    # Label the lines with their length
    c.setFont(_INSTRUCTION_FONT, 6.5)
    c.setFillColorRGB(0.3, 0.3, 0.3)
    c.drawCentredString(_CX, hy - 6.0, "← 100 mm →")
    c.drawString(vx + 3.0, _CY + half + 2.0, "100 mm")


def _draw_bottom_ruler(c: Canvas) -> None:
    """Draw millimeter ruler along the bottom edge of the page."""
    page_width_mm = LETTER_WIDTH_PT / MM_TO_PT  # 215.9 mm

    c.setLineWidth(0.3)
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont(_RULER_LABEL_FONT, _RULER_LABEL_SIZE)

    for mm in range(0, int(page_width_mm) + 1):
        x = mm * MM_TO_PT
        if x > LETTER_WIDTH_PT:
            break

        if mm % 10 == 0:
            tick_h = _RULER_MAJOR_TICK_PT
            if mm > 0:
                c.drawCentredString(x, tick_h + 1.5, str(mm))
        else:
            tick_h = _RULER_MINOR_TICK_PT

        c.line(x, 0.0, x, tick_h)


def _draw_left_ruler(c: Canvas) -> None:
    """Draw millimeter ruler along the left edge of the page."""
    page_height_mm = LETTER_HEIGHT_PT / MM_TO_PT  # 279.4 mm

    c.setLineWidth(0.3)
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont(_RULER_LABEL_FONT, _RULER_LABEL_SIZE)

    for mm in range(0, int(page_height_mm) + 1):
        y = mm * MM_TO_PT
        if y > LETTER_HEIGHT_PT:
            break

        if mm % 10 == 0:
            tick_w = _RULER_MAJOR_TICK_PT
            if mm > 0:
                c.drawString(tick_w + 1.5, y - 2.0, str(mm))
        else:
            tick_w = _RULER_MINOR_TICK_PT

        c.line(0.0, y, tick_w, y)


def _draw_instructions(c: Canvas, side_label: str) -> None:
    """Draw print and measurement instructions in the upper portion of the page."""
    # Place instructions above center — roughly in the top quarter
    top_y = LETTER_HEIGHT_PT - 20.0 * MM_TO_PT  # ~56pt from top

    c.setFillColorRGB(0, 0, 0)

    # --- Print instructions block ---
    c.setFont(_INSTRUCTION_BOLD_FONT, _INSTRUCTION_SIZE)
    c.drawCentredString(LETTER_WIDTH_PT / 2.0, top_y, "Print at Actual Size / 100%")

    c.setFont(_INSTRUCTION_FONT, _INSTRUCTION_SIZE)
    c.drawCentredString(LETTER_WIDTH_PT / 2.0, top_y - 12.0, "Long-edge duplex")
    c.drawCentredString(
        LETTER_WIDTH_PT / 2.0,
        top_y - 24.0,
        "Let sheet cool 3-5 minutes before measuring",
    )

    c.setFont(_INSTRUCTION_BOLD_FONT, _INSTRUCTION_SIZE + 1.0)
    c.drawRightString(LETTER_WIDTH_PT - 12.0, top_y - 36.0, side_label)

    # --- Measurement instructions block ---
    line_y = top_y - 54.0
    c.setFont(_INSTRUCTION_BOLD_FONT, _INSTRUCTION_SIZE)
    c.drawCentredString(
        LETTER_WIDTH_PT / 2.0, line_y, "How to Measure (each side independently):"
    )

    c.setFont(_INSTRUCTION_FONT, _INSTRUCTION_SIZE)
    meas_lines = [
        f"1. Left edge  →  vertical center line   (expected: {CENTER_X_MM:.2f} mm)",
        f"2. Bottom edge →  horizontal center line (expected: {CENTER_Y_MM:.2f} mm)",
        "Measure each printed side from its own visible edges.",
        "Record front and back values separately.",
    ]
    for i, text in enumerate(meas_lines):
        c.drawCentredString(LETTER_WIDTH_PT / 2.0, line_y - 13.0 - i * 12.0, text)


def _draw_page(c: Canvas, side_label: str) -> None:
    """Draw all calibration content onto the current canvas page."""
    _draw_bottom_ruler(c)
    _draw_left_ruler(c)
    _draw_crosshair(c)
    _draw_verification_lines(c)
    _draw_instructions(c, side_label)


def generate_sheet(output_path: str | Path) -> None:
    """Generate a 2-page duplex calibration sheet PDF.

    Page 1 is labeled FRONT and page 2 is labeled BACK so the user can
    measure the printed duplex sheet without confusing the two sides.
    The user measures from each side's visible edges to the center lines
    to determine per-side printer offsets.

    Args:
        output_path: Destination file path for the generated PDF.

    Raises:
        ValueError: If the output directory does not exist or is not writable.
    """
    output_path = Path(output_path)
    parent = output_path.parent

    if not parent.exists():
        raise ValueError(f"Output directory does not exist: {parent}")
    if not os.access(parent, os.W_OK):
        raise ValueError(f"Output directory is not writable: {parent}")

    page_size = (LETTER_WIDTH_PT, LETTER_HEIGHT_PT)
    c = Canvas(str(output_path), pagesize=page_size)

    # Page 1 — front side
    _draw_page(c, "FRONT")
    c.showPage()

    # Page 2 — back side
    _draw_page(c, "BACK")
    c.showPage()

    c.save()
