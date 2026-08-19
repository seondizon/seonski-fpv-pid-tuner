/** Rule-based PID/filter tuning recommendation engine.
 *
 * Ported from backend/app/tuning/engine.py -- a clean-room reimplementation
 * of the FPVPIDlab-style recommendation pattern documented in
 * docs/research/tuning-algorithms.md, NOT a port of FPVPIDlab's own code
 * (GPL-3.0, and its own thresholds are explicitly "not yet
 * hardware-validated" per that project's own docs). Every numeric constant
 * below is this project's own first-pass choice, to be validated against
 * real flight data before being trusted.
 *
 * ADVISORY ONLY. This module never touches a flight controller -- it only
 * produces Recommendation objects. Writing anything to hardware is
 * apply.ts's job, independently safety-gated.
 *
 * Parameter naming: modern Betaflight (4.x+) exposes PID terms as
 * individual per-axis-per-term CLI settables -- p_roll/i_roll/d_roll/
 * f_roll, p_pitch/..., p_yaw/.... Recommendations here use this modern
 * naming.
 */
import { gradeDtermNoise, gradeOvershoot, gradeTrackingErrorStd } from '../analysis/grading';
import type { DTermNoiseMetrics } from '../analysis/fftNoise';
import type { StepResponseResult } from '../analysis/stepResponse';
import type { TrackingStats } from '../analysis/tracking';

// yaw intentionally excluded from v1 -- see generateRecommendations's docstring.
const TUNABLE_AXES = ['roll', 'pitch'] as const;
type TunableAxis = (typeof TUNABLE_AXES)[number];

// Bounded, small steps: no single recommendation in one iteration exceeds
// this percentage change. This is a live, iterative tool (analyze -> tune ->
// fly -> re-analyze), not a one-shot "fix everything" pass.
const MAX_CHANGE_PCT = 15.0;

const D_RAISE_PCT_POOR = 12.0; // overshoot POOR (>25%)
const D_RAISE_PCT_FAIR = 5.0; // overshoot FAIR (10-25%)
const P_RAISE_PCT_POOR = 8.0; // tracking POOR
const P_RAISE_PCT_FAIR = 5.0; // tracking FAIR
const FILTER_ATTENTION_PCT = 10.0; // suggested cutoff-lowering magnitude, descriptive only

// Damping-ratio (D/P) safety ceiling -- a conservative default since this
// project doesn't yet know craft size (FPVPIDlab scales this by frame
// size; one flat ceiling for all builds until size-awareness is added).
const DAMPING_RATIO_CEILING = 0.85;

// Confidence floor below which the whole readiness result is blocked.
const MIN_CONFIDENCE_TO_PROCEED = 35;

export interface Recommendation {
  parameter: string;
  axis: string; // "roll" | "pitch" | "filter"
  currentValue: number | null;
  proposedValue: number | null;
  changePct: number;
  reason: string;
  confidencePct: number;
  category: string; // "roll" | "pitch" | "filter_ff"
}

export interface TuningReadiness {
  versionSupported: boolean;
  settingsReadOk: boolean;
  safetyPassed: boolean;
  confidencePct: number;
  blocked: boolean;
  blockReasons: string[];
}

/** 0 usable step-response segments -> low but non-zero confidence (20);
 * each additional segment adds 5 points, capped at 95 (never claim full
 * certainty -- this is a rule-based heuristic, not a validated model).
 * 15+ segments reaches the 95 cap. */
function confidenceFromSegments(numSegmentsUsed: number): number {
  return Math.min(95, 20 + Math.max(numSegmentsUsed, 0) * 5);
}

function dPRatioOf(dValue: number, pValue: number): number | null {
  if (pValue === 0) return null;
  return dValue / pValue;
}

