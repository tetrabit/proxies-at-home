from __future__ import annotations

import contextlib
import importlib
import importlib.util
import os
import subprocess
import sys
import tomllib
import uuid
from io import StringIO
from pathlib import Path

import pytest


_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_ARTIFACT_ROOT = _REPOSITORY_ROOT / ".review-artifacts" / "cli-adapter-reconciliation-01"
_SOURCE_ROOT = Path(__file__).parents[1] / "src"
_PROTECTED_ARTIFACT_PARTS = frozenset(
    {".git", ".todos", ".recovery", "evidence", "env", "ancestors"}
)
_CLI_SPEC = importlib.util.spec_from_file_location(
    "printer_calibration_cli_under_test",
    Path(__file__).parents[1] / "src" / "printer_calibration" / "cli.py",
)
assert _CLI_SPEC is not None and _CLI_SPEC.loader is not None
cli = importlib.util.module_from_spec(_CLI_SPEC)
_CLI_SPEC.loader.exec_module(cli)


def _new_artifact_path(label: str) -> Path:
    artifact_root = _ARTIFACT_ROOT.resolve(strict=True)
    if any(part in _PROTECTED_ARTIFACT_PARTS for part in artifact_root.parts):
        raise RuntimeError("refusing protected review-artifact path")

    candidate = artifact_root / f"{label}-{uuid.uuid4().hex}"
    candidate.mkdir()
    return candidate


def _require_cli_dependencies() -> None:
    missing_dependencies = [
        name
        for name in ("pypdf", "reportlab", "tomli_w")
        if importlib.util.find_spec(name) is None
    ]
    if missing_dependencies:
        pytest.skip(
            "actual CLI dependencies are unavailable: " + ", ".join(missing_dependencies)
        )


def _run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    _require_cli_dependencies()

    return subprocess.run(
        [sys.executable, "-m", "printer_calibration", *arguments],
        capture_output=True,
        check=False,
        encoding="utf-8",
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(_SOURCE_ROOT),
        },
    )


def _write_two_page_pdf(path: Path) -> None:
    writer = importlib.import_module("pypdf").PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.add_blank_page(width=612, height=792)
    with path.open("wb") as output_file:
        writer.write(output_file)


def _write_supported_profile(path: Path, *, name: str = "supported") -> None:
    path.write_text(
        "version = 1\n\n"
        f"[profiles.{name}]\n"
        'paper_size = "letter"\n'
        'duplex_mode = "long-edge"\n'
        "front_x_mm = 1.25\n"
        "front_y_mm = -2.5\n"
        "back_x_mm = 3.75\n"
        "back_y_mm = -4.125\n"
    )


def test_command_error_adapter_reports_value_errors_with_existing_string_and_exit_code() -> None:
    stderr = StringIO()

    def raise_value_error() -> None:
        raise ValueError("front_x_mm must be finite")

    with contextlib.redirect_stderr(stderr), pytest.raises(SystemExit) as raised:
        cli._run_command_with_error_adapter(raise_value_error)

    assert raised.value.code == 1
    assert stderr.getvalue() == "Error: front_x_mm must be finite\n"


def test_command_error_adapter_reports_unexpected_errors_with_existing_string_and_exit_code() -> None:
    stderr = StringIO()

    def raise_runtime_error() -> None:
        raise RuntimeError("storage unavailable")

    with contextlib.redirect_stderr(stderr), pytest.raises(SystemExit) as raised:
        cli._run_command_with_error_adapter(raise_runtime_error)

    assert raised.value.code == 1
    assert "RuntimeError: storage unavailable\n" in stderr.getvalue()
    assert stderr.getvalue().endswith("Unexpected error: storage unavailable\n")


@pytest.mark.parametrize("exception", [KeyboardInterrupt(), SystemExit(7)])
def test_command_error_adapter_propagates_base_exceptions(exception: BaseException) -> None:
    def raise_base_exception() -> None:
        raise exception

    with pytest.raises(type(exception)) as raised:
        cli._run_command_with_error_adapter(raise_base_exception)

    if isinstance(exception, SystemExit):
        assert raised.value.code == 7


