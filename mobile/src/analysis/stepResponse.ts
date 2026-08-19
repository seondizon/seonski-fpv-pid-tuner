/** Ported from backend/app/analysis/step_response.py -- Wiener-deconvolution
 * step response with sliding-window averaging, SP-amplitude gating, and
 * steady-state QC. See fft.ts's module docstring for the general
 * numpy-FFT-vs-fft.js zero-padding note; this module already zero-pads to
 * a power of two in the Python original, so there's no behavioral
 * deviation here specifically.
 */
import { Axis, AXES, BlackboxLog } from './blackboxLog';
import { ComplexSpectrum, fftFreq, gaussianFilter1dWrap, hannWindow, ifftFull, nextPow2, realFftFull } from './fft';
import { getOrReconstructSetpoint } from './setpoint';

const QC_SETTLED_MIN = 0.5;
const QC_SETTLED_MAX = 3.0;
const TAIL_START_S = 0.2;
const TAIL_FRACTION_OF_WINDOW = 0.6;
const SETTLING_BAND_FRAC = 0.05;

export interface StepResponseResult {
  timeS: Float64Array;
  response: Float64Array;
  numSegmentsUsed: number;
  numSegmentsRejected: number;
  overshootPct: number | null;
  riseTimeS: number | null;
  settlingTimeS: number | null;
  steadyStateErrorPct: number | null;
}

function tailStartIndex(sampleRateHz: number, responseWindowS: number, nResp: number): number {
  const tailStartS = Math.min(TAIL_START_S, responseWindowS * TAIL_FRACTION_OF_WINDOW);
  const idx = Math.round(tailStartS * sampleRateHz);
  return Math.max(0, Math.min(idx, nResp - 1));
}

/** Wiener-deconvolution regularization mask: a low floor everywhere, with a
 * much heavier floor above `cutoffHz` (smoothed across the cutoff boundary
 * by a circular Gaussian so the transition isn't a hard step) -- this
 * suppresses noise amplification at frequencies the FC's own filters
 * wouldn't pass anyway, without a hard, ringing-prone brick-wall cutoff. */
function buildRegularization(H: ComplexSpectrum, freqs: Float64Array, cutoffHz: number): Float64Array {
  const n = freqs.length;
  let maxPower = 0;
  for (let i = 0; i < n; i++) {
    const p = H.re[i] * H.re[i] + H.im[i] * H.im[i];
    if (p > maxPower) maxPower = p;
  }
  if (maxPower <= 0) maxPower = 1.0;

  const baseReg = 1e-4 * maxPower;
  const rawMask = new Float64Array(n);
  for (let i = 0; i < n; i++) rawMask[i] = Math.abs(freqs[i]) > cutoffHz ? 1 : 0;

  let freqRes = n > 1 ? Math.abs(freqs[1] - freqs[0]) : 1.0;
  if (!freqRes) freqRes = 1.0;
  const sigmaBins = Math.max(1.0, (cutoffHz * 0.25) / freqRes);
  const softMask = gaussianFilter1dWrap(rawMask, sigmaBins);

  const heavyRegScale = 50.0 * maxPower;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = baseReg + softMask[i] * heavyRegScale;
  return out;
}

function processWindow(
  spSeg: Float64Array,
  gyroSeg: Float64Array,
  sampleRateHz: number,
  cutoffHz: number,
  nResp: number,
  nfft: number
): Float64Array {
  const win = hannWindow(spSeg.length);
  const spWindowed = new Float64Array(spSeg.length);
  const gyroWindowed = new Float64Array(spSeg.length);
  for (let i = 0; i < spSeg.length; i++) {
    spWindowed[i] = spSeg[i] * win[i];
    gyroWindowed[i] = gyroSeg[i] * win[i];
  }

  const H = realFftFull(spWindowed, nfft);
  const G = realFftFull(gyroWindowed, nfft);
  const freqs = fftFreq(nfft, 1 / sampleRateHz);
  const reg = buildRegularization(H, freqs, cutoffHz);

  // deconvolved = ifft( G * conj(H) / (H*conj(H) + reg) )
  const quotRe = new Float64Array(nfft);
  const quotIm = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) {
    const cHre = H.re[i];
    const cHim = -H.im[i];
    const numRe = G.re[i] * cHre - G.im[i] * cHim;
    const numIm = G.re[i] * cHim + G.im[i] * cHre;
    const denom = H.re[i] * H.re[i] + H.im[i] * H.im[i] + reg[i];
    quotRe[i] = numRe / denom;
    quotIm[i] = numIm / denom;
  }
  const deconvolved = ifftFull(quotRe, quotIm);

  const raw = new Float64Array(nResp);
  let cumulative = 0;
  for (let i = 0; i < nResp; i++) {
    cumulative += deconvolved.re[i];
    raw[i] = cumulative;
  }
  const baseline = raw[0];
  for (let i = 0; i < nResp; i++) raw[i] -= baseline;
  return raw;
}

interface StepResponseMetrics {
  overshootPct: number | null;
  riseTimeS: number | null;
  settlingTimeS: number | null;
  steadyStateErrorPct: number | null;
}

