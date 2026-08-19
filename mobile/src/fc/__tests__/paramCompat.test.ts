import { BetaflightCliClient } from '../cliClient';
import { looksLikeInvalidName, resolveGetParam } from '../paramCompat';
import { FakeSerialTransport } from '../testSupport/fakeSerialTransport';

test('looksLikeInvalidName matches Betaflight\'s error wrapper, case-insensitively', () => {
  expect(looksLikeInvalidName('###ERROR IN get: INVALID NAME###')).toBe(true);
  expect(looksLikeInvalidName('###ERROR: get: invalid name###')).toBe(true);
  expect(looksLikeInvalidName('dterm_lpf1_static_hz = 100')).toBe(false);
});

test('resolveGetParam uses the canonical name when it resolves', async () => {
  const transport = new FakeSerialTransport({ 'get dterm_lpf1_static_hz': 'dterm_lpf1_static_hz = 100\n' });
  const client = new BetaflightCliClient(transport);
  const result = await resolveGetParam(client, 'dterm_lpf1_static_hz');
  expect(result).toEqual({ actualName: 'dterm_lpf1_static_hz', response: 'dterm_lpf1_static_hz = 100\n' });
});

test('resolveGetParam falls back to a legacy alias when canonical is invalid', async () => {
  const transport = new FakeSerialTransport({
    'get dterm_lpf1_static_hz': '###ERROR IN get: INVALID NAME###\n',
    'get dterm_lowpass_hz': 'dterm_lowpass_hz = 100\n',
  });
  const client = new BetaflightCliClient(transport);
  const result = await resolveGetParam(client, 'dterm_lpf1_static_hz');
  expect(result).toEqual({ actualName: 'dterm_lowpass_hz', response: 'dterm_lowpass_hz = 100\n' });
});

test('resolveGetParam returns null when no candidate resolves', async () => {
  const transport = new FakeSerialTransport({
    'get dterm_lpf1_static_hz': '###ERROR IN get: INVALID NAME###\n',
    'get dterm_lowpass_hz': '###ERROR IN get: INVALID NAME###\n',
  });
  const client = new BetaflightCliClient(transport);
  expect(await resolveGetParam(client, 'dterm_lpf1_static_hz')).toBeNull();
});

test('resolveGetParam returns null immediately for a name with no known aliases', async () => {
  const transport = new FakeSerialTransport({ 'get p_roll': '###ERROR IN get: INVALID NAME###\n' });
  const client = new BetaflightCliClient(transport);
  expect(await resolveGetParam(client, 'p_roll')).toBeNull();
  expect(transport.sentCommands).toEqual(['get p_roll']);
});
