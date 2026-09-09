from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from printer_calibration import apply_calibration
from printer_calibration.constants import LETTER_HEIGHT_PT, LETTER_WIDTH_PT, MM_TO_PT
from printer_calibration.transform import apply_profile


_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_REVIEW_ARTIFACTS_ROOT = _REPOSITORY_ROOT / ".review-artifacts"
_DEFAULT_ARTIFACT_PARENT = _REVIEW_ARTIFACTS_ROOT / "grouped-duplex-01"
_PROTECTED_ARTIFACT_PARTS = frozenset(
    {".git", ".todos", ".recovery", "evidence", "env", "ancestors"}
)


def _safe_artifact_path(raw_path: str | Path) -> Path:
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = _REPOSITORY_ROOT / candidate
    candidate = candidate.resolve(strict=False)

    try:
        relative_path = candidate.relative_to(_REVIEW_ARTIFACTS_ROOT)
    except ValueError as error:
        raise ValueError(
            "CALIBRATION_GROUPED_DUPLEX_TEST_ARTIFACT must be contained in "
            ".review-artifacts"
        ) from error

    if not relative_path.parts or any(
        part in _PROTECTED_ARTIFACT_PARTS for part in relative_path.parts
    ):
        raise ValueError("CALIBRATION_GROUPED_DUPLEX_TEST_ARTIFACT targets a protected path")

    return candidate


def _new_artifact_path(artifact_parent: Path) -> Path:
    artifact_parent.mkdir(parents=True, exist_ok=True)
    while True:
        candidate = _safe_artifact_path(artifact_parent / uuid.uuid4().hex)
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate


@pytest.fixture
def grouped_duplex_artifact() -> Path:
    artifact_parent = _safe_artifact_path(
        os.environ.get(
            "CALIBRATION_GROUPED_DUPLEX_TEST_ARTIFACT", _DEFAULT_ARTIFACT_PARENT
        )
    )
    return _new_artifact_path(artifact_parent)


def _write_labelled_pdf(path: Path, labels: list[str]) -> None:
    canvas = Canvas(str(path), pagesize=(LETTER_WIDTH_PT, LETTER_HEIGHT_PT))
    for label in labels:
        canvas.drawString(72, 720, label)
        canvas.showPage()
    canvas.save()


def _translation_for(page: object) -> tuple[float, float]:
    operations = page.get_contents().operations  # type: ignore[union-attr]
    translations = [
        (float(operands[4]), float(operands[5]))
        for operands, operator in operations
        if operator == b"cm"
        and list(map(float, operands[:4])) == [1.0, 0.0, 0.0, 1.0]
        and (float(operands[4]) != 0.0 or float(operands[5]) != 0.0)
    ]
    assert len(translations) == 1
    return translations[0]


def _assert_translations(
    pages: list[object], expected: list[tuple[float, float]]
) -> None:
    for actual, expected_translation in zip(
        [_translation_for(page) for page in pages], expected, strict=True
    ):
        assert actual == pytest.approx(expected_translation)


def test_grouped_duplex_applies_offsets_to_real_labelled_four_page_pdf_in_input_order(
    grouped_duplex_artifact: Path,
) -> None:
    input_path = grouped_duplex_artifact / "grouped-input.pdf"
    output_path = grouped_duplex_artifact / "grouped-output.pdf"
    _write_labelled_pdf(input_path, ["FRONT-1", "FRONT-2", "BACK-1", "BACK-2"])

    apply_calibration(
        input_path,
        output_path,
        {
            "paper_size": "letter",
            "duplex_mode": "long-edge",
            "front_x_mm": 1.0,
            "front_y_mm": 2.0,
            "back_x_mm": 3.0,
            "back_y_mm": 4.0,
        },
        page_mode="grouped-duplex",
        front_page_count=2,
    )

    output = PdfReader(output_path)
    assert [page.extract_text().strip() for page in output.pages] == [
        "FRONT-1",
        "FRONT-2",
        "BACK-1",
        "BACK-2",
    ]
    _assert_translations(
        list(output.pages),
        [
            (1.0 * MM_TO_PT, 2.0 * MM_TO_PT),
            (1.0 * MM_TO_PT, 2.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
        ],
    )



def test_actual_cli_accepts_grouped_duplex_ordering_without_changing_profile_metadata(
    grouped_duplex_artifact: Path,
) -> None:
    input_path = grouped_duplex_artifact / "grouped-input.pdf"
    output_path = grouped_duplex_artifact / "grouped-output.pdf"
    profile_file = grouped_duplex_artifact / "profiles.toml"
    _write_labelled_pdf(input_path, ["FRONT-1", "FRONT-2", "BACK-1", "BACK-2"])
    source_root = Path(__file__).parents[1] / "src"
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(source_root),
    }

    set_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "printer_calibration",
            "profile",
            "set",
            "--name",
            "strict-letter-long-edge",
            "--front-x-mm",
            "1",
            "--front-y-mm",
            "2",
            "--back-x-mm",
            "3",
            "--back-y-mm",
            "4",
            "--profile-file",
            str(profile_file),
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env=environment,
    )
    assert set_result.returncode == 0, set_result.stderr

    apply_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "printer_calibration",
            "apply",
            "--profile",
            "strict-letter-long-edge",
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--page-mode",
            "grouped-duplex",
            "--front-page-count",
            "2",
            "--profile-file",
            str(profile_file),
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env=environment,
    )
    assert apply_result.returncode == 0, apply_result.stderr

    output = PdfReader(output_path)
    assert [page.extract_text().strip() for page in output.pages] == [
        "FRONT-1",
        "FRONT-2",
        "BACK-1",
        "BACK-2",
    ]
    _assert_translations(
        list(output.pages),
        [
            (1.0 * MM_TO_PT, 2.0 * MM_TO_PT),
            (1.0 * MM_TO_PT, 2.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
        ],
    )


def test_grouped_duplex_requires_an_explicit_front_page_count(
    grouped_duplex_artifact: Path,
) -> None:
    input_path = grouped_duplex_artifact / "grouped-input.pdf"
    _write_labelled_pdf(input_path, ["FRONT-1", "BACK-1", "BACK-2"])

    with pytest.raises(ValueError, match="front_page_count is required"):
        apply_profile(
            input_path,
            grouped_duplex_artifact / "grouped-output.pdf",
            {
                "front_x_mm": 1.0,
                "front_y_mm": 2.0,
                "back_x_mm": 3.0,
                "back_y_mm": 4.0,
            },
            page_mode="grouped-duplex",
        )


def test_grouped_duplex_odd_page_count_uses_the_explicit_group_boundary(
    grouped_duplex_artifact: Path,
) -> None:
    input_path = grouped_duplex_artifact / "grouped-input.pdf"
    output_path = grouped_duplex_artifact / "grouped-output.pdf"
    _write_labelled_pdf(input_path, ["FRONT-1", "BACK-1", "BACK-2"])

    apply_profile(
        input_path,
        output_path,
        {
            "front_x_mm": 1.0,
            "front_y_mm": 2.0,
            "back_x_mm": 3.0,
            "back_y_mm": 4.0,
        },
        page_mode="grouped-duplex",
        front_page_count=1,
    )

    output = PdfReader(output_path)
    assert [page.extract_text().strip() for page in output.pages] == [
        "FRONT-1",
        "BACK-1",
        "BACK-2",
    ]
    _assert_translations(
        list(output.pages),
        [
            (1.0 * MM_TO_PT, 2.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
            (3.0 * MM_TO_PT, 4.0 * MM_TO_PT),
        ],
    )
