import argparse
import sys
import traceback
from pathlib import Path


def _default_profile_file() -> str:
    return str(Path.home() / ".printer-calibration" / "profiles.toml")


def _add_profile_file_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--profile-file",
        default=_default_profile_file(),
        help="Path to profiles TOML file (default: ~/.printer-calibration/profiles.toml)",
    )


def _build_parser() -> tuple[argparse.ArgumentParser, argparse.ArgumentParser]:
    parser = argparse.ArgumentParser(
        prog="printer-calibration",
        description=(
            "Duplex printer calibration tool. "
            "v1: US Letter, long-edge duplex, translation only"
        ),
    )
    subparsers = parser.add_subparsers(dest="command")

    _SIGN_V1 = "+X = move content right, +Y = move content up. v1: US Letter, long-edge duplex, translation only."

    # -- sheet ----------------------------------------------------------------
    sheet_p = subparsers.add_parser(
        "sheet",
        help="Generate a 2-page calibration sheet PDF. " + _SIGN_V1,
    )
    sheet_p.add_argument(
        "--output",
        required=True,
        metavar="PATH",
        help="Path to write the 2-page calibration PDF",
    )

    # -- profile group --------------------------------------------------------
    profile_p = subparsers.add_parser(
        "profile",
        help="Manage calibration profiles. " + _SIGN_V1,
    )
    profile_sub = profile_p.add_subparsers(dest="profile_command")

    # profile set
    set_p = profile_sub.add_parser(
        "set",
        help="Create or update a calibration profile. " + _SIGN_V1,
    )
    set_p.add_argument("--name", required=True, help="Profile name")
    set_p.add_argument(
        "--front-x-mm",
        required=True,
        type=float,
        dest="front_x_mm",
        metavar="MM",
        help="Front page X offset in mm (+X = move content right, +Y = move content up)",
    )
    set_p.add_argument(
        "--front-y-mm",
        required=True,
        type=float,
        dest="front_y_mm",
        metavar="MM",
        help="Front page Y offset in mm (+X = move content right, +Y = move content up)",
    )
    set_p.add_argument(
        "--back-x-mm",
        required=True,
        type=float,
        dest="back_x_mm",
        metavar="MM",
        help="Back page X offset in mm (+X = move content right, +Y = move content up)",
    )
    set_p.add_argument(
        "--back-y-mm",
        required=True,
        type=float,
        dest="back_y_mm",
        metavar="MM",
        help="Back page Y offset in mm (+X = move content right, +Y = move content up)",
    )
    _add_profile_file_arg(set_p)

    # profile list
    list_p = profile_sub.add_parser(
        "list",
        help="List all saved profile names. " + _SIGN_V1,
    )
    _add_profile_file_arg(list_p)

    # profile show
    show_p = profile_sub.add_parser(
        "show",
        help="Show details of a named profile. " + _SIGN_V1,
    )
    show_p.add_argument("--name", required=True, help="Profile name")
    _add_profile_file_arg(show_p)

    # profile delete
    delete_p = profile_sub.add_parser(
        "delete",
        help="Delete a named profile. " + _SIGN_V1,
    )
    delete_p.add_argument("--name", required=True, help="Profile name")
    _add_profile_file_arg(delete_p)

    # -- apply ----------------------------------------------------------------
    apply_p = subparsers.add_parser(
        "apply",
        help=(
            "Apply a calibration profile to a PDF. "
            "+X = move content right, +Y = move content up. "
            "v1: US Letter, long-edge duplex, translation only."
        ),
    )
    apply_p.add_argument(
        "--profile",
        required=True,
        dest="profile_name",
        metavar="NAME",
        help="Profile name to apply",
    )
    apply_p.add_argument(
        "--input", required=True, dest="input_pdf", metavar="PDF", help="Input PDF path"
    )
    apply_p.add_argument(
        "--output",
        dest="output_pdf",
        metavar="PDF",
        default=None,
        help="Output PDF path (default: <input-stem>.calibrated.pdf next to input)",
    )
    _add_profile_file_arg(apply_p)

    return parser, profile_p


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _handle_sheet(args: argparse.Namespace) -> None:
    from printer_calibration.sheet import generate_sheet

    try:
        generate_sheet(args.output)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


def _handle_profile_set(args: argparse.Namespace) -> None:
    from printer_calibration.profile import set_profile

    try:
        set_profile(
            name=args.name,
            front_x_mm=args.front_x_mm,
            front_y_mm=args.front_y_mm,
            back_x_mm=args.back_x_mm,
            back_y_mm=args.back_y_mm,
            profile_file=args.profile_file,
        )
        print(f"Profile '{args.name}' saved to {args.profile_file}")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


def _handle_profile_list(args: argparse.Namespace) -> None:
    from printer_calibration.profile import list_profiles

    try:
        names = list_profiles(profile_file=args.profile_file)
        for name in names:
            print(name)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


def _handle_profile_show(args: argparse.Namespace) -> None:
    from printer_calibration.profile import show_profile

    try:
        profile = show_profile(name=args.name, profile_file=args.profile_file)
        for key, value in profile.items():
            print(f"{key}: {value}")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


def _handle_profile_delete(args: argparse.Namespace) -> None:
    from printer_calibration.profile import delete_profile

    try:
        delete_profile(name=args.name, profile_file=args.profile_file)
        print(f"Profile '{args.name}' deleted.")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


def _handle_apply(args: argparse.Namespace) -> None:
    from printer_calibration.profile import get_profile
    from printer_calibration.transform import apply_profile

    input_path = Path(args.input_pdf)
    if args.output_pdf is not None:
        output_path = Path(args.output_pdf)
    else:
        output_path = input_path.parent / (input_path.stem + ".calibrated.pdf")

    try:
        profile = get_profile(name=args.profile_name, profile_file=args.profile_file)
        apply_profile(str(input_path), str(output_path), profile)
        print(f"Calibrated PDF written to {output_path}")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc()
        print(f"Unexpected error: {exc}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser, profile_p = _build_parser()
    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    if args.command == "sheet":
        _handle_sheet(args)

    elif args.command == "profile":
        if args.profile_command is None:
            profile_p.print_help()
            sys.exit(0)
        elif args.profile_command == "set":
            _handle_profile_set(args)
        elif args.profile_command == "list":
            _handle_profile_list(args)
        elif args.profile_command == "show":
            _handle_profile_show(args)
        elif args.profile_command == "delete":
            _handle_profile_delete(args)
        else:
            profile_p.print_help()
            sys.exit(1)

    elif args.command == "apply":
        _handle_apply(args)

    else:
        parser.print_help()
        sys.exit(1)
