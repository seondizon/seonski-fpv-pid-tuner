from __future__ import annotations

from app.tuning.compare import compare_iterations, find_best_iteration
from app.tuning.store import Iteration


def _summary(roll_tracking, roll_overshoot, pitch_tracking, pitch_overshoot, dterm_grade):
    return {
        "overall_grade": "GOOD",
        "axes": {
            "roll": {"tracking_pct": roll_tracking, "overshoot_pct": roll_overshoot},
            "pitch": {"tracking_pct": pitch_tracking, "overshoot_pct": pitch_overshoot},
            "yaw": {"tracking_pct": None, "overshoot_pct": None},
        },
        "noise": {"dterm_grade": dterm_grade},
    }


def test_compare_iterations_newer_is_better():
    older = _summary(60, 20, 60, 20, "FAIR")
    newer = _summary(85, 5, 85, 5, "GOOD")
    result = compare_iterations(older, newer)
    assert result["better"] == "newer"
    assert result["tracking_delta_pct"] > 0
    assert result["overshoot_delta_pct"] > 0
    assert result["noise_delta"] > 0


def test_compare_iterations_older_is_better():
    older = _summary(90, 3, 90, 3, "GOOD")
    newer = _summary(60, 25, 60, 25, "POOR")
    result = compare_iterations(older, newer)
    assert result["better"] == "older"


def test_compare_iterations_tie_when_nearly_identical():
    older = _summary(80, 8, 80, 8, "GOOD")
    newer = _summary(81, 7.5, 80, 8, "GOOD")
    result = compare_iterations(older, newer)
    assert result["better"] == "tie"


def test_compare_iterations_unknown_when_no_data():
    older = _summary(None, None, None, None, None)
    newer = _summary(None, None, None, None, None)
    result = compare_iterations(older, newer)
    assert result["better"] == "unknown"


def test_find_best_iteration_picks_highest_scoring():
    iterations = [
        Iteration(number=1, timestamp=0, label="Baseline", analysis_summary=_summary(60, 20, 60, 20, "FAIR")),
        Iteration(number=2, timestamp=1, label="Applied", analysis_summary=_summary(90, 3, 90, 3, "GOOD")),
        Iteration(number=3, timestamp=2, label="Applied", analysis_summary=_summary(70, 15, 70, 15, "FAIR")),
    ]
    assert find_best_iteration(iterations) == 2


def test_find_best_iteration_empty_or_no_data_returns_none():
    assert find_best_iteration([]) is None
    iterations = [Iteration(number=1, timestamp=0, label="Baseline", analysis_summary={})]
    assert find_best_iteration(iterations) is None
