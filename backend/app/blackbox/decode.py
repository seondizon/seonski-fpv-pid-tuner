"""Wrapper around the external `blackbox_decode` binary.

LICENSING NOTE (see docs/research/licenses.md#betaflight-blackbox-tools):
`blackbox_decode` (from betaflight/blackbox-tools) is GPL-3.0 licensed. We
invoke it exclusively as a separate, externally-built/installed subprocess
and never vendor, copy, or adapt any of its C source into this repository.
This module MUST remain a thin process-invocation wrapper -- do not port any
decoding/parsing logic from blackbox-tools' C source into Python here.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional, Sequence

from app.config import BLACKBOX_DECODE_BIN

# This file lives at backend/app/blackbox/decode.py, so parents[3] resolves:
#   parents[0] = backend/app/blackbox
#   parents[1] = backend/app
#   parents[2] = backend
#   parents[3] = <repo root>  (fpv-tuner/)
_REPO_ROOT = Path(__file__).resolve().parents[3]

# Where scripts/build_blackbox_decode.sh places the compiled binary.
_VENDOR_BIN = _REPO_ROOT / "vendor" / "blackbox-tools" / "obj" / "blackbox_decode"

_NOT_FOUND_MESSAGE = (
    "Could not locate the `blackbox_decode` binary.\n"
    "Checked, in order:\n"
    "  1. the FPV_TUNER_BLACKBOX_DECODE_BIN environment variable "
    "(app.config.BLACKBOX_DECODE_BIN)\n"
    f"  2. {_VENDOR_BIN}\n"
    "  3. `blackbox_decode` on PATH\n\n"
    "Fix: run `scripts/build_blackbox_decode.sh` from the repo root to clone "
    "and build betaflight/blackbox-tools, or set "
    "FPV_TUNER_BLACKBOX_DECODE_BIN to point at an existing blackbox_decode "
    "binary, or install blackbox_decode somewhere on your PATH."
)


def find_blackbox_decode_binary() -> str:
    """Locate the blackbox_decode binary.

    Priority order:
      1. `app.config.BLACKBOX_DECODE_BIN` (env var `FPV_TUNER_BLACKBOX_DECODE_BIN`)
         override, if set and the path exists.
      2. `<repo_root>/vendor/blackbox-tools/obj/blackbox_decode` (where
         `scripts/build_blackbox_decode.sh` places it).
      3. `blackbox_decode` found on PATH (via `shutil.which`).

    Raises:
        RuntimeError: if none of the above are found, with instructions to
            run scripts/build_blackbox_decode.sh.
    """
    if BLACKBOX_DECODE_BIN:
        override_path = Path(BLACKBOX_DECODE_BIN)
        if override_path.exists():
            return str(override_path)

    if _VENDOR_BIN.exists():
        return str(_VENDOR_BIN)

    found_on_path = shutil.which("blackbox_decode")
    if found_on_path:
        return found_on_path

    raise RuntimeError(_NOT_FOUND_MESSAGE)


# blackbox-tools issue #74 ("Parser can loop forever on an unexpected
# record-boundary byte; streamPeekChar/streamReadChar conflate 0xFF with
# EOF") is a real, confirmed hang risk that we flagged in our own research
# (docs/research/reference-analysis.md) before ever hitting it -- and then
# hit it for real: a flight controller whose SPI dataflash reported 100%
# "used" (i.e. was likely never erased, so the dump contains old/garbage
# bytes past the real log) sent blackbox_decode into a genuine infinite
# loop, confirmed via `ps` showing 25+ minutes of sustained 99.9% CPU with
# zero output written. Bound every invocation with a hard timeout so a
# malformed/unerased log can never again hang this process indefinitely.
_DECODE_TIMEOUT_S = 180


def decode_log(
    log_path: str,
    output_dir: Optional[str] = None,
    extra_args: Optional[Sequence[str]] = None,
    timeout: float = _DECODE_TIMEOUT_S,
) -> list[str]:
    """Run blackbox_decode on log_path and return the produced CSV paths.

    Args:
        log_path: path to a .bbl/.bfl/.txt Blackbox log file.
        output_dir: if given, passed to blackbox_decode via `--output-dir`
            and used as the directory to search for produced CSVs.
            Otherwise CSVs are expected next to `log_path`.
        extra_args: additional CLI flags appended verbatim, e.g.
            ["--merge-gps", "--unit-rotation", "deg/s",
             "--unit-acceleration", "g"].
        timeout: hard ceiling in seconds on the blackbox_decode subprocess
            (default 180s -- generously above the ~10s a real multi-megabyte
            log takes to decode on a Pi 2B per our own real-hardware testing,
            but far short of "forever"). See blackbox-tools issue #74 above
            for why this exists: a malformed/unerased flash dump can put the
            decoder into a genuine infinite loop, not just a slow one.

    Returns:
        A sorted list of produced CSV file paths (one per embedded session),
        matching blackbox_decode's `<basename>.NN.csv` naming convention.

    Raises:
        FileNotFoundError: if `log_path` does not exist.
        RuntimeError: if blackbox_decode cannot be located, exits non-zero,
            times out, or (despite exiting zero) produces no discoverable
            CSV output. The raised error always includes the command,
            stdout, and stderr -- failures are never swallowed silently.
    """
    binary = find_blackbox_decode_binary()

    log_file = Path(log_path)
    if not log_file.exists():
        raise FileNotFoundError(f"Blackbox log file not found: {log_file}")

    command: list[str] = [binary]

    resolved_output_dir: Optional[Path] = None
    if output_dir is not None:
        resolved_output_dir = Path(output_dir)
        resolved_output_dir.mkdir(parents=True, exist_ok=True)
        command += ["--output-dir", str(resolved_output_dir)]

    if extra_args:
        command += list(extra_args)

    command.append(str(log_file))

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"blackbox_decode did not finish within {timeout}s decoding {log_file} and was killed "
            "-- this usually means the log file is malformed or was never erased (old/garbage bytes "
            "past the real log can trigger a known blackbox_decode infinite-loop bug, see "
            "docs/research/reference-analysis.md, blackbox-tools issue #74). Try erasing the FC's "
            "Blackbox flash (Betaflight CLI `blackbox erase` or Configurator's Erase Flash button) "
            "before the next flight.\n"
            f"command: {' '.join(command)}\n"
            f"--- partial stdout ---\n{exc.stdout or ''}\n"
            f"--- partial stderr ---\n{exc.stderr or ''}"
        ) from exc

    if result.returncode != 0:
        raise RuntimeError(
            "blackbox_decode failed "
            f"(exit code {result.returncode}) decoding {log_file}\n"
            f"command: {' '.join(command)}\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )

    search_dir = resolved_output_dir if resolved_output_dir is not None else log_file.parent
    stem = log_file.stem  # e.g. "LOG00001" from "LOG00001.BBL"

    # blackbox_decode names output "<basename>.NN.csv" (NN = session index,
    # zero-padded), one file per embedded logging session in the source file.
    csv_files = sorted(search_dir.glob(f"{stem}.*.csv"))
    if not csv_files:
        # Fall back to a looser match in case of an unexpected naming variant.
        csv_files = sorted(search_dir.glob(f"{stem}*.csv"))

    if not csv_files:
        raise RuntimeError(
            "blackbox_decode exited successfully but produced no CSV output "
            f"for {log_file} (searched {search_dir})\n"
            f"command: {' '.join(command)}\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )

    return [str(p) for p in csv_files]
