from __future__ import annotations

import importlib.util
import multiprocessing
import queue
from pathlib import Path
from typing import Any

import pytest


_SOURCE_PATH = Path(__file__).parents[1] / "src" / "printer_calibration" / "profile.py"
_WORKER_TIMEOUT_SECONDS = 15


def _load_profile_module() -> Any:
    spec = importlib.util.spec_from_file_location("profile_locking_under_test", _SOURCE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _profile_values(offset: float) -> tuple[float, float, float, float]:
    return (offset, offset + 1, offset + 2, offset + 3)


def _coordinated_writer(
    profile_file: str,
    name: str,
    offset: float,
    start_barrier: Any,
    first_loaded: Any,
    second_attempted: Any,
    release_first: Any,
    is_first: bool,
    result_queue: Any,
) -> None:
    module = _load_profile_module()
    try:
        start_barrier.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        if is_first:
            real_load = module._load

            def pause_after_load(path: Path) -> dict:
                data = real_load(path)
                first_loaded.set()
                if not release_first.wait(timeout=_WORKER_TIMEOUT_SECONDS):
                    raise TimeoutError("first writer was not released")
                return data

            module._load = pause_after_load
        else:
            if not first_loaded.wait(timeout=_WORKER_TIMEOUT_SECONDS):
                raise TimeoutError("first writer did not load the profile")
            second_attempted.set()

        module.set_profile(name, *_profile_values(offset), profile_file)
        result_queue.put((name, "saved", ""))
    except BaseException as error:
        result_queue.put((name, "error", repr(error)))


def _coordinated_delete_or_set(
    profile_file: str,
    start_barrier: Any,
    delete_loaded: Any,
    set_attempted: Any,
    release_delete: Any,
    is_deleter: bool,
    result_queue: Any,
) -> None:
    module = _load_profile_module()
    try:
        start_barrier.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        if is_deleter:
            real_load = module._load

            def pause_after_load(path: Path) -> dict:
                data = real_load(path)
                delete_loaded.set()
                if not release_delete.wait(timeout=_WORKER_TIMEOUT_SECONDS):
                    raise TimeoutError("deleter was not released")
                return data

            module._load = pause_after_load
            module.delete_profile("existing", profile_file)
            result_queue.put(("delete", "saved", ""))
        else:
            if not delete_loaded.wait(timeout=_WORKER_TIMEOUT_SECONDS):
                raise TimeoutError("deleter did not load the profile")
            set_attempted.set()
            module.set_profile("second", *_profile_values(10), profile_file)
            result_queue.put(("set", "saved", ""))
    except BaseException as error:
        result_queue.put(("delete" if is_deleter else "set", "error", repr(error)))


def _exception_then_recovery_writer(
    profile_file: str,
    start_barrier: Any,
    write_failed: Any,
    is_failing_writer: bool,
    result_queue: Any,
) -> None:
    module = _load_profile_module()
    try:
        start_barrier.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        if is_failing_writer:
            def fail_save(_path: Path, _data: dict) -> None:
                raise OSError("simulated save failure")

            module._save = fail_save
            with pytest.raises(OSError, match="simulated save failure"):
                module.set_profile("failing", *_profile_values(1), profile_file)
            write_failed.set()
            result_queue.put(("failing", "failed-as-expected", ""))
        else:
            if not write_failed.wait(timeout=_WORKER_TIMEOUT_SECONDS):
                raise TimeoutError("failing writer did not finish")
            module.set_profile("recovered", *_profile_values(10), profile_file)
            result_queue.put(("recovered", "saved", ""))
    except BaseException as error:
        result_queue.put(("failing" if is_failing_writer else "recovered", "error", repr(error)))


def _join_or_fail(processes: tuple[Any, ...]) -> None:
    for process in processes:
        process.join(timeout=_WORKER_TIMEOUT_SECONDS)
    alive = [process.pid for process in processes if process.is_alive()]
    if alive:
        for process in processes:
            process.terminate()
        pytest.fail(f"worker processes did not finish: {alive}")
    assert [process.exitcode for process in processes] == [0] * len(processes)


def _drain_results(result_queue: Any, count: int) -> dict[str, tuple[str, str]]:
    results: dict[str, tuple[str, str]] = {}
    for _ in range(count):
        name, status, detail = result_queue.get(timeout=_WORKER_TIMEOUT_SECONDS)
        results[name] = (status, detail)
    return results


def test_two_process_writers_keep_distinct_profiles_when_first_writer_is_paused_after_load(
    tmp_path: Path,
) -> None:
    profile_file = tmp_path / "profiles.toml"
    context = multiprocessing.get_context("spawn")
    start_barrier = context.Barrier(2)
    first_loaded = context.Event()
    second_attempted = context.Event()
    release_first = context.Event()
    result_queue = context.Queue()
    first = context.Process(
        target=_coordinated_writer,
        args=(
            str(profile_file),
            "first",
            1,
            start_barrier,
            first_loaded,
            second_attempted,
            release_first,
            True,
            result_queue,
        ),
    )
    second = context.Process(
        target=_coordinated_writer,
        args=(
            str(profile_file),
            "second",
            10,
            start_barrier,
            first_loaded,
            second_attempted,
            release_first,
            False,
            result_queue,
        ),
    )

    first.start()
    second.start()
    try:
        assert first_loaded.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        assert second_attempted.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        with pytest.raises(queue.Empty):
            result_queue.get(timeout=1)
        release_first.set()
        _join_or_fail((first, second))
    finally:
        release_first.set()
        for process in (first, second):
            if process.is_alive():
                process.terminate()
                process.join(timeout=_WORKER_TIMEOUT_SECONDS)

    assert _drain_results(result_queue, 2) == {
        "first": ("saved", ""),
        "second": ("saved", ""),
    }
    module = _load_profile_module()
    assert set(module.list_profiles(profile_file)) == {"first", "second"}


def test_delete_keeps_a_concurrent_new_profile_when_paused_after_load(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.toml"
    _load_profile_module().set_profile("existing", *_profile_values(1), profile_file)
    context = multiprocessing.get_context("spawn")
    start_barrier = context.Barrier(2)
    delete_loaded = context.Event()
    set_attempted = context.Event()
    release_delete = context.Event()
    result_queue = context.Queue()
    deleter = context.Process(
        target=_coordinated_delete_or_set,
        args=(
            str(profile_file),
            start_barrier,
            delete_loaded,
            set_attempted,
            release_delete,
            True,
            result_queue,
        ),
    )
    setter = context.Process(
        target=_coordinated_delete_or_set,
        args=(
            str(profile_file),
            start_barrier,
            delete_loaded,
            set_attempted,
            release_delete,
            False,
            result_queue,
        ),
    )

    deleter.start()
    setter.start()
    try:
        assert delete_loaded.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        assert set_attempted.wait(timeout=_WORKER_TIMEOUT_SECONDS)
        with pytest.raises(queue.Empty):
            result_queue.get(timeout=1)
        release_delete.set()
        _join_or_fail((deleter, setter))
    finally:
        release_delete.set()
        for process in (deleter, setter):
            if process.is_alive():
                process.terminate()
                process.join(timeout=_WORKER_TIMEOUT_SECONDS)

    assert _drain_results(result_queue, 2) == {
        "delete": ("saved", ""),
        "set": ("saved", ""),
    }
    assert _load_profile_module().list_profiles(profile_file) == ["second"]


def test_failed_writer_releases_lock_for_barrier_controlled_recovery_process(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.toml"
    context = multiprocessing.get_context("spawn")
    start_barrier = context.Barrier(2)
    write_failed = context.Event()
    result_queue = context.Queue()
    failing = context.Process(
        target=_exception_then_recovery_writer,
        args=(str(profile_file), start_barrier, write_failed, True, result_queue),
    )
    recovery = context.Process(
        target=_exception_then_recovery_writer,
        args=(str(profile_file), start_barrier, write_failed, False, result_queue),
    )

    failing.start()
    recovery.start()
    try:
        _join_or_fail((failing, recovery))
    finally:
        for process in (failing, recovery):
            if process.is_alive():
                process.terminate()
                process.join(timeout=_WORKER_TIMEOUT_SECONDS)

    assert _drain_results(result_queue, 2) == {
        "failing": ("failed-as-expected", ""),
        "recovered": ("saved", ""),
    }
    module = _load_profile_module()
    assert module.list_profiles(profile_file) == ["recovered"]
