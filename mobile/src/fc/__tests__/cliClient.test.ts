import { BetaflightCliClient } from '../cliClient';
import { parseBetaflightVersion } from '../version';
import { FakeSerialTransport, RaisingOnExitTransport } from '../testSupport/fakeSerialTransport';

test('applyConfigLines blocks on version mismatch', async () => {
  const transport = new FakeSerialTransport();
  const client = new BetaflightCliClient(transport);

  const detected = parseBetaflightVersion('4.3.0');
  const target = parseBetaflightVersion('4.5.0');

  const configText = 'set gyro_lpf1_static_hz = 250\nresource MOTOR 1 A08\n';
  const result = await client.applyConfigLines(configText, detected, target);

  expect(result.blockedVersionMismatch).toBe(true);
  expect(result.applied).toEqual([]);
  expect(transport.sentCommands).toEqual([]);
  expect(result.skippedHardwareSpecific.some((line) => line.includes('resource'))).toBe(true);
  expect(result.linesRequiringReview.some((line) => line.includes('gyro_lpf1_static_hz'))).toBe(true);
});

test('applyConfigLines blocks on scheme crossing', async () => {
  const transport = new FakeSerialTransport();
  const client = new BetaflightCliClient(transport);

  const detected = parseBetaflightVersion('4.5.0');
  const target = parseBetaflightVersion('2025.12.0');

  const result = await client.applyConfigLines('set foo = 1\n', detected, target);
  expect(result.blockedVersionMismatch).toBe(true);
  expect(transport.sentCommands).toEqual([]);
});

test('applyConfigLines skips hardware-specific lines and sends set lines', async () => {
  const transport = new FakeSerialTransport({
    'set gyro_lpf1_static_hz = 250': 'gyro_lpf1_static_hz set to 250',
  });
  const client = new BetaflightCliClient(transport);

  const sameVersionA = parseBetaflightVersion('4.5.0');
  const sameVersionB = parseBetaflightVersion('4.5.2'); // same major.minor -> matches

  const configText = 'resource MOTOR 1 A08\nset gyro_lpf1_static_hz = 250\ntimer A08 AF3\n';
  const result = await client.applyConfigLines(configText, sameVersionA, sameVersionB);

  expect(result.blockedVersionMismatch).toBe(false);
  expect(result.applied).toContain('set gyro_lpf1_static_hz = 250');
  expect(result.skippedHardwareSpecific).toContain('resource MOTOR 1 A08');
  expect(result.skippedHardwareSpecific).toContain('timer A08 AF3');

  expect(transport.sentCommands.some((cmd) => cmd.includes('resource'))).toBe(false);
  expect(transport.sentCommands.some((cmd) => cmd.startsWith('timer'))).toBe(false);
  expect(transport.sentCommands).toContain('set gyro_lpf1_static_hz = 250');
});

test('applyConfigLines records FC rejections', async () => {
  const transport = new FakeSerialTransport({ 'set bogus_param = 1': 'ERROR IN COMMAND bogus_param' });
  const client = new BetaflightCliClient(transport);
  const v = parseBetaflightVersion('4.5.0');

  const result = await client.applyConfigLines('set bogus_param = 1\n', v, v);

  expect(result.blockedVersionMismatch).toBe(false);
  expect(result.applied).toEqual([]);
  expect(result.rejected).toHaveLength(1);
  const [rejectedLine, errorText] = result.rejected[0];
  expect(rejectedLine).toBe('set bogus_param = 1');
  expect(errorText).toContain('ERROR IN COMMAND');
});

test('getVersion uses CLI banner parsing', async () => {
  const banner = '# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 (abcdef1234) MSP API: 1.45';
  const transport = new FakeSerialTransport({ version: banner });
  const client = new BetaflightCliClient(transport);

  const version = await client.getVersion();
  expect(version).not.toBeNull();
  expect(version!.raw).toBe('4.5.0');
  expect(version!.scheme).toBe('semver');
});

test('exitCli swallows transport error', async () => {
  // Regression test: found against a real Betaflight FC -- its USB CDC-ACM
  // connection can drop/reset as a direct result of `exit`, which must not
  // be treated as a failure.
  const client = new BetaflightCliClient(new RaisingOnExitTransport());
  await expect(client.exitCli()).resolves.toBeUndefined();
});
