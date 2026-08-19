/** Safety-critical orchestration for writing approved tuning changes to a
 * flight controller.
 *
 * Ported from backend/app/tuning/apply.py.
 *
 * SAFETY: back up first, write only the approved changes, verify every
 * value was actually accepted BEFORE saving, and stop immediately --
 * without saving, without proceeding to further changes -- if anything
 * doesn't verify. A partially-applied, unverified tune must never be
 * persisted to flash. This module does NOT decide whether recommendations
 * are safe to apply in the first place (that's engine.ts's job, upstream
 * of this), and applying it against a real physical FC is always a
 * deliberate, explicit action gated at the UI layer -- never triggered
 * automatically.
 */
import type { BetaflightCliClient } from '../fc/cliClient';
import { resolveSetParam } from '../fc/paramCompat';
import type { Job } from '../jobs';
import type { Recommendation } from './engine';

const STEP_NAMES = [
  'Backup',
  'Writing settings',
  'Verifying',
  'Saving FC',
  'Rebooting',
  'Reconnecting',
  'Final verification',
];

const ERROR_MARKERS = [
  'error in command',
  'unknown command',
  'invalid name',
  'invalid value',
  'out of range',
  'not found',
];

function looksLikeError(response: string): boolean {
  const lowered = response.toLowerCase();
  return ERROR_MARKERS.some((marker) => lowered.includes(marker));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseGetValue(response: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, 'im');
  const match = pattern.exec(response);
  return match ? match[1].trim() : null;
}

/** `expected === null` (a filter-only/advisory recommendation with no
 * concrete numeric value -- see engine.ts) is always treated as a
 * mismatch, never a silent match: this module only ever applies concrete
 * numeric parameter changes, so a null proposedValue reaching here means
 * the caller passed something it shouldn't have. */
