import { compareIterations, findBestIteration } from '../compare';
import type { AnalysisSummary } from '../analysisSummary';
import type { Grade } from '../../analysis/grading';
import type { Iteration } from '../store';

function buildSummary(
  rollTracking: number | null,
  rollOvershoot: number | null,
  pitchTracking: number | null,
  pitchOvershoot: number | null,
  dtermGrade: Grade | undefined
): AnalysisSummary {
  return {
    overallGrade: 'GOOD',
    axes: {
      roll: {
        grade: 'GOOD',
        trackingPct: rollTracking,
        overshootPct: rollOvershoot,
        settlingTimeMs: null,
        oscillation: 'LOW',
        eventsUsed: 0,
      },
      pitch: {
        grade: 'GOOD',
        trackingPct: pitchTracking,
        overshootPct: pitchOvershoot,
        settlingTimeMs: null,
        oscillation: 'LOW',
        eventsUsed: 0,
      },
    },
    noise: dtermGrade
      ? { gyroGrade: 'GOOD', dtermGrade, mainPeakHz: null, mainPeakClassification: null, motorHarmonicLikely: false }
      : undefined,
  };
}

test('newer iteration is reported as better', () => {
  const older = buildSummary(60, 20, 60, 20, 'FAIR');
  const newer = buildSummary(85, 5, 85, 5, 'GOOD');
  const result = compareIterations(older, newer);
  expect(result.better).toBe('newer');
  expect(result.trackingDeltaPct as number).toBeGreaterThan(0);
  expect(result.overshootDeltaPct as number).toBeGreaterThan(0);
  expect(result.noiseDelta).toBeGreaterThan(0);
});

test('older iteration is reported as better', () => {
  const older = buildSummary(90, 3, 90, 3, 'GOOD');
  const newer = buildSummary(60, 25, 60, 25, 'POOR');
  const result = compareIterations(older, newer);
  expect(result.better).toBe('older');
});

test('nearly identical iterations are a tie', () => {
  const older = buildSummary(80, 8, 80, 8, 'GOOD');
  const newer = buildSummary(81, 7.5, 80, 8, 'GOOD');
  const result = compareIterations(older, newer);
  expect(result.better).toBe('tie');
});

test('unknown when there is no data', () => {
  const older = buildSummary(null, null, null, null, undefined);
  const newer = buildSummary(null, null, null, null, undefined);
  const result = compareIterations(older, newer);
  expect(result.better).toBe('unknown');
});

function iterationAt(number: number, s: AnalysisSummary): Iteration {
  return { number, timestamp: number, label: 'Applied', appliedChanges: [], analysisSummary: s };
}

test('findBestIteration picks the highest-scoring iteration', () => {
  const iterations = [
    iterationAt(1, buildSummary(60, 20, 60, 20, 'FAIR')),
    iterationAt(2, buildSummary(90, 3, 90, 3, 'GOOD')),
    iterationAt(3, buildSummary(70, 15, 70, 15, 'FAIR')),
  ];
  expect(findBestIteration(iterations)).toBe(2);
});

test('findBestIteration returns null for empty input or no scorable data', () => {
  expect(findBestIteration([])).toBeNull();
  expect(findBestIteration([iterationAt(1, {})])).toBeNull();
});
