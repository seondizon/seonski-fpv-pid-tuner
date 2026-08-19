/** Craft name, PID profile, and Blackbox storage type detection.
 *
 * Ported from backend/app/fc/info.py, then hardened for cross-version
 * compatibility (Betaflight 4.2 through the latest calendar-versioned
 * release) after live-hardware testing surfaced two real bugs, confirmed
 * against Betaflight's own source:
 *
 * 1. `name` was renamed to `craft_name` at Betaflight 4.4.0 -- querying the
 *    wrong one for a given firmware version returns an "INVALID NAME"
 *    error, not the craft name. Fixed via resolveGetParam's alias fallback
 *    (see paramCompat.ts).
 * 2. `status` has NEVER printed the active PID profile in any Betaflight
 *    4.2-latest release (confirmed by reading cliStatus()'s source at
 *    multiple tags) -- the original regex here was based on a mistaken
 *    assumption and could only ever match by accident. The actual, stable
 *    source of this value across the whole range is the dedicated
 *    `profile` command (no arguments), which replies `profile <N>`.
 */
import { BetaflightCliClient } from './cliClient';
import { resolveGetParam } from './paramCompat';

// Betaflight's `get <name>` output looks like:
//     name = Chimera7
// possibly followed by blank lines or an "Allowed range"/help line depending
// on version. This matches the first "key = value" style line and captures
// everything after '=' up to end of line.
const GET_VALUE_PATTERN = /^\s*(\S+)\s*=\s*(.*?)\s*$/gm;

function parseGetValue(response: string, key: string): string | null {
  GET_VALUE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GET_VALUE_PATTERN.exec(response)) !== null) {
    if (match[1].toLowerCase() === key.toLowerCase()) {
      const value = match[2].trim();
      return value || null;
    }
  }
  return null;
}

/** Run `get craft_name` (falling back to the pre-4.4.0 name `name`) and
 * return the craft name, or null if it's unset (empty) or the response
 * couldn't be parsed -- an unset craft name is normal, not an error. */
export async function getCraftName(cliClient: BetaflightCliClient): Promise<string | null> {
  const resolved = await resolveGetParam(cliClient, 'craft_name');
  if (!resolved) return null;
  return parseGetValue(resolved.response, resolved.actualName);
}

/** Run `get blackbox_device` and return one of SPIFLASH/SDCARD/SERIAL/NONE,
 * or null if it can't be determined. If the FC returns a value outside that
 * known set, still return the raw (uppercased) value rather than silently
 * mapping it to a guess. */
export async function getBlackboxStorageType(cliClient: BetaflightCliClient): Promise<string | null> {
  const response = await cliClient.runCommand('get blackbox_device');
  const value = parseGetValue(response, 'blackbox_device');
  return value ? value.toUpperCase() : null;
}

// `profile` (no arguments) replies e.g. "profile 2" -- confirmed byte-
// identical across Betaflight 4.2.0 through the latest calver release
// (unlike `status`, which has never included this and whose wording drifts
// across versions for its own, unrelated fields).
const PID_PROFILE_PATTERN = /profile\s+(\d+)/i;

/** Best-effort: run `profile` and parse the active PID profile index from
 * its reply. Returns null (never a guessed default) if the pattern can't
 * be found. */
export async function getPidProfileIndex(cliClient: BetaflightCliClient): Promise<number | null> {
  const response = await cliClient.runCommand('profile');
  const match = PID_PROFILE_PATTERN.exec(response);
  if (!match) return null;
  return parseInt(match[1], 10);
}
