from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from printer_calibration import CalibrationProfile, load_profile, save_profile
from printer_calibration.transform import apply_profile


@pytest.mark.parametrize(
    ("field", "unsupported_value"),
    [
        ("paper_size", "legal"),
        ("duplex_mode", "short-edge"),
    ],
)
def test_save_profile_rejects_unsupported_metadata_before_creating_storage(
    tmp_path: Path, field: str, unsupported_value: str
) -> None:
    storage_directory = tmp_path / "new-storage"
    profile_file = storage_directory / "profiles.toml"
    profile = {
        "paper_size": "letter",
        "duplex_mode": "long-edge",
        "front_x_mm": 1.25,
        "front_y_mm": -2.5,
        "back_x_mm": 3.75,
        "back_y_mm": -4.125,
    }
    profile[field] = unsupported_value

    with pytest.raises(ValueError, match=rf"{field} must be supported"):
        save_profile("unsupported", profile, profile_file)

    assert not storage_directory.exists()


def test_save_profile_roundtrips_supported_metadata_exactly(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.toml"
    profile = CalibrationProfile(
        front_x_mm=1.25,
        front_y_mm=-2.5,
        back_x_mm=3.75,
        back_y_mm=-4.125,
        paper_size="letter",
        duplex_mode="long-edge",
    )
    expected = {
        "paper_size": "letter",
        "duplex_mode": "long-edge",
        "front_x_mm": 1.25,
        "front_y_mm": -2.5,
        "back_x_mm": 3.75,
        "back_y_mm": -4.125,
    }

    saved = save_profile("supported", profile, profile_file)

    assert saved.to_dict() == expected
    assert load_profile("supported", profile_file).to_dict() == expected
    with profile_file.open("rb") as profile_data:
        assert tomllib.load(profile_data)["profiles"]["supported"] == expected


def test_transform_rejects_unsupported_metadata_before_opening_input(tmp_path: Path) -> None:
    output_path = tmp_path / "output.pdf"

    with pytest.raises(ValueError, match=r"duplex_mode must be supported"):
        apply_profile(
            tmp_path / "does-not-exist.pdf",
            output_path,
            {
                "paper_size": "letter",
                "duplex_mode": "short-edge",
                "front_x_mm": 1.25,
                "front_y_mm": -2.5,
                "back_x_mm": 3.75,
                "back_y_mm": -4.125,
            },
        )

    assert not output_path.exists()


def test_actual_cli_roundtrips_supported_metadata_exactly(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.toml"
    source_root = Path(__file__).parents[1] / "src"
    env = {
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
            "supported",
            "--front-x-mm",
            "1.25",
            "--front-y-mm",
            "-2.5",
            "--back-x-mm",
            "3.75",
            "--back-y-mm",
            "-4.125",
            "--profile-file",
            str(profile_file),
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env=env,
    )
    assert set_result.returncode == 0, set_result.stderr

    show_result = subprocess.run(
        [
            sys.executable,
            "-m",
            "printer_calibration",
            "profile",
            "show",
            "--name",
            "supported",
            "--profile-file",
            str(profile_file),
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env=env,
    )

    assert show_result.returncode == 0, show_result.stderr
    assert show_result.stdout == (
        "paper_size: letter\n"
        "duplex_mode: long-edge\n"
        "front_x_mm: 1.25\n"
        "front_y_mm: -2.5\n"
        "back_x_mm: 3.75\n"
        "back_y_mm: -4.125\n"
    )


@pytest.mark.parametrize(
    ("field", "unsupported_value"),
    [("paper_size", "legal"), ("duplex_mode", "short-edge")],
)
def test_actual_cli_rejects_unsupported_stored_metadata(
    tmp_path: Path, field: str, unsupported_value: str
) -> None:
    profile_file = tmp_path / "profiles.toml"
    profile_file.write_text(
        "version = 1\n\n"
        "[profiles.unsupported]\n"
        f'paper_size = "{unsupported_value if field == "paper_size" else "letter"}"\n'
        f'duplex_mode = "{unsupported_value if field == "duplex_mode" else "long-edge"}"\n'
        "front_x_mm = 1.25\n"
        "front_y_mm = -2.5\n"
        "back_x_mm = 3.75\n"
        "back_y_mm = -4.125\n"
    )
    original_bytes = profile_file.read_bytes()
    source_root = Path(__file__).parents[1] / "src"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "printer_calibration",
            "profile",
            "show",
            "--name",
            "unsupported",
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
    assert f"{field} must be supported" in result.stderr
    assert profile_file.read_bytes() == original_bytes
