"""Validation for calibration offsets supplied through every public surface."""

from __future__ import annotations

import math
from typing import Mapping, cast

_OFFSET_FIELDS = ("front_x_mm", "front_y_mm", "back_x_mm", "back_y_mm")


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