function computeMetrics(
  timeS: Float64Array,
  response: Float64Array,
  sampleRateHz: number,
  responseWindowS: number
): StepResponseMetrics {
  const nResp = response.length;
  const none: StepResponseMetrics = {
    overshootPct: null,
    riseTimeS: null,
    settlingTimeS: null,
    steadyStateErrorPct: null,
  };

  const tailIdx = tailStartIndex(sampleRateHz, responseWindowS, nResp);
  const tail = response.subarray(tailIdx);
  if (tail.length === 0) return none;
  for (const v of tail) if (!Number.isFinite(v)) return none;

  let settled = 0;
  for (const v of tail) settled += v;
  settled /= tail.length;
  if (!(settled > 0) || !Number.isFinite(settled)) return none;

  let peak = -Infinity;
  for (const v of response) if (v > peak) peak = v;
  const overshootPct = peak > settled ? ((peak - settled) / settled) * 100 : 0.0;

  const loThresh = 0.1 * settled;
  const hiThresh = 0.9 * settled;
  let idxLo = -1;
  for (let i = 0; i < nResp; i++) {
    if (response[i] >= loThresh) {
      idxLo = i;
      break;
    }
  }
  let riseTimeS: number | null = null;
  if (idxLo !== -1) {
    let idxHi = -1;
    for (let i = idxLo; i < nResp; i++) {
      if (response[i] >= hiThresh) {
        idxHi = i;
        break;
      }
    }
    if (idxHi !== -1) riseTimeS = timeS[idxHi] - timeS[idxLo];
  }

  const band = SETTLING_BAND_FRAC * Math.abs(settled);
  let lastOutside = -1;
  for (let i = 0; i < nResp; i++) {
    if (Math.abs(response[i] - settled) > band) lastOutside = i;
  }
  let settlingTimeS: number | null;
  if (lastOutside === -1) settlingTimeS = timeS[0];
  else if (lastOutside < nResp - 1) settlingTimeS = timeS[lastOutside + 1];
  else settlingTimeS = null;

  const steadyStateErrorPct = Math.abs(1.0 - settled) * 100.0;

  return { overshootPct, riseTimeS, settlingTimeS, steadyStateErrorPct };
}

export function computeStepResponse(
  log: BlackboxLog,
  axis: Axis,
  windowS: number = 1.0,
  overlapFactor: number = 16,
  cutoffHz: number = 25.0,
  responseWindowS: number = 0.5,
  spGateMinDps: number = 20.0,
  spGateMaxDps: number = 500.0
): StepResponseResult {
  if (!AXES.includes(axis)) throw new Error(`Invalid axis: ${axis}`);

  const setpoint = getOrReconstructSetpoint(log, axis);
  const gyro = log.gyro[axis];
  if (!gyro || gyro.length === 0) throw new Error(`No gyro data for axis ${axis}`);

  const sampleRateHz = log.sampleRateHz;
  const nTotal = Math.min(setpoint.length, gyro.length);
  const windowLen = Math.max(Math.round(windowS * sampleRateHz), 2);
  const nResp = Math.max(Math.round(responseWindowS * sampleRateHz), 1);
  const nfft = nextPow2(Math.max(windowLen, nResp));
  const stride = Math.max(Math.floor(windowLen / Math.max(overlapFactor, 1)), 1);

  const timeS = new Float64Array(nResp);
  for (let i = 0; i < nResp; i++) timeS[i] = i / sampleRateHz;

  let numUsed = 0;
  let numRejected = 0;
  const accepted: Float64Array[] = [];

  if (nTotal >= windowLen) {
    for (let start = 0; start + windowLen <= nTotal; start += stride) {
      const spSeg = setpoint.subarray(start, start + windowLen);
      const gyroSeg = gyro.subarray(start, start + windowLen);

      let peakSp = 0;
      for (let i = 0; i < spSeg.length; i++) {
        const a = Math.abs(spSeg[i]);
        if (a > peakSp) peakSp = a;
      }
      if (peakSp < spGateMinDps || peakSp > spGateMaxDps) {
        numRejected++;
        continue;
      }

      const raw = processWindow(spSeg, gyroSeg, sampleRateHz, cutoffHz, nResp, nfft);
      const tailIdx = tailStartIndex(sampleRateHz, responseWindowS, nResp);
      const tail = raw.subarray(tailIdx);
      if (tail.length === 0) {
        numRejected++;
        continue;
      }
      let settledMean = 0;
      for (const v of tail) settledMean += v;
      settledMean /= tail.length;

      if (!(settledMean >= QC_SETTLED_MIN && settledMean <= QC_SETTLED_MAX)) {
        numRejected++;
        continue;
      }

      const normalized = new Float64Array(nResp);
      for (let i = 0; i < nResp; i++) normalized[i] = raw[i] / settledMean;
      accepted.push(normalized);
      numUsed++;
    }
  }

  if (numUsed === 0) {
    return {
      timeS,
      response: new Float64Array(nResp).fill(NaN),
      numSegmentsUsed: 0,
      numSegmentsRejected: numRejected,
      overshootPct: null,
      riseTimeS: null,
      settlingTimeS: null,
      steadyStateErrorPct: null,
    };
  }

  const averaged = new Float64Array(nResp);
  for (const arr of accepted) for (let i = 0; i < nResp; i++) averaged[i] += arr[i];
  for (let i = 0; i < nResp; i++) averaged[i] /= accepted.length;

  const metrics = computeMetrics(timeS, averaged, sampleRateHz, responseWindowS);

  return {
    timeS,
    response: averaged,
    numSegmentsUsed: numUsed,
    numSegmentsRejected: numRejected,
    ...metrics,
  };
}
