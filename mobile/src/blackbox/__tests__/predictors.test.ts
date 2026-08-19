import { applyPredictor } from '../predictors';
import type { BlackboxHeader } from '../header';

function fakeHeader(properties: Record<string, string> = {}): BlackboxHeader {
  return {
    product: '',
    dataVersion: 0,
    firmwareType: '',
    firmwareRevision: '',
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

test('PREDICTOR_0 returns the raw value unchanged', () => {
  expect(applyPredictor(0, 42, {}, 'x', {}, fakeHeader(), null)).toBe(42);
});

test('PREDICTOR_PREVIOUS adds the previous value', () => {
  expect(applyPredictor(1, 5, { x: 100 }, 'x', {}, fakeHeader(), null)).toBe(105);
});

test('PREDICTOR_STRAIGHT_LINE extrapolates 2*prev - prevPrev', () => {
  const result = applyPredictor(2, 0, { x: 10 }, 'x', {}, fakeHeader(), { x: 4 });
  expect(result).toBe(2 * 10 - 4);
});

test('PREDICTOR_AVERAGE_2 uses truncating division for negative sums', () => {
  // Confirmed against real hardware: C firmware truncates toward zero, so
  // (-3 + 0) / 2 = -1, not floor's -2.
  const result = applyPredictor(3, 0, { x: -3 }, 'x', {}, fakeHeader(), { x: 0 });
  expect(result).toBe(-1);
});

test('PREDICTOR_MINTHROTTLE adds the header minthrottle value', () => {
  const header = fakeHeader({ minthrottle: '1070' });
  expect(applyPredictor(4, 5, {}, 'x', {}, header, null)).toBe(1075);
});

test('PREDICTOR_MOTOR_0 reads motor[0] from allPrev, not prevValues', () => {
  const result = applyPredictor(5, 3, { 'motor[0]': 999 }, 'x', { 'motor[0]': 111 }, fakeHeader(), null);
  expect(result).toBe(114); // uses allPrev's 111, not prevValues' 999
});

test('PREDICTOR_INC adds 1 plus the raw value to the previous value', () => {
  expect(applyPredictor(6, 0, { x: 50 }, 'x', {}, fakeHeader(), null)).toBe(51);
});

test('PREDICTOR_1500 adds the constant 1500', () => {
  expect(applyPredictor(8, -20, {}, 'x', {}, fakeHeader(), null)).toBe(1480);
});

test('PREDICTOR_VBATREF adds the header vbatref value', () => {
  const header = fakeHeader({ vbatref: '420' });
  expect(applyPredictor(9, 5, {}, 'x', {}, header, null)).toBe(425);
});

test('PREDICTOR_LAST_MAIN_FRAME_TIME adds the previous loopIteration', () => {
  const result = applyPredictor(10, 3, { loopIteration: 200 }, 'x', {}, fakeHeader(), null);
  expect(result).toBe(203);
});

test('PREDICTOR_MINMOTOR reads the low value from motorOutput when present', () => {
  const header = fakeHeader({ motorOutput: '1000,2000', minthrottle: '1070' });
  expect(applyPredictor(11, 5, {}, 'x', {}, header, null)).toBe(1005);
});

test('PREDICTOR_MINMOTOR falls back to minthrottle when motorOutput is absent', () => {
  const header = fakeHeader({ minthrottle: '1070' });
  expect(applyPredictor(11, 5, {}, 'x', {}, header, null)).toBe(1075);
});
