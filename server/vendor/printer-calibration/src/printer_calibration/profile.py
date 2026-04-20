import tomllib
from pathlib import Path
from typing import Union

import tomli_w

_DEFAULT_PROFILE_FILE = Path.home() / ".printer-calibration" / "profiles.toml"


def _resolve_path(profile_file: Union[Path, str, None]) -> Path:
    if profile_file is None:
        return _DEFAULT_PROFILE_FILE
    return Path(profile_file)


def _load(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "profiles": {}}
    with path.open("rb") as f:
        data = tomllib.load(f)
    if "profiles" not in data:
        data["profiles"] = {}
    return data


def _save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        tomli_w.dump(data, f)


def set_profile(
    name: str,
    front_x_mm: float,
    front_y_mm: float,
    back_x_mm: float,
    back_y_mm: float,
    profile_file: Union[Path, str, None] = None,
) -> None:
    path = _resolve_path(profile_file)
    data = _load(path)
    data["profiles"][name] = {
        "paper_size": "letter",
        "duplex_mode": "long-edge",
        "front_x_mm": float(front_x_mm),
        "front_y_mm": float(front_y_mm),
        "back_x_mm": float(back_x_mm),
        "back_y_mm": float(back_y_mm),
    }
    _save(path, data)


def list_profiles(profile_file: Union[Path, str, None] = None) -> list[str]:
    path = _resolve_path(profile_file)
    data = _load(path)
    return list(data["profiles"].keys())


def show_profile(name: str, profile_file: Union[Path, str, None] = None) -> dict:
    return get_profile(name, profile_file)


def delete_profile(name: str, profile_file: Union[Path, str, None] = None) -> None:
    path = _resolve_path(profile_file)
    data = _load(path)
    if name not in data["profiles"]:
        raise ValueError(f"Profile '{name}' not found")
    del data["profiles"][name]
    _save(path, data)


def get_profile(name: str, profile_file: Union[Path, str, None] = None) -> dict:
    path = _resolve_path(profile_file)
    data = _load(path)
    if name not in data["profiles"]:
        raise ValueError(f"Profile '{name}' not found")
    return dict(data["profiles"][name])
