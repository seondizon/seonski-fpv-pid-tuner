/** Ported from backend/app/analysis/tracking.py. */
import { Axis, AXES, BlackboxLog } from './blackboxLog';
import { getOrReconstructSetpoint } from './setpoint';

const ERROR_HIST_RANGE: [number, number] = [-1000.0, 1000.0];
const ERROR_HIST_BINS = 200;

export interface TrackingStats {
  errorStd: number;
  meanAbsErrorByStickBin: Record<number, number>;
  semByStickBin: Record<number, number>;
}

export interface KsResult {
  statistic: number;
  pvalue: number;
  significantDifference: boolean;
}

function pidError(log: BlackboxLog, axis: Axis): Float64Array {
  if (!AXES.includes(axis)) throw new Error(`Invalid axis: ${axis}`);
  const setpoint = getOrReconstructSetpoint(log, axis);
  const gyro = log.gyro[axis] ?? new Float64Array(0);
  const n = Math.min(setpoint.length, gyro.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = gyro[i] - setpoint[i];
  return out;
}

/** Fixed-range, fixed-bin-count histogram matching numpy.histogram's
 * semantics: half-open bins except the last, which is closed on both
 * ends; values outside `range` are silently excluded. */
function histogram(data: Float64Array, bins: number, range: [number, number]): Float64Array {
  const [lo, hi] = range;
  const counts = new Float64Array(bins);
  const width = (hi - lo) / bins;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo || v > hi) continue;
    let idx = Math.floor((v - lo) / width);
    if (idx === bins) idx = bins - 1;
    if (idx >= 0 && idx < bins) counts[idx]++;
  }
  return counts;
}

function peakNormalizedHistogram(error: Float64Array): Float64Array {
  const counts = histogram(error, ERROR_HIST_BINS, ERROR_HIST_RANGE);
  let peak = 0;
  for (const c of counts) if (c > peak) peak = c;
  if (peak === 0) return counts;
  const out = new Float64Array(counts.length);
  for (let i = 0; i < counts.length; i++) out[i] = counts[i] / peak;
  return out;
}

function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/** Population standard deviation (ddof=0), matching numpy's default. */
function stdDevPopulation(values: ArrayLike<number>): number {
  const m = mean(values);
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

export function computeTrackingErrorStats(
  log: BlackboxLog,
  axis: Axis,
  numBins: number = 10
): TrackingStats {
  if (!AXES.includes(axis)) throw new Error(`Invalid axis: ${axis}`);
  if (numBins < 1) throw new Error('numBins must be >= 1');

  const setpoint = getOrReconstructSetpoint(log, axis);
  const gyro = log.gyro[axis] ?? new Float64Array(0);
  const n = Math.min(setpoint.length, gyro.length);
  const error = new Float64Array(n);
  const absSetpoint = new Float64Array(n);
  const absError = new Float64Array(n);
  let maxAbsSetpoint = 0;
  for (let i = 0; i < n; i++) {
    error[i] = gyro[i] - setpoint[i];
    absSetpoint[i] = Math.abs(setpoint[i]);
    absError[i] = Math.abs(error[i]);
    if (absSetpoint[i] > maxAbsSetpoint) maxAbsSetpoint = absSetpoint[i];
  }

  const errorStd = stdDevPopulation(peakNormalizedHistogram(error));

  const meanAbsErrorByStickBin: Record<number, number> = {};
  const semByStickBin: Record<number, number> = {};
  let prevThreshold = 0;
  for (let i = 1; i <= numBins; i++) {
    const pct = Math.round((i * 100) / numBins);
    const threshold = maxAbsSetpoint * (pct / 100);
    if (maxAbsSetpoint <= 0) {
      meanAbsErrorByStickBin[pct] = NaN;
      semByStickBin[pct] = NaN;
      continue;
    }
    const samples: number[] = [];
    for (let j = 0; j < n; j++) {
      if (absSetpoint[j] > prevThreshold && absSetpoint[j] <= threshold) samples.push(absError[j]);
    }
    if (samples.length > 0) {
      meanAbsErrorByStickBin[pct] = mean(samples);
      semByStickBin[pct] = samples.length > 1 ? stdDevPopulation(samples) / Math.sqrt(samples.length) : 0.0;
    } else {
      meanAbsErrorByStickBin[pct] = NaN;
      semByStickBin[pct] = NaN;
    }
    prevThreshold = threshold;
  }

  return { errorStd, meanAbsErrorByStickBin, semByStickBin };
}

function countLessEq(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Two-sample Kolmogorov-Smirnov statistic + asymptotic p-value.
 *
 * DEVIATION FROM THE PYTHON REFERENCE: scipy.stats.ks_2samp's exact p-value
 * method (used for small equal-size samples like these 200-bin histograms)
 * involves a combinatorial formula this port does not attempt to
 * replicate. This uses the standard asymptotic Kolmogorov distribution
 * instead, via the alternating series, with Stephens' (1970) finite-sample
 * correction factor applied to its argument for better small-n accuracy --
 * which is not guaranteed bit-identical to scipy but is the well-known
 * textbook formula for the same statistic -- adequate for this project's
 * "broad interpretive agreement" validation bar for analysis output (see
 * docs/research/reference-analysis.md). The KS statistic itself (D) is
 * computed exactly, with no approximation. */
function ks2samp(a: number[], b: number[]): { statistic: number; pvalue: number } {
  const n = a.length;
  const m = b.length;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  const allValues = Array.from(new Set([...sortedA, ...sortedB])).sort((x, y) => x - y);

  let d = 0;
  for (const v of allValues) {
    const cdfA = countLessEq(sortedA, v) / n;
    const cdfB = countLessEq(sortedB, v) / m;
    const diff = Math.abs(cdfA - cdfB);
    if (diff > d) d = diff;
  }

  // Stephens (1970) finite-sample correction factor applied to the
  // classical asymptotic Kolmogorov distribution -- noticeably more
  // accurate than the plain sqrt(en)*d form for the sample sizes here
  // (both histograms are always exactly 200 bins).
  const enRoot = Math.sqrt((n * m) / (n + m));
  const lambda = (enRoot + 0.12 + 0.11 / enRoot) * d;
  const pvalue = kolmogorovSurvival(lambda);
  return { statistic: d, pvalue };
}

/** P(D > lambda) under the asymptotic Kolmogorov distribution, via the
 * standard alternating series. Small lambda is clamped to p=1 to avoid the
 * (mathematically convergent but practically noisy) series near 0. */
function kolmogorovSurvival(lambda: number): number {
  if (lambda < 0.2) return 1.0;
  let sum = 0;
  for (let k = 1; k <= 100; k++) {
    const term = (k % 2 === 0 ? -1 : 1) * Math.exp(-2 * k * k * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(Math.max(2 * sum, 0), 1);
}

export function compareTrackingKs(logA: BlackboxLog, logB: BlackboxLog, axis: Axis): KsResult {
  if (!AXES.includes(axis)) throw new Error(`Invalid axis: ${axis}`);
  const histA = peakNormalizedHistogram(pidError(logA, axis));
  const histB = peakNormalizedHistogram(pidError(logB, axis));
  const { statistic, pvalue } = ks2samp(Array.from(histA), Array.from(histB));
  return { statistic, pvalue, significantDifference: pvalue <= 0.05 };
}
