/** Ported from backend/app/analysis/fft_noise.py.
 *
 * See fft.ts's module docstring for the zero-padding deviation from the
 * Python reference: every rfft call site here pads its input up to the
 * next power of two (fft.js's only supported size class), changing the
 * exact bin count/frequency resolution vs. numpy's unpadded rfft. Each
 * function below computes its own freqHz consistently from the padded
 * size it actually used, so results stay internally correct -- they just
 * don't have bin-for-bin identical frequencies to the Python reference.
 */
import { Axis, AXES, BlackboxLog } from './blackboxLog';
import { hannWindow, magnitude, nextPow2, realFftHalf, rfftFreq } from './fft';

// ---------------------------------------------------------------------------
// Throttle noise heatmap
// ---------------------------------------------------------------------------

export interface ThrottleSpectrogram {
  throttleBinsPct: Float64Array; // 1..100
  freqHz: Float64Array;
  magnitude: Float64Array[]; // 100 rows, one per throttle bin
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Separable box filter, mode='nearest' (edge-replicated), matching
 * scipy.ndimage.uniform_filter(size=kernelSize, mode='nearest'). */
function uniformFilter2D(data: Float64Array[], kernelSize: [number, number]): Float64Array[] {
  const rows = data.length;
  const cols = rows > 0 ? data[0].length : 0;
  const [kh, kw] = kernelSize;
  const halfH = Math.floor(kh / 2);
  const halfW = Math.floor(kw / 2);
  const out: Float64Array[] = [];
  for (let r = 0; r < rows; r++) {
    const outRow = new Float64Array(cols);
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let dr = -halfH; dr <= halfH; dr++) {
        const rr = clamp(r + dr, 0, rows - 1);
        for (let dc = -halfW; dc <= halfW; dc++) {
          const cc = clamp(c + dc, 0, cols - 1);
          sum += data[rr][cc];
        }
      }
      outRow[c] = sum / (kh * kw);
    }
    out.push(outRow);
  }
  return out;
}

/** Smooths a matrix that may contain NaN "holes" without letting them
 * poison neighboring cells: smooth the numerator (NaN treated as 0) and
 * the valid-count separately, then divide -- the standard "smooth with
 * holes" trick, matching the Python reference exactly. */
function smoothWithNanHoles(data: Float64Array[], kernelSize: [number, number]): Float64Array[] {
  const rows = data.length;
  const cols = rows > 0 ? data[0].length : 0;
  const valid = data.map((row) => Float64Array.from(row, (v) => (Number.isNaN(v) ? 0 : 1)));
  const filled = data.map((row) => Float64Array.from(row, (v) => (Number.isNaN(v) ? 0 : v)));
  const smoothedSum = uniformFilter2D(filled, kernelSize);
  const smoothedCount = uniformFilter2D(valid, kernelSize);
  const out: Float64Array[] = [];
  for (let r = 0; r < rows; r++) {
    const outRow = new Float64Array(cols);
    for (let c = 0; c < cols; c++) {
      outRow[c] = smoothedCount[r][c] > 0 ? smoothedSum[r][c] / smoothedCount[r][c] : NaN;
    }
    out.push(outRow);
  }
  return out;
}

export function computeThrottleNoiseHeatmap(
  signal: Float64Array,
  throttlePct: Float64Array,
  sampleRateHz: number,
  segmentS: number = 0.2,
  binOverlapPct: number = 6.0
): ThrottleSpectrogram {
  const n = Math.min(signal.length, throttlePct.length);
  const segLen = Math.max(Math.round(segmentS * sampleRateHz), 1);
  const numSegments = Math.floor(n / segLen);
  const paddedSize = nextPow2(segLen);
  const freqHz = rfftFreq(paddedSize, 1 / sampleRateHz);

  const throttleBinsPct = new Float64Array(100);
  for (let i = 0; i < 100; i++) throttleBinsPct[i] = i + 1;

  if (numSegments === 0) {
    const nanRows = Array.from({ length: 100 }, () => new Float64Array(freqHz.length).fill(NaN));
    return { throttleBinsPct, freqHz, magnitude: nanRows };
  }

  const win = hannWindow(segLen);
  const segMeanThrottle = new Float64Array(numSegments);
  const segSpectra: Float64Array[] = [];
  for (let i = 0; i < numSegments; i++) {
    const start = i * segLen;
    const windowed = new Float64Array(segLen);
    let throttleSum = 0;
    for (let j = 0; j < segLen; j++) {
      windowed[j] = signal[start + j] * win[j];
      throttleSum += throttlePct[start + j];
    }
    segMeanThrottle[i] = throttleSum / segLen;
    segSpectra.push(magnitude(realFftHalf(windowed, paddedSize)));
  }

  const magnitudeRows: Float64Array[] = [];
  for (let bin = 0; bin < 100; bin++) {
    const center = bin + 1;
    const matching: Float64Array[] = [];
    for (let i = 0; i < numSegments; i++) {
      if (Math.abs(segMeanThrottle[i] - center) <= binOverlapPct) matching.push(segSpectra[i]);
    }
    if (matching.length === 0) {
      magnitudeRows.push(new Float64Array(freqHz.length).fill(NaN));
    } else {
      const row = new Float64Array(freqHz.length);
      for (let f = 0; f < freqHz.length; f++) {
        let sum = 0;
        for (const spec of matching) sum += spec[f];
        row[f] = sum / matching.length;
      }
      magnitudeRows.push(row);
    }
  }

  return { throttleBinsPct, freqHz, magnitude: smoothWithNanHoles(magnitudeRows, [3, 3]) };
}

