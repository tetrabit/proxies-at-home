"""PDF translation engine for printer calibration offsets."""

from __future__ import annotations

from pathlib import Path

import pypdf
from pypdf import PdfReader, PdfWriter, Transformation

from printer_calibration.bounded_output import BoundedBinaryWriter, validate_max_output_bytes
from printer_calibration.constants import MM_TO_PT
from printer_calibration.validation import validate_finite_offsets, validate_profile_metadata


def apply_profile(
    input_path: str | Path,
    output_path: str | Path,
    profile: dict,
    page_mode: str = "duplex",
    front_page_count: int | None = None,
    max_output_bytes: int | None = None,
) -> None:
    """Apply calibration offsets from *profile* to every page of *input_path*.

    In ``duplex`` mode, even-indexed pages (0-based: 0, 2, 4, …) are treated
    as front faces and receive ``front_x_mm`` / ``front_y_mm`` offsets. Odd-
    indexed pages (1, 3, 5, …) are back faces and receive ``back_x_mm`` /
    ``back_y_mm``. In ``back-only`` mode, every page receives the back-page
    offsets. In ``grouped-duplex`` mode, pages before ``front_page_count`` are
    fronts and all remaining pages are backs; their input order is unchanged.
    Grouped ordering is independent of the profile's physical ``duplex_mode``
    metadata, which remains the supported ``long-edge`` printer setting.

    The output PDF is written to *output_path* and has the same page count as
    the input.  All arithmetic stays in floating-point — values are never
    rounded before being written.

    Args:
        input_path: Path to the source PDF.
        output_path: Destination path for the calibrated PDF.
        profile: Dict with keys ``front_x_mm``, ``front_y_mm``,
            ``back_x_mm``, ``back_y_mm`` (all floats, mm units).
        page_mode: ``duplex`` for alternating front/back pages, ``back-only``
            for PDFs that contain only back pages, or ``grouped-duplex`` for a
            front group followed by a back group.
        front_page_count: Required only for ``grouped-duplex``. The explicit
            number of leading front pages; it must leave at least one back page.
        max_output_bytes: Optional cap enforced before any serializer write that
            would grow the output past this many bytes.

    Raises:
        ValueError: If the input file cannot be opened, is not a valid PDF,
            or is encrypted.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    max_output_bytes = validate_max_output_bytes(max_output_bytes)
    if page_mode not in {"duplex", "back-only", "grouped-duplex"}:
        raise ValueError(
            "page_mode must be 'duplex', 'back-only', or 'grouped-duplex'"
        )
    if page_mode == "grouped-duplex":
        if front_page_count is None:
            raise ValueError("front_page_count is required for grouped-duplex mode")
        if isinstance(front_page_count, bool) or not isinstance(front_page_count, int):
            raise ValueError("front_page_count must be an integer")

    offsets = validate_finite_offsets(profile)
    validate_profile_metadata(profile)

    # --- open & validate -------------------------------------------------------
    try:
        reader = PdfReader(input_path)
    except (pypdf.errors.PdfReadError, FileNotFoundError, OSError) as exc:
        raise ValueError(f"Cannot open input PDF '{input_path}': {exc}") from exc

    if reader.is_encrypted:
        raise ValueError("Input PDF is encrypted and cannot be processed")

    if page_mode == "grouped-duplex":
        assert front_page_count is not None
        if not 0 < front_page_count < len(reader.pages):
            raise ValueError(
                "front_page_count must be greater than 0 and less than the input page count"
            )

    # --- extract offsets (mm → pt, keep as float) ------------------------------
    front_tx = offsets["front_x_mm"] * MM_TO_PT
    front_ty = offsets["front_y_mm"] * MM_TO_PT
    back_tx = offsets["back_x_mm"] * MM_TO_PT
    back_ty = offsets["back_y_mm"] * MM_TO_PT

    # --- single-pass transform + write ----------------------------------------
    writer = PdfWriter()

    for index, page in enumerate(reader.pages):
        if page_mode == "back-only":
            tx, ty = back_tx, back_ty
        elif page_mode == "grouped-duplex":
            assert front_page_count is not None
            if index < front_page_count:
                tx, ty = front_tx, front_ty
            else:
                tx, ty = back_tx, back_ty
        elif index % 2 == 0:
            tx, ty = front_tx, front_ty
        else:
            tx, ty = back_tx, back_ty

        writer.add_page(page)
        writer.pages[-1].add_transformation(Transformation().translate(tx=tx, ty=ty))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as fh:
        output = (
            fh
            if max_output_bytes is None
            else BoundedBinaryWriter(fh, max_bytes=max_output_bytes)
        )
        writer.write(output)
