from __future__ import annotations

import math
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from printer_calibration import (
    CalibrationProfile,
    calculate_axis_offset,
    load_profile,
    save_profile,
    validate_finite_offsets,
)
from printer_calibration.transform import apply_profile


_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_REVIEW_ARTIFACTS_ROOT = _REPOSITORY_ROOT / ".review-artifacts"
_DEFAULT_ARTIFACT_PARENT = _REVIEW_ARTIFACTS_ROOT / "finite-test-integration-01"
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
            "CALIBRATION_FINITE_TEST_ARTIFACT must be contained in "
            ".review-artifacts"
        ) from error

    if not relative_path.parts or any(
        part in _PROTECTED_ARTIFACT_PARTS for part in relative_path.parts
    ):
        raise ValueError("CALIBRATION_FINITE_TEST_ARTIFACT targets a protected path")

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
def finite_test_artifact() -> Path:
    artifact_parent = _safe_artifact_path(
        os.environ.get("CALIBRATION_FINITE_TEST_ARTIFACT", _DEFAULT_ARTIFACT_PARENT)
    )
    return _new_artifact_path(artifact_parent)


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_public_validation_rejects_nonfinite_offsets(value: float) -> None:
    with pytest.raises(ValueError, match=r"front_x_mm must be finite"):
        validate_finite_offsets(
            {
                "front_x_mm": value,
                "front_y_mm": 0.0,
                "back_x_mm": 0.0,
                "back_y_mm": 0.0,
            }
        )


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_calculate_axis_offset_rejects_nonfinite_measurements(value: float) -> None:
    with pytest.raises(ValueError, match=r"measured_mm must be finite"):
        calculate_axis_offset(0.0, value)


def test_save_profile_rejects_nan_before_creating_storage(
    finite_test_artifact: Path,
) -> None:
    profile_file = finite_test_artifact / "storage-nan-green.toml"

    with pytest.raises(ValueError, match=r"back_y_mm must be finite"):
        save_profile(
            "invalid",
            {
                "front_x_mm": 0.0,
                "front_y_mm": 0.0,
                "back_x_mm": 0.0,
                "back_y_mm": math.nan,
            },
            profile_file,
        )

    assert not profile_file.exists()


def test_finite_offsets_are_preserved_through_public_profile_storage(
    finite_test_artifact: Path,
) -> None:
    profile_file = finite_test_artifact / "finite-preserved.toml"
    profile = CalibrationProfile(1.25, -2.5, 3.75, -4.125)

    saved = save_profile("finite", profile, profile_file)

    assert saved == profile
    assert load_profile("finite", profile_file) == profile


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_apply_profile_rejects_nonfinite_before_opening_the_input_pdf(
    finite_test_artifact: Path,
    value: float,
) -> None:
    output_path = finite_test_artifact / "transform-nan-output.pdf"

    with pytest.raises(ValueError, match=r"front_x_mm must be finite"):
        apply_profile(
            finite_test_artifact / "transform-nan-input-does-not-exist.pdf",
            output_path,
            {
                "front_x_mm": value,
                "front_y_mm": 0.0,
                "back_x_mm": 0.0,
                "back_y_mm": 0.0,
            },
        )

    assert not output_path.exists()


@pytest.mark.parametrize(
    ("value", "label"),
    [("nan", "nan"), ("+inf", "plus-inf"), ("-inf", "minus-inf")],
)
def test_actual_cli_rejects_nonfinite_offsets_before_storage(
    finite_test_artifact: Path,
    value: str,
    label: str,
) -> None:
    profile_file = finite_test_artifact / f"cli-{label}.toml"
    source_root = Path(__file__).parents[1] / "src"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "printer_calibration",
            "profile",
            "set",
            "--name",
            "invalid",
            f"--front-x-mm={value}",
            "--front-y-mm",
            "0",
            "--back-x-mm",
            "0",
            "--back-y-mm",
            "0",
            "--profile-file",
            str(profile_file),
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(source_root),
        },
    )

    assert result.returncode == 1
    assert "front_x_mm must be finite" in result.stderr
    assert not profile_file.exists()
