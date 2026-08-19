import type { Axis, BlackboxLog } from '../blackboxLog';

/** Builds a minimal BlackboxLog directly from field values, for testing
 * analysis functions without going through the Blackbox binary decoder. */
export function buildTestLog(overrides: Partial<BlackboxLog> = {}): BlackboxLog {
  const zero = (): Record<Axis, Float64Array> => ({
    roll: new Float64Array(0),
    pitch: new Float64Array(0),
    yaw: new Float64Array(0),
  });
  return {
    timeS: new Float64Array(0),
    sampleRateHz: 1000,
    setpoint: {},
    gyro: zero(),
    axisP: zero(),
    axisI: zero(),
    axisD: zero(),
    axisF: zero(),
    throttlePct: new Float64Array(0),
    headers: {},
    firmwareVersion: null,
    ...overrides,
  };
}

/** Linearly spaced time array of length n at the given sample rate. */
export function timeSeries(n: number, sampleRateHz: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = i / sampleRateHz;
  return out;
}

/** One-pole IIR low-pass filter matching scipy.signal.lfilter([1-a],[1,-a],
 * x): y[0] = (1-a)*x[0]; y[n] = a*y[n-1] + (1-a)*x[n]. This is the standard
 * discrete first-order lag with analytically known step response
 * 1-exp(-t/tau) when driven by a step, for `a = exp(-1/(sampleRateHz*tau))`. */
export function onePoleLowPass(x: Float64Array, a: number): Float64Array {
  const y = new Float64Array(x.length);
  y[0] = (1 - a) * x[0];
  for (let i = 1; i < x.length; i++) y[i] = a * y[i - 1] + (1 - a) * x[i];
  return y;
}
