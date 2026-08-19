/** CLI settable-parameter name compatibility across Betaflight firmware
 * versions 4.2 through the latest calendar-versioned release.
 *
 * Confirmed by diffing Betaflight's own source (src/main/cli/settings.c /
 * parameter_names.h) across tags 4.2.0, 4.3.0, 4.4.0, 4.5.0, and 2025.12+:
 * a handful of settings this project depends on were renamed partway
 * through that range. "Canonical" below always means the name used by the
 * CURRENT/latest firmware (and by the rest of this app's code, e.g.
 * engine.ts's Recommendation.parameter) -- LEGACY_ALIASES lists the older
 * name(s) to fall back to when the canonical name doesn't exist on the
 * connected FC.
 *
 * - `craft_name` replaced `name` at Betaflight 4.4.0.
 * - `dterm_lpf1_static_hz`/`dterm_lpf2_static_hz`/`gyro_lpf1_static_hz`/
 *   `gyro_lpf2_static_hz` replaced `dterm_lowpass_hz`/`dterm_lowpass2_hz`/
 *   `gyro_lowpass_hz`/`gyro_lowpass2_hz` at Betaflight 4.3.0.
 *
 * Every other CLI parameter this app uses (p/i/d/f_roll|pitch|yaw,
 * blackbox_device) has used the same name across the entire 4.2-latest
 * range and needs no alias entry.
 */
export const LEGACY_ALIASES: Record<string, string[]> = {
  craft_name: ['name'],
  dterm_lpf1_static_hz: ['dterm_lowpass_hz'],
  dterm_lpf2_static_hz: ['dterm_lowpass2_hz'],
  gyro_lpf1_static_hz: ['gyro_lowpass_hz'],
  gyro_lpf2_static_hz: ['gyro_lowpass2_hz'],
};

/** Betaflight's CLI wraps every rejected `get`/`set` in a line containing
 * one of these substrings, confirmed stable across 4.2-latest (the exact
 * "###ERROR..." wrapper text changed at 4.3.0, but "invalid name"/"invalid
 * value" themselves did not). A name that doesn't exist on the connected
 * firmware -- e.g. querying a renamed parameter under its old or new name --
 * reliably triggers "invalid name", which is what alias fallback keys off. */
export function looksLikeInvalidName(response: string): boolean {
  return response.toLowerCase().includes('invalid name');
}

export interface CliRunner {
  runCommand(command: string, timeoutMs?: number): Promise<string>;
}

/** Runs `get <canonicalName>`; if the FC reports the name doesn't exist,
 * retries with each known legacy alias in turn. Returns the actual CLI name
 * that worked plus its raw response text (so callers' existing value-
 * parsing regexes run unchanged against real command output), or null if
 * neither the canonical name nor any alias resolved. */
export async function resolveGetParam(
  client: CliRunner,
  canonicalName: string
): Promise<{ actualName: string; response: string } | null> {
  const candidates = [canonicalName, ...(LEGACY_ALIASES[canonicalName] ?? [])];
  for (const name of candidates) {
    const response = await client.runCommand(`get ${name}`);
    if (!looksLikeInvalidName(response)) {
      return { actualName: name, response };
    }
  }
  return null;
}

/** Writes `set <canonicalName> = <value>`; if the FC reports the name
 * doesn't exist, retries with each known legacy alias in turn. Always
 * returns the last attempted name/response pair, even if every candidate
 * failed -- unlike resolveGetParam, a write's caller (apply.ts) needs a
 * response to inspect either way (to distinguish "name doesn't exist on
 * this firmware" from "name existed but the value itself was rejected",
 * which stops alias-retrying immediately since that's not a naming
 * problem). Never silently treats the write as having succeeded. */
export async function resolveSetParam(
  client: CliRunner,
  canonicalName: string,
  value: number
): Promise<{ actualName: string; response: string }> {
  const candidates = [canonicalName, ...(LEGACY_ALIASES[canonicalName] ?? [])];
  let actualName = canonicalName;
  let response = '';
  for (const name of candidates) {
    response = await client.runCommand(`set ${name} = ${value}`);
    actualName = name;
    if (!looksLikeInvalidName(response)) break;
  }
  return { actualName, response };
}
