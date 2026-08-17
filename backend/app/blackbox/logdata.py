"""Parse blackbox_decode's CSV output into a structured, analysis-ready object.

This module only ever reads the CSV text that the external `blackbox_decode`
binary produces (see decode.py) -- it contains no code derived from
betaflight/blackbox-tools' C source (GPL-3.0). Column layouts below
(axisP/I/D/F[0-2], rcCommand[0-3], gyroADC[0-2], motor[0..N], vbatLatest,
setpoint[0-2], time (us)) are simply the well-known, publicly documented
Betaflight Blackbox CSV field names -- not decoder logic.

AXIS ORDER CONVENTION: Betaflight's blackbox fields consistently index axes
as 0=roll, 1=pitch, 2=yaw (e.g. `axisP[0]`/`axisP[1]`/`axisP[2]`,
`rcCommand[0]`=roll/`[1]`=pitch/`[2]`=yaw/`[3]`=throttle, `gyroADC[0..2]`).
This is a hard convention throughout the Betaflight firmware and its
blackbox field definitions -- getting this wrong silently corrupts every
downstream analysis, so every axis-indexed column in this file is mapped
through the single `_AXES = ("roll", "pitch", "yaw")` tuple below rather than
re-derived ad hoc.

HEADER/PREAMBLE CAVEAT: We do not have a real `blackbox_decode` binary or
sample .bbl file available in this development environment to confirm
byte-for-byte what its CSV output looks like. Based on
docs/research/reference-analysis.md, blackbox_decode's CSV output is
data-only (it starts directly with the column header row); the log's
`H <key>:<value>` metadata preamble lives in the raw .bbl/.bfl file, not
necessarily reproduced verbatim in the CSV. To be defensive, this loader
still scans for and captures any comment-like/`key,value` preamble lines
that appear *before* the recognized column-header row in the CSV file
itself (some blackbox_decode versions/flags may include them) -- but on a
"clean" CSV with no preamble, `headers` will simply be `{}` and
`firmware_version` will be `None`. Treat this as a best-effort parse; adjust
once we can validate against real blackbox_decode output.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

# Standard Betaflight blackbox axis order: 0=roll, 1=pitch, 2=yaw.
_AXES = ("roll", "pitch", "yaw")

# Matches a bare field name optionally followed by a blackbox_decode
# unit annotation, e.g. "axisP[0]" or "axisP[0] (deg/s)".
def _column_pattern(base: str) -> re.Pattern:
    return re.compile(r"^" + re.escape(base) + r"(\s*\(.*\))?$")


def _find_column(fieldnames: list[str], base: str) -> Optional[str]:
    """Find the actual CSV column name matching `base`, ignoring any
    trailing unit annotation blackbox_decode's --unit-* flags add
    (e.g. base="gyroADC[0]" matches both "gyroADC[0]" and
    "gyroADC[0] (deg/s)")."""
    pattern = _column_pattern(base)
    for name in fieldnames:
        if pattern.match(name.strip()):
            return name
    return None


def _axis_dict(
    fieldnames: list[str],
    data: dict[str, np.ndarray],
    bases: list[str],
    length: int,
) -> dict[str, np.ndarray]:
    """Build a {'roll': arr, 'pitch': arr, 'yaw': arr} dict, trying each
    candidate column-name base in order per axis, and zero-filling any axis
    that isn't present at all (e.g. yaw axisD, which many tunes omit)."""
    result: dict[str, np.ndarray] = {}
    for i, axis in enumerate(_AXES):
        column = None
        for base in bases:
            column = _find_column(fieldnames, f"{base}[{i}]")
            if column is not None:
                break
        result[axis] = data[column] if column is not None else np.zeros(length, dtype=float)
    return result


