import { decodeFlightModes, getPrimaryMode } from '../flightModes';

test('decodeFlightModes lists every set flag by name', () => {
  const flags = (1 << 0) | (1 << 1) | (1 << 15); // ARM | ANGLE | FAILSAFE
  expect(decodeFlightModes(flags)).toEqual(['ARM', 'ANGLE', 'FAILSAFE']);
});

test('decodeFlightModes returns an empty list for no flags set', () => {
  expect(decodeFlightModes(0)).toEqual([]);
});

test('getPrimaryMode: disarmed when the ARM bit is clear', () => {
  expect(getPrimaryMode(0)).toBe('DISARMED');
});

test('getPrimaryMode: ANGLE takes priority when armed and angle is set', () => {
  const flags = 1 | (1 << 1);
  expect(getPrimaryMode(flags)).toBe('ANGLE');
});

test('getPrimaryMode: FAILSAFE reported when armed with neither angle nor horizon', () => {
  const flags = 1 | (1 << 15);
  expect(getPrimaryMode(flags)).toBe('FAILSAFE');
});

test('getPrimaryMode: ANGLE takes priority over FAILSAFE when both are set', () => {
  // Matches the ordering in the Python reference this was ported from --
  // ANGLE/HORIZON are checked before FAILSAFE.
  const flags = 1 | (1 << 1) | (1 << 15);
  expect(getPrimaryMode(flags)).toBe('ANGLE');
});

test('getPrimaryMode: ACRO when armed with no other relevant flags', () => {
  expect(getPrimaryMode(1)).toBe('ACRO');
});
