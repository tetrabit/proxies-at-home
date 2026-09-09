import os
import tempfile
import tomllib
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator, Union

import tomli_w

from printer_calibration.validation import validate_finite_offsets

if os.name == "nt":
    import msvcrt
else:
    import fcntl

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
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            tomli_w.dump(data, temporary_file)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
    except Exception:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
        raise


def _acquire_lock(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
    else:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _release_lock(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@contextmanager
def _profile_lock(path: Path) -> Iterator[None]:
    """Serialize profile read-modify-write operations with a stable sidecar file."""
    lock_path = path.with_name(f".{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        _acquire_lock(lock_file)
        try:
            yield
        finally:
            _release_lock(lock_file)


def set_profile(
    name: str,
    front_x_mm: float,
    front_y_mm: float,
    back_x_mm: float,
    back_y_mm: float,
    profile_file: Union[Path, str, None] = None,
) -> None:
    offsets = validate_finite_offsets(
        {
            "front_x_mm": front_x_mm,
            "front_y_mm": front_y_mm,
            "back_x_mm": back_x_mm,
            "back_y_mm": back_y_mm,
        }
    )
    path = _resolve_path(profile_file)
    with _profile_lock(path):
        data = _load(path)
        data["profiles"][name] = {
            "paper_size": "letter",
            "duplex_mode": "long-edge",
            **offsets,
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
    with _profile_lock(path):
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
