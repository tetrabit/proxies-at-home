"""PDF translation engine for printer calibration offsets."""

from __future__ import annotations

from pathlib import Path

import pypdf
from pypdf import PdfReader, PdfWriter, Transformation

from printer_calibration.constants import MM_TO_PT


def apply_profile(
    input_path: str | Path,
    output_path: str | Path,
    profile: dict,
    page_mode: str = "duplex",
) -> None:
    """Apply calibration offsets from *profile* to every page of *input_path*.

    In ``duplex`` mode, even-indexed pages (0-based: 0, 2, 4, …) are treated
    as front faces and receive ``front_x_mm`` / ``front_y_mm`` offsets. Odd-
    indexed pages (1, 3, 5, …) are back faces and receive ``back_x_mm`` /
    ``back_y_mm``. In ``back-only`` mode, every page receives the back-page
    offsets.

    The output PDF is written to *output_path* and has the same page count as
    the input.  All arithmetic stays in floating-point — values are never
    rounded before being written.

    Args:
        input_path: Path to the source PDF.
        output_path: Destination path for the calibrated PDF.
        profile: Dict with keys ``front_x_mm``, ``front_y_mm``,
            ``back_x_mm``, ``back_y_mm`` (all floats, mm units).
        page_mode: ``duplex`` for alternating front/back pages, ``back-only``
            for PDFs that contain only back pages.

    Raises:
        ValueError: If the input file cannot be opened, is not a valid PDF,
            or is encrypted.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    if page_mode not in {"duplex", "back-only"}:
        raise ValueError("page_mode must be 'duplex' or 'back-only'")

    # --- open & validate -------------------------------------------------------
    try:
        reader = PdfReader(input_path)
    except (pypdf.errors.PdfReadError, FileNotFoundError, OSError) as exc:
        raise ValueError(f"Cannot open input PDF '{input_path}': {exc}") from exc

    if reader.is_encrypted:
        raise ValueError("Input PDF is encrypted and cannot be processed")

    # --- extract offsets (mm → pt, keep as float) ------------------------------
    front_tx: float = float(profile["front_x_mm"]) * MM_TO_PT
    front_ty: float = float(profile["front_y_mm"]) * MM_TO_PT
    back_tx: float = float(profile["back_x_mm"]) * MM_TO_PT
    back_ty: float = float(profile["back_y_mm"]) * MM_TO_PT

    # --- single-pass transform + write ----------------------------------------
    writer = PdfWriter()

    for index, page in enumerate(reader.pages):
        if page_mode == "back-only":
            tx, ty = back_tx, back_ty
        elif index % 2 == 0:
            tx, ty = front_tx, front_ty
        else:
            tx, ty = back_tx, back_ty

        page.add_transformation(Transformation().translate(tx=tx, ty=ty))
        writer.add_page(page)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as fh:
        writer.write(fh)