// ---------------------------------------------------------------------------
// Peak detection
// ---------------------------------------------------------------------------

export interface NoisePeak {
  freqHz: number;
  magnitudeDb: number;
  prominenceDb: number;
  classification: string;
}

const MOTOR_BAND: [number, number] = [60.0, 300.0];
const PROP_BAND: [number, number] = [150.0, 500.0];
const STRUCTURAL_BAND: [number, number] = [300.0, 800.0];
const HARMONIC_RATIOS = [2.0, 3.0];
const HARMONIC_TOLERANCE = 0.08;

function classifyByBand(freqHz: number): string {
  if (freqHz >= MOTOR_BAND[0] && freqHz <= MOTOR_BAND[1]) return 'motor';
  if (freqHz >= PROP_BAND[0] && freqHz <= PROP_BAND[1]) return 'prop_blade_pass';
  if (freqHz >= STRUCTURAL_BAND[0] && freqHz <= STRUCTURAL_BAND[1]) return 'structural_resonance';
  if (freqHz > STRUCTURAL_BAND[1]) return 'high_freq_resonance';
  return 'unknown';
}

function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pure-JS approximation of scipy.signal.find_peaks(height, prominence,
 * distance), directly porting the numpy fallback the Python reference
 * already ships for when scipy is unavailable -- this project has no
 * scipy-equivalent dependency at all, so this fallback is always the path
 * taken, not a rarely-exercised branch. */
function findPeaksNumpyFallback(
  values: Float64Array,
  height: number,
  prominence: number,
  distance: number
): { indices: number[]; prominences: number[] } {
  const n = values.length;
  const candidates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (values[i] > values[i - 1] && values[i] > values[i + 1] && values[i] >= height) {
      candidates.push(i);
    }
  }

  function peakProminence(i: number): number {
    let leftMin = values[i];
    for (let j = i - 1; j >= 0; j--) {
      if (values[j] > values[i]) break;
      if (values[j] < leftMin) leftMin = values[j];
    }
    let rightMin = values[i];
    for (let j = i + 1; j < n; j++) {
      if (values[j] > values[i]) break;
      if (values[j] < rightMin) rightMin = values[j];
    }
    return values[i] - Math.max(leftMin, rightMin);
  }

  const withProminence = candidates
    .map((i) => ({ i, prom: peakProminence(i) }))
    .filter((c) => c.prom >= prominence);
  withProminence.sort((a, b) => values[b.i] - values[a.i]);

  const kept: number[] = [];
  for (const c of withProminence) {
    if (kept.every((k) => Math.abs(k - c.i) >= distance)) kept.push(c.i);
  }
  kept.sort((a, b) => a - b);

  const prominenceByIndex = new Map(withProminence.map((c) => [c.i, c.prom]));
  return { indices: kept, prominences: kept.map((i) => prominenceByIndex.get(i)!) };
}

