/** Ported from backend/app/analysis/grading.py -- pure functions, no numpy
 * dependency, trivial 1:1 port.
 *
 * grade_dterm_noise here deliberately duplicates fft_noise.ts's D-term
 * threshold numbers (0.5 / 0.3) rather than importing from it, exactly as
 * the Python reference does, so this module has zero dependencies on the
 * rest of the analysis engine and can be reused standalone (e.g. by a
 * future tuning engine). The label sets differ on purpose: fftNoise.ts's
 * own grade is GOOD/MARGINAL/POOR; this module's is GOOD/FAIR/POOR at the
 * same boundaries.
 */

export type Grade = 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';
export type OscillationLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN';

const GRADE_RANK: Record<'POOR' | 'FAIR' | 'GOOD', number> = { POOR: 0, FAIR: 1, GOOD: 2 };

export function gradeOvershoot(overshootPct: number | null): Grade {
  if (overshootPct === null) return 'UNKNOWN';
  if (overshootPct < 10) return 'GOOD';
  if (overshootPct < 25) return 'FAIR';
  return 'POOR';
}

export function gradeTrackingErrorStd(errorStd: number | null): Grade {
  if (errorStd === null) return 'UNKNOWN';
  if (errorStd < 0.12) return 'GOOD';
  if (errorStd < 0.22) return 'FAIR';
  return 'POOR';
}

export function trackingErrorStdToPct(errorStd: number | null): number | null {
  if (errorStd === null) return null;
  const pct = 100.0 * (1.0 - Math.min(errorStd / 0.4, 1.0));
  return Math.round(Math.max(pct, 0.0) * 10) / 10;
}

export function gradeOscillation(
  overshootPct: number | null,
  settlingTimeS: number | null
): OscillationLevel {
  if (overshootPct === null || settlingTimeS === null) return 'UNKNOWN';
  if (overshootPct > 20 && settlingTimeS > 0.15) return 'HIGH';
  if (overshootPct > 10 || settlingTimeS > 0.1) return 'MODERATE';
  return 'LOW';
}

export function gradeDtermNoise(dPRatio: number | null, hfEnergyRatio: number | null): Grade {
  if (dPRatio === null) return 'UNKNOWN';
  if (dPRatio > 0.5) return 'POOR';
  if (dPRatio > 0.3 || (hfEnergyRatio !== null && hfEnergyRatio > 0.3)) return 'FAIR';
  return 'GOOD';
}

/** The worst grade among the known (non-UNKNOWN) inputs. */
export function overallGrade(grades: Grade[]): Grade {
  const known = grades.filter((g): g is 'POOR' | 'FAIR' | 'GOOD' => g in GRADE_RANK);
  if (known.length === 0) return 'UNKNOWN';
  return known.reduce((worst, g) => (GRADE_RANK[g] < GRADE_RANK[worst] ? g : worst));
}
