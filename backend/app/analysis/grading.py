"""Shared GOOD/FAIR/POOR grading thresholds.

Centralized here so the analysis-summary endpoint (api/routes.py) and the
tuning-recommendation engine (app/tuning/) judge the same numbers the same
way -- two independently-worded "this axis is fine" / "this axis needs a
tune" verdicts would be confusing and untrustworthy on a small touchscreen
that can only show one topic at a time.

These are first-pass, our-own-clean-room thresholds inspired by the ranges
discussed in docs/research/tuning-algorithms.md (FPVPIDlab's style-dependent
overshoot targets, SmartTune's D/P-ratio noise grading) -- NOT validated
against real flight data yet (see README roadmap). Treat every numeric
boundary here as provisional.
"""
from __future__ import annotations

_GRADE_RANK = {"POOR": 0, "FAIR": 1, "GOOD": 2}


def grade_overshoot(overshoot_pct: float | None) -> str:
    """FPVPIDlab-style bands (balanced flight-style target): <10% good
    tracking/damping, 10-25% usable but a touch underdamped, >25% poor."""
    if overshoot_pct is None:
        return "UNKNOWN"
    if overshoot_pct < 10:
        return "GOOD"
    if overshoot_pct < 25:
        return "FAIR"
    return "POOR"


def grade_tracking_error_std(error_std: float | None) -> str:
    """error_std is the std of PIDtoolbox's peak-normalized PID-error
    histogram (see analysis/tracking.py) -- a "looseness" scalar, not a
    percentage. Lower is tighter tracking. These band edges are a rough,
    unvalidated first pass at converting that scalar into a 3-level grade."""
    if error_std is None:
        return "UNKNOWN"
    if error_std < 0.12:
        return "GOOD"
    if error_std < 0.22:
        return "FAIR"
    return "POOR"


def tracking_error_std_to_pct(error_std: float | None) -> float | None:
    """Rough, intentionally-simple 0-100 "tracking quality" display number
    for the touchscreen Roll/Pitch cards, derived from error_std. This is a
    display convenience, not a scientifically meaningful percentage -- the
    real signal is error_std itself and the GOOD/FAIR/POOR grade above."""
    if error_std is None:
        return None
    pct = 100.0 * (1.0 - min(error_std / 0.4, 1.0))
    return round(max(pct, 0.0), 1)


def grade_oscillation(overshoot_pct: float | None, settling_time_s: float | None) -> str:
    """A quick "ringing" read: high overshoot combined with a long settling
    time (relative to a typical acro step response) suggests oscillation
    rather than a single clean overshoot-and-settle."""
    if overshoot_pct is None or settling_time_s is None:
        return "UNKNOWN"
    if overshoot_pct > 20 and settling_time_s > 0.15:
        return "HIGH"
    if overshoot_pct > 10 or settling_time_s > 0.10:
        return "MODERATE"
    return "LOW"


def grade_dterm_noise(d_p_ratio: float | None, hf_energy_ratio: float | None) -> str:
    """Same thresholds as fft_noise.py's compute_dterm_noise_metrics
    (SmartTune's D/P-ratio bands), but labeled GOOD/FAIR/POOR instead of
    GOOD/MARGINAL/POOR to match this app's UI-wide 3-grade convention.
    Duplicated here as pure numbers (not imported) so this module has no
    dependency on BlackboxLog/analysis plumbing and can be reused by both
    the summary endpoint and the tuning engine with whatever inputs they
    already have on hand."""
    if d_p_ratio is None:
        return "UNKNOWN"
    if d_p_ratio > 0.5:
        return "POOR"
    if d_p_ratio > 0.3 or (hf_energy_ratio is not None and hf_energy_ratio > 0.3):
        return "FAIR"
    return "GOOD"


def overall_grade(grades: list[str]) -> str:
    """Overall = the worst individual grade (a single bad axis/noise reading
    should not be hidden behind otherwise-good numbers). UNKNOWN entries are
    ignored unless everything is UNKNOWN."""
    known = [g for g in grades if g in _GRADE_RANK]
    if not known:
        return "UNKNOWN"
    return min(known, key=lambda g: _GRADE_RANK[g])
