"""
Tests for app.analysis.* using purely synthetic signals (no real Blackbox
data). All BlackboxLog fixtures are constructed directly against the
dataclass shape in app.blackbox.logdata -- no dependency on the real BBL/CSV
loading pipeline.
"""
from __future__ import annotations

import numpy as np
import pytest
from scipy.signal import lfilter

from app.blackbox.logdata import BlackboxLog
from app.analysis.setpoint import get_or_reconstruct_setpoint
from app.analysis.step_response import compute_step_response
from app.analysis.fft_noise import (
    compute_dterm_noise_metrics,
    compute_filter_transmission_ratio,
    compute_throttle_noise_heatmap,
    detect_noise_peaks,
)
from app.analysis.tracking import compare_tracking_ks, compute_tracking_error_stats


# ---------------------------------------------------------------------------
# Fixture helper
# ---------------------------------------------------------------------------


def make_log(
    n: int,
    sample_rate_hz: float = 1000.0,
    setpoint: dict | None = None,
    gyro: dict | None = None,
    axis_p: dict | None = None,
    axis_i: dict | None = None,
    axis_d: dict | None = None,
    axis_f: dict | None = None,
    throttle_pct: np.ndarray | None = None,
    headers: dict | None = None,
) -> BlackboxLog:
    time_s = np.arange(n) / sample_rate_hz
    zeros_axes = {"roll": np.zeros(n), "pitch": np.zeros(n), "yaw": np.zeros(n)}
    return BlackboxLog(
        time_s=time_s,
        sample_rate_hz=sample_rate_hz,
        setpoint=setpoint if setpoint is not None else {},
        gyro=gyro if gyro is not None else dict(zeros_axes),
        axis_p=axis_p if axis_p is not None else dict(zeros_axes),
        axis_i=axis_i if axis_i is not None else dict(zeros_axes),
        axis_d=axis_d if axis_d is not None else dict(zeros_axes),
        axis_f=axis_f if axis_f is not None else dict(zeros_axes),
        throttle_pct=throttle_pct if throttle_pct is not None else np.full(n, 50.0),
        motor=np.zeros((n, 4)),
        vbat_v=None,
        headers=headers if headers is not None else {},
        firmware_version=None,
    )


# ---------------------------------------------------------------------------
# setpoint.py
# ---------------------------------------------------------------------------


