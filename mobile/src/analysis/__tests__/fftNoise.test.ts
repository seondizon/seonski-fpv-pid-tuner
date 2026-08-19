import {
  computeDtermNoiseMetrics,
  computeFilterTransmissionRatio,
  computeThrottleNoiseHeatmap,
  detectNoisePeaks,
} from '../fftNoise';
import { magnitude, nextPow2, realFftHalf, rfftFreq } from '../fft';
import { buildTestLog, timeSeries } from '../testSupport/buildTestLog';
import type { Axis } from '../blackboxLog';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('detectNoisePeaks finds a known tone', () => {
  const sampleRateHz = 2000;
  const n = 4096;
  const t = timeSeries(n, sampleRateHz);
  const rand = mulberry32(0);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    signal[i] = 5.0 * Math.sin(2 * Math.PI * 150 * t[i]) + (rand() - 0.5) * 0.1;
  }
  const size = nextPow2(n);
  const freqHz = rfftFreq(size, 1 / sampleRateHz);
  const mag = magnitude(realFftHalf(signal, size));

  const peaks = detectNoisePeaks(freqHz, mag);
  expect(peaks.length).toBeGreaterThan(0);
  const near150 = peaks.some((p) => Math.abs(p.freqHz - 150) < 5);
  expect(near150).toBe(true);
  for (const p of peaks) {
    expect(['motor', 'prop_blade_pass', 'structural_resonance', 'high_freq_resonance', 'unknown']).toContain(
      p.classification
    );
  }
});

test('detectNoisePeaks returns an empty list for a flat spectrum', () => {
  const freqHz = rfftFreq(1024, 1 / 1000);
  const mag = new Float64Array(freqHz.length).fill(1.0);
  expect(detectNoisePeaks(freqHz, mag)).toEqual([]);
});

function sineLog(pAmp: number, dAmp: number, dFreqHz: number, n: number, sampleRateHz: number) {
  const t = timeSeries(n, sampleRateHz);
  const pTerm = new Float64Array(n);
  const dTerm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pTerm[i] = pAmp * Math.sin(2 * Math.PI * 5 * t[i]);
    dTerm[i] = dAmp * Math.sin(2 * Math.PI * dFreqHz * t[i]);
  }
  return buildTestLog({
    sampleRateHz,
    axisP: { roll: pTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    axisD: { roll: dTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });
}

test('dterm noise grade GOOD for a low D/P ratio', () => {
  const log = sineLog(20, 2, 5, 2000, 1000); // ratio exactly 0.1, same freq -> hf ratio ~0
  const metrics = computeDtermNoiseMetrics(log, 'roll');
  expect(metrics.grade).toBe('GOOD');
  expect(metrics.dPRatio).toBeCloseTo(0.1, 1);
});

test('dterm noise grade POOR for a high D/P ratio', () => {
  const log = sineLog(10, 6, 5, 2000, 1000); // ratio 0.6
  const metrics = computeDtermNoiseMetrics(log, 'roll');
  expect(metrics.grade).toBe('POOR');
  expect(metrics.dPRatio).toBeGreaterThan(0.5);
});

test('dterm noise grade MARGINAL via high-frequency energy ratio', () => {
  const n = 4000;
  const sampleRateHz = 1000;
  const t = timeSeries(n, sampleRateHz);
  const pTerm = new Float64Array(n);
  const dTerm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pTerm[i] = 21.0 * Math.sin(2 * Math.PI * 5 * t[i]);
    dTerm[i] = 1.0 * Math.sin(2 * Math.PI * 5 * t[i]) + 3.0 * Math.sin(2 * Math.PI * 200 * t[i]);
  }
  const log = buildTestLog({
    sampleRateHz,
    axisP: { roll: pTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    axisD: { roll: dTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });
  const metrics = computeDtermNoiseMetrics(log, 'roll');
  expect(metrics.dPRatio).toBeLessThanOrEqual(0.3);
  expect(metrics.hfEnergyRatio).toBeGreaterThan(0.3);
  expect(metrics.grade).toBe('MARGINAL');
});

test('dterm noise metrics: missing axisD returns zeroed GOOD metrics', () => {
  const log = buildTestLog();
  const metrics = computeDtermNoiseMetrics(log, 'roll');
  expect(metrics).toEqual({ dTermRms: 0, dPRatio: 0, hfEnergyRatio: 0, grade: 'GOOD' });
});

test('dterm noise metrics throws on an invalid axis', () => {
  const log = buildTestLog();
  expect(() => computeDtermNoiseMetrics(log, 'bogus' as Axis)).toThrow();
});

test('throttle noise heatmap shape and NaN handling', () => {
  const sampleRateHz = 500;
  const n = 1000;
  const rand = mulberry32(1);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = rand() - 0.5;
  const throttlePct = new Float64Array(n).fill(40.0);

  const spectrogram = computeThrottleNoiseHeatmap(signal, throttlePct, sampleRateHz);
  expect(spectrogram.magnitude).toHaveLength(100);
  for (const row of spectrogram.magnitude) expect(row).toHaveLength(spectrogram.freqHz.length);
  expect(Array.from(spectrogram.throttleBinsPct)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

  // Row for throttle bin 40 (index 39) should have real data; bin 1 (index
  // 0), far outside the default ±6% overlap from 40, should be all-NaN.
  expect(spectrogram.magnitude[39].some((v) => !Number.isNaN(v))).toBe(true);
  expect(spectrogram.magnitude[0].every((v) => Number.isNaN(v))).toBe(true);
});

test('filter transmission ratio is ~1 at the dominant frequency when signals are equal', () => {
  const sampleRateHz = 1000;
  const n = 512;
  const t = timeSeries(n, sampleRateHz);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin(2 * Math.PI * 50 * t[i]);

  const size = nextPow2(n);
  const preMag = magnitude(realFftHalf(signal, size));
  let peakIdx = 0;
  for (let i = 1; i < preMag.length; i++) if (preMag[i] > preMag[peakIdx]) peakIdx = i;

  const { transmissionRatio } = computeFilterTransmissionRatio(signal, signal, sampleRateHz);
  // Only the dominant bin is guaranteed well-conditioned -- near-zero
  // off-peak bins are dominated by the +1e-12 denominator epsilon and
  // aren't meaningfully close to 1 (ported test intent: "ratio at the
  // peak-magnitude bin ~= 1.0", not "every bin").
  expect(transmissionRatio[peakIdx]).toBeCloseTo(1.0, 3);
});
