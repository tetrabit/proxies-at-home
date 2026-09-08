from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import tomllib
import types
from pathlib import Path

import pytest


_SOURCE_PATH = Path(__file__).parents[1] / "src" / "printer_calibration" / "profile.py"
_INITIAL_TOML = b'''version = 1

[profiles.existing]
paper_size = "letter"
duplex_mode = "long-edge"
front_x_mm = 0.0
front_y_mm = 0.0
back_x_mm = 0.0
back_y_mm = 0.0
'''


def _fallback_tomli_w() -> types.ModuleType:
    module = types.ModuleType("tomli_w")

    def dump(data: dict, file: object) -> None:
        lines = [f"version = {data.get('version', 1)}"]
        for name, values in data["profiles"].items():
            lines.extend(("", f"[profiles.{name}]"))
            for key, value in values.items():
                encoded = json.dumps(value) if isinstance(value, str) else str(value)
                lines.append(f"{key} = {encoded}")
        file.write(("\n".join(lines) + "\n").encode())

    module.dump = dump  # type: ignore[attr-defined]
    return module


@pytest.fixture
def profile_module(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    if importlib.util.find_spec("tomli_w") is None:
        monkeypatch.setitem(sys.modules, "tomli_w", _fallback_tomli_w())

    spec = importlib.util.spec_from_file_location("profile_atomic_under_test", _SOURCE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_set_profile_replaces_complete_toml_from_same_directory(
    tmp_path: Path,
    profile_module: types.ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_file = tmp_path / "profiles" / "profiles.toml"
    profile_file.parent.mkdir()
    profile_file.write_bytes(_INITIAL_TOML)
    replace_calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def observe_replace(source: str | Path, destination: str | Path) -> None:
        source_path = Path(source)
        destination_path = Path(destination)
        replace_calls.append((source_path, destination_path))
        assert source_path.parent == profile_file.parent
        assert destination_path == profile_file
        with source_path.open("rb") as temporary_file:
            temporary_data = tomllib.load(temporary_file)
        assert set(temporary_data["profiles"]) == {"existing", "new"}
        real_replace(source_path, destination_path)

    monkeypatch.setattr(profile_module, "os", os, raising=False)
    monkeypatch.setattr(profile_module.os, "replace", observe_replace)

    profile_module.set_profile("new", 1, 2, 3, 4, profile_file)

    assert len(replace_calls) == 1
    with profile_file.open("rb") as saved_file:
        saved_data = tomllib.load(saved_file)
    assert set(saved_data["profiles"]) == {"existing", "new"}


def test_set_profile_replace_failure_preserves_old_bytes_and_cleans_tempfile(
    tmp_path: Path,
    profile_module: types.ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_file = tmp_path / "profiles" / "profiles.toml"
    profile_file.parent.mkdir()
    profile_file.write_bytes(_INITIAL_TOML)
    original_bytes = profile_file.read_bytes()

    def fail_replace(source: str | Path, destination: str | Path) -> None:
        source_path = Path(source)
        assert Path(destination) == profile_file
        with source_path.open("rb") as temporary_file:
            assert set(tomllib.load(temporary_file)["profiles"]) == {"existing", "new"}
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(profile_module, "os", os, raising=False)
    monkeypatch.setattr(profile_module.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated replacement failure"):
        profile_module.set_profile("new", 1, 2, 3, 4, profile_file)

    assert profile_file.read_bytes() == original_bytes
    assert list(profile_file.parent.glob(".profiles.toml.*.tmp")) == []


def test_set_profile_fsyncs_tempfile_before_replacing(
    tmp_path: Path,
    profile_module: types.ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_file = tmp_path / "profiles" / "profiles.toml"
    profile_file.parent.mkdir()
    profile_file.write_bytes(_INITIAL_TOML)
    events: list[str] = []
    real_fsync = os.fsync
    real_replace = os.replace

    def observe_fsync(file_descriptor: int) -> None:
        events.append("fsync")
        real_fsync(file_descriptor)

    def observe_replace(source: str | Path, destination: str | Path) -> None:
        events.append("replace")
        assert events == ["fsync", "replace"]
        real_replace(source, destination)

    monkeypatch.setattr(profile_module, "os", os, raising=False)
    monkeypatch.setattr(profile_module.os, "fsync", observe_fsync)
    monkeypatch.setattr(profile_module.os, "replace", observe_replace)

    profile_module.set_profile("new", 1, 2, 3, 4, profile_file)

    assert events == ["fsync", "replace"]


def test_set_profile_write_failure_preserves_old_bytes_and_cleans_tempfile(
    tmp_path: Path,
    profile_module: types.ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_file = tmp_path / "profiles" / "profiles.toml"
    profile_file.parent.mkdir()
    profile_file.write_bytes(_INITIAL_TOML)
    original_bytes = profile_file.read_bytes()

    def fail_dump(_data: dict, temporary_file: object) -> None:
        temporary_file.write(b"[profiles.incomplete]\n")  # type: ignore[attr-defined]
        raise OSError("simulated write failure")

    monkeypatch.setattr(profile_module.tomli_w, "dump", fail_dump)

    with pytest.raises(OSError, match="simulated write failure"):
        profile_module.set_profile("new", 1, 2, 3, 4, profile_file)

    assert profile_file.read_bytes() == original_bytes
    assert list(profile_file.parent.glob(".profiles.toml.*.tmp")) == []


def test_readers_only_observe_complete_toml_during_profile_write(
    tmp_path: Path,
    profile_module: types.ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_file = tmp_path / "profiles" / "profiles.toml"
    profile_file.parent.mkdir()
    profile_file.write_bytes(_INITIAL_TOML)
    partial_written = threading.Event()
    reads_finished = threading.Event()
    parse_errors: list[Exception] = []
    complete_toml = _INITIAL_TOML + b'''\n[profiles.new]\npaper_size = "letter"\nduplex_mode = "long-edge"\nfront_x_mm = 1.0\nfront_y_mm = 2.0\nback_x_mm = 3.0\nback_y_mm = 4.0\n'''

    def slow_dump(_data: dict, temporary_file: object) -> None:
        temporary_file.write(complete_toml[:10])  # type: ignore[attr-defined]
        temporary_file.flush()  # type: ignore[attr-defined]
        partial_written.set()
        assert reads_finished.wait(timeout=1)
        temporary_file.write(complete_toml[10:])  # type: ignore[attr-defined]

    def read_while_write_is_partial() -> None:
        assert partial_written.wait(timeout=1)
        try:
            for _ in range(100):
                tomllib.loads(profile_file.read_text())
        except Exception as error:  # pragma: no cover - asserted below
            parse_errors.append(error)
        finally:
            reads_finished.set()

    monkeypatch.setattr(profile_module.tomli_w, "dump", slow_dump)
    reader = threading.Thread(target=read_while_write_is_partial)
    reader.start()
    try:
        profile_module.set_profile("new", 1, 2, 3, 4, profile_file)
    finally:
        reads_finished.set()
        reader.join(timeout=1)

    assert not reader.is_alive()
    assert parse_errors == []
    with profile_file.open("rb") as saved_file:
        assert set(tomllib.load(saved_file)["profiles"]) == {"existing", "new"}