class TestSetpoint:
    def test_uses_direct_setpoint_when_present(self):
        n = 100
        sp = np.linspace(0, 100, n)
        log = make_log(n, setpoint={"roll": sp})
        result = get_or_reconstruct_setpoint(log, "roll")
        np.testing.assert_allclose(result, sp)

    def test_reconstructs_from_axis_p_and_header(self):
        n = 200
        gyro_roll = np.full(n, 10.0)
        p_term = np.full(n, 5.0)
        log = make_log(
            n,
            setpoint={},
            gyro={"roll": gyro_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            axis_p={"roll": p_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            headers={"rollPID": "45,80,30"},
        )
        result = get_or_reconstruct_setpoint(log, "roll")
        expected = gyro_roll + p_term / (0.032029 * 45.0)
        np.testing.assert_allclose(result, expected)

    def test_missing_header_raises(self):
        n = 50
        log = make_log(
            n,
            setpoint={},
            axis_p={"roll": np.ones(n), "pitch": np.zeros(n), "yaw": np.zeros(n)},
            headers={},
        )
        with pytest.raises(ValueError):
            get_or_reconstruct_setpoint(log, "roll")

    def test_invalid_axis_raises(self):
        log = make_log(10)
        with pytest.raises(ValueError):
            get_or_reconstruct_setpoint(log, "bogus")


# ---------------------------------------------------------------------------
# step_response.py
# ---------------------------------------------------------------------------


class TestStepResponse:
    def _first_order_log(self, tau_s=0.05, sample_rate_hz=1000.0, duration_s=20.0, amplitude=150.0):
        """Square-wave setpoint (within the 20-500 dps gate) driving a known
        first-order lag to produce gyro -- a system with a well-defined,
        analytically-known step response (1 - exp(-t/tau))."""
        n = int(duration_s * sample_rate_hz)
        t = np.arange(n) / sample_rate_hz
        period_s = 2.0
        setpoint_roll = amplitude * (np.mod(t, period_s) < (period_s / 2.0)).astype(float)

        a = np.exp(-1.0 / (sample_rate_hz * tau_s))
        gyro_roll = lfilter([1 - a], [1, -a], setpoint_roll)

        log = make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            setpoint={"roll": setpoint_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            gyro={"roll": gyro_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        return log

    def test_recovers_plausible_step_response(self):
        log = self._first_order_log()
        result = compute_step_response(log, "roll")

        assert result.num_segments_used > 0
        assert result.num_segments_used + result.num_segments_rejected > 0

        # Curve should settle near 1.0 (per-window normalization forces each
        # accepted window's tail to a mean of 1.0, so the averaged tail
        # should also land close to 1.0).
        tail = result.response[-len(result.response) // 5 :]
        assert np.all(np.isfinite(tail))
        assert 0.7 <= np.mean(tail) <= 1.3

        assert result.rise_time_s is not None
        assert 0.0 < result.rise_time_s < 0.3

        assert result.settling_time_s is not None
        assert 0.0 < result.settling_time_s <= 0.5

        assert result.steady_state_error_pct is not None
        assert result.steady_state_error_pct < 10.0

        # First-order lag has no overshoot; allow slack for FFT/windowing
        # ringing artifacts.
        assert result.overshoot_pct is not None
        assert result.overshoot_pct < 40.0

    def test_zero_segments_pass_gate_does_not_crash(self):
        n = 5000
        sample_rate_hz = 1000.0
        # Setpoint amplitude well below the 20 dps gate floor -> every window
        # should be rejected.
        setpoint_roll = np.full(n, 5.0)
        gyro_roll = np.full(n, 5.0)
        log = make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            setpoint={"roll": setpoint_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            gyro={"roll": gyro_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        result = compute_step_response(log, "roll")

        assert result.num_segments_used == 0
        assert result.num_segments_rejected > 0
        assert np.all(np.isnan(result.response))
        assert result.overshoot_pct is None
        assert result.rise_time_s is None
        assert result.settling_time_s is None
        assert result.steady_state_error_pct is None

    def test_invalid_axis_raises(self):
        log = self._first_order_log(duration_s=2.0)
        with pytest.raises(ValueError):
            compute_step_response(log, "bogus")

    def test_log_shorter_than_window_does_not_crash(self):
        n = 50  # far shorter than the default 1s window at 1000 Hz
        log = make_log(
            n,
            setpoint={"roll": np.full(n, 100.0), "pitch": np.zeros(n), "yaw": np.zeros(n)},
            gyro={"roll": np.full(n, 100.0), "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        result = compute_step_response(log, "roll")
        assert result.num_segments_used == 0
        assert result.num_segments_rejected == 0


# ---------------------------------------------------------------------------
# fft_noise.py
# ---------------------------------------------------------------------------


class TestFftNoise:
    def test_detect_noise_peaks_finds_known_tone(self):
        sample_rate_hz = 2000.0
        duration_s = 4.0
        n = int(sample_rate_hz * duration_s)
        t = np.arange(n) / sample_rate_hz
        rng = np.random.default_rng(0)
        signal = 5.0 * np.sin(2 * np.pi * 150.0 * t) + 0.05 * rng.standard_normal(n)

        freq_hz = np.fft.rfftfreq(n, d=1.0 / sample_rate_hz)
        magnitude = np.abs(np.fft.rfft(signal))

        peaks = detect_noise_peaks(freq_hz, magnitude)
        assert len(peaks) > 0
        closest = min(peaks, key=lambda p: abs(p.freq_hz - 150.0))
        assert abs(closest.freq_hz - 150.0) < 5.0
        assert closest.classification in {
            "motor",
            "prop_blade_pass",
            "structural_resonance",
            "high_freq_resonance",
            "unknown",
        }

    def test_dterm_noise_grade_good(self):
        n = 2000
        sample_rate_hz = 1000.0
        t = np.arange(n) / sample_rate_hz
        p_term = 20.0 * np.sin(2 * np.pi * 5.0 * t)
        d_term = 2.0 * np.sin(2 * np.pi * 5.0 * t)  # ratio = 0.1, low-freq only
        log = make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            axis_p={"roll": p_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            axis_d={"roll": d_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        metrics = compute_dterm_noise_metrics(log, "roll")
        assert metrics.grade == "GOOD"
        assert metrics.d_p_ratio == pytest.approx(0.1, rel=0.05)

    def test_dterm_noise_grade_poor(self):
        n = 2000
        sample_rate_hz = 1000.0
        t = np.arange(n) / sample_rate_hz
        p_term = 10.0 * np.sin(2 * np.pi * 5.0 * t)
        d_term = 6.0 * np.sin(2 * np.pi * 5.0 * t)  # ratio = 0.6 -> POOR
        log = make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            axis_p={"roll": p_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            axis_d={"roll": d_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        metrics = compute_dterm_noise_metrics(log, "roll")
        assert metrics.grade == "POOR"
        assert metrics.d_p_ratio > 0.5

    def test_dterm_noise_grade_marginal_via_hf_ratio(self):
        n = 4000
        sample_rate_hz = 1000.0
        t = np.arange(n) / sample_rate_hz
        # d/p ratio kept comfortably below 0.3, but D-term dominated by
        # high-frequency content above fs/8 = 125 Hz -> MARGINAL via
        # hf_energy_ratio, not via d_p_ratio.
        d_term = 1.0 * np.sin(2 * np.pi * 5.0 * t) + 3.0 * np.sin(2 * np.pi * 200.0 * t)
        p_term = 21.0 * np.sin(2 * np.pi * 5.0 * t)
        log = make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            axis_p={"roll": p_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            axis_d={"roll": d_term, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )
        metrics = compute_dterm_noise_metrics(log, "roll")
        assert metrics.d_p_ratio <= 0.3
        assert metrics.hf_energy_ratio > 0.3
        assert metrics.grade == "MARGINAL"

    def test_dterm_noise_missing_axis_raises(self):
        log = make_log(10)
        with pytest.raises(ValueError):
            compute_dterm_noise_metrics(log, "bogus")

    def test_throttle_noise_heatmap_shape_and_nan_handling(self):
        sample_rate_hz = 500.0
        n = int(sample_rate_hz * 2.0)
        rng = np.random.default_rng(1)
        signal = rng.standard_normal(n)
        # Throttle only ever in a narrow band -> most bins should be NaN.
        throttle_pct = np.full(n, 40.0)

        spectrogram = compute_throttle_noise_heatmap(signal, throttle_pct, sample_rate_hz)
        assert spectrogram.magnitude.shape == (100, len(spectrogram.freq_hz))
        assert np.all(spectrogram.throttle_bins_pct == np.arange(1, 101))
        # Bin near 40% should be populated (not NaN).
        assert not np.isnan(spectrogram.magnitude[39]).all()
        # A bin far from 40% (with default 6% overlap) should be all-NaN.
        assert np.isnan(spectrogram.magnitude[0]).all()

    def test_filter_transmission_ratio_unity_when_signals_equal(self):
        n = 512
        sample_rate_hz = 1000.0
        t = np.arange(n) / sample_rate_hz
        signal = np.sin(2 * np.pi * 50.0 * t)
        freq_hz, ratio = compute_filter_transmission_ratio(signal, signal, sample_rate_hz)
        assert len(freq_hz) == len(ratio)
        # Where the pre-filter signal has real energy, ratio should be ~1.
        idx = np.argmax(np.abs(np.fft.rfft(signal)))
        assert ratio[idx] == pytest.approx(1.0, rel=1e-3)


# ---------------------------------------------------------------------------
# tracking.py
# ---------------------------------------------------------------------------


class TestTracking:
    def _tracking_log(self, undershoot_frac=0.1, noise_std=2.0, seed=42, n=4000, sample_rate_hz=1000.0):
        t = np.arange(n) / sample_rate_hz
        rng = np.random.default_rng(seed)
        setpoint_roll = 500.0 * np.sin(2 * np.pi * 0.5 * t)
        gyro_roll = setpoint_roll * (1.0 - undershoot_frac) + noise_std * rng.standard_normal(n)
        return make_log(
            n,
            sample_rate_hz=sample_rate_hz,
            setpoint={"roll": setpoint_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
            gyro={"roll": gyro_roll, "pitch": np.zeros(n), "yaw": np.zeros(n)},
        )

    def test_compute_tracking_error_stats_is_sane(self):
        log = self._tracking_log()
        stats = compute_tracking_error_stats(log, "roll", num_bins=10)

        assert np.isfinite(stats.error_std)
        assert stats.error_std >= 0.0
        assert set(stats.mean_abs_error_by_stick_bin.keys()) == {10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
        assert set(stats.sem_by_stick_bin.keys()) == set(stats.mean_abs_error_by_stick_bin.keys())

        # Tracking error should broadly grow with stick deflection, since
        # error = -undershoot_frac * setpoint + noise.
        mae_10 = stats.mean_abs_error_by_stick_bin[10]
        mae_100 = stats.mean_abs_error_by_stick_bin[100]
        assert np.isfinite(mae_10) and np.isfinite(mae_100)
        assert mae_100 > mae_10

    def test_compute_tracking_error_stats_invalid_axis_raises(self):
        log = self._tracking_log()
        with pytest.raises(ValueError):
            compute_tracking_error_stats(log, "bogus")

    def test_ks_self_comparison_high_pvalue(self):
        log = self._tracking_log()
        result = compare_tracking_ks(log, log, "roll")
        assert result["pvalue"] > 0.05
        assert result["significant_difference"] is False
        assert result["statistic"] == pytest.approx(0.0, abs=1e-9)

    def test_ks_different_distributions_low_pvalue(self):
        loose_log = self._tracking_log(undershoot_frac=0.5, noise_std=10.0, seed=1)
        tight_log = self._tracking_log(undershoot_frac=0.0, noise_std=0.5, seed=2)
        result = compare_tracking_ks(loose_log, tight_log, "roll")
        assert result["pvalue"] <= 0.05
        assert result["significant_difference"] is True