function valuesMatch(expected: number | null, actualText: string | null, tolerance: number = 1e-6): boolean {
  if (expected === null || actualText === null) return false;
  const actual = parseFloat(actualText);
  if (Number.isNaN(actual)) return false;
  return Math.abs(actual - expected) <= Math.max(tolerance, Math.abs(expected) * 0.01); // 1% relative tolerance
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ApplyResult {
  backupText: string;
  applied: string[];
  rejected: Array<[string, string]>;
  verificationMismatches: Array<[string, string, string]>;
  saved: boolean;
  reconnected: boolean | null; // null if reconnectFn wasn't given
  finalVerificationMismatches: Array<[string, string, string]>;
  aborted: boolean;
  abortReason: string | null;
}

/** Apply `recommendations` to the FC `cliClient` is already connected to
 * (must already be in CLI mode -- same calling convention as the rest of
 * this project's CliClient usage).
 *
 * `reconnectFn`, if given, is called repeatedly (up to reconnectTimeoutS,
 * polling every reconnectPollIntervalS) after the FC reboots, and should
 * attempt to open a fresh connection and return a new, already-in-CLI-mode
 * BetaflightCliClient, or null if the FC isn't back yet. This function
 * owns the retry loop; `reconnectFn` just owns "try once, right now." If
 * reconnectFn is omitted, the Reconnecting/Final verification steps are
 * marked done with detail "not attempted" and the caller is expected to
 * handle reconnection as a separate, later action.
 *
 * Stops immediately (without calling `save`) if ANY write is rejected or
 * ANY pre-save verification mismatches -- per the safety spec, a partial/
 * unverified tune must never be persisted to flash. */
export async function applyTuningChanges(
  cliClient: BetaflightCliClient,
  recommendations: Recommendation[],
  job: Job,
  reconnectFn?: () => Promise<BetaflightCliClient | null>,
  reconnectTimeoutS: number = 30.0,
  reconnectPollIntervalS: number = 2.0
): Promise<ApplyResult> {
  for (const name of STEP_NAMES) {
    if (!job.steps.some((s) => s.name === name)) {
      throw new Error(`job must be created with all apply steps, missing ${JSON.stringify(name)}`);
    }
  }

  const result: ApplyResult = {
    backupText: '',
    applied: [],
    rejected: [],
    verificationMismatches: [],
    saved: false,
    reconnected: null,
    finalVerificationMismatches: [],
    aborted: false,
    abortReason: null,
  };

  const abort = (stepName: string, reason: string): ApplyResult => {
    job.setStep(stepName, 'error', reason);
    result.aborted = true;
    result.abortReason = reason;
    return result;
  };

  // --- 1. Backup ---------------------------------------------------------
  job.setStep('Backup', 'in_progress');
  try {
    result.backupText = await cliClient.dumpDiffAll();
  } catch (exc) {
    return abort('Backup', `Could not back up current configuration: ${(exc as Error).message}`);
  }
  job.setStep('Backup', 'done');

  // --- 2. Writing settings -------------------------------------------------
  // Some parameter names were renamed by Betaflight partway through the
  // 4.2-latest version range this app supports (e.g. dterm/gyro filter
  // settings at 4.3.0) -- resolveSetParam retries under the older name if
  // the FC rejects the modern one as unknown, and reports back whichever
  // actual CLI name it used so the verify steps below query that same name,
  // not necessarily rec.parameter itself (see fc/paramCompat.ts).
  job.setStep('Writing settings', 'in_progress');
  const actualNameFor = new Map<string, string>();
  for (const rec of recommendations) {
    if (rec.proposedValue === null) {
      // Should never reach here -- the caller is responsible for only
      // passing recommendations with a concrete value (see engine.ts's
      // module doc on filter-category recs) -- but never write a
      // nonsensical "set X = null" if it does.
      result.rejected.push([rec.parameter, 'no concrete proposedValue to write']);
      continue;
    }
    const { actualName, response } = await resolveSetParam(cliClient, rec.parameter, rec.proposedValue);
    actualNameFor.set(rec.parameter, actualName);
    if (looksLikeError(response)) {
      result.rejected.push([rec.parameter, response.trim()]);
    } else {
      result.applied.push(rec.parameter);
    }
  }
  if (result.rejected.length > 0) {
    return abort(
      'Writing settings',
      `The FC rejected ${result.rejected.length} setting(s): ${result.rejected.map(([p]) => p).join(', ')}`
    );
  }
  job.setStep('Writing settings', 'done');

  // --- 3. Verifying (BEFORE saving) ---------------------------------------
  job.setStep('Verifying', 'in_progress');
  for (const rec of recommendations) {
    const actualName = actualNameFor.get(rec.parameter) ?? rec.parameter;
    const response = await cliClient.runCommand(`get ${actualName}`);
    const actualText = parseGetValue(response, actualName);
    if (!valuesMatch(rec.proposedValue, actualText)) {
      result.verificationMismatches.push([rec.parameter, String(rec.proposedValue), String(actualText)]);
    }
  }
  if (result.verificationMismatches.length > 0) {
    return abort(
      'Verifying',
      `${result.verificationMismatches.length} setting(s) did not verify after being written -- nothing was saved.`
    );
  }
  job.setStep('Verifying', 'done');

  // --- 4. Saving FC --------------------------------------------------------
  job.setStep('Saving FC', 'in_progress');
  await cliClient.runCommand('save', 2000); // FC reboots on save; a lack of response here is expected
  result.saved = true;
  job.setStep('Saving FC', 'done');

  // --- 5. Rebooting ----------------------------------------------------------
  // The FC's USB connection drops as a direct, expected result of `save`
  // rebooting the board (same behavior already confirmed for `exit` -- see
  // fc/cliClient.ts's exitCli() docstring). Nothing to actively do here
  // except mark the step and move on to reconnecting.
  job.setStep('Rebooting', 'done', 'FC is rebooting (USB disconnect expected)');

  // --- 6. Reconnecting ----------------------------------------------------
  if (!reconnectFn) {
    job.setStep('Reconnecting', 'done', 'not attempted (no reconnect function provided)');
    job.setStep('Final verification', 'done', 'not attempted');
    return result;
  }

  job.setStep('Reconnecting', 'in_progress');
  let newClient: BetaflightCliClient | null = null;
  const deadline = Date.now() + reconnectTimeoutS * 1000;
  while (Date.now() < deadline) {
    newClient = await reconnectFn();
    if (newClient !== null) break;
    await sleep(reconnectPollIntervalS * 1000);
  }

  if (newClient === null) {
    result.reconnected = false;
    job.setStep(
      'Reconnecting',
      'error',
      `FC did not reconnect within ${reconnectTimeoutS}s -- the tune was saved, but final verification could not run. Reconnect manually to confirm.`
    );
    job.setStep('Final verification', 'error', 'skipped (not reconnected)');
    return result;
  }

  result.reconnected = true;
  job.setStep('Reconnecting', 'done');

  // --- 7. Final verification -----------------------------------------------
  job.setStep('Final verification', 'in_progress');
  for (const rec of recommendations) {
    const actualName = actualNameFor.get(rec.parameter) ?? rec.parameter;
    const response = await newClient.runCommand(`get ${actualName}`);
    const actualText = parseGetValue(response, actualName);
    if (!valuesMatch(rec.proposedValue, actualText)) {
      result.finalVerificationMismatches.push([rec.parameter, String(rec.proposedValue), String(actualText)]);
    }
  }
  job.setStep(
    'Final verification',
    result.finalVerificationMismatches.length === 0 ? 'done' : 'error',
    result.finalVerificationMismatches.length === 0
      ? null
      : `${result.finalVerificationMismatches.length} mismatch(es) after reboot`
  );

  return result;
}

/** Step names to pass to createJob() for an apply-tune job -- exposed as a
 * function (not just a module-level array) so callers don't accidentally
 * mutate the shared array. */
export function applyJobStepNames(): string[] {
  return [...STEP_NAMES];
}
