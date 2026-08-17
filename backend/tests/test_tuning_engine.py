from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from app.tuning.engine import generate_recommendations, compute_readiness, Recommendation


@dataclass
class _FakeStepResponse:
    time_s: object = None
    response: object = None
    num_segments_used: int = 20
    num_segments_rejected: int = 2
    overshoot_pct: Optional[float] = 5.0
    rise_time_s: Optional[float] = 0.04
    settling_time_s: Optional[float] = 0.08
    steady_state_error_pct: Optional[float] = 0.0


@dataclass
class _FakeDTermNoise:
    d_term_rms: float = 5.0
    d_p_ratio: float = 0.15
    hf_energy_ratio: float = 0.05
    grade: str = "GOOD"


@dataclass
class _FakeTracking:
    error_std: float = 0.08
    mean_abs_error_by_stick_bin: dict = field(default_factory=dict)
    sem_by_stick_bin: dict = field(default_factory=dict)


def _good_inputs():
    step = {"roll": _FakeStepResponse(), "pitch": _FakeStepResponse()}
    noise = {"roll": _FakeDTermNoise(), "pitch": _FakeDTermNoise()}
    tracking = {"roll": _FakeTracking(), "pitch": _FakeTracking()}
    return step, noise, tracking


def test_well_tuned_log_produces_no_recommendations():
    step, noise, tracking = _good_inputs()
    recs = generate_recommendations(step, noise, tracking)
    assert recs == []


def test_high_overshoot_good_noise_recommends_d_raise():
    step, noise, tracking = _good_inputs()
    step["roll"] = _FakeStepResponse(overshoot_pct=30.0, num_segments_used=20)
    recs = generate_recommendations(step, noise, tracking)

    roll_recs = [r for r in recs if r.axis == "roll"]
    assert len(roll_recs) == 1
    rec = roll_recs[0]
    assert rec.parameter == "d_roll"
    assert rec.change_pct > 0
    assert rec.confidence_pct > 0
    assert len(rec.reason) < 150
    assert "\n" not in rec.reason


def test_high_overshoot_but_poor_noise_recommends_filter_not_d():
    step, noise, tracking = _good_inputs()
    step["roll"] = _FakeStepResponse(overshoot_pct=30.0)
    noise["roll"] = _FakeDTermNoise(d_p_ratio=0.6, hf_energy_ratio=0.4, grade="POOR")
    recs = generate_recommendations(step, noise, tracking)

    roll_recs = [r for r in recs if r.category in ("roll", "filter_ff") and (r.axis in ("roll", "filter"))]
    # Must not recommend raising D for roll when noise is poor.
    assert not any(r.parameter == "d_roll" for r in recs)
    assert any(r.category == "filter_ff" for r in recs)


def test_poor_tracking_low_overshoot_recommends_p_not_d():
    step, noise, tracking = _good_inputs()
    tracking["roll"] = _FakeTracking(error_std=0.3)  # POOR band
    recs = generate_recommendations(step, noise, tracking)

    roll_recs = [r for r in recs if r.axis == "roll"]
    assert len(roll_recs) == 1
    assert roll_recs[0].parameter == "p_roll"


def test_d_raise_respects_damping_ratio_ceiling_when_pids_known():
    step, noise, tracking = _good_inputs()
    step["roll"] = _FakeStepResponse(overshoot_pct=30.0)
    current_pids = {"p_roll": 40.0, "d_roll": 34.0}  # ratio already 0.85 (at ceiling)
    recs = generate_recommendations(step, noise, tracking, current_pids=current_pids)

    d_recs = [r for r in recs if r.parameter == "d_roll"]
    # Already at ceiling -- must not recommend pushing D higher.
    assert d_recs == []


def test_d_raise_caps_at_ceiling_when_room_remains():
    step, noise, tracking = _good_inputs()
    step["roll"] = _FakeStepResponse(overshoot_pct=30.0)
    current_pids = {"p_roll": 40.0, "d_roll": 30.0}  # ratio 0.75, some room to 0.85
    recs = generate_recommendations(step, noise, tracking, current_pids=current_pids)

    d_recs = [r for r in recs if r.parameter == "d_roll"]
    assert len(d_recs) == 1
    assert d_recs[0].proposed_value <= 40.0 * 0.85 + 1e-6
    assert d_recs[0].current_value == 30.0


def test_no_single_recommendation_exceeds_safety_cap():
    step, noise, tracking = _good_inputs()
    step["roll"] = _FakeStepResponse(overshoot_pct=99.0)
    step["pitch"] = _FakeStepResponse(overshoot_pct=99.0)
    tracking["roll"] = _FakeTracking(error_std=0.9)
    tracking["pitch"] = _FakeTracking(error_std=0.9)
    recs = generate_recommendations(step, noise, tracking)
    assert all(abs(r.change_pct) <= 15.0 for r in recs)


def test_compute_readiness_blocks_on_unsupported_version():
    readiness = compute_readiness([], version_supported=False, settings_read_ok=True)
    assert readiness.blocked is True
    assert any("version" in reason.lower() for reason in readiness.block_reasons)


def test_compute_readiness_blocks_on_settings_read_failure():
    readiness = compute_readiness([], version_supported=True, settings_read_ok=False)
    assert readiness.blocked is True
    assert any("settings" in reason.lower() or "read" in reason.lower() for reason in readiness.block_reasons)


def test_compute_readiness_normal_case_not_blocked():
    recs = [
        Recommendation(
            parameter="d_roll",
            axis="roll",
            current_value=30.0,
            proposed_value=33.0,
            change_pct=10.0,
            reason="test",
            confidence_pct=80,
            category="roll",
        )
    ]
    readiness = compute_readiness(recs, version_supported=True, settings_read_ok=True)
    assert readiness.blocked is False
    assert readiness.confidence_pct == 80


def test_compute_readiness_with_zero_recommendations_is_confident():
    readiness = compute_readiness([], version_supported=True, settings_read_ok=True)
    assert readiness.blocked is False
    assert readiness.confidence_pct >= 35
