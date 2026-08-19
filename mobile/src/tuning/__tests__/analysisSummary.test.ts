import { buildAnalysisSummary } from '../analysisSummary';
import { buildTestLog, onePoleLowPass, timeSeries } from '../../analysis/testSupport/buildTestLog';

/** Reuses Phase 3's first-order-lag fixture (step_response.py's own test
 * construction) since this module is exercised end-to-end, not unit by
 * unit -- a real-shaped log is more useful here than hand-picked numbers. */
function wellTunedLog() {
  const sampleRateHz = 1000;
  const durationS = 20;
  const n = Math.round(durationS * sampleRateHz);
  const timeS = timeSeries(n, sampleRateHz);
  const periodS = 2.0;
  const amplitude = 150.0;
  const setpoint = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    setpoint[i] = (timeS[i] % periodS) < periodS / 2 ? amplitude : 0;
  }
  const a = Math.exp(-1 / (sampleRateHz * 0.05));
  const gyro = onePoleLowPass(setpoint, a);

  return buildTestLog({
    timeS,
    sampleRateHz,
    setpoint: { roll: setpoint, pitch: setpoint, yaw: setpoint },
    gyro: { roll: gyro, pitch: gyro, yaw: gyro },
  });
}

test('buildAnalysisSummary produces a complete, self-consistent shape', () => {
  const log = wellTunedLog();
  const summary = buildAnalysisSummary(log);

  expect(['GOOD', 'FAIR', 'POOR', 'UNKNOWN']).toContain(summary.overallGrade);
  expect(summary.confidencePct).toBeGreaterThanOrEqual(0);
  expect(summary.confidencePct).toBeLessThanOrEqual(95);

  for (const axis of ['roll', 'pitch', 'yaw'] as const) {
    const axisSummary = summary.axes?.[axis];
    expect(axisSummary).toBeDefined();
    expect(['GOOD', 'FAIR', 'POOR', 'UNKNOWN']).toContain(axisSummary!.grade);
    expect(['LOW', 'MODERATE', 'HIGH', 'UNKNOWN']).toContain(axisSummary!.oscillation);
    expect(axisSummary!.eventsUsed).toBeGreaterThanOrEqual(0);
  }

  expect(summary.noise).toBeDefined();
  expect(['GOOD', 'FAIR']).toContain(summary.noise!.gyroGrade);
  expect(['GOOD', 'FAIR', 'POOR', 'UNKNOWN']).toContain(summary.noise!.dtermGrade);
  expect(typeof summary.noise!.motorHarmonicLikely).toBe('boolean');
});

test('buildAnalysisSummary throws on a genuinely empty log, matching the Python reference', () => {
  // computeStepResponse itself requires non-empty gyro data (see
  // stepResponse.ts) -- an entirely empty log has nothing to analyze, and
  // the Python reference this was reconstructed from has the same
  // requirement, so this is expected behavior, not a gap to paper over.
  const log = buildTestLog();
  expect(() => buildAnalysisSummary(log)).toThrow();
});
