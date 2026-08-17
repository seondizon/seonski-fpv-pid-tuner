from __future__ import annotations

from app.analysis.grading import (
    grade_overshoot,
    grade_tracking_error_std,
    tracking_error_std_to_pct,
    grade_oscillation,
    grade_dterm_noise,
    overall_grade,
)


def test_grade_overshoot_bands():
    assert grade_overshoot(5.0) == "GOOD"
    assert grade_overshoot(15.0) == "FAIR"
    assert grade_overshoot(40.0) == "POOR"
    assert grade_overshoot(None) == "UNKNOWN"


def test_grade_tracking_error_std_bands():
    assert grade_tracking_error_std(0.05) == "GOOD"
    assert grade_tracking_error_std(0.18) == "FAIR"
    assert grade_tracking_error_std(0.5) == "POOR"
    assert grade_tracking_error_std(None) == "UNKNOWN"


def test_tracking_error_std_to_pct_monotonic_and_bounded():
    assert tracking_error_std_to_pct(None) is None
    lo = tracking_error_std_to_pct(0.0)
    hi = tracking_error_std_to_pct(1.0)
    assert lo == 100.0
    assert hi == 0.0
    assert 0.0 <= tracking_error_std_to_pct(0.2) <= 100.0


def test_grade_oscillation():
    assert grade_oscillation(5.0, 0.05) == "LOW"
    assert grade_oscillation(15.0, 0.05) == "MODERATE"
    assert grade_oscillation(30.0, 0.2) == "HIGH"
    assert grade_oscillation(None, 0.05) == "UNKNOWN"


def test_grade_dterm_noise():
    assert grade_dterm_noise(0.1, 0.05) == "GOOD"
    assert grade_dterm_noise(0.35, 0.05) == "FAIR"
    assert grade_dterm_noise(0.6, 0.05) == "POOR"
    assert grade_dterm_noise(None, None) == "UNKNOWN"


def test_overall_grade_is_worst_known():
    assert overall_grade(["GOOD", "FAIR", "GOOD"]) == "FAIR"
    assert overall_grade(["GOOD", "POOR"]) == "POOR"
    assert overall_grade(["GOOD", "GOOD"]) == "GOOD"
    assert overall_grade(["UNKNOWN", "UNKNOWN"]) == "UNKNOWN"
    assert overall_grade(["UNKNOWN", "GOOD"]) == "GOOD"
