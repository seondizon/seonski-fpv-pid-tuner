import {
  gradeDtermNoise,
  gradeOscillation,
  gradeOvershoot,
  gradeTrackingErrorStd,
  overallGrade,
  trackingErrorStdToPct,
} from '../grading';

test('gradeOvershoot boundaries', () => {
  expect(gradeOvershoot(5.0)).toBe('GOOD');
  expect(gradeOvershoot(15.0)).toBe('FAIR');
  expect(gradeOvershoot(40.0)).toBe('POOR');
  expect(gradeOvershoot(null)).toBe('UNKNOWN');
});

test('gradeTrackingErrorStd boundaries', () => {
  expect(gradeTrackingErrorStd(0.05)).toBe('GOOD');
  expect(gradeTrackingErrorStd(0.18)).toBe('FAIR');
  expect(gradeTrackingErrorStd(0.5)).toBe('POOR');
  expect(gradeTrackingErrorStd(null)).toBe('UNKNOWN');
});

test('trackingErrorStdToPct', () => {
  expect(trackingErrorStdToPct(null)).toBeNull();
  expect(trackingErrorStdToPct(0.0)).toBe(100.0);
  expect(trackingErrorStdToPct(1.0)).toBe(0.0); // clamped: 1.0/0.4=2.5 -> min(.,1)=1 -> pct=0
  const mid = trackingErrorStdToPct(0.2)!;
  expect(mid).toBeGreaterThanOrEqual(0);
  expect(mid).toBeLessThanOrEqual(100);
});

test('gradeOscillation boundaries', () => {
  expect(gradeOscillation(5.0, 0.05)).toBe('LOW');
  expect(gradeOscillation(15.0, 0.05)).toBe('MODERATE');
  expect(gradeOscillation(30.0, 0.2)).toBe('HIGH');
  expect(gradeOscillation(null, 0.05)).toBe('UNKNOWN');
});

test('gradeDtermNoise boundaries', () => {
  expect(gradeDtermNoise(0.1, 0.05)).toBe('GOOD');
  expect(gradeDtermNoise(0.35, 0.05)).toBe('FAIR');
  expect(gradeDtermNoise(0.6, 0.05)).toBe('POOR');
  expect(gradeDtermNoise(null, null)).toBe('UNKNOWN');
});

test('overallGrade picks the worst known grade', () => {
  expect(overallGrade(['GOOD', 'FAIR', 'GOOD'])).toBe('FAIR');
  expect(overallGrade(['GOOD', 'POOR'])).toBe('POOR');
  expect(overallGrade(['GOOD', 'GOOD'])).toBe('GOOD');
  expect(overallGrade(['UNKNOWN', 'UNKNOWN'])).toBe('UNKNOWN');
  expect(overallGrade(['UNKNOWN', 'GOOD'])).toBe('GOOD');
});
