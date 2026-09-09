"""Validation for calibration offsets supplied through every public surface."""

from __future__ import annotations

import math
from typing import Mapping, cast

_OFFSET_FIELDS = ("front_x_mm", "front_y_mm", "back_x_mm", "back_y_mm")
DEFAULT_PAPER_SIZE = "letter"
DEFAULT_DUPLEX_MODE = "long-edge"
_SUPPORTED_PAPER_SIZES = frozenset({DEFAULT_PAPER_SIZE})
_SUPPORTED_DUPLEX_MODES = frozenset({DEFAULT_DUPLEX_MODE})


def validate_finite_value(value: object, field: str) -> float:
    """Return *value* as a finite float with a field-specific error."""
    try:
        number = float(cast(float | str, value))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} must be finite")
    return number


def validate_finite_offsets(values: Mapping[str, object]) -> dict[str, float]:
    """Return the four calibration offsets as finite floats.

    Non-finite values cannot be serialized safely or used in PDF transforms.
    """
    validated: dict[str, float] = {}
    for field in _OFFSET_FIELDS:
        try:
            value = values[field]
        except KeyError as exc:
            raise ValueError(f"{field} must be a finite number") from exc
        validated[field] = validate_finite_value(value, field)
    return validated


def validate_profile_metadata(values: Mapping[str, object]) -> dict[str, str]:
    """Return supported paper and duplex metadata without substituting values."""
    paper_size = values.get("paper_size", DEFAULT_PAPER_SIZE)
    duplex_mode = values.get("duplex_mode", DEFAULT_DUPLEX_MODE)
    if not isinstance(paper_size, str) or paper_size not in _SUPPORTED_PAPER_SIZES:
        raise ValueError("paper_size must be supported (supported values: letter)")
    if not isinstance(duplex_mode, str) or duplex_mode not in _SUPPORTED_DUPLEX_MODES:
        raise ValueError("duplex_mode must be supported (supported values: long-edge)")
    return {"paper_size": paper_size, "duplex_mode": duplex_mode}
