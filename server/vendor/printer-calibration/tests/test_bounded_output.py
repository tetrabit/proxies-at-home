"""Bounded PDF output coverage with real file boundaries."""

from __future__ import annotations

from pathlib import Path

import pytest

from printer_calibration.bounded_output import BoundedBinaryWriter, OutputLimitExceeded
from pypdf import PdfWriter
from printer_calibration.sheet import generate_sheet
from printer_calibration.transform import apply_profile


def test_bounded_writer_rejects_an_overlimit_write_before_any_of_its_bytes_reach_disk(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "bounded.bin"

    with output_path.open("wb") as raw:
        bounded = BoundedBinaryWriter(raw, max_bytes=4)
        assert bounded.write(b"four") == 4
        with pytest.raises(OutputLimitExceeded, match="4"):
            bounded.write(b"!")

    assert output_path.read_bytes() == b"four"


def test_bounded_writer_rejects_a_truncate_that_would_expand_past_its_limit(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "truncated.bin"

    with output_path.open("wb+") as raw:
        bounded = BoundedBinaryWriter(raw, max_bytes=4)
        bounded.write(b"four")
        with pytest.raises(OutputLimitExceeded, match="4"):
            bounded.truncate(5)

    assert output_path.read_bytes() == b"four"


def test_bounded_writer_accounts_for_seeked_writes_without_rejecting_in_place_rewrites(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "seeked.bin"

    with output_path.open("wb") as raw:
        bounded = BoundedBinaryWriter(raw, max_bytes=4)
        bounded.write(b"four")
        assert bounded.seek(0) == 0
        bounded.write(b"F")
        assert bounded.tell() == 1
        assert bounded.seek(4) == 4
        with pytest.raises(OutputLimitExceeded):
            bounded.write(b"!")

    assert output_path.read_bytes() == b"Four"


def test_generate_sheet_rejects_a_real_pdf_before_an_overlimit_serializer_write(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "sheet.pdf"

    with pytest.raises(OutputLimitExceeded, match="1"):
        generate_sheet(output_path, max_output_bytes=1)

    assert output_path.read_bytes() == b""


def test_apply_profile_rejects_a_real_pdf_before_an_overlimit_serializer_write(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.pdf"
    output_path = tmp_path / "output.pdf"
    source = PdfWriter()
    source.add_blank_page(width=72, height=72)
    with input_path.open("wb") as raw:
        source.write(raw)

    with pytest.raises(OutputLimitExceeded, match="1"):
        apply_profile(
            input_path,
            output_path,
            {
                "front_x_mm": 0,
                "front_y_mm": 0,
                "back_x_mm": 0,
                "back_y_mm": 0,
            },
            max_output_bytes=1,
        )

    assert output_path.read_bytes() == b""
