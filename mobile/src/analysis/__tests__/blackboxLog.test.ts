import { buildBlackboxLog } from '../blackboxLog';
import type { BlackboxSegment } from '../../blackbox/decoder';
import type { BlackboxHeader } from '../../blackbox/header';

function fakeHeader(properties: Record<string, string> = {}): BlackboxHeader {
  return {
    product: '',
    dataVersion: 0,
    firmwareType: '',
    firmwareRevision: 'Betaflight 4.5.0',
    firmwareDate: '',
    boardInfo: '',
    craftName: '',
    iFieldDefs: [],
    pFieldDefs: [],
    sFieldDefs: [],
    properties,
    iInterval: 32,
    pRatio: 1,
  };
}

function fakeSegment(columns: Record<string, number[]>): BlackboxSegment {
  const n = columns.time?.length ?? 0;
  return {
    header: fakeHeader(),
    fieldNames: Object.keys(columns),
    columns,
    frameTypes: new Uint8Array(n),
    frameCount: n,
    events: [],
  };
}

test('derives timeS (normalized to 0) and sampleRateHz from the raw microsecond time column', () => {
  const time = [1_000_000, 1_001_000, 1_002_000, 1_003_000]; // 1ms steps -> 1000Hz
  const log = buildBlackboxLog(fakeSegment({ time }));
  expect(Array.from(log.timeS)).toEqual([0, 0.001, 0.002, 0.003]);
  expect(log.sampleRateHz).toBeCloseTo(1000, 6);
});

test('zero-fills gyro/axis fields for axes that were not logged', () => {
  const time = [0, 1000, 2000];
  const log = buildBlackboxLog(
    fakeSegment({
      time,
      'gyroADC[0]': [1, 2, 3],
      'gyroADC[1]': [4, 5, 6],
      // gyroADC[2] intentionally absent
      'axisP[0]': [10, 20, 30],
      'axisP[1]': [11, 21, 31],
      // axisP[2] intentionally absent, matching our real fixture's FC config
    })
  );
  expect(Array.from(log.gyro.roll)).toEqual([1, 2, 3]);
  expect(Array.from(log.gyro.pitch)).toEqual([4, 5, 6]);
  expect(Array.from(log.gyro.yaw)).toEqual([0, 0, 0]);
  expect(Array.from(log.axisP.yaw)).toEqual([0, 0, 0]);
});

test('setpoint is absence-tracked, not zero-filled', () => {
  const time = [0, 1000];
  const log = buildBlackboxLog(fakeSegment({ time, 'setpoint[0]': [5, 6] }));
  expect(log.setpoint.roll).toBeDefined();
  expect(Array.from(log.setpoint.roll!)).toEqual([5, 6]);
  expect(log.setpoint.pitch).toBeUndefined();
  expect(log.setpoint.yaw).toBeUndefined();
});

test('gyroData is accepted as a fallback name for gyroADC', () => {
  const time = [0, 1000];
  const log = buildBlackboxLog(fakeSegment({ time, 'gyroData[0]': [7, 8] }));
  expect(Array.from(log.gyro.roll)).toEqual([7, 8]);
});

describe('throttle_pct range detection', () => {
  test('normalized -1..1 range maps to 0..100', () => {
    const time = [0, 1000, 2000];
    const log = buildBlackboxLog(fakeSegment({ time, 'rcCommand[3]': [-1, 0, 1] }));
    expect(Array.from(log.throttlePct)).toEqual([0, 50, 100]);
  });

  test('normalized 0..1 range maps to 0..100', () => {
    const time = [0, 1000];
    const log = buildBlackboxLog(fakeSegment({ time, 'rcCommand[3]': [0, 1] }));
    expect(Array.from(log.throttlePct)).toEqual([0, 100]);
  });

  test('already-0-100 range passes through', () => {
    const time = [0, 1000];
    const log = buildBlackboxLog(fakeSegment({ time, 'rcCommand[3]': [0, 100] }));
    expect(Array.from(log.throttlePct)).toEqual([0, 100]);
  });

  test('raw RC pulse-width range (1000-2000) maps to 0..100', () => {
    const time = [0, 1000];
    const log = buildBlackboxLog(fakeSegment({ time, 'rcCommand[3]': [1000, 2000] }));
    expect(Array.from(log.throttlePct)).toEqual([0, 100]);
  });

  test('clamps out-of-range results to [0, 100]', () => {
    const time = [0, 1000];
    // pulse-width range, but a value below 1000 should clamp to 0, not go negative
    const log = buildBlackboxLog(fakeSegment({ time, 'rcCommand[3]': [900, 2100] }));
    expect(log.throttlePct[0]).toBe(0);
    expect(log.throttlePct[1]).toBe(100);
  });
});

test('carries forward firmwareVersion and headers', () => {
  const log = buildBlackboxLog(fakeSegment({ time: [0] }));
  expect(log.firmwareVersion).toBe('Betaflight 4.5.0');
});