@pytest.mark.parametrize(
    ("label", "arguments", "expected_error"),
    [
        (
            "sheet",
            ("sheet", "--output", "{artifact}/missing/calibration.pdf"),
            "Error: Output directory does not exist: {artifact}/missing\n",
        ),
        (
            "profile-set-finite",
            (
                "profile",
                "set",
                "--name",
                "invalid",
                "--front-x-mm",
                "nan",
                "--front-y-mm",
                "0",
                "--back-x-mm",
                "0",
                "--back-y-mm",
                "0",
                "--profile-file",
                "{artifact}/profiles.toml",
            ),
            "Error: front_x_mm must be finite\n",
        ),
        (
            "profile-show-metadata",
            (
                "profile",
                "show",
                "--name",
                "unsupported",
                "--profile-file",
                "{artifact}/profiles.toml",
            ),
            "Error: duplex_mode must be supported (supported values: long-edge)\n",
        ),
        (
            "profile-delete",
            (
                "profile",
                "delete",
                "--name",
                "missing",
                "--profile-file",
                "{artifact}/profiles.toml",
            ),
            "Error: Profile 'missing' not found\n",
        ),
        (
            "apply-missing-profile",
            (
                "apply",
                "--profile",
                "missing",
                "--input",
                "{artifact}/input.pdf",
                "--profile-file",
                "{artifact}/profiles.toml",
            ),
            "Error: Profile 'missing' not found\n",
        ),
    ],
)
def test_actual_cli_value_errors_keep_existing_error_string_and_exit_code(
    label: str, arguments: tuple[str, ...], expected_error: str
) -> None:
    artifact = _new_artifact_path(label)
    if label == "profile-show-metadata":
        _write_supported_profile(artifact / "profiles.toml", name="unsupported")
        (artifact / "profiles.toml").write_text(
            (artifact / "profiles.toml")
            .read_text()
            .replace('duplex_mode = "long-edge"', 'duplex_mode = "short-edge"')
        )

    result = _run_cli(*(argument.format(artifact=artifact) for argument in arguments))

    assert result.returncode == 1
    assert result.stderr == expected_error.format(artifact=artifact)


def test_actual_cli_profile_list_keeps_existing_unexpected_error_string_and_exit_code() -> None:
    artifact = _new_artifact_path("profile-list")
    profile_file = artifact / "profiles.toml"
    malformed_toml = "not valid toml = [\n"
    profile_file.write_text(malformed_toml)

    with pytest.raises(tomllib.TOMLDecodeError) as decode_error:
        tomllib.loads(malformed_toml)

    result = _run_cli("profile", "list", "--profile-file", str(profile_file))

    assert result.returncode == 1
    assert "TOMLDecodeError" in result.stderr
    assert result.stderr.endswith(f"Unexpected error: {decode_error.value}\n")


def test_actual_cli_grouped_duplex_preserves_supported_metadata_and_page_order() -> None:
    _require_cli_dependencies()
    artifact = _new_artifact_path("grouped-duplex")
    profile_file = artifact / "profiles.toml"
    input_pdf = artifact / "input.pdf"
    output_pdf = artifact / "output.pdf"
    _write_two_page_pdf(input_pdf)

    set_result = _run_cli(
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
    )
    assert set_result.returncode == 0, set_result.stderr
    with profile_file.open("rb") as profile_data:
        stored_profile = tomllib.load(profile_data)["profiles"]["supported"]
    assert stored_profile["paper_size"] == "letter"
    assert stored_profile["duplex_mode"] == "long-edge"

    apply_result = _run_cli(
        "apply",
        "--profile",
        "supported",
        "--input",
        str(input_pdf),
        "--output",
        str(output_pdf),
        "--page-mode",
        "grouped-duplex",
        "--front-page-count",
        "1",
        "--profile-file",
        str(profile_file),
    )

    assert apply_result.returncode == 0, apply_result.stderr
    assert apply_result.stdout == f"Calibrated PDF written to {output_pdf}\n"
    assert len(importlib.import_module("pypdf").PdfReader(output_pdf).pages) == 2


def test_actual_cli_grouped_duplex_validation_keeps_existing_error_string_and_exit_code() -> None:
    _require_cli_dependencies()
    artifact = _new_artifact_path("grouped-duplex-error")
    profile_file = artifact / "profiles.toml"
    input_pdf = artifact / "input.pdf"
    _write_supported_profile(profile_file)
    _write_two_page_pdf(input_pdf)

    result = _run_cli(
        "apply",
        "--profile",
        "supported",
        "--input",
        str(input_pdf),
        "--page-mode",
        "grouped-duplex",
        "--front-page-count",
        "0",
        "--profile-file",
        str(profile_file),
    )

    assert result.returncode == 1
    assert result.stderr == (
        "Error: front_page_count must be greater than 0 and less than the input page count\n"
    )