def _setpoint_dict(
    fieldnames: list[str], data: dict[str, np.ndarray]
) -> dict[str, np.ndarray]:
    """Populate setpoint per-axis ONLY from a directly-logged `setpoint[i]`
    column. Unlike _axis_dict, missing axes are simply omitted (not
    zero-filled): a directly-logged setpoint absent from a log is a
    different situation than a genuinely-zero setpoint, and downstream
    reconstruction (from axisP/gyro, implemented elsewhere in the analysis
    module) needs to be able to tell the difference. If no setpoint[0-2]
    columns exist at all, this returns {} -- callers must check for that and
    reconstruct setpoint themselves in that case."""
    result: dict[str, np.ndarray] = {}
    for i, axis in enumerate(_AXES):
        column = _find_column(fieldnames, f"setpoint[{i}]")
        if column is not None:
            result[axis] = data[column]
    return result


_TIME_PATTERN = re.compile(r"^time(\s*\((?P<unit>[^)]*)\))?$", re.IGNORECASE)
_TIME_UNIT_SCALE = {
    "us": 1e6,
    "µs": 1e6,
    "microsecond": 1e6,
    "microseconds": 1e6,
    "ms": 1e3,
    "millisecond": 1e3,
    "milliseconds": 1e3,
    "s": 1.0,
    "sec": 1.0,
    "second": 1.0,
    "seconds": 1.0,
}


@dataclass
class BlackboxLog:
    """A decoded Blackbox flight log, in analysis-ready arrays.

    Axis-indexed dicts (`setpoint`, `gyro`, `axis_p`, `axis_i`, `axis_d`,
    `axis_f`) always use the keys 'roll', 'pitch', 'yaw' -- matching
    Betaflight's blackbox index convention 0=roll, 1=pitch, 2=yaw.
    """

    time_s: np.ndarray  # seconds, monotonic from log start (t[0] == 0)
    sample_rate_hz: float  # estimated from the median of np.diff(time_s)
    setpoint: dict  # {'roll'/'pitch'/'yaw': ndarray} deg/s if directly
    # logged (setpoint[0-2] columns); {} if not present in this log -- in
    # that case downstream analysis code is expected to reconstruct
    # setpoint from axisP/gyro (not implemented in this module).
    gyro: dict  # {'roll'/'pitch'/'yaw': ndarray} deg/s, filtered gyro
    # (gyroADC[0-2]); zero-filled per-axis if genuinely absent.
    axis_p: dict  # per-axis P term (axisP[0-2]); zero-filled if absent.
    axis_i: dict  # per-axis I term (axisI[0-2]); zero-filled if absent.
    axis_d: dict  # per-axis D term (axisD[0-2]); zero-filled if absent
    # (yaw D is commonly disabled/omitted -> zeros).
    axis_f: dict  # per-axis feedforward term (axisF[0-2]); zero-filled if
    # absent (older logs predate feedforward -> zeros).
    throttle_pct: np.ndarray  # 0-100, derived from rcCommand[3] -- see
    # _compute_throttle_pct for the exact unit-detection/mapping logic.
    motor: np.ndarray  # shape (N, num_motors); columns ordered motor[0..],
    # empty (N, 0) array if no motor columns are present.
    vbat_v: Optional[np.ndarray]
    headers: dict = field(default_factory=dict)  # raw preamble key:value
    # strings captured ahead of the CSV column-header row, if any (see
    # module docstring HEADER/PREAMBLE CAVEAT -- often {}).
    firmware_version: Optional[str] = None  # best-effort, parsed out of
    # `headers` if a firmware/version-like key was found there.


