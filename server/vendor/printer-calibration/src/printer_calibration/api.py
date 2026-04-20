"""Public library API for printer_calibration.

This module gives other Python projects a stable surface for generating
calibration sheets, computing offsets from measurements, storing profiles, and
applying those profiles to PDFs.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, cast

from printer_calibration.constants import CENTER_X_MM, CENTER_Y_MM
from printer_calibration.profile import (
    delete_profile,
    get_profile,
    list_profiles,
    set_profile,
)
from printer_calibration.sheet import generate_sheet
from printer_calibration.transform import apply_profile


def _as_float(data: Mapping[str, object], key: str) -> float:
    return float(cast(float | str, data[key]))


def _as_str(data: Mapping[str, object], key: str, default: str) -> str:
    value = data.get(key, default)
    return str(value)


@dataclass(frozen=True, slots=True)
class CalibrationProfile:
    """A reusable calibration profile expressed in floating-point millimeters."""

    front_x_mm: float
    front_y_mm: float
    back_x_mm: float
    back_y_mm: float
    paper_size: str = "letter"
    duplex_mode: str = "long-edge"

    def to_dict(self) -> dict[str, float | str]:
        """Return the profile in the TOML-compatible shape used internally."""
        return {
            "paper_size": self.paper_size,
            "duplex_mode": self.duplex_mode,
            "front_x_mm": float(self.front_x_mm),
            "front_y_mm": float(self.front_y_mm),
            "back_x_mm": float(self.back_x_mm),
            "back_y_mm": float(self.back_y_mm),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, object]) -> "CalibrationProfile":
        """Build a typed profile from a mapping-like object."""
        return cls(
            front_x_mm=_as_float(data, "front_x_mm"),
            front_y_mm=_as_float(data, "front_y_mm"),
            back_x_mm=_as_float(data, "back_x_mm"),
            back_y_mm=_as_float(data, "back_y_mm"),
            paper_size=_as_str(data, "paper_size", "letter"),
            duplex_mode=_as_str(data, "duplex_mode", "long-edge"),
        )


def calculate_axis_offset(expected_mm: float, measured_mm: float) -> float:
    """Convert an observed measurement into the signed correction offset.

    Positive X moves content right. Positive Y moves content up.
    The offset formula is: expected - measured.
    """
    return float(expected_mm) - float(measured_mm)


def calculate_profile(
    front_x_measured_mm: float,
    front_y_measured_mm: float,
    back_x_measured_mm: float,
    back_y_measured_mm: float,
) -> CalibrationProfile:
    """Create a calibration profile from measured front/back distances."""
    return CalibrationProfile(
        front_x_mm=calculate_axis_offset(CENTER_X_MM, front_x_measured_mm),
        front_y_mm=calculate_axis_offset(CENTER_Y_MM, front_y_measured_mm),
        back_x_mm=calculate_axis_offset(CENTER_X_MM, back_x_measured_mm),
        back_y_mm=calculate_axis_offset(CENTER_Y_MM, back_y_measured_mm),
    )


def generate_calibration_sheet(output_path: str | Path) -> None:
    """Generate the 2-page calibration sheet PDF."""
    generate_sheet(output_path)


def apply_calibration(
    input_path: str | Path,
    output_path: str | Path,
    profile: CalibrationProfile | Mapping[str, object],
) -> None:
    """Apply a profile to a PDF using the library-friendly profile type."""
    apply_profile(input_path, output_path, _coerce_profile(profile))


def save_profile(
    name: str,
    profile: CalibrationProfile | Mapping[str, object],
    profile_file: str | Path | None = None,
) -> CalibrationProfile:
    """Persist a profile and return the typed profile that was saved."""
    typed = CalibrationProfile.from_dict(_coerce_profile(profile))
    set_profile(
        name=name,
        front_x_mm=typed.front_x_mm,
        front_y_mm=typed.front_y_mm,
        back_x_mm=typed.back_x_mm,
        back_y_mm=typed.back_y_mm,
        profile_file=profile_file,
    )
    return typed


def load_profile(
    name: str,
    profile_file: str | Path | None = None,
) -> CalibrationProfile:
    """Load a saved profile as a typed object."""
    return CalibrationProfile.from_dict(get_profile(name, profile_file=profile_file))


def list_saved_profiles(profile_file: str | Path | None = None) -> list[str]:
    """List profile names from storage."""
    return list_profiles(profile_file=profile_file)


def delete_saved_profile(name: str, profile_file: str | Path | None = None) -> None:
    """Delete a saved profile from storage."""
    delete_profile(name, profile_file=profile_file)


def _coerce_profile(
    profile: CalibrationProfile | Mapping[str, object],
) -> dict[str, float | str]:
    if isinstance(profile, CalibrationProfile):
        return profile.to_dict()
    return CalibrationProfile.from_dict(profile).to_dict()
