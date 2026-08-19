/** Ported from backend/app/analysis/setpoint.py. */
import { Axis, AXES, BlackboxLog } from './blackboxLog';

/** PID-Analyzer legacy constant relating a logged P-term to the setpoint
 * it was driving toward -- version-specific, not a physical constant. Only
 * used when setpoint wasn't logged directly and must be reconstructed. */
const LEGACY_P_SCALE = 0.032029;

function parsePGain(headers: Record<string, string>, axis: Axis): number | null {
  for (const key of [`${axis}PID`, `${axis}_pid`]) {
    const value = headers[key];
    if (!value) continue;
    const p = parseFloat(value.split(',')[0]);
    if (!Number.isNaN(p)) return p;
  }
  return null;
}

/** Returns the directly-logged setpoint for `axis` if present, otherwise
 * reconstructs it from the axis's P-term and gyro data using the header's
 * P gain. Throws if axis is invalid, or if reconstruction isn't possible
 * (missing P-term/gyro data, or no parseable P-gain header, or a P gain of
 * exactly 0). */
export function getOrReconstructSetpoint(log: BlackboxLog, axis: Axis): Float64Array {
  if (!AXES.includes(axis)) {
    throw new Error(`Invalid axis: ${axis}`);
  }

  const direct = log.setpoint[axis];
  if (direct && direct.length > 0) return direct;

  const pTerm = log.axisP[axis];
  if (!pTerm || pTerm.length === 0) {
    throw new Error(`No setpoint logged and no axisP data for axis ${axis} to reconstruct it`);
  }
  const gyro = log.gyro[axis];
  if (!gyro || gyro.length === 0) {
    throw new Error(`No setpoint logged and no gyro data for axis ${axis} to reconstruct it`);
  }

  const pGain = parsePGain(log.headers, axis);
  if (pGain === null) {
    throw new Error(`No setpoint logged and no P-gain header found for axis ${axis} to reconstruct it`);
  }
  if (pGain === 0) {
    throw new Error(`P gain for axis ${axis} is zero, cannot reconstruct setpoint`);
  }

  const n = Math.min(pTerm.length, gyro.length);
  const out = new Float64Array(n);
  const scale = LEGACY_P_SCALE * pGain;
  for (let i = 0; i < n; i++) out[i] = gyro[i] + pTerm[i] / scale;
  return out;
}