function generateAxisRecommendations(
  axis: TunableAxis,
  step: StepResponseResult,
  dtermNoise: DTermNoiseMetrics,
  tracking: TrackingStats,
  currentPids: Record<string, number> | null
): Recommendation[] {
  const recs: Recommendation[] = [];
  const confidence = confidenceFromSegments(step.numSegmentsUsed);
  const dParam = `d_${axis}`;
  const pParam = `p_${axis}`;
  const currentD = currentPids ? (currentPids[dParam] ?? null) : null;
  const currentP = currentPids ? (currentPids[pParam] ?? null) : null;

  const noiseGrade = gradeDtermNoise(dtermNoise.dPRatio, dtermNoise.hfEnergyRatio);
  const overshootGrade = gradeOvershoot(step.overshootPct);
  const trackingGrade = gradeTrackingErrorStd(tracking.errorStd);

  const axisLabel = axis.charAt(0).toUpperCase() + axis.slice(1);
  let madeDRecommendation = false;

  if (noiseGrade === 'FAIR' || noiseGrade === 'POOR') {
    // D-effectiveness / noise gating: don't raise D into noise -- redirect
    // to filtering instead, and skip any overshoot-driven D raise below.
    recs.push({
      parameter: 'dterm_lpf1_static_hz',
      axis: 'filter',
      currentValue: null,
      proposedValue: null,
      changePct: -FILTER_ATTENTION_PCT,
      reason: `${axisLabel} D-term noise is elevated -- lower the D-term filter cutoff before raising D further.`,
      confidencePct: confidence,
      category: 'filter_ff',
    });
    madeDRecommendation = true; // blocks the overshoot-driven D path below
  } else if (overshootGrade === 'POOR') {
    let proposedPct = D_RAISE_PCT_POOR;
    let proposedValue: number | null = null;
    if (currentD !== null && currentP !== null && currentP > 0) {
      const cappedD = currentP * DAMPING_RATIO_CEILING;
      let candidateD = currentD * (1 + proposedPct / 100.0);
      if (candidateD > cappedD) {
        candidateD = cappedD;
        proposedPct = currentD ? Math.round((candidateD / currentD - 1) * 100.0 * 10) / 10 : 0.0;
      }
      proposedValue = Math.round(candidateD * 10) / 10;
    }
    if (proposedValue === null || currentD === null || proposedValue > currentD) {
      recs.push({
        parameter: dParam,
        axis,
        currentValue: currentD,
        proposedValue,
        changePct: proposedPct,
        reason: `${axisLabel} overshoot is high -- raising D should tighten damping.`,
        confidencePct: confidence,
        category: axis,
      });
      madeDRecommendation = true;
    }
  } else if (overshootGrade === 'FAIR') {
    let proposedPct = D_RAISE_PCT_FAIR;
    let proposedValue: number | null = null;
    let skip = false;
    if (currentD !== null && currentP !== null && currentP > 0) {
      const ratio = dPRatioOf(currentD, currentP);
      const cappedD = currentP * DAMPING_RATIO_CEILING;
      const candidateD = currentD * (1 + proposedPct / 100.0);
      if (ratio !== null && ratio >= DAMPING_RATIO_CEILING) {
        skip = true; // already at/above the safe ceiling -- nothing more to safely offer
      } else if (candidateD > cappedD) {
        proposedPct = currentD ? Math.round((cappedD / currentD - 1) * 100.0 * 10) / 10 : 0.0;
        proposedValue = Math.round(cappedD * 10) / 10;
      } else {
        proposedValue = Math.round(candidateD * 10) / 10;
      }
    }
    if (!skip) {
      recs.push({
        parameter: dParam,
        axis,
        currentValue: currentD,
        proposedValue,
        changePct: proposedPct,
        reason: `${axisLabel} shows a touch of overshoot -- a small D increase should help without adding noise.`,
        confidencePct: confidence,
        category: axis,
      });
      madeDRecommendation = true;
    }
  }

  if (!madeDRecommendation && (trackingGrade === 'FAIR' || trackingGrade === 'POOR')) {
    const proposedPct = trackingGrade === 'POOR' ? P_RAISE_PCT_POOR : P_RAISE_PCT_FAIR;
    const proposedValue = currentP !== null ? Math.round(currentP * (1 + proposedPct / 100.0) * 10) / 10 : null;
    recs.push({
      parameter: pParam,
      axis,
      currentValue: currentP,
      proposedValue,
      changePct: proposedPct,
      reason: `${axisLabel} tracking is a bit loose -- a small P increase should tighten it.`,
      confidencePct: confidence,
      category: axis,
    });
  }

  return recs;
}

/** See module docstring. Only roll/pitch are considered -- yaw's tuning
 * thresholds differ enough (per docs/research/tuning-algorithms.md's notes
 * on yaw's more permissive bands) that guessing at them for v1 isn't
 * worthwhile; add yaw support once that's researched properly rather than
 * reusing roll/pitch bands. */
export function generateRecommendations(
  stepResponseByAxis: Partial<Record<string, StepResponseResult>>,
  dtermNoiseByAxis: Partial<Record<string, DTermNoiseMetrics>>,
  trackingByAxis: Partial<Record<string, TrackingStats>>,
  currentPids: Record<string, number> | null = null
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  for (const axis of TUNABLE_AXES) {
    const step = stepResponseByAxis[axis];
    const dterm = dtermNoiseByAxis[axis];
    const tracking = trackingByAxis[axis];
    if (!step || !dterm || !tracking) continue;
    recommendations.push(...generateAxisRecommendations(axis, step, dterm, tracking, currentPids));
  }
  return recommendations;
}

/** See module docstring. Config-backup success is judged elsewhere (the
 * apply-orchestration module) -- this function only covers what the
 * recommendation engine itself can judge: version/input confidence and a
 * safety-bounds sanity check on the recommendations it produced. */
export function computeReadiness(
  recommendations: Recommendation[],
  versionSupported: boolean,
  settingsReadOk: boolean
): TuningReadiness {
  const blockReasons: string[] = [];

  if (!versionSupported) {
    blockReasons.push('Betaflight version could not be confirmed as supported.');
  }
  if (!settingsReadOk) {
    blockReasons.push('Flight controller settings could not be read reliably.');
  }

  const overCap = recommendations.filter((r) => Math.abs(r.changePct) > MAX_CHANGE_PCT + 1e-9);
  if (overCap.length > 0) {
    blockReasons.push(`${overCap.length} recommendation(s) exceed the ${MAX_CHANGE_PCT}% safety cap.`);
  }

  let confidencePct: number;
  if (recommendations.length > 0) {
    confidencePct = Math.min(...recommendations.map((r) => r.confidencePct));
  } else {
    // Nothing to be unconfident about -- a well-tuned log producing zero
    // recommendations is a confident "no tune required" outcome.
    confidencePct = 90;
  }

  if (confidencePct < MIN_CONFIDENCE_TO_PROCEED) {
    blockReasons.push(
      `Confidence (${confidencePct}%) is below the minimum needed to proceed (${MIN_CONFIDENCE_TO_PROCEED}%) -- fly a longer/more representative session.`
    );
  }

  return {
    versionSupported,
    settingsReadOk,
    safetyPassed: overCap.length === 0,
    confidencePct,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}
