/** Shared types between the app controller (useTunerController.ts) and the
 * presentational screens in src/screens/. Screens should treat all of this
 * as read-only data + callbacks -- no screen talks to src/fc, src/blackbox,
 * src/analysis or src/tuning directly.
 */
import type { Axis } from '../analysis/blackboxLog';
import type { DTermNoiseMetrics } from '../analysis/fftNoise';
import type { StepResponseResult } from '../analysis/stepResponse';
import type { TrackingStats } from '../analysis/tracking';
import type { AnalysisSummary } from '../tuning/analysisSummary';
import type { CompareResult } from '../tuning/compare';
import type { Recommendation, TuningReadiness } from '../tuning/engine';
import type { ApplyResult } from '../tuning/apply';
import type { ChecklistStep } from '../theme/components';

export type ScreenName =
  | 'waiting'
  | 'fcInfo'
  | 'analysis'
  | 'recommendation'
  | 'applying'
  | 'applied';

export interface FcSummary {
  craftName: string | null;
  versionRaw: string | null;
  boardTarget: string | null;
  pidProfile: number | null;
  blackboxStorage: string | null;
  blackboxUsedBytes: number | null;
  /** Number of prior flights already recorded for this exact physical FC
   * (identified by its hardware UID, not its craft name -- see
   * useTunerController.ts's readFcUid), so the user can see the app
   * recognized this quad rather than starting a fresh history. 0 for a
   * craft connected for the first time. */
  priorFlightCount: number;
}

export interface AxisPidSetup {
  p: number | null;
  i: number | null;
  d: number | null;
  f: number | null;
}

export interface CurrentTuneSetup {
  roll: AxisPidSetup;
  pitch: AxisPidSetup;
  yaw: AxisPidSetup;
  filters: {
    dtermLpf1Hz: number | null;
    dtermLpf2Hz: number | null;
    gyroLpf1Hz: number | null;
    gyroLpf2Hz: number | null;
  };
}

/** Raw values keyed by CLI parameter name (e.g. "p_roll"), as read live
 * from the FC -- the exact shape engine.ts/apply.ts already expect. */
export type CurrentPidValues = Record<string, number>;

export type ProcessingPhase = 'downloading' | 'decoding' | 'analyzing' | 'done' | 'error';

export interface ProcessingState {
  phase: ProcessingPhase;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  error: string | null;
}

export interface AxisChartData {
  stepResponse: StepResponseResult;
  dtermNoise: DTermNoiseMetrics;
  tracking: TrackingStats;
  gyroSpectrum: { freqHz: Float64Array; magnitudeDb: Float64Array };
}

export interface AnalysisResult {
  summary: AnalysisSummary;
  byAxis: Partial<Record<Extract<Axis, 'roll' | 'pitch'>, AxisChartData>>;
  recommendations: Recommendation[];
  readiness: TuningReadiness;
  comparison: CompareResult | null;
  previousSummary: AnalysisSummary | null;
}

export type ApplyPhase = 'idle' | 'running' | 'done' | 'error';

export interface ApplyState {
  phase: ApplyPhase;
  steps: ChecklistStep[];
  percent: number;
  result: ApplyResult | null;
  error: string | null;
}

export interface WaitingScreenProps {
  fcAttached: boolean;
  deviceLabel: string | null;
  connecting: boolean;
  connectError: string | null;
  onConnect: () => void;
}

export interface FcInfoScreenProps {
  fcSummary: FcSummary;
  processing: ProcessingState;
  onDownload: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
}

export interface AnalysisScreenProps {
  fcSummary: FcSummary;
  currentTune: CurrentTuneSetup;
  result: AnalysisResult;
  onExit: () => void;
  onGetRecommendation: () => void;
  onFinish: () => void;
}

export interface RecommendationScreenProps {
  recommendations: Recommendation[];
  confidencePct: number;
  /** Filter-category recommendations never carry a concrete currentValue
   * (engine.ts only produces a descriptive "lower by X%" hint for those --
   * see its module docstring). currentTune lets the screen still show the
   * real current filter Hz value next to that descriptive hint, without
   * inventing a computed value the engine never validated. */
  currentTune: CurrentTuneSetup;
  onCancel: () => void;
  onApply: () => void;
}

export interface ApplyingScreenProps {
  apply: ApplyState;
  onDone: () => void;
  onRetryReconnect: () => void;
}

export interface AppliedScreenProps {
  apply: ApplyState;
  onDone: () => void;
}
