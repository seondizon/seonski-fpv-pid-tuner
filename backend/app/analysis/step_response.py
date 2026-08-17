"""
Step-response extraction via Wiener deconvolution.

Clean-room reimplementation of the PID-Analyzer (Plasmatree) / SmartTune CLI
lineage described in docs/research/tuning-algorithms.md ("Step-Response
Approaches" and "Event Detection Approaches" sections):

  * Primary method: Wiener-regularized FFT deconvolution over Hann-windowed,
    heavily-overlapped sliding windows across the whole flight (PID-Analyzer
    lineage) -- not PIDtoolbox's snap-release heuristic, and not an
    ungated continuous sweep like the original PID-Analyzer.
  * SmartTune-style SP-amplitude gating (20-500 deg/s by default) is applied
    per window *before* deconvolving, to discard windows with too little or
    too much stick input to produce a trustworthy step response.
  * A steady-state sanity QC (per SmartTune) rejects windows whose settled
    tail isn't in a plausible range, before they're allowed to contribute to
    the final average.
  * On top of the averaged curve we compute the scalar metrics that FPVPIDlab
    computes and neither PIDtoolbox nor PID-Analyzer do at all: rise time,
    overshoot %, settling time, steady-state error.

None of this is a byte-for-byte port of any reference project -- the exact
regularization-mask shape and QC constants below are our own clean-room
implementation of the *math descriptions* in tuning-algorithms.md, not copied
code. Treat specific constants (regularization scale, QC bounds) as our own
first-pass choices to be validated against real logs later, same as the
sources they're inspired by.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal.windows import hann

from app.analysis.setpoint import get_or_reconstruct_setpoint
from app.blackbox.logdata import BlackboxLog

_AXES = ("roll", "pitch", "yaw")

# Steady-state QC bounds (SmartTune-style): the *normalized* tail of a
# per-window step response must settle somewhere in this range to be trusted.
# Values well outside [0.5, 3.0] indicate the deconvolution blew up on that
# window (e.g. near-zero settled gain, or wild divergence), not a real tuning
# characteristic.
_QC_SETTLED_MIN = 0.5
_QC_SETTLED_MAX = 3.0

# Portion of the extracted response window treated as "settled tail" for both
# per-window QC/normalization and for the final scalar metrics. Mirrors
# SmartTune's "mean in [0.5, 3.0] over 200-500ms" language: with the default
# response_window_s=0.5, this tail is exactly the [0.2s, 0.5s] region.
_TAIL_START_S = 0.2
_TAIL_FRACTION_OF_WINDOW = 0.6  # fallback if response_window_s < _TAIL_START_S

# Settling-time band: +/- this fraction of the settled value.
_SETTLING_BAND_FRAC = 0.05


@dataclass
class StepResponseResult:
    time_s: np.ndarray          # 0..response_window_s, response curve time axis
    response: np.ndarray        # normalized step response (0 = start, ~1 = settled)
    num_segments_used: int      # how many windows passed quality gating and contributed
    num_segments_rejected: int
    overshoot_pct: float | None    # None if response never exceeds ~1.0 meaningfully
    rise_time_s: float | None      # time from 10% to 90% of settled value
    settling_time_s: float | None  # time to stay within e.g. +/-5% of settled value
    steady_state_error_pct: float | None


def _next_pow2(n: int) -> int:
    n = max(int(n), 1)
    return 1 << int(np.ceil(np.log2(n)))


def _tail_start_index(sample_rate_hz: float, response_window_s: float, n_resp: int) -> int:
    tail_start_s = min(_TAIL_START_S, response_window_s * _TAIL_FRACTION_OF_WINDOW)
    idx = int(round(tail_start_s * sample_rate_hz))
    return int(min(max(idx, 0), max(n_resp - 1, 0)))


def _build_regularization(H: np.ndarray, freqs: np.ndarray, cutoff_hz: float) -> np.ndarray:
    """
    Frequency-dependent Wiener regularization mask, following the PID-Analyzer
    method described in tuning-algorithms.md: frequencies below `cutoff_hz` are
    trusted as signal (small regularization, deconvolution dominated by
    G*conj(H)/|H|^2), frequencies above are treated as noise-dominated (large
    regularization, deconvolution suppressed towards ~0 there). The transition
    is softened with a Gaussian smoothing pass instead of a hard step, to avoid
    ringing artifacts from a discontinuous mask.
    """
    Pxx = np.abs(H) ** 2
    max_power = float(Pxx.max()) if Pxx.max() > 0 else 1.0

    # Small baseline regularization everywhere, mainly to avoid divide-by-zero
    # (inspired by SmartTune's lambda = 1e-4 * max(Pxx) baseline term).
    base_reg = 1e-4 * max_power

    abs_freqs = np.abs(freqs)
    raw_mask = (abs_freqs > cutoff_hz).astype(float)

    # fftfreq's bin ordering ([0, df, ..., +fmax, -fmax, ..., -df]) is
    # circular in real frequency space (the last bin is adjacent to the
    # first when wrapped), so mode='wrap' smooths correctly across that
    # boundary instead of treating it as a discontinuity.
    freq_res = freqs[1] - freqs[0] if len(freqs) > 1 else 1.0
    freq_res = abs(freq_res) or 1.0
    sigma_bins = max(1.0, (cutoff_hz * 0.25) / freq_res)
    soft_mask = gaussian_filter1d(raw_mask, sigma=sigma_bins, mode="wrap")

    heavy_reg_scale = 50.0 * max_power
    return base_reg + soft_mask * heavy_reg_scale


def _process_window(
    sp_seg: np.ndarray,
    gyro_seg: np.ndarray,
    sample_rate_hz: float,
    cutoff_hz: float,
    n_resp: int,
    nfft: int,
) -> np.ndarray:
    """Hann-window, deconvolve, cumsum -> raw (un-normalized, zero-baselined) step response."""
    win = hann(len(sp_seg), sym=False)
    sp_windowed = sp_seg * win
    gyro_windowed = gyro_seg * win

    H = np.fft.fft(sp_windowed, n=nfft)
    G = np.fft.fft(gyro_windowed, n=nfft)
    freqs = np.fft.fftfreq(nfft, d=1.0 / sample_rate_hz)

    regularization = _build_regularization(H, freqs, cutoff_hz)
    deconvolved = np.real(np.fft.ifft(G * np.conj(H) / (H * np.conj(H) + regularization)))

    raw = np.cumsum(deconvolved)[:n_resp]
    raw = raw - raw[0]  # baseline: early value ~0
    return raw


def compute_step_response(
    log: BlackboxLog,
    axis: str,
    window_s: float = 1.0,
    overlap_factor: int = 16,
    cutoff_hz: float = 25.0,
    response_window_s: float = 0.5,
    sp_gate_min_dps: float = 20.0,
    sp_gate_max_dps: float = 500.0,
) -> StepResponseResult:
    if axis not in _AXES:
        raise ValueError(f"axis must be one of {_AXES!r}, got {axis!r}")

    setpoint = get_or_reconstruct_setpoint(log, axis)
    gyro = log.gyro.get(axis) if getattr(log, "gyro", None) else None
    if gyro is None or len(gyro) == 0:
        raise ValueError(f"log.gyro[{axis!r}] is missing/empty")
    gyro = np.asarray(gyro, dtype=float)
    setpoint = np.asarray(setpoint, dtype=float)

    sample_rate_hz = float(log.sample_rate_hz)
    n_total = min(len(setpoint), len(gyro))
    setpoint = setpoint[:n_total]
    gyro = gyro[:n_total]

    window_len = max(int(round(window_s * sample_rate_hz)), 2)
    n_resp = max(int(round(response_window_s * sample_rate_hz)), 1)
    nfft = _next_pow2(max(window_len, n_resp))
    stride = max(int(window_len // max(overlap_factor, 1)), 1)

    time_s = np.arange(n_resp) / sample_rate_hz

    num_used = 0
    num_rejected = 0
    accepted_responses = []

    if n_total >= window_len:
        for start in range(0, n_total - window_len + 1, stride):
            sp_seg = setpoint[start : start + window_len]
            gyro_seg = gyro[start : start + window_len]

            # SmartTune-style SP-amplitude gating: discard windows with too
            # little stick input (nothing to measure) or too much (likely a
            # non-representative/extreme maneuver).
            peak_sp = np.max(np.abs(sp_seg))
            if not (sp_gate_min_dps <= peak_sp <= sp_gate_max_dps):
                num_rejected += 1
                continue

            raw = _process_window(sp_seg, gyro_seg, sample_rate_hz, cutoff_hz, n_resp, nfft)

            tail_idx = _tail_start_index(sample_rate_hz, response_window_s, n_resp)
            tail = raw[tail_idx:]
            if tail.size == 0:
                num_rejected += 1
                continue
            settled_mean = float(np.mean(tail))

            # Steady-state QC: reject windows whose settled tail isn't in a
            # plausible range (near-zero or wildly divergent settled gain
            # indicates the deconvolution didn't produce a trustworthy result
            # on this window, not a real tuning characteristic).
            if not (_QC_SETTLED_MIN <= settled_mean <= _QC_SETTLED_MAX):
                num_rejected += 1
                continue

            normalized = raw / settled_mean
            accepted_responses.append(normalized)
            num_used += 1
    # else: log shorter than one window -> zero windows attempted, zero used/rejected.

    if num_used == 0:
        return StepResponseResult(
            time_s=time_s,
            response=np.full(n_resp, np.nan),
            num_segments_used=0,
            num_segments_rejected=num_rejected,
            overshoot_pct=None,
            rise_time_s=None,
            settling_time_s=None,
            steady_state_error_pct=None,
        )

    # Plain mean across accepted windows. NOTE: PID-Analyzer instead uses a
    # density/mode-seeking weighted average (2D histogram of time x amplitude
    # across all windows, Gaussian-smoothed, density^2-weighted) which is more
    # robust to outlier windows than a plain mean. That's a documented
    # alternative worth revisiting later if plain averaging proves too
    # sensitive to outliers in practice; a simple mean is a reasonable
    # starting point since we already QC-gate windows before they reach here.
    averaged = np.mean(np.stack(accepted_responses, axis=0), axis=0)

    overshoot_pct, rise_time_s, settling_time_s, steady_state_error_pct = _compute_metrics(
        time_s, averaged, sample_rate_hz, response_window_s
    )

    return StepResponseResult(
        time_s=time_s,
        response=averaged,
        num_segments_used=num_used,
        num_segments_rejected=num_rejected,
        overshoot_pct=overshoot_pct,
        rise_time_s=rise_time_s,
        settling_time_s=settling_time_s,
        steady_state_error_pct=steady_state_error_pct,
    )


def _compute_metrics(
    time_s: np.ndarray,
    response: np.ndarray,
    sample_rate_hz: float,
    response_window_s: float,
):
    """
    Compute scalar step-response metrics using standard control-theory
    definitions, on the assumption that the response is normalized so a
    perfectly-tracking system would settle at 1.0:

      - overshoot_pct: (peak - settled) / settled * 100, 0 if peak <= settled.
      - rise_time_s: time from the response first reaching 10% of the settled
        value to first reaching 90% of the settled value.
      - settling_time_s: time after which the response stays within
        +/- 5% of the settled value for the remainder of the response window
        (found by walking backward from the end for the last band violation).
      - steady_state_error_pct: |1.0 - settled| * 100, i.e. how far the
        settled value is from the ideal normalized target of 1.0, in
        percentage points.

    Returns None for any metric that isn't well-defined (e.g. settled value
    is <= 0, or the response never reaches the required threshold).
    """
    n_resp = len(response)
    tail_idx = _tail_start_index(sample_rate_hz, response_window_s, n_resp)
    tail = response[tail_idx:]
    if tail.size == 0 or not np.all(np.isfinite(tail)):
        return None, None, None, None

    settled = float(np.mean(tail))
    if settled <= 0 or not np.isfinite(settled):
        return None, None, None, None

    peak = float(np.max(response))
    overshoot_pct = ((peak - settled) / settled * 100.0) if peak > settled else 0.0

    lo_thresh = 0.1 * settled
    hi_thresh = 0.9 * settled
    idx_lo_candidates = np.flatnonzero(response >= lo_thresh)
    rise_time_s = None
    if idx_lo_candidates.size > 0:
        idx_lo = idx_lo_candidates[0]
        idx_hi_candidates = np.flatnonzero(response[idx_lo:] >= hi_thresh)
        if idx_hi_candidates.size > 0:
            idx_hi = idx_lo + idx_hi_candidates[0]
            rise_time_s = float(time_s[idx_hi] - time_s[idx_lo])

    band = _SETTLING_BAND_FRAC * abs(settled)
    outside = np.flatnonzero(np.abs(response - settled) > band)
    settling_time_s = None
    if outside.size == 0:
        settling_time_s = float(time_s[0])
    elif outside[-1] < n_resp - 1:
        settling_time_s = float(time_s[outside[-1] + 1])
    # else: still outside the band at the very end of the response window ->
    # settling_time_s stays None (never demonstrably settled within the window).

    steady_state_error_pct = abs(1.0 - settled) * 100.0

    return overshoot_pct, rise_time_s, settling_time_s, steady_state_error_pct
