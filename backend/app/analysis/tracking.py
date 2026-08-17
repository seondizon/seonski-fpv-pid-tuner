"""
Tracking-error metrics (PIDtoolbox `PTplotPIDerror.m` lineage).

Clean-room reimplementation from the description in
docs/research/tuning-algorithms.md ("Tracking Metrics" section):

  * PID-error (gyro - setpoint) histogram, peak-normalized (divided by its own
    max bin count, not the total sample count), std() of that normalized
    histogram as a scalar "looseness" indicator.
  * Stick-deflection-binned mean-absolute-error (10%, 20%, ..., 100% of
    max |setpoint| in the log) with standard error of the mean, showing how
    tracking error grows with maneuver intensity.
  * Two-sample Kolmogorov-Smirnov test between two logs' normalized PID-error
    distributions, to flag statistically significant tuning differences.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.stats import ks_2samp

from app.analysis.setpoint import get_or_reconstruct_setpoint
from app.blackbox.logdata import BlackboxLog

_AXES = ("roll", "pitch", "yaw")

# Histogram range for the PID-error distribution, per tuning-algorithms.md
# ("roughly [-1000, 1000] deg/s").
_ERROR_HIST_RANGE = (-1000.0, 1000.0)
_ERROR_HIST_BINS = 200


@dataclass
class TrackingStats:
    error_std: float                          # std of the peak-normalized PID-error histogram ("looseness" scalar)
    mean_abs_error_by_stick_bin: dict = field(default_factory=dict)   # {10: mae, 20: mae, ..., 100: mae}
    sem_by_stick_bin: dict = field(default_factory=dict)


def _pid_error(log: BlackboxLog, axis: str) -> np.ndarray:
    if axis not in _AXES:
        raise ValueError(f"axis must be one of {_AXES!r}, got {axis!r}")
    setpoint = get_or_reconstruct_setpoint(log, axis)
    gyro = np.asarray(log.gyro.get(axis, []), dtype=float)
    n = min(len(setpoint), len(gyro))
    return gyro[:n] - setpoint[:n]


def _peak_normalized_histogram(error: np.ndarray) -> np.ndarray:
    counts, _ = np.histogram(error, bins=_ERROR_HIST_BINS, range=_ERROR_HIST_RANGE)
    peak = counts.max()
    if peak == 0:
        return counts.astype(float)
    return counts.astype(float) / float(peak)


def compute_tracking_error_stats(log: BlackboxLog, axis: str, num_bins: int = 10) -> TrackingStats:
    """
    error = gyro[axis] - get_or_reconstruct_setpoint(log, axis).

    error_std: std() of the peak-normalized error histogram (PIDtoolbox
    "looseness" scalar -- a wider/flatter normalized histogram means larger
    std, indicating looser tracking).

    Stick-deflection binning: for `num_bins` evenly-spaced thresholds up to
    100% of max(|setpoint|) in this log (i.e. 10%, 20%, ..., 100% for the
    default num_bins=10), each bin covers samples where |setpoint| falls in
    (previous_threshold, this_threshold]. For each bin we report
    mean(|error|) and its standard error of the mean (std / sqrt(n)). A bin
    with zero samples reports NaN for both rather than raising.
    """
    if axis not in _AXES:
        raise ValueError(f"axis must be one of {_AXES!r}, got {axis!r}")
    if num_bins < 1:
        raise ValueError("num_bins must be >= 1")

    setpoint = get_or_reconstruct_setpoint(log, axis)
    gyro = np.asarray(log.gyro.get(axis, []), dtype=float)
    n = min(len(setpoint), len(gyro))
    setpoint = setpoint[:n]
    error = gyro[:n] - setpoint

    normalized_hist = _peak_normalized_histogram(error)
    error_std = float(np.std(normalized_hist))

    abs_setpoint = np.abs(setpoint)
    max_abs_setpoint = float(np.max(abs_setpoint)) if abs_setpoint.size else 0.0
    abs_error = np.abs(error)

    mae_by_bin: dict = {}
    sem_by_bin: dict = {}
    prev_threshold = 0.0
    for i in range(1, num_bins + 1):
        pct = int(round(i * 100.0 / num_bins))
        threshold = max_abs_setpoint * (pct / 100.0)
        if max_abs_setpoint <= 0:
            mae_by_bin[pct] = float("nan")
            sem_by_bin[pct] = float("nan")
            continue
        mask = (abs_setpoint > prev_threshold) & (abs_setpoint <= threshold)
        samples = abs_error[mask]
        if samples.size > 0:
            mae_by_bin[pct] = float(np.mean(samples))
            sem_by_bin[pct] = float(np.std(samples) / np.sqrt(samples.size)) if samples.size > 1 else 0.0
        else:
            mae_by_bin[pct] = float("nan")
            sem_by_bin[pct] = float("nan")
        prev_threshold = threshold

    return TrackingStats(
        error_std=error_std,
        mean_abs_error_by_stick_bin=mae_by_bin,
        sem_by_stick_bin=sem_by_bin,
    )


def compare_tracking_ks(log_a: BlackboxLog, log_b: BlackboxLog, axis: str) -> dict:
    """
    Two-sample Kolmogorov-Smirnov test (scipy.stats.ks_2samp) between
    log_a's and log_b's peak-normalized PID-error histograms for `axis`.

    Returns {'statistic': ..., 'pvalue': ..., 'significant_difference': pvalue <= 0.05}.
    """
    error_a = _pid_error(log_a, axis)
    error_b = _pid_error(log_b, axis)

    hist_a = _peak_normalized_histogram(error_a)
    hist_b = _peak_normalized_histogram(error_b)

    result = ks_2samp(hist_a, hist_b)
    pvalue = float(result.pvalue)
    return {
        "statistic": float(result.statistic),
        "pvalue": pvalue,
        "significant_difference": pvalue <= 0.05,
    }
