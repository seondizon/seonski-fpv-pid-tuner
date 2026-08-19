/** Compare two tune iterations' analysis results.
 *
 * Ported from backend/app/tuning/compare.py. Pure comparison logic over two
 * AnalysisSummary snapshots (see analysisSummary.ts, store.ts's Iteration)
 * -- doesn't touch the FC or decide whether to keep tuning (that's
 * stopping.ts's job).
 */
import type { AnalysisSummary } from './analysisSummary';
import type { Iteration } from './store';

const GRADE_RANK: Record<string, number> = { POOR: 0, FAIR: 1, GOOD: 2 };

export interface CompareResult {
  trackingDeltaPct: number | null;
  overshootDeltaPct: number | null;
  noiseDelta: number;
  better: 'newer' | 'older' | 'tie' | 'unknown';
  summary: string;
}

function axisAvg(summary: AnalysisSummary, field: 'trackingPct' | 'overshootPct'): number | null {
  const values = (['roll', 'pitch'] as const)
    .map((axis) => summary.axes?.[axis]?.[field])
    .filter((v): v is number => v !== null && v !== undefined);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** A single scalar combining tracking (higher better), overshoot (lower
 * better), and noise grade (higher better) into one comparable number.
 * Weights are this project's own first-pass judgment call, not derived
 * from any reference project: trackingPct and overshootPct are already on
 * roughly comparable 0-100-ish scales, so they're combined at equal
 * weight; noise grade is mapped to a 0/10/20 bonus so a full grade step
 * (e.g. FAIR -> GOOD) matters about as much as a 10-point tracking/
 * overshoot swing, without letting noise alone dominate the comparison.
 * Returns null if there isn't enough data to score at all. */
function score(summary: AnalysisSummary): number | null {
  const tracking = axisAvg(summary, 'trackingPct');
  const overshoot = axisAvg(summary, 'overshootPct');
  const noiseGrade = summary.noise?.dtermGrade;
  const noiseRank = noiseGrade !== undefined ? GRADE_RANK[noiseGrade] : undefined;
  const noiseBonus = (noiseRank ?? 1) * 10; // UNKNOWN/missing -> treated as FAIR (rank 1)

  const parts = [tracking, overshoot !== null ? 100 - overshoot : null].filter(
    (v): v is number => v !== null
  );
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length + noiseBonus;
}

export function compareIterations(older: AnalysisSummary, newer: AnalysisSummary): CompareResult {
  const olderTracking = axisAvg(older, 'trackingPct');
  const newerTracking = axisAvg(newer, 'trackingPct');
  const trackingDeltaPct =
    olderTracking !== null && newerTracking !== null ? newerTracking - olderTracking : null;

  const olderOvershoot = axisAvg(older, 'overshootPct');
  const newerOvershoot = axisAvg(newer, 'overshootPct');
  const overshootDeltaPct =
    olderOvershoot !== null && newerOvershoot !== null ? olderOvershoot - newerOvershoot : null;

  const olderNoise = older.noise?.dtermGrade !== undefined ? GRADE_RANK[older.noise.dtermGrade] : undefined;
  const newerNoise = newer.noise?.dtermGrade !== undefined ? GRADE_RANK[newer.noise.dtermGrade] : undefined;
  const noiseDelta = olderNoise !== undefined && newerNoise !== undefined ? newerNoise - olderNoise : 0;

  const olderScore = score(older);
  const newerScore = score(newer);

  if (olderScore === null || newerScore === null) {
    return {
      trackingDeltaPct,
      overshootDeltaPct,
      noiseDelta,
      better: 'unknown',
      summary: 'Not enough data to compare these two tunes.',
    };
  }

  const diff = newerScore - olderScore;
  let better: CompareResult['better'];
  let summary: string;
  if (Math.abs(diff) < 2.0) {
    // within noise of each other -- call it a tie rather than overclaiming
    better = 'tie';
    summary = 'These two tunes perform about the same.';
  } else if (diff > 0) {
    better = 'newer';
    summary = 'The newer tune is an improvement.';
  } else {
    better = 'older';
    summary = 'The previous tune remains the better one.';
  }

  return { trackingDeltaPct, overshootDeltaPct, noiseDelta, better, summary };
}

/** Given iterations (in chronological order), returns the `number` of the
 * one with the best analysisSummary score, or null if none of them have
 * enough data to score. Ties resolve to the earliest iteration -- a tune
 * that's merely "as good as" the current one isn't a reason to prefer it
 * over an already-proven baseline. */
export function findBestIteration(iterations: Iteration[]): number | null {
  let bestNumber: number | null = null;
  let bestScore: number | null = null;
  for (const iteration of iterations) {
    const s = score(iteration.analysisSummary);
    if (s === null) continue;
    if (bestScore === null || s > bestScore) {
      bestScore = s;
      bestNumber = iteration.number;
    }
  }
  return bestNumber;
}
