"""
FFT / frequency-domain noise analysis.

Clean-room reimplementation (from the math descriptions in
docs/research/tuning-algorithms.md, "FFT / Frequency-Domain Approaches" and
"Noise Metrics" sections) of:

  * PIDtoolbox's throttle-binned FFT noise heatmap (`PTthrSpec.m` lineage) --
    described there as "the most portable, well-specified algorithm" among all
    references studied.
  * SmartTune-style FFT peak detection + motor/prop/structural classification.
  * PID-Analyzer's filter-transmission-ratio concept.
  * SmartTune's D-term noise metrics/grading thresholds.

No code from any of those projects is copied -- only PIDtoolbox/PID-Analyzer's
*algorithm descriptions* are used (they are not reusable per
docs/research/reference-analysis.md), and SmartTune's approach, while MIT and
directly reusable, is likewise reimplemented here rather than vendored, to
keep this module dependency-free of any external repo.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import uniform_filter
from scipy.signal.windows import hann

from app.blackbox.logdata import BlackboxLog

try:
    from scipy.signal import find_peaks as _scipy_find_peaks
except ImportError:  # pragma: no cover - exercised only when scipy is absent
    _scipy_find_peaks = None


# ---------------------------------------------------------------------------
# Throttle-binned FFT noise heatmap (PIDtoolbox PTthrSpec.m lineage)
# ---------------------------------------------------------------------------


@dataclass
class ThrottleSpectrogram:
    throttle_bins_pct: np.ndarray   # e.g. 1..100
    freq_hz: np.ndarray
    magnitude: np.ndarray           # shape (len(throttle_bins_pct), len(freq_hz))


def compute_throttle_noise_heatmap(
    signal: np.ndarray,
    throttle_pct: np.ndarray,
    sample_rate_hz: float,
    segment_s: float = 0.2,
    bin_overlap_pct: float = 6.0,
    smooth_kernel=(3, 3),
) -> ThrottleSpectrogram:
    """
    PIDtoolbox `PTthrSpec.m`-style throttle-vs-frequency noise heatmap:

    1. Split `signal` into non-overlapping `segment_s`-length segments.
    2. Tag each segment with its mean throttle (from `throttle_pct`).
    3. Pool segments into 100 integer throttle bins (1..100), each bin
       collecting every segment whose mean throttle is within
       +/- `bin_overlap_pct` of the bin center (deliberate overlap/smoothing,
       per the source algorithm).
    4. Hann-window + rfft-magnitude each pooled segment, nanmean across the
       pooled segments in that bin -> one row of the throttle x frequency
       matrix. Bins with zero pooled segments are left as NaN.
    5. 2D box-smooth the resulting matrix with `scipy.ndimage.uniform_filter`.
    """
    signal = np.asarray(signal, dtype=float)
    throttle_pct = np.asarray(throttle_pct, dtype=float)
    n = min(len(signal), len(throttle_pct))
    signal = signal[:n]
    throttle_pct = throttle_pct[:n]

    seg_len = max(int(round(segment_s * sample_rate_hz)), 1)
    num_segments = n // seg_len

    freq_hz = np.fft.rfftfreq(seg_len, d=1.0 / sample_rate_hz)
    throttle_bins_pct = np.arange(1, 101, dtype=float)

    if num_segments == 0:
        magnitude = np.full((len(throttle_bins_pct), len(freq_hz)), np.nan)
        return ThrottleSpectrogram(throttle_bins_pct, freq_hz, magnitude)

    win = hann(seg_len, sym=False)

    seg_mean_throttle = np.empty(num_segments)
    seg_spectra = np.empty((num_segments, len(freq_hz)))
    for i in range(num_segments):
        chunk = signal[i * seg_len : (i + 1) * seg_len]
        thr_chunk = throttle_pct[i * seg_len : (i + 1) * seg_len]
        seg_mean_throttle[i] = np.mean(thr_chunk)
        spectrum = np.fft.rfft(chunk * win)
        seg_spectra[i] = np.abs(spectrum)

    magnitude = np.full((len(throttle_bins_pct), len(freq_hz)), np.nan)
    for row, center in enumerate(throttle_bins_pct):
        mask = np.abs(seg_mean_throttle - center) <= bin_overlap_pct
        if np.any(mask):
            magnitude[row] = np.nanmean(seg_spectra[mask], axis=0)

    # 2D box smoothing. NaNs would poison uniform_filter, so smooth a
    # nan-to-zero copy and a validity mask separately, then divide back out
    # (a standard trick for smoothing arrays with holes).
    valid = ~np.isnan(magnitude)
    filled = np.where(valid, magnitude, 0.0)
    smoothed_sum = uniform_filter(filled, size=smooth_kernel, mode="nearest")
    smoothed_count = uniform_filter(valid.astype(float), size=smooth_kernel, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        smoothed = np.where(smoothed_count > 0, smoothed_sum / smoothed_count, np.nan)

    return ThrottleSpectrogram(throttle_bins_pct, freq_hz, smoothed)


# ---------------------------------------------------------------------------
# SmartTune-style peak detection + classification
# ---------------------------------------------------------------------------


@dataclass
class NoisePeak:
    freq_hz: float
    magnitude_db: float
    prominence_db: float
    classification: str   # 'motor' | 'prop_blade_pass' | 'structural_resonance' | 'high_freq_resonance' | 'unknown'


# Heuristic frequency-range assumptions (SmartTune-style, our own first-pass
# numbers -- need tuning against real logs later):
#   - "motor" band: fundamental motor electrical/mechanical noise, roughly
#     80-300 Hz on typical 5" freestyle quads at cruise-to-high throttle.
#   - "prop_blade_pass" band: prop blade-pass frequency (motor RPM x blade
#     count), typically overlapping/just above the motor band, ~150-500 Hz.
#   - "structural_resonance": mid-range frame/arm resonances, ~300-800 Hz.
#   - "high_freq_resonance": anything higher, >800 Hz (electrical noise,
#     high-order harmonics, etc).
# A peak found to be ~2x or ~3x the frequency of a stronger, lower-frequency
# peak is classified as a harmonic of that peak's category rather than by its
# own raw frequency band (harmonic relationship takes priority).
_MOTOR_BAND = (60.0, 300.0)
_PROP_BAND = (150.0, 500.0)
_STRUCTURAL_BAND = (300.0, 800.0)
_HARMONIC_RATIOS = (2.0, 3.0)
_HARMONIC_TOLERANCE = 0.08  # +/- 8% tolerance when matching a harmonic ratio


def _classify_by_band(freq_hz: float) -> str:
    if _MOTOR_BAND[0] <= freq_hz <= _MOTOR_BAND[1]:
        return "motor"
    if _PROP_BAND[0] <= freq_hz <= _PROP_BAND[1]:
        return "prop_blade_pass"
    if _STRUCTURAL_BAND[0] <= freq_hz <= _STRUCTURAL_BAND[1]:
        return "structural_resonance"
    if freq_hz > _STRUCTURAL_BAND[1]:
        return "high_freq_resonance"
    return "unknown"


def _find_peaks_numpy_fallback(
    values: np.ndarray, height: float, prominence: float, distance: int
) -> np.ndarray:
    """
    Pure-numpy local-maxima peak finder, used when scipy is unavailable (per
    tuning-algorithms.md: "this project wants the option to drop scipy on the
    Pi later"). Not a full reimplementation of scipy's prominence algorithm,
    but a reasonable approximation:
      1. Find strict local maxima above `height`.
      2. Approximate each candidate's prominence as the drop to the lower of
         its two nearest valleys on either side (within the full array),
         reusing scipy's own definition in spirit (min of the two sides).
      3. Enforce minimum `distance` between kept peaks, keeping the taller
         peak when two candidates are too close (greedy, tallest-first).
    """
    n = len(values)
    candidates = [
        i for i in range(1, n - 1)
        if values[i] > values[i - 1] and values[i] > values[i + 1] and values[i] >= height
    ]

    def _prominence(i: int) -> float:
        left_min = values[i]
        for j in range(i - 1, -1, -1):
            if values[j] > values[i]:
                break
            left_min = min(left_min, values[j])
        right_min = values[i]
        for j in range(i + 1, n):
            if values[j] > values[i]:
                break
            right_min = min(right_min, values[j])
        return values[i] - max(left_min, right_min)

    scored = [(i, _prominence(i)) for i in candidates]
    scored = [(i, p) for i, p in scored if p >= prominence]
    scored.sort(key=lambda t: values[t[0]], reverse=True)

    kept: list[int] = []
    for i, _ in scored:
        if all(abs(i - k) >= distance for k in kept):
            kept.append(i)
    kept.sort()
    return np.array(kept, dtype=int)


def detect_noise_peaks(freq_hz: np.ndarray, magnitude: np.ndarray) -> list:
    """
    SmartTune-style peak detection: noise floor = median of the (linear)
    magnitude spectrum converted to dB; peaks found via
    `scipy.signal.find_peaks(height=noise_floor_db+30, prominence=15,
    distance=3)` on the dB-scaled spectrum, with a pure-numpy local-maxima
    fallback if scipy is unavailable.

    Peaks are classified by harmonic relationship first (a peak at ~2x/3x the
    frequency of a stronger, lower peak inherits that peak's category), then
    by our own best-effort frequency-band heuristic (see module comments
    above `_MOTOR_BAND` etc. for the exact ranges assumed).
    """
    freq_hz = np.asarray(freq_hz, dtype=float)
    magnitude = np.asarray(magnitude, dtype=float)
    eps = 1e-12
    magnitude_db = 20.0 * np.log10(magnitude + eps)

    noise_floor_db = float(np.median(magnitude_db))
    height = noise_floor_db + 30.0
    prominence = 15.0
    distance = 3

    if _scipy_find_peaks is not None:
        idx, props = _scipy_find_peaks(
            magnitude_db, height=height, prominence=prominence, distance=distance
        )
        prominences = props.get("prominences", np.zeros(len(idx)))
    else:
        idx = _find_peaks_numpy_fallback(magnitude_db, height, prominence, distance)
        prominences = np.array([magnitude_db[i] - noise_floor_db for i in idx])

    if len(idx) == 0:
        return []

    peak_freqs = freq_hz[idx]
    peak_mags = magnitude_db[idx]

    # Sort by descending magnitude so stronger (likely fundamental) peaks are
    # available as harmonic references when classifying weaker ones.
    order = np.argsort(peak_mags)[::-1]

    classifications: dict[int, str] = {}
    for rank_pos, sorted_pos in enumerate(order):
        f = peak_freqs[sorted_pos]
        best_class = None
        for other_pos in order[:rank_pos]:
            f_ref = peak_freqs[other_pos]
            if f_ref <= 0:
                continue
            ratio = f / f_ref
            for harmonic in _HARMONIC_RATIOS:
                if abs(ratio - harmonic) <= _HARMONIC_TOLERANCE * harmonic:
                    best_class = classifications.get(other_pos, _classify_by_band(f_ref))
                    break
            if best_class is not None:
                break
        classifications[sorted_pos] = best_class if best_class is not None else _classify_by_band(f)

    peaks = []
    for i in range(len(idx)):
        peaks.append(
            NoisePeak(
                freq_hz=float(peak_freqs[i]),
                magnitude_db=float(peak_mags[i]),
                prominence_db=float(prominences[i]) if i < len(prominences) else 0.0,
                classification=classifications[i],
            )
        )
    peaks.sort(key=lambda p: p.freq_hz)
    return peaks


# ---------------------------------------------------------------------------
# D-term noise metrics (SmartTune DTermNoiseAnalyzer thresholds)
# ---------------------------------------------------------------------------


@dataclass
class DTermNoiseMetrics:
    d_term_rms: float
    d_p_ratio: float
    hf_energy_ratio: float   # fraction of D-term FFT power above sample_rate_hz/8
    grade: str               # 'GOOD' | 'MARGINAL' | 'POOR' per SmartTune thresholds


def compute_dterm_noise_metrics(log: BlackboxLog, axis: str) -> DTermNoiseMetrics:
    """
    SmartTune `DTermNoiseAnalyzer`-style D-term noise metrics:
      - d_term_rms: RMS of the D-term signal.
      - d_p_ratio: RMS(D) / RMS(P) -- "how much of the control effort is
        coming from the (noise-sensitive) derivative path".
      - hf_energy_ratio: fraction of the D-term's FFT power that falls above
        sample_rate_hz/8 (a proxy for "how much of the D-term is noise rather
        than a clean derivative of a real maneuver").
      - grade: 'POOR' if d_p_ratio > 0.5; 'MARGINAL' if d_p_ratio > 0.3 or
        hf_energy_ratio > 0.3; else 'GOOD'. (SmartTune thresholds, to be
        validated against real logs before trusting numerically, per
        tuning-algorithms.md.)
    """
    if axis not in ("roll", "pitch", "yaw"):
        raise ValueError(f"axis must be one of ('roll', 'pitch', 'yaw'), got {axis!r}")

    d_term = np.asarray(log.axis_d.get(axis, []), dtype=float)
    p_term = np.asarray(log.axis_p.get(axis, []), dtype=float)

    if d_term.size == 0:
        return DTermNoiseMetrics(d_term_rms=0.0, d_p_ratio=0.0, hf_energy_ratio=0.0, grade="GOOD")

    d_term_rms = float(np.sqrt(np.mean(d_term ** 2)))
    p_term_rms = float(np.sqrt(np.mean(p_term ** 2))) if p_term.size else 0.0
    d_p_ratio = d_term_rms / p_term_rms if p_term_rms > 1e-12 else 0.0

    spectrum = np.fft.rfft(d_term)
    freqs = np.fft.rfftfreq(len(d_term), d=1.0 / float(log.sample_rate_hz))
    power = np.abs(spectrum) ** 2
    total_power = float(np.sum(power))
    hf_cutoff = float(log.sample_rate_hz) / 8.0
    hf_power = float(np.sum(power[freqs > hf_cutoff]))
    hf_energy_ratio = hf_power / total_power if total_power > 1e-12 else 0.0

    if d_p_ratio > 0.5:
        grade = "POOR"
    elif d_p_ratio > 0.3 or hf_energy_ratio > 0.3:
        grade = "MARGINAL"
    else:
        grade = "GOOD"

    return DTermNoiseMetrics(
        d_term_rms=d_term_rms,
        d_p_ratio=d_p_ratio,
        hf_energy_ratio=hf_energy_ratio,
        grade=grade,
    )


# ---------------------------------------------------------------------------
# Filter transmission ratio (PID-Analyzer concept)
# ---------------------------------------------------------------------------


def compute_filter_transmission_ratio(
    pre_filter_signal: np.ndarray, post_filter_signal: np.ndarray, sample_rate_hz: float
) -> tuple:
    """
    PID-Analyzer-style filter transmission ratio: ratio of the post-filter
    signal's FFT magnitude to the pre-filter signal's FFT magnitude, per
    frequency bin, over a single rfft of the whole provided arrays. Values
    near 1.0 mean the filter passes that frequency largely unattenuated;
    values near 0 mean it's heavily suppressed there.

    Caller is responsible for handing in comparable-length, time-aligned
    pre/post arrays (e.g. from two different debug_mode logging passes).
    """
    pre = np.asarray(pre_filter_signal, dtype=float)
    post = np.asarray(post_filter_signal, dtype=float)
    n = min(len(pre), len(post))
    pre = pre[:n]
    post = post[:n]

    freq_hz = np.fft.rfftfreq(n, d=1.0 / sample_rate_hz)
    pre_mag = np.abs(np.fft.rfft(pre))
    post_mag = np.abs(np.fft.rfft(post))

    eps = 1e-12
    transmission_ratio = post_mag / (pre_mag + eps)
    return freq_hz, transmission_ratio