export function detectNoisePeaks(freqHz: Float64Array, mag: Float64Array): NoisePeak[] {
  const n = mag.length;
  const magnitudeDb = new Float64Array(n);
  for (let i = 0; i < n; i++) magnitudeDb[i] = 20 * Math.log10(mag[i] + 1e-12);

  const noiseFloorDb = median(Float64Array.from(magnitudeDb).sort());
  const { indices, prominences } = findPeaksNumpyFallback(
    magnitudeDb,
    noiseFloorDb + 30.0,
    15.0,
    3
  );
  if (indices.length === 0) return [];

  // Classify strongest peaks first, so a weaker peak that's a harmonic of a
  // stronger one can inherit that stronger peak's already-resolved
  // classification.
  const order = indices
    .map((_, pos) => pos)
    .sort((a, b) => magnitudeDb[indices[b]] - magnitudeDb[indices[a]]);
  const classifications: (string | null)[] = new Array(indices.length).fill(null);

  for (let rankPos = 0; rankPos < order.length; rankPos++) {
    const pos = order[rankPos];
    const f = freqHz[indices[pos]];
    let bestClass: string | null = null;

    outer: for (const otherPos of order.slice(0, rankPos)) {
      const fRef = freqHz[indices[otherPos]];
      if (fRef === 0) continue;
      for (const harmonic of HARMONIC_RATIOS) {
        const ratio = f / fRef;
        if (Math.abs(ratio - harmonic) <= HARMONIC_TOLERANCE * harmonic) {
          bestClass = classifications[otherPos];
          break outer;
        }
      }
    }
    classifications[pos] = bestClass ?? classifyByBand(f);
  }

  const peaks = indices.map((idx, pos) => ({
    freqHz: freqHz[idx],
    magnitudeDb: magnitudeDb[idx],
    prominenceDb: pos < prominences.length ? prominences[pos] : 0.0,
    classification: classifications[pos]!,
  }));
  peaks.sort((a, b) => a.freqHz - b.freqHz);
  return peaks;
}

// ---------------------------------------------------------------------------
// D-term noise metrics
// ---------------------------------------------------------------------------

export interface DTermNoiseMetrics {
  dTermRms: number;
  dPRatio: number;
  hfEnergyRatio: number;
  grade: 'GOOD' | 'MARGINAL' | 'POOR';
}

function rms(values: Float64Array): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

export function computeDtermNoiseMetrics(log: BlackboxLog, axis: Axis): DTermNoiseMetrics {
  if (!AXES.includes(axis)) throw new Error(`Invalid axis: ${axis}`);

  const dTerm = log.axisD[axis] ?? new Float64Array(0);
  const pTerm = log.axisP[axis] ?? new Float64Array(0);
  if (dTerm.length === 0) {
    return { dTermRms: 0, dPRatio: 0, hfEnergyRatio: 0, grade: 'GOOD' };
  }

  const sampleRateHz = log.sampleRateHz;
  const dTermRms = rms(dTerm);
  const pTermRms = pTerm.length > 0 ? rms(pTerm) : 0;
  const dPRatio = pTermRms > 1e-12 ? dTermRms / pTermRms : 0;

  const paddedSize = nextPow2(dTerm.length);
  const spectrum = realFftHalf(dTerm, paddedSize);
  const freqs = rfftFreq(paddedSize, 1 / sampleRateHz);
  const power = new Float64Array(freqs.length);
  let totalPower = 0;
  for (let i = 0; i < freqs.length; i++) {
    power[i] = spectrum.re[i] * spectrum.re[i] + spectrum.im[i] * spectrum.im[i];
    totalPower += power[i];
  }
  const hfCutoff = sampleRateHz / 8.0;
  let hfPower = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] > hfCutoff) hfPower += power[i];
  }
  const hfEnergyRatio = totalPower > 1e-12 ? hfPower / totalPower : 0;

  let grade: 'GOOD' | 'MARGINAL' | 'POOR';
  if (dPRatio > 0.5) grade = 'POOR';
  else if (dPRatio > 0.3 || hfEnergyRatio > 0.3) grade = 'MARGINAL';
  else grade = 'GOOD';

  return { dTermRms, dPRatio, hfEnergyRatio, grade };
}

// ---------------------------------------------------------------------------
// Filter transmission ratio
// ---------------------------------------------------------------------------

export function computeFilterTransmissionRatio(
  preFilterSignal: Float64Array,
  postFilterSignal: Float64Array,
  sampleRateHz: number
): { freqHz: Float64Array; transmissionRatio: Float64Array } {
  const n = Math.min(preFilterSignal.length, postFilterSignal.length);
  const paddedSize = nextPow2(n);
  const freqHz = rfftFreq(paddedSize, 1 / sampleRateHz);
  const preMag = magnitude(realFftHalf(preFilterSignal.subarray(0, n), paddedSize));
  const postMag = magnitude(realFftHalf(postFilterSignal.subarray(0, n), paddedSize));
  const transmissionRatio = new Float64Array(freqHz.length);
  for (let i = 0; i < freqHz.length; i++) {
    transmissionRatio[i] = postMag[i] / (preMag[i] + 1e-12);
  }
  return { freqHz, transmissionRatio };
}
