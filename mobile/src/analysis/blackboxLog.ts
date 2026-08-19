/** Builds the analysis-ready BlackboxLog shape directly from a decoded
 * BlackboxSegment (src/blackbox/decoder.ts), unlike the Python reference's
 * backend/app/blackbox/logdata.py, which parses this out of a
 * `blackbox_decode`-produced CSV. There's no CSV round trip on this side --
 * Phase 2's decoder already produces columnar data -- but the resulting
 * shape (axis-keyed roll/pitch/yaw dicts, zero-filled vs. absence-tracked
 * per field, throttle_pct derivation) is a deliberate match to logdata.py's,
 * since every analysis function ported from backend/app/analysis/* expects
 * exactly this shape.
 */
import type { BlackboxSegment } from '../blackbox/decoder';

export type Axis = 'roll' | 'pitch' | 'yaw';
export const AXES: readonly Axis[] = ['roll', 'pitch', 'yaw'];
const AXIS_INDEX: Record<Axis, number> = { roll: 0, pitch: 1, yaw: 2 };

export interface BlackboxLog {
  timeS: Float64Array;
  sampleRateHz: number;
  /** Absence-tracked (not zero-filled): only axes actually logged as a
   * direct `setpoint[i]` column are present here. Missing axes must be
   * reconstructed via setpoint.ts's getOrReconstructSetpoint. */
  setpoint: Partial<Record<Axis, Float64Array>>;
  gyro: Record<Axis, Float64Array>;
  axisP: Record<Axis, Float64Array>;
  axisI: Record<Axis, Float64Array>;
  axisD: Record<Axis, Float64Array>;
  axisF: Record<Axis, Float64Array>;
  throttlePct: Float64Array;
  headers: Record<string, string>;
  firmwareVersion: string | null;
}

function getColumn(columns: Record<string, number[]>, name: string): Float64Array | null {
  const col = columns[name];
  return col && col.length > 0 ? Float64Array.from(col) : null;
}

function buildAxisRecord(
  columns: Record<string, number[]>,
  prefixes: string[],
  length: number
): Record<Axis, Float64Array> {
  const result = {} as Record<Axis, Float64Array>;
  for (const axis of AXES) {
    let col: Float64Array | null = null;
    for (const prefix of prefixes) {
      col = getColumn(columns, `${prefix}[${AXIS_INDEX[axis]}]`);
      if (col) break;
    }
    result[axis] = col ?? new Float64Array(length);
  }
  return result;
}

function buildSetpointRecord(
  columns: Record<string, number[]>
): Partial<Record<Axis, Float64Array>> {
  const result: Partial<Record<Axis, Float64Array>> = {};
  for (const axis of AXES) {
    const col = getColumn(columns, `setpoint[${AXIS_INDEX[axis]}]`);
    if (col) result[axis] = col;
  }
  return result;
}

/** Ported from logdata.py's _compute_throttle_pct: rcCommand[3] can appear
 * in several different raw ranges depending on firmware/config, so the
 * range is inspected first to pick the right mapping to a 0-100 scale. */
function computeThrottlePct(rcCommand3: Float64Array | null): Float64Array {
  if (!rcCommand3 || rcCommand3.length === 0) return new Float64Array(0);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of rcCommand3) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Float64Array(rcCommand3.length);
  for (let i = 0; i < rcCommand3.length; i++) {
    const raw = rcCommand3[i];
    let pct: number;
    if (lo >= -1.5 && hi <= 1.5) {
      pct = lo < -0.01 ? ((raw + 1) / 2) * 100 : raw * 100;
    } else if (lo >= -0.5 && hi <= 100.5) {
      pct = raw;
    } else {
      pct = ((raw - 1000) / 1000) * 100;
    }
    out[i] = Math.min(100, Math.max(0, pct));
  }
  return out;
}

/** 1 / median(positive consecutive diffs), matching logdata.py exactly. */
function computeSampleRateHz(timeS: Float64Array): number {
  const diffs: number[] = [];
  for (let i = 1; i < timeS.length; i++) {
    const d = timeS[i] - timeS[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length % 2 === 0 ? (diffs[mid - 1] + diffs[mid]) / 2 : diffs[mid];
  return median > 0 ? 1 / median : 0;
}

/** Betaflight's raw `time` field is always microseconds (confirmed against
 * real hardware -- see the Phase 1 MSP validation), unlike
 * blackbox_decode's CSV output, which carries a unit suffix that
 * logdata.py has to detect. No unit detection is needed here since Phase
 * 2's decoder never converts units. */
export function buildBlackboxLog(segment: BlackboxSegment): BlackboxLog {
  const rawTime = getColumn(segment.columns, 'time');
  const n = rawTime ? rawTime.length : segment.frameCount;
  const timeS = new Float64Array(n);
  if (rawTime && rawTime.length > 0) {
    const t0 = rawTime[0];
    for (let i = 0; i < n; i++) timeS[i] = (rawTime[i] - t0) / 1e6;
  }

  return {
    timeS,
    sampleRateHz: computeSampleRateHz(timeS),
    setpoint: buildSetpointRecord(segment.columns),
    gyro: buildAxisRecord(segment.columns, ['gyroADC', 'gyroData'], n),
    axisP: buildAxisRecord(segment.columns, ['axisP'], n),
    axisI: buildAxisRecord(segment.columns, ['axisI'], n),
    axisD: buildAxisRecord(segment.columns, ['axisD'], n),
    axisF: buildAxisRecord(segment.columns, ['axisF'], n),
    throttlePct: computeThrottlePct(getColumn(segment.columns, 'rcCommand[3]')),
    headers: segment.header.properties,
    firmwareVersion: segment.header.firmwareRevision || null,
  };
}
