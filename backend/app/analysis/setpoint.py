"""
Setpoint retrieval / reconstruction.

Modern Betaflight logs typically log `setpoint[0-3]` directly. When that field
is absent (older logs, or a decoder that didn't extract it), we fall back to
the legacy PID-Analyzer (Plasmatree) reconstruction method documented in
docs/research/tuning-algorithms.md ("Step-Response Approaches" /
"Setpoint reconstruction" in reference-analysis.md #4):

    setpoint = gyro + axis_p_term / (0.032029 * P_gain)

IMPORTANT: the `0.032029` constant is a hard-coded, Betaflight-version-specific
scaling factor that PID-Analyzer itself only validated against Betaflight
3.15/3.2/3.3 (2017-2018-era firmware). It is NOT a physical constant and is not
authoritative for modern firmware (which has RPM filtering, D_MAX, feedforward,
and different internal P-term scaling). Treat any setpoint reconstructed this
way as an approximation of last resort -- prefer a directly-logged setpoint
whenever the log provides one.
"""
from __future__ import annotations

import numpy as np

from app.blackbox.logdata import BlackboxLog

# Legacy PID-Analyzer P-term scaling constant. See module docstring.
_LEGACY_P_SCALE = 0.032029

_AXES = ("roll", "pitch", "yaw")
_HEADER_KEYS = {
    "roll": ("rollPID", "roll_pid"),
    "pitch": ("pitchPID", "pitch_pid"),
    "yaw": ("yawPID", "yaw_pid"),
}


def _parse_p_gain(headers: dict, axis: str) -> float:
    """
    Parse the P gain for `axis` out of a Betaflight-style "P,I,D" header string,
    e.g. headers['rollPID'] == "45,80,30" -> P gain = 45.0.

    Raises ValueError if no matching header is found or it can't be parsed.
    """
    for key in _HEADER_KEYS[axis]:
        if key in headers and headers[key] not in (None, ""):
            raw = headers[key]
            parts = str(raw).split(",")
            if not parts or parts[0].strip() == "":
                continue
            try:
                return float(parts[0].strip())
            except ValueError:
                continue
    raise ValueError(
        f"Cannot reconstruct setpoint for axis '{axis}': no usable "
        f"PID header found (looked for {_HEADER_KEYS[axis]!r} in log.headers)."
    )


def get_or_reconstruct_setpoint(log: BlackboxLog, axis: str) -> np.ndarray:
    """
    Return the setpoint array (deg/s) for `axis`.

    Prefers `log.setpoint[axis]` when present and non-empty. Falls back to the
    legacy PID-Analyzer reconstruction formula (see module docstring) using
    `log.axis_p[axis]` and a P gain parsed from `log.headers`.
    """
    if axis not in _AXES:
        raise ValueError(f"axis must be one of {_AXES!r}, got {axis!r}")

    setpoint = getattr(log, "setpoint", None) or {}
    sp = setpoint.get(axis)
    if sp is not None and len(sp) > 0:
        return np.asarray(sp, dtype=float)

    axis_p = getattr(log, "axis_p", None) or {}
    p_term = axis_p.get(axis)
    if p_term is None or len(p_term) == 0:
        raise ValueError(
            f"Cannot reconstruct setpoint for axis '{axis}': log.setpoint[{axis!r}] "
            f"is missing/empty and log.axis_p[{axis!r}] is also missing/empty."
        )

    gyro = getattr(log, "gyro", None) or {}
    gyro_axis = gyro.get(axis)
    if gyro_axis is None or len(gyro_axis) == 0:
        raise ValueError(
            f"Cannot reconstruct setpoint for axis '{axis}': log.gyro[{axis!r}] "
            "is missing/empty."
        )

    p_gain = _parse_p_gain(getattr(log, "headers", None) or {}, axis)
    if p_gain == 0:
        raise ValueError(
            f"Cannot reconstruct setpoint for axis '{axis}': parsed P gain is 0."
        )

    p_term = np.asarray(p_term, dtype=float)
    gyro_axis = np.asarray(gyro_axis, dtype=float)
    return gyro_axis + p_term / (_LEGACY_P_SCALE * p_gain)
