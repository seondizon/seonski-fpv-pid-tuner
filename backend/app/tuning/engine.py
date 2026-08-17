"""Rule-based PID/filter tuning recommendation engine.

Clean-room reimplementation of the FPVPIDlab-style recommendation pattern
documented in docs/research/tuning-algorithms.md ("PID Recommendation
Strategies", "Confidence Strategies", "Safety Strategies") -- NOT a port of
FPVPIDlab's own code (GPL-3.0, and its own thresholds are explicitly
"not yet hardware-validated" per that project's own docs). Every numeric
constant below is this project's own first-pass choice, to be validated
against real flight data before being trusted -- consistent with this
project's established stance elsewhere (see grading.py, step_response.py).

ADVISORY ONLY. This module never touches a flight controller -- it only
produces Recommendation objects. Writing anything to hardware is a
separate, independently safety-gated piece of work.

Parameter naming: modern Betaflight (4.x+) exposes PID terms as individual
per-axis-per-term CLI settables -- `p_roll`/`i_roll`/`d_roll`/`f_roll`,
`p_pitch`/..., `p_yaw`/... (this replaced the older combined "rollPID"-style
comma-triple values from `dump`/`diff` output in earlier Cleanflight-era
firmware). Recommendations here use this modern naming.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from app.analysis import grading

_AXES = ("roll", "pitch")  # yaw intentionally excluded from v1 -- see module docstring below

# Bounded, small steps: no single recommendation in one iteration exceeds
# this percentage change. This is a live, iterative tool (analyze -> tune ->
# fly -> re-analyze) per the product design, not a one-shot "fix everything"
# pass -- see docs/research/tuning-algorithms.md Safety Strategies.
_MAX_CHANGE_PCT = 15.0

_D_RAISE_PCT_POOR = 12.0   # overshoot POOR (>25%)
_D_RAISE_PCT_FAIR = 5.0    # overshoot FAIR (10-25%)
_P_RAISE_PCT_POOR = 8.0    # tracking POOR
_P_RAISE_PCT_FAIR = 5.0    # tracking FAIR
_FILTER_ATTENTION_PCT = 10.0  # suggested cutoff-lowering magnitude, descriptive only

# Damping-ratio (D/P) safety ceiling -- a conservative default since this
# project doesn't yet know craft size (FPVPIDlab scales this by frame size;
# we use one flat ceiling for all builds until size-awareness is added).
_DAMPING_RATIO_CEILING = 0.85

# Confidence floor below which the whole readiness result is blocked.
_MIN_CONFIDENCE_TO_PROCEED = 35


@dataclass
class Recommendation:
    parameter: str
    axis: str  # "roll" | "pitch" | "filter"
    current_value: Optional[float]
    proposed_value: Optional[float]
    change_pct: float
    reason: str
    confidence_pct: int
    category: str  # "roll" | "pitch" | "filter_ff"


@dataclass
class TuningReadiness:
    version_supported: bool
    settings_read_ok: bool
    safety_passed: bool
    confidence_pct: int
    blocked: bool
    block_reasons: list = field(default_factory=list)


def _confidence_from_segments(num_segments_used: int) -> int:
    """0 usable step-response segments -> low but non-zero confidence (20);
    each additional segment adds 5 points, capped at 95 (never claim full
    certainty -- this is a rule-based heuristic, not a validated model).
    15+ segments reaches the 95 cap."""
    return min(95, 20 + max(num_segments_used, 0) * 5)


def _d_p_ratio(d_value: float, p_value: float) -> Optional[float]:
    if p_value == 0:
        return None
    return d_value / p_value


def _generate_axis_recommendations(
    axis: str,
    step,
    dterm_noise,
    tracking,
    current_pids: Optional[dict],
) -> list[Recommendation]:
    recs: list[Recommendation] = []
    confidence = _confidence_from_segments(step.num_segments_used)
    d_param, p_param = f"d_{axis}", f"p_{axis}"
    current_d = current_pids.get(d_param) if current_pids else None
    current_p = current_pids.get(p_param) if current_pids else None

    noise_grade = grading.grade_dterm_noise(dterm_noise.d_p_ratio, dterm_noise.hf_energy_ratio)
    overshoot_grade = grading.grade_overshoot(step.overshoot_pct)
    tracking_grade = grading.grade_tracking_error_std(tracking.error_std)

    made_d_recommendation = False

    if noise_grade in ("FAIR", "POOR"):
        # D-effectiveness / noise gating: don't raise D into noise -- redirect
        # to filtering instead, and skip any overshoot-driven D raise below.
        recs.append(
            Recommendation(
                parameter="dterm_lpf1_static_hz",
                axis="filter",
                current_value=None,
                proposed_value=None,
                change_pct=-_FILTER_ATTENTION_PCT,
                reason=(
                    f"{axis.capitalize()} D-term noise is elevated -- lower the D-term "
                    "filter cutoff before raising D further."
                ),
                confidence_pct=confidence,
                category="filter_ff",
            )
        )
        made_d_recommendation = True  # blocks the overshoot-driven D path below
    elif overshoot_grade == "POOR":
        proposed_pct = _D_RAISE_PCT_POOR
        proposed_value = None
        if current_d is not None and current_p is not None and current_p > 0:
            capped_d = current_p * _DAMPING_RATIO_CEILING
            candidate_d = current_d * (1 + proposed_pct / 100.0)
            if candidate_d > capped_d:
                candidate_d = capped_d
                proposed_pct = round((candidate_d / current_d - 1) * 100.0, 1) if current_d else 0.0
            proposed_value = round(candidate_d, 1)
        if proposed_value is None or current_d is None or proposed_value > current_d:
            recs.append(
                Recommendation(
                    parameter=d_param,
                    axis=axis,
                    current_value=current_d,
                    proposed_value=proposed_value,
                    change_pct=proposed_pct,
                    reason=f"{axis.capitalize()} overshoot is high -- raising D should tighten damping.",
                    confidence_pct=confidence,
                    category=axis,
                )
            )
            made_d_recommendation = True
    elif overshoot_grade == "FAIR":
        proposed_pct = _D_RAISE_PCT_FAIR
        proposed_value = None
        skip = False
        if current_d is not None and current_p is not None and current_p > 0:
            ratio = _d_p_ratio(current_d, current_p)
            capped_d = current_p * _DAMPING_RATIO_CEILING
            candidate_d = current_d * (1 + proposed_pct / 100.0)
            if ratio is not None and ratio >= _DAMPING_RATIO_CEILING:
                skip = True  # already at/above the safe ceiling -- nothing more to safely offer
            elif candidate_d > capped_d:
                candidate_d = capped_d
                proposed_pct = round((candidate_d / current_d - 1) * 100.0, 1) if current_d else 0.0
                proposed_value = round(candidate_d, 1)
            else:
                proposed_value = round(candidate_d, 1)
        if not skip:
            recs.append(
                Recommendation(
                    parameter=d_param,
                    axis=axis,
                    current_value=current_d,
                    proposed_value=proposed_value,
                    change_pct=proposed_pct,
                    reason=(
                        f"{axis.capitalize()} shows a touch of overshoot -- a small D "
                        "increase should help without adding noise."
                    ),
                    confidence_pct=confidence,
                    category=axis,
                )
            )
            made_d_recommendation = True

    if not made_d_recommendation and tracking_grade in ("FAIR", "POOR"):
        proposed_pct = _P_RAISE_PCT_POOR if tracking_grade == "POOR" else _P_RAISE_PCT_FAIR
        proposed_value = round(current_p * (1 + proposed_pct / 100.0), 1) if current_p is not None else None
        recs.append(
            Recommendation(
                parameter=p_param,
                axis=axis,
                current_value=current_p,
                proposed_value=proposed_value,
                change_pct=proposed_pct,
                reason=f"{axis.capitalize()} tracking is a bit loose -- a small P increase should tighten it.",
                confidence_pct=confidence,
                category=axis,
            )
        )

    return recs


def generate_recommendations(
    step_response_by_axis: dict,
    dterm_noise_by_axis: dict,
    tracking_by_axis: dict,
    current_pids: Optional[dict] = None,
) -> list[Recommendation]:
    """See module docstring for the overall design. Only roll/pitch are
    considered -- yaw's tuning thresholds differ enough (per
    docs/research/tuning-algorithms.md's notes on yaw's more permissive
    bands) that guessing at them for v1 isn't worthwhile; add yaw support
    once that's researched properly rather than reusing roll/pitch bands."""
    recommendations: list[Recommendation] = []
    for axis in _AXES:
        if axis not in step_response_by_axis or axis not in dterm_noise_by_axis or axis not in tracking_by_axis:
            continue
        recommendations.extend(
            _generate_axis_recommendations(
                axis,
                step_response_by_axis[axis],
                dterm_noise_by_axis[axis],
                tracking_by_axis[axis],
                current_pids,
            )
        )
    return recommendations


