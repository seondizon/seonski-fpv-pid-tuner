import { getOrReconstructSetpoint } from '../setpoint';
import { buildTestLog } from '../testSupport/buildTestLog';
import type { Axis } from '../blackboxLog';

test('returns directly-logged setpoint as-is when present', () => {
  const direct = Float64Array.from([1, 2, 3]);
  const log = buildTestLog({ setpoint: { roll: direct } });
  expect(getOrReconstructSetpoint(log, 'roll')).toBe(direct);
});

test('reconstructs from axisP + gyro + header P gain when not logged directly', () => {
  const pTerm = Float64Array.from([10, 20, 30]);
  const gyro = Float64Array.from([1, 1, 1]);
  const log = buildTestLog({
    axisP: { roll: pTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    gyro: { roll: gyro, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    headers: { rollPID: '45,80,30' },
  });
  const result = getOrReconstructSetpoint(log, 'roll');
  const scale = 0.032029 * 45;
  expect(result[0]).toBeCloseTo(1 + 10 / scale, 10);
  expect(result[1]).toBeCloseTo(1 + 20 / scale, 10);
  expect(result[2]).toBeCloseTo(1 + 30 / scale, 10);
});

test('accepts the snake_case header key variant', () => {
  const pTerm = Float64Array.from([10]);
  const gyro = Float64Array.from([0]);
  const log = buildTestLog({
    axisP: { roll: pTerm, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    gyro: { roll: gyro, pitch: new Float64Array(0), yaw: new Float64Array(0) },
    headers: { roll_pid: '45,80,30' },
  });
  expect(() => getOrReconstructSetpoint(log, 'roll')).not.toThrow();
});

test('throws when no setpoint and no axisP data', () => {
  const log = buildTestLog();
  expect(() => getOrReconstructSetpoint(log, 'roll')).toThrow();
});

test('throws when P gain header is missing', () => {
  const log = buildTestLog({
    axisP: { roll: Float64Array.from([1]), pitch: new Float64Array(0), yaw: new Float64Array(0) },
    gyro: { roll: Float64Array.from([1]), pitch: new Float64Array(0), yaw: new Float64Array(0) },
  });
  expect(() => getOrReconstructSetpoint(log, 'roll')).toThrow();
});

test('throws when P gain is exactly zero', () => {
  const log = buildTestLog({
    axisP: { roll: Float64Array.from([1]), pitch: new Float64Array(0), yaw: new Float64Array(0) },
    gyro: { roll: Float64Array.from([1]), pitch: new Float64Array(0), yaw: new Float64Array(0) },
    headers: { rollPID: '0,80,30' },
  });
  expect(() => getOrReconstructSetpoint(log, 'roll')).toThrow();
});

test('throws on an invalid axis', () => {
  const log = buildTestLog();
  expect(() => getOrReconstructSetpoint(log, 'bogus' as Axis)).toThrow();
});
