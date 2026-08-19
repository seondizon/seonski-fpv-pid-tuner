import { computeStepResponse } from '../stepResponse';
import { buildTestLog, onePoleLowPass, timeSeries } from '../testSupport/buildTestLog';
import type { Axis } from '../blackboxLog';

/** Matches backend/app/analysis/step_response.py's test fixture builder
 * exactly: a square-wave setpoint (period 2.0s, 50% duty) driven through a
 * one-pole low-pass filter, which has an analytically known step response
 * of 1-exp(-t/tau). */
function firstOrderLog(tauS = 0.05, sampleRateHz = 1000.0, durationS = 20.0, amplitude = 150.0) {
  const n = Math.round(durationS * sampleRateHz);
  const timeS = timeSeries(n, sampleRateHz);
  const periodS = 2.0;
  const setpoint = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    setpoint[i] = (timeS[i] % periodS) < periodS / 2 ? amplitude : 0;
  }
  const a = Math.exp(-1 / (sampleRateHz * tauS));
  const gyro = onePoleLowPass(setpoint, a);

  return buildTestLog({
    timeS,
    sampleRateHz,
    setpoint: { roll: setpoint },
    gyro: { roll: gyro, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });
}

test('recovers a plausible step response from a synthetic first-order log', () => {
  const log = firstOrderLog();
  const result = computeStepResponse(log, 'roll');

  expect(result.numSegmentsUsed).toBeGreaterThan(0);
  expect(result.numSegmentsUsed + result.numSegmentsRejected).toBeGreaterThan(0);

  const tailStart = Math.floor((result.response.length * 4) / 5);
  const tail = Array.from(result.response.subarray(tailStart));
  expect(tail.every(Number.isFinite)).toBe(true);
  const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
  expect(tailMean).toBeGreaterThan(0.7);
  expect(tailMean).toBeLessThan(1.3);

  expect(result.riseTimeS).not.toBeNull();
  expect(result.riseTimeS as number).toBeGreaterThan(0);
  expect(result.riseTimeS as number).toBeLessThan(0.3);

  expect(result.settlingTimeS).not.toBeNull();
  expect(result.settlingTimeS as number).toBeGreaterThan(0);
  expect(result.settlingTimeS as number).toBeLessThanOrEqual(0.5);

  expect(result.steadyStateErrorPct as number).toBeLessThan(10.0);
  // A true first-order lag has zero overshoot; allow slack for
  // FFT/windowing artifacts from the deconvolution itself.
  expect(result.overshootPct as number).toBeLessThan(40.0);
});

test('zero segments passing the SP gate does not crash', () => {
  const n = 5000;
  const sampleRateHz = 1000;
  const constant = new Float64Array(n).fill(5.0); // below the 20 dps gate floor
  const log = buildTestLog({
    timeS: timeSeries(n, sampleRateHz),
    sampleRateHz,
    setpoint: { roll: constant },
    gyro: { roll: constant, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });

  const result = computeStepResponse(log, 'roll');
  expect(result.numSegmentsUsed).toBe(0);
  expect(result.numSegmentsRejected).toBeGreaterThan(0);
  expect(Array.from(result.response).every(Number.isNaN)).toBe(true);
  expect(result.overshootPct).toBeNull();
  expect(result.riseTimeS).toBeNull();
  expect(result.settlingTimeS).toBeNull();
  expect(result.steadyStateErrorPct).toBeNull();
});

test('throws on an invalid axis', () => {
  const log = firstOrderLog();
  expect(() => computeStepResponse(log, 'bogus' as Axis)).toThrow();
});

test('a log shorter than the analysis window does not crash and attempts zero windows', () => {
  const n = 50;
  const sampleRateHz = 1000;
  const setpoint = new Float64Array(n).fill(100);
  const gyro = new Float64Array(n).fill(50);
  const log = buildTestLog({
    timeS: timeSeries(n, sampleRateHz),
    sampleRateHz,
    setpoint: { roll: setpoint },
    gyro: { roll: gyro, pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });

  const result = computeStepResponse(log, 'roll');
  expect(result.numSegmentsUsed).toBe(0);
  expect(result.numSegmentsRejected).toBe(0);
});
