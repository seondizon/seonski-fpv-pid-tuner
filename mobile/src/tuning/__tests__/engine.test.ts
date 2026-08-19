import { computeReadiness, generateRecommendations, Recommendation } from '../engine';
import type { DTermNoiseMetrics } from '../../analysis/fftNoise';
import type { StepResponseResult } from '../../analysis/stepResponse';
import type { TrackingStats } from '../../analysis/tracking';

function fakeStepResponse(overrides: Partial<StepResponseResult> = {}): StepResponseResult {
  return {
    timeS: new Float64Array(0),
    response: new Float64Array(0),
    numSegmentsUsed: 20,
    numSegmentsRejected: 2,
    overshootPct: 5.0,
    riseTimeS: 0.04,
    settlingTimeS: 0.08,
    steadyStateErrorPct: 0.0,
    ...overrides,
  };
}

function fakeDtermNoise(overrides: Partial<DTermNoiseMetrics> = {}): DTermNoiseMetrics {
  return { dTermRms: 5.0, dPRatio: 0.15, hfEnergyRatio: 0.05, grade: 'GOOD', ...overrides };
}

function fakeTracking(overrides: Partial<TrackingStats> = {}): TrackingStats {
  return { errorStd: 0.08, meanAbsErrorByStickBin: {}, semByStickBin: {}, ...overrides };
}

function goodInputs() {
  return {
    step: { roll: fakeStepResponse(), pitch: fakeStepResponse() },
    noise: { roll: fakeDtermNoise(), pitch: fakeDtermNoise() },
    tracking: { roll: fakeTracking(), pitch: fakeTracking() },
  };
}

test('a well-tuned log produces no recommendations', () => {
  const { step, noise, tracking } = goodInputs();
  expect(generateRecommendations(step, noise, tracking)).toEqual([]);
});

test('high overshoot with good noise recommends a D raise', () => {
  const { step, noise, tracking } = goodInputs();
  step.roll = fakeStepResponse({ overshootPct: 30.0, numSegmentsUsed: 20 });
  const recs = generateRecommendations(step, noise, tracking);

  const rollRecs = recs.filter((r) => r.axis === 'roll');
  expect(rollRecs).toHaveLength(1);
  const rec = rollRecs[0];
  expect(rec.parameter).toBe('d_roll');
  expect(rec.changePct).toBeGreaterThan(0);
  expect(rec.confidencePct).toBeGreaterThan(0);
  expect(rec.reason.length).toBeLessThan(150);
  expect(rec.reason).not.toContain('\n');
});

test('high overshoot but poor noise recommends filter, not D', () => {
  const { step, noise, tracking } = goodInputs();
  step.roll = fakeStepResponse({ overshootPct: 30.0 });
  noise.roll = fakeDtermNoise({ dPRatio: 0.6, hfEnergyRatio: 0.4, grade: 'POOR' });
  const recs = generateRecommendations(step, noise, tracking);

  expect(recs.some((r) => r.parameter === 'd_roll')).toBe(false);
  expect(recs.some((r) => r.category === 'filter_ff')).toBe(true);
});

test('poor tracking with low overshoot recommends P, not D', () => {
  const { step, noise, tracking } = goodInputs();
  tracking.roll = fakeTracking({ errorStd: 0.3 }); // POOR band
  const recs = generateRecommendations(step, noise, tracking);

  const rollRecs = recs.filter((r) => r.axis === 'roll');
  expect(rollRecs).toHaveLength(1);
  expect(rollRecs[0].parameter).toBe('p_roll');
});

test('D raise respects the damping ratio ceiling when PIDs are known', () => {
  const { step, noise, tracking } = goodInputs();
  step.roll = fakeStepResponse({ overshootPct: 30.0 });
  const currentPids = { p_roll: 40.0, d_roll: 34.0 }; // ratio already 0.85 (at ceiling)
  const recs = generateRecommendations(step, noise, tracking, currentPids);

  expect(recs.filter((r) => r.parameter === 'd_roll')).toEqual([]);
});

test('D raise caps at the ceiling when room remains', () => {
  const { step, noise, tracking } = goodInputs();
  step.roll = fakeStepResponse({ overshootPct: 30.0 });
  const currentPids = { p_roll: 40.0, d_roll: 30.0 }; // ratio 0.75, some room to 0.85
  const recs = generateRecommendations(step, noise, tracking, currentPids);

  const dRecs = recs.filter((r) => r.parameter === 'd_roll');
  expect(dRecs).toHaveLength(1);
  expect(dRecs[0].proposedValue as number).toBeLessThanOrEqual(40.0 * 0.85 + 1e-6);
  expect(dRecs[0].currentValue).toBe(30.0);
});

test('no single recommendation exceeds the safety cap', () => {
  const { step, noise, tracking } = goodInputs();
  step.roll = fakeStepResponse({ overshootPct: 99.0 });
  step.pitch = fakeStepResponse({ overshootPct: 99.0 });
  tracking.roll = fakeTracking({ errorStd: 0.9 });
  tracking.pitch = fakeTracking({ errorStd: 0.9 });
  const recs = generateRecommendations(step, noise, tracking);
  expect(recs.every((r) => Math.abs(r.changePct) <= 15.0)).toBe(true);
});

test('computeReadiness blocks on an unsupported version', () => {
  const readiness = computeReadiness([], false, true);
  expect(readiness.blocked).toBe(true);
  expect(readiness.blockReasons.some((r) => r.toLowerCase().includes('version'))).toBe(true);
});

test('computeReadiness blocks on a settings-read failure', () => {
  const readiness = computeReadiness([], true, false);
  expect(readiness.blocked).toBe(true);
  expect(readiness.blockReasons.some((r) => /settings|read/i.test(r))).toBe(true);
});

test('computeReadiness is not blocked in the normal case', () => {
  const recs: Recommendation[] = [
    {
      parameter: 'd_roll',
      axis: 'roll',
      currentValue: 30.0,
      proposedValue: 33.0,
      changePct: 10.0,
      reason: 'test',
      confidencePct: 80,
      category: 'roll',
    },
  ];
  const readiness = computeReadiness(recs, true, true);
  expect(readiness.blocked).toBe(false);
  expect(readiness.confidencePct).toBe(80);
});

test('computeReadiness with zero recommendations is confident', () => {
  const readiness = computeReadiness([], true, true);
  expect(readiness.blocked).toBe(false);
  expect(readiness.confidencePct).toBeGreaterThanOrEqual(35);
});
