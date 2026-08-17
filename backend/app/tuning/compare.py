"""Compare two tune iterations' analysis results.

Per the UX spec section 14 ("Do Not Assume the Latest Tune Is Best"): the
tuner must be able to say "Tune #2 was better than Tune #3," not just
assume whatever was applied most recently is the best one. This module is
pure comparison logic over two `GET /api/analysis/summary`-shaped snapshots
(see store.Iteration.analysis_summary) -- it doesn't touch the FC or decide
whether to keep tuning (that's app/tuning/stopping.py's job).
"""
from __future__ import annotations

from typing import Optional

_GRADE_RANK = {"POOR": 0, "FAIR": 1, "GOOD": 2}


def _axis_avg(summary: dict, field: str) -> Optional[float]:
    values = [summary.get("axes", {}).get(axis, {}).get(field) for axis in ("roll", "pitch")]
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def _score(summary: dict) -> Optional[float]:
    """A single scalar combining tracking (higher better), overshoot (lower
    better), and noise grade (higher better) into one comparable number.
    Weights are our own first-pass judgment call, not derived from any
    reference project: tracking_pct and overshoot_pct are already on
    roughly comparable 0-100-ish scales, so they're combined at equal
    weight; noise grade is mapped to a 0/10/20 bonus so a full grade step
    (e.g. FAIR -> GOOD) matters about as much as a 10-point tracking/
    overshoot swing, without letting noise alone dominate the comparison.
    Returns None if there isn't enough data to score at all.
    """
    tracking = _axis_avg(summary, "tracking_pct")
    overshoot = _axis_avg(summary, "overshoot_pct")
    noise_grade = summary.get("noise", {}).get("dterm_grade")
    noise_bonus = _GRADE_RANK.get(noise_grade, 1) * 10  # UNKNOWN -> treated as FAIR (rank 1)

    parts = [v for v in (tracking, (100 - overshoot) if overshoot is not None else None) if v is not None]
    if not parts:
        return None
    return sum(parts) / len(parts) + noise_bonus


def compare_iterations(older: dict, newer: dict) -> dict:
    """Compare two analysis-summary snapshots (older vs newer iteration).

    Returns:
        {
            "tracking_delta_pct": float | None,   # positive = newer tracks better
            "overshoot_delta_pct": float | None,  # positive = newer has LOWER overshoot (improvement)
            "noise_delta": int,                   # positive = newer noise grade improved
            "better": "newer" | "older" | "tie" | "unknown",
            "summary": str,                       # short, touchscreen-appropriate verdict
        }
    """
    older_tracking = _axis_avg(older, "tracking_pct")
    newer_tracking = _axis_avg(newer, "tracking_pct")
    tracking_delta = (newer_tracking - older_tracking) if None not in (older_tracking, newer_tracking) else None

    older_overshoot = _axis_avg(older, "overshoot_pct")
    newer_overshoot = _axis_avg(newer, "overshoot_pct")
    overshoot_delta = (older_overshoot - newer_overshoot) if None not in (older_overshoot, newer_overshoot) else None

    older_noise = _GRADE_RANK.get(older.get("noise", {}).get("dterm_grade"))
    newer_noise = _GRADE_RANK.get(newer.get("noise", {}).get("dterm_grade"))
    noise_delta = (newer_noise - older_noise) if None not in (older_noise, newer_noise) else 0

    older_score = _score(older)
    newer_score = _score(newer)

    if older_score is None or newer_score is None:
        return {
            "tracking_delta_pct": tracking_delta,
            "overshoot_delta_pct": overshoot_delta,
            "noise_delta": noise_delta,
            "better": "unknown",
            "summary": "Not enough data to compare these two tunes.",
        }

    diff = newer_score - older_score
    if abs(diff) < 2.0:  # within noise of each other -- call it a tie rather than overclaiming
        better = "tie"
        summary = "These two tunes perform about the same."
    elif diff > 0:
        better = "newer"
        summary = "The newer tune is an improvement."
    else:
        better = "older"
        summary = "The previous tune remains the better one."

    return {
        "tracking_delta_pct": tracking_delta,
        "overshoot_delta_pct": overshoot_delta,
        "noise_delta": noise_delta,
        "better": better,
        "summary": summary,
    }


def find_best_iteration(iterations: list) -> Optional[int]:
    """Given a list of store.Iteration objects (in chronological order),
    return the `number` of the one with the best analysis_summary score, or
    None if none of them have enough data to score. Ties resolve to the
    earliest iteration (a tune that's merely "as good as" the current one
    isn't a reason to prefer it over an already-proven baseline)."""
    best_number: Optional[int] = None
    best_score: Optional[float] = None
    for iteration in iterations:
        score = _score(iteration.analysis_summary)
        if score is None:
            continue
        if best_score is None or score > best_score:
            best_score = score
            best_number = iteration.number
    return best_number
