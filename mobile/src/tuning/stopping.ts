/** Stopping-criteria evaluation: has this craft's tune converged?
 *
 * Ported from backend/app/tuning/stopping.py. Per the product's iterative-
 * tuning philosophy, the tuner must not chase improvements forever -- once
 * the analysis is already GOOD and the previous iteration didn't
 * meaningfully improve on the one before it, the answer should be "tune
 * complete", including "no tune required at all" on a first-ever analysis
 * that's already good.
 */
import type { AnalysisSummary, AxisSummary } from './analysisSummary';

// Below this aggregate improvement percentage, the latest tune is
// considered "not meaningfully better" than the previous one.
const IMPROVEMENT_THRESHOLD_PCT = 1.0;

export interface TuneCompleteResult {
  tuneComplete: boolean;
  reasons: string[];
  improvementPct: number | null;
}

/** A single 0-100-ish "how good is this axis" scalar combining trackingPct
 * (already 0-100, higher better) and overshootPct (lower better, so
 * inverted and clamped). A deliberately simple aggregate for comparing two
 * iterations, not a scientific metric. */
function axisScore(axisSummary: AxisSummary | undefined): number | null {
  if (!axisSummary) return null;
  const parts: number[] = [];
  if (axisSummary.trackingPct !== null && axisSummary.trackingPct !== undefined) {
    parts.push(axisSummary.trackingPct);
  }
  if (axisSummary.overshootPct !== null && axisSummary.overshootPct !== undefined) {
    parts.push(Math.max(0.0, 100.0 - axisSummary.overshootPct));
  }
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

function overallScore(summary: AnalysisSummary): number | null {
  const scores = [axisScore(summary.axes?.roll), axisScore(summary.axes?.pitch)].filter(
    (s): s is number => s !== null
  );
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

/** Mimics Python's f"{value:+g}" -- always-signed, trailing-zero-stripped
 * formatting. Negative values already carry their own '-', so the '+'
 * prefix is only added for non-negative values (this is the exact
 * distinction a prior review caught as a "+-5%" double-sign bug). */
function formatSignedPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  const stripped = parseFloat(value.toPrecision(6)).toString();
  return `${sign}${stripped}%`;
}

export function evaluateTuneComplete(
  currentSummary: AnalysisSummary,
  previousSummary: AnalysisSummary | null
): TuneCompleteResult {
  const reasons: string[] = [];
  const overallGrade = currentSummary.overallGrade;

  if (overallGrade !== 'GOOD') {
    for (const axisName of ['roll', 'pitch'] as const) {
      const axis = currentSummary.axes?.[axisName];
      const grade = axis?.grade;
      if (grade !== 'GOOD' && grade !== undefined && grade !== 'UNKNOWN') {
        const label = axisName.charAt(0).toUpperCase() + axisName.slice(1);
        reasons.push(`${label} ${grade.toLowerCase()} still elevated`);
      }
    }
    const noiseGrade = currentSummary.noise?.dtermGrade;
    if (noiseGrade !== 'GOOD' && noiseGrade !== undefined && noiseGrade !== 'UNKNOWN') {
      reasons.push('D-term noise still needs attention');
    }
    if (reasons.length === 0) {
      reasons.push('Overall result is not yet in the good range');
    }
    return { tuneComplete: false, reasons, improvementPct: null };
  }

  if (previousSummary === null) {
    // Nothing to compare against, and already GOOD -- valid "no tune
    // required" outcome on a first-ever analysis.
    return { tuneComplete: true, reasons: ['Result is already good'], improvementPct: null };
  }

  const currentScore = overallScore(currentSummary);
  const previousScore = overallScore(previousSummary);

  if (currentScore === null || previousScore === null) {
    // Can't compute a meaningful delta -- fall back to "already GOOD" as
    // the deciding factor rather than blocking on missing data.
    return { tuneComplete: true, reasons: ['Result is already good'], improvementPct: null };
  }

  const improvementPct =
    previousScore <= 0 ? 0.0 : Math.round(((currentScore - previousScore) / previousScore) * 100.0 * 100) / 100;

  if (improvementPct < IMPROVEMENT_THRESHOLD_PCT) {
    return {
      tuneComplete: true,
      reasons: [`No meaningful improvement over the previous tune (${formatSignedPercent(improvementPct)})`],
      improvementPct,
    };
  }

  return {
    tuneComplete: false,
    reasons: [`Still improving over the previous tune (${formatSignedPercent(improvementPct)})`],
    improvementPct,
  };
}