def _compute_throttle_pct(
    fieldnames: list[str], data: dict[str, np.ndarray], length: int
) -> np.ndarray:
    """Derive 0-100 throttle percentage from rcCommand[3].

    rcCommand[3] is Betaflight's throttle *stick* command, and shows up in
    blackbox CSVs in one of a few conventions depending on firmware/flags:
      - raw RC microseconds, roughly 1000 (min) - 2000 (max)
      - already-normalized 0-100 (rare, some --unit-* combos)
      - already-normalized -1..1 or 0..1 float

    We inspect the observed value range to pick the right mapping rather
    than assuming one, and always clip the result to [0, 100].
    """
    column = _find_column(fieldnames, "rcCommand[3]")
    if column is None:
        return np.zeros(length, dtype=float)

    raw = data[column]
    if raw.size == 0:
        return raw.astype(float)

    lo, hi = float(np.nanmin(raw)), float(np.nanmax(raw))

    if -1.5 <= lo and hi <= 1.5:
        # Normalized float convention.
        if lo < -0.01:
            pct = (raw + 1.0) / 2.0 * 100.0  # -1..1 -> 0..100
        else:
            pct = raw * 100.0  # 0..1 -> 0..100
    elif -0.5 <= lo and hi <= 100.5:
        # Already a 0-100 percentage.
        pct = raw.astype(float)
    else:
        # Raw RC pulse-width convention, ~1000-2000 microseconds.
        pct = (raw - 1000.0) / 1000.0 * 100.0

    return np.clip(pct, 0.0, 100.0)


def _extract_motor(fieldnames: list[str], data: dict[str, np.ndarray], length: int) -> np.ndarray:
    """Stack all motor[N] columns (any count, e.g. 4 for a quad, more for
    hex/octo) into a (length, num_motors) array, ordered by motor index."""
    motor_pattern = re.compile(r"^motor\[(\d+)\](\s*\(.*\))?$")
    indexed_columns: dict[int, str] = {}
    for name in fieldnames:
        match = motor_pattern.match(name.strip())
        if match:
            indexed_columns[int(match.group(1))] = name

    if not indexed_columns:
        return np.zeros((length, 0), dtype=float)

    ordered_columns = [indexed_columns[i] for i in sorted(indexed_columns)]
    return np.column_stack([data[c] for c in ordered_columns])


def _split_preamble_and_header(raw_rows: list[list[str]]) -> tuple[list[list[str]], list[str], list[list[str]]]:
    """Split raw CSV rows into (preamble rows, header row, data rows).

    The real column-header row is identified as the first row that mentions
    a "time"-like field and has more than a handful of columns (a plain
    key/value preamble line would not). See module docstring for the
    HEADER/PREAMBLE CAVEAT -- on a "clean" blackbox_decode CSV with no
    preamble, this simply finds row 0 and `preamble` comes back empty.
    """
    header_index = None
    for i, row in enumerate(raw_rows):
        joined = ",".join(row)
        if len(row) > 3 and re.search(r"\btime\b", joined, re.IGNORECASE):
            header_index = i
            break

    if header_index is None:
        # Fall back to treating the first row as the header, per
        # blackbox_decode's documented (preamble-free) CSV format.
        header_index = 0

    preamble = raw_rows[:header_index]
    header_row = raw_rows[header_index]
    data_rows = [r for r in raw_rows[header_index + 1 :] if r and any(c.strip() for c in r)]
    return preamble, header_row, data_rows


def _parse_headers(preamble: list[list[str]]) -> dict:
    headers: dict = {}
    for row in preamble:
        if not row:
            continue
        if len(row) >= 2 and row[0].strip():
            headers[row[0].strip()] = ",".join(c.strip() for c in row[1:])
        elif len(row) == 1 and ":" in row[0]:
            key, _, value = row[0].partition(":")
            headers[key.strip()] = value.strip()
    return headers


def _parse_firmware_version(headers: dict) -> Optional[str]:
    for key, value in headers.items():
        if re.search(r"firmware|version", key, re.IGNORECASE):
            match = re.search(r"\d+\.\d+(\.\d+)?", str(value))
            if match:
                return match.group(0)
    return None


