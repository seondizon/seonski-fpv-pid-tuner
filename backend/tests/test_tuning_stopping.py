from __future__ import annotations

from app.tuning.stopping import evaluate_tune_complete


def _summary(overall_grade, roll_tracking=90.0, roll_overshoot=5.0, pitch_tracking=90.0, pitch_overshoot=5.0, dterm_grade="GOOD"):
    return {
        "overall_grade": overall_grade,
        "confidence_pct": 90,
        "axes": {
            "roll": {"grade": "GOOD" if overall_grade == "GOOD" else overall_grade, "tracking_pct": roll_tracking, "overshoot_pct": roll_overshoot},
            "pitch": {"grade": "GOOD" if overall_grade == "GOOD" else overall_grade, "tracking_pct": pitch_tracking, "overshoot_pct": pitch_overshoot},
            "yaw": {"grade": "GOOD"},
        },
        "noise": {"dterm_grade": dterm_grade, "gyro_grade": "GOOD"},
    }


def test_all_good_no_previous_is_complete():
    result = evaluate_tune_complete(_summary("GOOD"), None)
    assert result["tune_complete"] is True
    assert result["improvement_pct"] is None


def test_poor_axis_not_complete_with_reason():
    result = evaluate_tune_complete(_summary("POOR", roll_tracking=40.0, roll_overshoot=40.0), None)
    assert result["tune_complete"] is False
    assert len(result["reasons"]) >= 1


def test_meaningful_improvement_not_complete():
    previous = _summary("FAIR", roll_tracking=50.0, roll_overshoot=30.0, pitch_tracking=50.0, pitch_overshoot=30.0)
    current = _summary("GOOD", roll_tracking=95.0, roll_overshoot=3.0, pitch_tracking=95.0, pitch_overshoot=3.0)
    result = evaluate_tune_complete(current, previous)
    assert result["tune_complete"] is False
    assert result["improvement_pct"] > 1.0


def test_negligible_improvement_is_complete():
    previous = _summary("GOOD", roll_tracking=90.0, roll_overshoot=5.0, pitch_tracking=90.0, pitch_overshoot=5.0)
    current = _summary("GOOD", roll_tracking=90.2, roll_overshoot=4.9, pitch_tracking=90.1, pitch_overshoot=5.0)
    result = evaluate_tune_complete(current, previous)
    assert result["tune_complete"] is True
    assert result["improvement_pct"] < 1.0


def test_regression_still_reports_but_not_crash():
    previous = _summary("GOOD", roll_tracking=95.0, roll_overshoot=3.0, pitch_tracking=95.0, pitch_overshoot=3.0)
    current = _summary("GOOD", roll_tracking=91.0, roll_overshoot=5.0, pitch_tracking=91.0, pitch_overshoot=5.0)
    result = evaluate_tune_complete(current, previous)
    assert isinstance(result["tune_complete"], bool)
    assert result["improvement_pct"] <= 0
    # Regression test for a double-sign formatting bug ("+-5%" instead of
    # "-5%") found on review: a negative improvement_pct must not produce a
    # reason string with two leading sign characters.
    assert "+-" not in result["reasons"][0]