def compute_readiness(
    recommendations: list[Recommendation],
    version_supported: bool,
    settings_read_ok: bool,
) -> TuningReadiness:
    """See module docstring. Config-backup success is judged elsewhere (the
    apply-orchestration module) -- this function only covers what the
    recommendation engine itself can judge: version/input confidence and a
    safety-bounds sanity check on the recommendations it produced."""
    block_reasons: list = []

    if not version_supported:
        block_reasons.append("Betaflight version could not be confirmed as supported.")
    if not settings_read_ok:
        block_reasons.append("Flight controller settings could not be read reliably.")

    over_cap = [r for r in recommendations if abs(r.change_pct) > _MAX_CHANGE_PCT + 1e-9]
    if over_cap:
        block_reasons.append(
            f"{len(over_cap)} recommendation(s) exceed the {_MAX_CHANGE_PCT:g}% safety cap."
        )

    if recommendations:
        confidence_pct = min(r.confidence_pct for r in recommendations)
    else:
        # Nothing to be unconfident about -- a well-tuned log producing zero
        # recommendations is a confident "no tune required" outcome.
        confidence_pct = 90

    if confidence_pct < _MIN_CONFIDENCE_TO_PROCEED:
        block_reasons.append(
            f"Confidence ({confidence_pct}%) is below the minimum needed to proceed "
            f"({_MIN_CONFIDENCE_TO_PROCEED}%) -- fly a longer/more representative session."
        )

    blocked = bool(block_reasons)
    return TuningReadiness(
        version_supported=version_supported,
        settings_read_ok=settings_read_ok,
        safety_passed=not over_cap,
        confidence_pct=confidence_pct,
        blocked=blocked,
        block_reasons=block_reasons,
    )