def load_blackbox_csv(csv_path: str) -> BlackboxLog:
    """Parse a blackbox_decode CSV file into a BlackboxLog.

    Reads the CSV's actual header row to discover column names (rather than
    assuming fixed indices), since they vary by firmware/config and by which
    --unit-* flags blackbox_decode was invoked with.

    Raises:
        FileNotFoundError: if csv_path does not exist.
        ValueError: on an empty file, a header-only file with no data rows,
            malformed/ragged rows, non-numeric data, or no recognizable
            time column.
    """
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"Blackbox CSV not found: {path}")

    with open(path, newline="") as f:
        raw_rows = [row for row in csv.reader(f) if row]

    if not raw_rows:
        raise ValueError(f"Blackbox CSV is empty: {path}")

    preamble, header_row, data_rows = _split_preamble_and_header(raw_rows)
    fieldnames = [h.strip() for h in header_row]

    if not data_rows:
        raise ValueError(f"Blackbox CSV has a header but no data rows: {path}")

    num_columns = len(fieldnames)
    malformed = [i for i, row in enumerate(data_rows) if len(row) != num_columns]
    if malformed:
        raise ValueError(
            f"Blackbox CSV {path} has {len(malformed)} malformed row(s) with a "
            f"column count mismatch (expected {num_columns} columns); "
            f"first offending row index: {malformed[0]}"
        )

    try:
        values = np.array(data_rows, dtype=float)
    except ValueError as exc:
        raise ValueError(f"Blackbox CSV {path} contains non-numeric data: {exc}") from exc

    length = values.shape[0]
    data = {name: values[:, idx] for idx, name in enumerate(fieldnames)}

    # --- time ---
    time_column = None
    time_unit = None
    for name in fieldnames:
        match = _TIME_PATTERN.match(name.strip())
        if match:
            time_column = name
            time_unit = (match.group("unit") or "").strip().lower()
            break

    if time_column is None:
        raise ValueError(
            f"Blackbox CSV {path} has no recognizable time column; "
            f"columns found: {fieldnames}"
        )

    scale = _TIME_UNIT_SCALE.get(time_unit)
    if scale is None:
        # No unit annotation (bare "time" column). blackbox_decode's default
        # output (no --unit-time flag) is microseconds -- assume that here.
        scale = 1e6

    time_s = data[time_column] / scale
    time_s = time_s - time_s[0]  # monotonic from log start

    diffs = np.diff(time_s)
    positive_diffs = diffs[diffs > 0]
    if positive_diffs.size == 0:
        raise ValueError(f"Blackbox CSV {path} has no valid increasing time samples")
    sample_rate_hz = float(1.0 / np.median(positive_diffs))

    # --- axis-indexed fields ---
    setpoint = _setpoint_dict(fieldnames, data)
    gyro = _axis_dict(fieldnames, data, ["gyroADC", "gyroData"], length)
    axis_p = _axis_dict(fieldnames, data, ["axisP"], length)
    axis_i = _axis_dict(fieldnames, data, ["axisI"], length)
    axis_d = _axis_dict(fieldnames, data, ["axisD"], length)
    axis_f = _axis_dict(fieldnames, data, ["axisF"], length)

    # --- throttle / motors / vbat ---
    throttle_pct = _compute_throttle_pct(fieldnames, data, length)
    motor = _extract_motor(fieldnames, data, length)

    vbat_column = _find_column(fieldnames, "vbatLatest") or _find_column(fieldnames, "vbat")
    vbat_v = data[vbat_column] if vbat_column is not None else None

    # --- best-effort header/firmware parsing (see module docstring) ---
    headers = _parse_headers(preamble)
    firmware_version = _parse_firmware_version(headers)

    return BlackboxLog(
        time_s=time_s,
        sample_rate_hz=sample_rate_hz,
        setpoint=setpoint,
        gyro=gyro,
        axis_p=axis_p,
        axis_i=axis_i,
        axis_d=axis_d,
        axis_f=axis_f,
        throttle_pct=throttle_pct,
        motor=motor,
        vbat_v=vbat_v,
        headers=headers,
        firmware_version=firmware_version,
    )
