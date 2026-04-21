from __future__ import annotations

from pathlib import Path

import pytest

from printer_calibration import transform


class FakePage:
    def __init__(self) -> None:
        self.transforms: list[object] = []

    def add_transformation(self, transformation: object) -> None:
        self.transforms.append(transformation)


class FakeReader:
    def __init__(self, _input_path: Path) -> None:
        self.is_encrypted = False
        self.pages = [FakePage(), FakePage(), FakePage()]


class FakeWriter:
    last_instance: "FakeWriter | None" = None

    def __init__(self) -> None:
        self.pages: list[FakePage] = []
        FakeWriter.last_instance = self

    def add_page(self, page: FakePage) -> None:
        self.pages.append(page)

    def write(self, _fh: object) -> None:
        return None


class FakeTransformation:
    def __init__(self) -> None:
        self.tx = 0.0
        self.ty = 0.0

    def translate(self, *, tx: float, ty: float) -> "FakeTransformation":
        self.tx = tx
        self.ty = ty
        return self


@pytest.fixture(autouse=True)
def patch_pdf_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transform, "PdfReader", FakeReader)
    monkeypatch.setattr(transform, "PdfWriter", FakeWriter)
    monkeypatch.setattr(transform, "Transformation", FakeTransformation)


def test_apply_profile_uses_duplex_page_parity(tmp_path: Path) -> None:
    input_path = tmp_path / "input.pdf"
    input_path.write_bytes(b"%PDF-1.4\n")
    output_path = tmp_path / "output.pdf"

    transform.apply_profile(
        input_path,
        output_path,
        {
            "front_x_mm": 1,
            "front_y_mm": 2,
            "back_x_mm": 3,
            "back_y_mm": 4,
        },
        page_mode="duplex",
    )

    writer = FakeWriter.last_instance
    assert writer is not None
    assert [(page.transforms[0].tx, page.transforms[0].ty) for page in writer.pages] == [
        (transform.MM_TO_PT, 2 * transform.MM_TO_PT),
        (3 * transform.MM_TO_PT, 4 * transform.MM_TO_PT),
        (transform.MM_TO_PT, 2 * transform.MM_TO_PT),
    ]


def test_apply_profile_uses_back_offsets_for_back_only_mode(tmp_path: Path) -> None:
    input_path = tmp_path / "input.pdf"
    input_path.write_bytes(b"%PDF-1.4\n")
    output_path = tmp_path / "output.pdf"

    transform.apply_profile(
        input_path,
        output_path,
        {
            "front_x_mm": 1,
            "front_y_mm": 2,
            "back_x_mm": 3,
            "back_y_mm": 4,
        },
        page_mode="back-only",
    )

    writer = FakeWriter.last_instance
    assert writer is not None
    assert [(page.transforms[0].tx, page.transforms[0].ty) for page in writer.pages] == [
        (3 * transform.MM_TO_PT, 4 * transform.MM_TO_PT),
        (3 * transform.MM_TO_PT, 4 * transform.MM_TO_PT),
        (3 * transform.MM_TO_PT, 4 * transform.MM_TO_PT),
    ]


def test_apply_profile_rejects_invalid_page_modes(tmp_path: Path) -> None:
    input_path = tmp_path / "input.pdf"
    input_path.write_bytes(b"%PDF-1.4\n")
    output_path = tmp_path / "output.pdf"

    with pytest.raises(ValueError, match="page_mode"):
        transform.apply_profile(
            input_path,
            output_path,
            {
                "front_x_mm": 1,
                "front_y_mm": 2,
                "back_x_mm": 3,
                "back_y_mm": 4,
            },
            page_mode="weird-mode",
        )
