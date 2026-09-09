"""Public-library smoke coverage using actual pypdf PDF files."""

from __future__ import annotations

from pathlib import Path

import pytest
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from printer_calibration import CalibrationProfile, apply_calibration
from printer_calibration.constants import MM_TO_PT


def _write_distinctly_sized_pdf(path: Path) -> list[tuple[float, float]]:
    """Create a small, real PDF whose ordered pages have unique media boxes."""
    dimensions = [(201.0, 301.0), (202.0, 302.0), (203.0, 303.0)]
    canvas = Canvas(str(path), pagesize=dimensions[0])
    for index, dimensions_for_page in enumerate(dimensions, start=1):
        canvas.setPageSize(dimensions_for_page)
        canvas.drawString(24, 24, f"PAGE-{index}")
        canvas.showPage()
    canvas.save()
    return dimensions


def _translation_for(page: object) -> tuple[float, float]:
    contents = page.get_contents()  # type: ignore[union-attr]
    assert contents is not None
    translations = [
        (float(operands[4]), float(operands[5]))
        for operands, operator in contents.operations
        if operator == b"cm"
        and [float(value) for value in operands[:4]] == [1.0, 0.0, 0.0, 1.0]
        and (float(operands[4]) != 0.0 or float(operands[5]) != 0.0)
    ]
    assert len(translations) == 1
    return translations[0]


def test_public_library_transforms_a_real_small_pdf_with_finite_offsets(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.pdf"
    output_path = tmp_path / "output.pdf"
    page_dimensions = _write_distinctly_sized_pdf(input_path)
    profile = CalibrationProfile(
        front_x_mm=1.25,
        front_y_mm=-2.5,
        back_x_mm=3.75,
        back_y_mm=-4.125,
    )

    apply_calibration(input_path, output_path, profile)

    output = PdfReader(output_path)
    pages = list(output.pages)
    assert len(pages) == 3
    assert [
        (float(page.mediabox.width), float(page.mediabox.height)) for page in pages
    ] == page_dimensions
    expected_translations = [
        (1.25 * MM_TO_PT, -2.5 * MM_TO_PT),
        (3.75 * MM_TO_PT, -4.125 * MM_TO_PT),
        (1.25 * MM_TO_PT, -2.5 * MM_TO_PT),
    ]
    for actual, expected in zip(
        [_translation_for(page) for page in pages], expected_translations, strict=True
    ):
        assert actual == pytest.approx(expected)
