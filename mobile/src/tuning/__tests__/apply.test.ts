import { BetaflightCliClient } from '../../fc/cliClient';
import { createJob } from '../../jobs';
import { applyJobStepNames, applyTuningChanges } from '../apply';
import { FakeSerialTransport } from '../../fc/testSupport/fakeSerialTransport';
import type { Recommendation } from '../engine';

function fakeRecommendation(parameter: string, proposedValue: number): Recommendation {
  return {
    parameter,
    axis: 'roll',
    currentValue: null,
    proposedValue,
    changePct: 0,
    reason: '',
    confidencePct: 80,
    category: 'roll',
  };
}

function makeClient(responses: Record<string, string>): { client: BetaflightCliClient; transport: FakeSerialTransport } {
  const transport = new FakeSerialTransport(responses);
  return { client: new BetaflightCliClient(transport), transport };
}

function job() {
  return createJob(applyJobStepNames());
}

test('happy path with no reconnect function', async () => {
  const recs = [fakeRecommendation('d_roll', 42), fakeRecommendation('p_roll', 46)];
  const { client, transport } = makeClient({
    'diff all': 'set d_roll = 38\nset p_roll = 45\n',
    'set d_roll = 42': 'd_roll set to 42\n',
    'set p_roll = 46': 'p_roll set to 46\n',
    'get d_roll': 'd_roll = 42\n',
    'get p_roll': 'p_roll = 46\n',
    save: 'Saving settings\n',
  });
  const j = job();
  const result = await applyTuningChanges(client, recs, j);

  expect(result.aborted).toBe(false);
  expect(result.applied).toEqual(['d_roll', 'p_roll']);
  expect(result.rejected).toEqual([]);
  expect(result.verificationMismatches).toEqual([]);
  expect(result.saved).toBe(true);
  expect(result.reconnected).toBeNull();
  expect(j.toSnapshot().steps[5].detail).toBe('not attempted (no reconnect function provided)');
  void transport;
});

test('a recommendation with no concrete proposedValue is rejected, never written as "= null"', async () => {
  const recs = [fakeRecommendation('dterm_lpf1_static_hz', null as unknown as number)];
  const { client, transport } = makeClient({ 'diff all': '# diff all\n' });
  const j = job();
  const result = await applyTuningChanges(client, recs, j);

  expect(result.aborted).toBe(true);
  expect(result.saved).toBe(false);
  expect(result.rejected).toEqual([['dterm_lpf1_static_hz', 'no concrete proposedValue to write']]);
  expect(transport.sentCommands.some((c) => c.includes('null'))).toBe(false);
});

test('aborts on a rejected write and does not save', async () => {
  const recs = [fakeRecommendation('bogus_param', 99)];
  const { client, transport } = makeClient({
    'diff all': '# diff all\n',
    'set bogus_param = 99': 'ERROR IN COMMAND\n',
  });
  const j = job();
  const result = await applyTuningChanges(client, recs, j);

  expect(result.aborted).toBe(true);
  expect(result.saved).toBe(false);
  expect(result.rejected).toHaveLength(1);
  expect(transport.sentCommands).not.toContain('save');
});

test('aborts on a verification mismatch and does not save', async () => {
  const recs = [fakeRecommendation('d_roll', 42)];
  const { client, transport } = makeClient({
    'diff all': '# diff all\n',
    'set d_roll = 42': 'd_roll set to 42\n',
    'get d_roll': 'd_roll = 38\n', // FC reports the OLD value -- didn't actually take
  });
  const j = job();
  const result = await applyTuningChanges(client, recs, j);

  expect(result.aborted).toBe(true);
  expect(result.saved).toBe(false);
  expect(result.verificationMismatches).toEqual([['d_roll', '42', '38']]);
  expect(transport.sentCommands).not.toContain('save');
});

