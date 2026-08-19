import { evaluateTuneComplete } from '../stopping';
import type { AnalysisSummary } from '../analysisSummary';
import type { Grade } from '../../analysis/grading';

function buildSummary(
  overallGrade: Grade,
  rollTracking = 90.0,
  rollOvershoot = 5.0,
  pitchTracking = 90.0,
  pitchOvershoot = 5.0,
  dtermGrade: Grade = 'GOOD'
): AnalysisSummary {
  const axisGrade = overallGrade === 'GOOD' ? 'GOOD' : overallGrade;
  return {
    overallGrade,
    confidencePct: 90,
    axes: {
      roll: {
        grade: axisGrade,
        trackingPct: rollTracking,
        overshootPct: rollOvershoot,
        settlingTimeMs: null,
        oscillation: 'LOW',
        eventsUsed: 0,
      },
      pitch: {
        grade: axisGrade,
        trackingPct: pitchTracking,
        overshootPct: pitchOvershoot,
        settlingTimeMs: null,
        oscillation: 'LOW',
        eventsUsed: 0,
      },
    },
    noise: { gyroGrade: 'GOOD', dtermGrade, mainPeakHz: null, mainPeakClassification: null, motorHarmonicLikely: false },
  };
}

test('all good with no previous iteration is complete', () => {
  const result = evaluateTuneComplete(buildSummary('GOOD'), null);
  expect(result.tuneComplete).toBe(true);
  expect(result.improvementPct).toBeNull();
});

test('a poor axis is not complete, with a reason', () => {
  const result = evaluateTuneComplete(buildSummary('POOR', 40.0, 40.0), null);
  expect(result.tuneComplete).toBe(false);
  expect(result.reasons.length).toBeGreaterThanOrEqual(1);
});

test('meaningful improvement is not complete', () => {
  const previous = buildSummary('FAIR', 50.0, 30.0, 50.0, 30.0);
  const current = buildSummary('GOOD', 95.0, 3.0, 95.0, 3.0);
  const result = evaluateTuneComplete(current, previous);
  expect(result.tuneComplete).toBe(false);
  expect(result.improvementPct as number).toBeGreaterThan(1.0);
});

test('negligible improvement is complete', () => {
  const previous = buildSummary('GOOD', 90.0, 5.0, 90.0, 5.0);
  const current = buildSummary('GOOD', 90.2, 4.9, 90.1, 5.0);
  const result = evaluateTuneComplete(current, previous);
  expect(result.tuneComplete).toBe(true);
  expect(result.improvementPct as number).toBeLessThan(1.0);
});

test('a regression is reported but does not crash, and formats the sign correctly', () => {
  const previous = buildSummary('GOOD', 95.0, 3.0, 95.0, 3.0);
  const current = buildSummary('GOOD', 91.0, 5.0, 91.0, 5.0);
  const result = evaluateTuneComplete(current, previous);
  expect(typeof result.tuneComplete).toBe('boolean');
  expect(result.improvementPct as number).toBeLessThanOrEqual(0);
  // Regression test for a double-sign formatting bug ("+-5%" instead of
  // "-5%"): a negative improvementPct must not produce a reason string
  // with two leading sign characters.
  expect(result.reasons[0]).not.toContain('+-');
});
