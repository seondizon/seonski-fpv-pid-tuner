"""Stopping-criteria evaluation: has this craft's tune converged?

Per the product's iterative-tuning philosophy (docs/research/tuning-algorithms.md
and the appliance-UX spec's "Detecting When the Tune Is Good Enough"), the
tuner must not chase improvements forever -- once the analysis is already
GOOD and the previous iteration didn't meaningfully improve on the one
before it, the answer should be "tune complete", including "no tune
required at all" on a first-ever analysis that's already good.
"""
from __future__ import annotations

from typing import Optional

# Below this aggregate improvement percentage, the latest tune is considered
# "not meaningfully better" than the previous one -- matches the appliance-UX
# spec's own example number ("Improvement from last iteration: <1%").
_IMPROVEMENT_THRESHOLD_PCT = 1.0


def _axis_score(axis_summary: Optional[dict]) -> Optional[float]:
    """A single 0-100-ish "how good is this axis" scalar combining
    tracking_pct (already 0-100, higher better) and overshoot_pct (lower
    better, so inverted and clamped). Simple average of the two -- this is
    a deliberately simple aggregate for comparing two iterations, not a
    scientific metric; document any change to this weighting clearly if it
    turns out too coarse in practice."""
    if not axis_summary:
        return None
    tracking_pct = axis_summary.get("tracking_pct")
    overshoot_pct = axis_summary.get("overshoot_pct")
    parts = []
    if tracking_pct is not None:
        parts.append(tracking_pct)
    if overshoot_pct is not None:
        parts.append(max(0.0, 100.0 - overshoot_pct))
    if not parts:
        return None
    return sum(parts) / len(parts)


def _overall_score(summary: dict) -> Optional[float]:
    axes = summary.get("axes", {})
    scores = [
        s
        for s in (_axis_score(axes.get("roll")), _axis_score(axes.get("pitch")))
        if s is not None
    ]
    if not scores:
        return None
    return sum(scores) / len(scores)


def evaluate_tune_complete(current_summary: dict, previous_summary: Optional[dict]) -> dict:
    """See module docstring. `current_summary`/`previous_summary` are shaped
    like GET /api/analysis/summary's response (see
    backend/app/api/routes.py::get_analysis_summary)."""
    reasons: list = []
    overall_grade = current_summary.get("overall_grade")

    if overall_grade != "GOOD":
        for axis_name in ("roll", "pitch"):
            axis = current_summary.get("axes", {}).get(axis_name, {})
            if axis.get("grade") not in ("GOOD", None, "UNKNOWN"):
                reasons.append(f"{axis_name.capitalize()} {axis.get('grade', 'result').lower()} still elevated")
        noise = current_summary.get("noise", {})
        if noise.get("dterm_grade") not in ("GOOD", None, "UNKNOWN"):
            reasons.append("D-term noise still needs attention")
        if not reasons:
            reasons.append("Overall result is not yet in the good range")
        return {"tune_complete": False, "reasons": reasons, "improvement_pct": None}

    if previous_summary is None:
        # Nothing to compare against, and already GOOD -- valid "no tune
        # required" outcome on a first-ever analysis.
        return {"tune_complete": True, "reasons": ["Result is already good"], "improvement_pct": None}

    current_score = _overall_score(current_summary)
    previous_score = _overall_score(previous_summary)

    if current_score is None or previous_score is None:
        # Can't compute a meaningful delta -- fall back to "already GOOD" as
        # the deciding factor rather than blocking on missing data.
        return {"tune_complete": True, "reasons": ["Result is already good"], "improvement_pct": None}

    if previous_score <= 0:
        improvement_pct = 0.0
    else:
        improvement_pct = round((current_score - previous_score) / previous_score * 100.0, 2)

    if improvement_pct < _IMPROVEMENT_THRESHOLD_PCT:
        return {
            "tune_complete": True,
            "reasons": [f"No meaningful improvement over the previous tune ({improvement_pct:+g}%)"],
            "improvement_pct": improvement_pct,
        }

    return {
        "tune_complete": False,
        "reasons": [f"Still improving over the previous tune ({improvement_pct:+g}%)"],
        "improvement_pct": improvement_pct,
    }