test('reconnect succeeds after retries', async () => {
  const recs = [fakeRecommendation('d_roll', 42)];
  const { client } = makeClient({
    'diff all': '# diff all\n',
    'set d_roll = 42': 'ok\n',
    'get d_roll': 'd_roll = 42\n',
    save: 'Saving settings\n',
  });
  const j = job();

  let attempts = 0;
  const reconnectFn = async () => {
    attempts += 1;
    if (attempts < 3) return null; // FC not back yet
    return makeClient({ 'get d_roll': 'd_roll = 42\n' }).client;
  };

  const result = await applyTuningChanges(client, recs, j, reconnectFn, 30, 0.01);

  expect(result.reconnected).toBe(true);
  expect(result.finalVerificationMismatches).toEqual([]);
  expect(attempts).toBe(3);
});

test('reconnect timeout is reported but does not crash', async () => {
  const recs = [fakeRecommendation('d_roll', 42)];
  const { client } = makeClient({
    'diff all': '# diff all\n',
    'set d_roll = 42': 'ok\n',
    'get d_roll': 'd_roll = 42\n',
    save: 'Saving settings\n',
  });
  const j = job();

  const result = await applyTuningChanges(client, recs, j, async () => null, 0.05, 0.02);

  expect(result.reconnected).toBe(false);
  expect(result.saved).toBe(true); // the save DID happen -- only reconnect/final-verify failed
  expect(j.toSnapshot().steps[5].status).toBe('error');
});

test('falls back to a legacy CLI name when the FC rejects the modern one, and verifies against that same name', async () => {
  // Reproduces a pre-4.3.0 Betaflight FC: it doesn't know
  // dterm_lpf1_static_hz (renamed at 4.3.0), only the older
  // dterm_lowpass_hz -- the write, pre-save verify, and post-reboot final
  // verify must all consistently use whichever name actually worked.
  const recs = [fakeRecommendation('dterm_lpf1_static_hz', 90)];
  const { client } = makeClient({
    'diff all': '# diff all\n',
    'set dterm_lpf1_static_hz = 90': '###ERROR IN set: INVALID NAME###\n',
    'set dterm_lowpass_hz = 90': 'dterm_lowpass_hz set to 90\n',
    'get dterm_lowpass_hz': 'dterm_lowpass_hz = 90\n',
    save: 'Saving settings\n',
  });
  const j = job();

  const reconnectFn = async () => makeClient({ 'get dterm_lowpass_hz': 'dterm_lowpass_hz = 90\n' }).client;
  const result = await applyTuningChanges(client, recs, j, reconnectFn, 30, 0.01);

  expect(result.aborted).toBe(false);
  expect(result.applied).toEqual(['dterm_lpf1_static_hz']);
  expect(result.verificationMismatches).toEqual([]);
  expect(result.finalVerificationMismatches).toEqual([]);
  expect(result.saved).toBe(true);
});

test('a real out-of-range value is rejected under the modern name, without masking it as a naming problem', async () => {
  // The modern name DOES exist on this FC -- resolveSetParam must not
  // alias-retry past a genuine "invalid value" rejection.
  const recs = [fakeRecommendation('dterm_lpf1_static_hz', 99999)];
  const { client, transport } = makeClient({
    'diff all': '# diff all\n',
    'set dterm_lpf1_static_hz = 99999': '###ERROR IN set: INVALID VALUE###\n',
  });
  const j = job();
  const result = await applyTuningChanges(client, recs, j);

  expect(result.aborted).toBe(true);
  expect(result.saved).toBe(false);
  expect(transport.sentCommands).not.toContain('set dterm_lowpass_hz = 99999');
});

test('final verification mismatch after reconnect is flagged but not aborted', async () => {
  // Per the safety spec, there's no "undo" for a save after the fact -- but
  // a post-reboot mismatch must still be visibly reported, not silently
  // swallowed as success.
  const recs = [fakeRecommendation('d_roll', 42)];
  const { client } = makeClient({
    'diff all': '# diff all\n',
    'set d_roll = 42': 'ok\n',
    'get d_roll': 'd_roll = 42\n',
    save: 'Saving settings\n',
  });
  const j = job();

  const reconnectFn = async () => makeClient({ 'get d_roll': 'd_roll = 38\n' }).client; // reverted somehow after reboot

  const result = await applyTuningChanges(client, recs, j, reconnectFn, 30, 0.01);

  expect(result.reconnected).toBe(true);
  expect(result.finalVerificationMismatches).toEqual([['d_roll', '42', '38']]);
  expect(j.toSnapshot().steps[6].status).toBe('error');
});
