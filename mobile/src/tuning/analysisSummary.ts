/** Consolidated, pre-graded analysis results -- one call instead of the UI
 * making 3+ axis-by-axis requests and computing grades itself.
 *
 * Reconstructed from the Python reference's backend/app/api/routes.py::
 * get_analysis_summary (deleted along with the rest of the HTTP API layer
 * when the project pivoted to mobile-only -- see git history around commit
 * b75aa6e), since compare.ts/stopping.ts both operate on exactly this
 * shape. Grading thresholds live in analysis/grading.ts so this module and
 * the tuning engine agree on what GOOD/FAIR/POOR mean.
 */
import { computeDtermNoiseMetrics, detectNoisePeaks } from '../analysis/fftNoise';
import { hannWindow, magnitude, nextPow2, realFftHalf, rfftFreq } from '../analysis/fft';
import { computeStepResponse } from '../analysis/stepResponse';
import { computeTrackingErrorStats } from '../analysis/tracking';
import * as grading from '../analysis/grading';
import type { Axis, BlackboxLog } from '../analysis/blackboxLog';
import type { Grade } from '../analysis/grading';

const SUMMARY_AXES: readonly Axis[] = ['roll', 'pitch', 'yaw'];

export interface AxisSummary {
  grade: Grade;
  trackingPct: number | null;
  overshootPct: number | null;
  settlingTimeMs: number | null;
  oscillation: grading.OscillationLevel;
  eventsUsed: number;
}

export interface NoiseSummary {
  gyroGrade: 'GOOD' | 'FAIR';
  dtermGrade: Grade;
  mainPeakHz: number | null;
  mainPeakClassification: string | null;
  motorHarmonicLikely: boolean;
}

/** All fields optional: a freshly-created iteration with no analysis run
 * yet against it is a valid, "empty" AnalysisSummary (`{}`), not an error
 * -- matching the Python reference's dict.get()-based leniency, since
 * compare.ts/stopping.ts must tolerate exactly this case. */
export interface AnalysisSummary {
  overallGrade?: Grade;
  confidencePct?: number;
  axes?: Partial<Record<Axis, AxisSummary>>;
  noise?: NoiseSummary;
}

export function buildAnalysisSummary(log: BlackboxLog): AnalysisSummary {
  const axesOut: Partial<Record<Axis, AxisSummary>> = {};
  const axisGrades: Grade[] = [];

  for (const axis of SUMMARY_AXES) {
    const step = computeStepResponse(log, axis);
    const tracking = computeTrackingErrorStats(log, axis);
    const overshootGrade = grading.gradeOvershoot(step.overshootPct);
    const trackingGrade = grading.gradeTrackingErrorStd(tracking.errorStd);
    const axisGrade = grading.overallGrade([overshootGrade, trackingGrade]);
    axisGrades.push(axisGrade);
    axesOut[axis] = {
      grade: axisGrade,
      trackingPct: grading.trackingErrorStdToPct(tracking.errorStd),
      overshootPct: step.overshootPct,
      settlingTimeMs: step.settlingTimeS === null ? null : Math.round(step.settlingTimeS * 1000 * 10) / 10,
      oscillation: grading.gradeOscillation(step.overshootPct, step.settlingTimeS),
      eventsUsed: step.numSegmentsUsed,
    };
  }

  const dtermRoll = computeDtermNoiseMetrics(log, 'roll');
  const dtermGrade = grading.gradeDtermNoise(dtermRoll.dPRatio, dtermRoll.hfEnergyRatio);

  let mainPeak: { freqHz: number; classification: string } | null = null;
  let motorHarmonicLikely = false;
  const gyroRoll = log.gyro.roll;
  if (gyroRoll && gyroRoll.length >= 8) {
    const win = hannWindow(gyroRoll.length);
    const windowed = new Float64Array(gyroRoll.length);
    for (let i = 0; i < gyroRoll.length; i++) windowed[i] = gyroRoll[i] * win[i];
    const paddedSize = nextPow2(gyroRoll.length);
    const spectrum = magnitude(realFftHalf(windowed, paddedSize));
    const freqHz = rfftFreq(paddedSize, 1 / log.sampleRateHz);
    const peaks = detectNoisePeaks(freqHz, spectrum);
    if (peaks.length > 0) {
      const top = peaks.reduce((a, b) => (b.magnitudeDb > a.magnitudeDb ? b : a));
      mainPeak = { freqHz: top.freqHz, classification: top.classification };
      motorHarmonicLikely = top.classification === 'motor' || top.classification === 'prop_blade_pass';
    }
  }

  const gyroGrade: 'GOOD' | 'FAIR' = dtermRoll.hfEnergyRatio < 0.3 ? 'GOOD' : 'FAIR';
  const noise: NoiseSummary = {
    gyroGrade,
    dtermGrade,
    mainPeakHz: mainPeak?.freqHz ?? null,
    mainPeakClassification: mainPeak?.classification ?? null,
    motorHarmonicLikely,
  };

  const overall = grading.overallGrade([...axisGrades, dtermGrade, gyroGrade]);
  // Confidence is a simple, honest placeholder here (data volume only) --
  // the real per-recommendation confidence scoring lives in the tuning
  // engine (engine.ts), which has more context to do this properly.
  const totalEvents = (axesOut.roll?.eventsUsed ?? 0) + (axesOut.pitch?.eventsUsed ?? 0);
  const confidencePct = Math.min(95, 40 + totalEvents * 2);

  return { overallGrade: overall, confidencePct, axes: axesOut, noise };
}
