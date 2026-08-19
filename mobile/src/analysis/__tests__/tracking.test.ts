import { compareTrackingKs, computeTrackingErrorStats } from '../tracking';
import { buildTestLog, timeSeries } from '../testSupport/buildTestLog';
import type { Axis } from '../blackboxLog';

/** Deterministic pseudo-noise generator (mulberry32), used instead of
 * trying to reproduce numpy's PCG64 bit-stream -- these tests only need
 * "some varied, bounded values", not numpy-specific numbers. See
 * docs/research/reference-analysis.md's porting notes on why matching
 * numpy's RNG exactly isn't attempted. */
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

function trackingLog(undershootFrac: number, noiseStd: number, seed: number, n = 4000, sampleRateHz = 1000): ReturnType<typeof buildTestLog> {
  const rand = mulberry32(seed);
  const timeS = timeSeries(n, sampleRateHz);
  const setpointRoll = new Float64Array(n);
  const gyroRoll = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    setpointRoll[i] = 500 * Math.sin(2 * Math.PI * 0.5 * timeS[i]);
    // Box-Muller-ish spread from the uniform generator -- bounded, varied,
    // deterministic; not a true Gaussian, which isn't needed here.
    const noise = (rand() - 0.5) * 2 * noiseStd * Math.sqrt(3);
    gyroRoll[i] = setpointRoll[i] * (1 - undershootFrac) + noise;
  }
  return buildTestLog({
    timeS,
    sampleRateHz,
    setpoint: { roll: setpointRoll },
    gyro: { roll: gyroRoll, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });
}

test('computeTrackingErrorStats produces sane, complete output', () => {
  const log = trackingLog(0.1, 2.0, 42);
  const stats = computeTrackingErrorStats(log, 'roll');

  expect(Number.isFinite(stats.errorStd)).toBe(true);
  expect(stats.errorStd).toBeGreaterThanOrEqual(0);

  const expectedBins = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  expect(Object.keys(stats.meanAbsErrorByStickBin).map(Number).sort((a, b) => a - b)).toEqual(expectedBins);
  expect(Object.keys(stats.semByStickBin).map(Number).sort((a, b) => a - b)).toEqual(expectedBins);

  // error = -undershootFrac*setpoint + noise, so |error| grows with stick
  // deflection -- error at full deflection should exceed error near center.
  expect(stats.meanAbsErrorByStickBin[100]).toBeGreaterThan(stats.meanAbsErrorByStickBin[10]);
});

test('computeTrackingErrorStats throws on an invalid axis', () => {
  const log = trackingLog(0.1, 2.0, 1);
  expect(() => computeTrackingErrorStats(log, 'bogus' as Axis)).toThrow();
});

test('KS self-comparison reports high p-value and no significant difference', () => {
  const log = trackingLog(0.2, 3.0, 7);
  const result = compareTrackingKs(log, log, 'roll');
  expect(result.statistic).toBeCloseTo(0, 9);
  expect(result.pvalue).toBeGreaterThan(0.05);
  expect(result.significantDifference).toBe(false);
});

test('KS comparison of clearly different distributions reports low p-value', () => {
  const loose = trackingLog(0.5, 10.0, 11);
  const tight = trackingLog(0.0, 0.5, 22);
  const result = compareTrackingKs(loose, tight, 'roll');
  expect(result.pvalue).toBeLessThanOrEqual(0.05);
  expect(result.significantDifference).toBe(true);
});
