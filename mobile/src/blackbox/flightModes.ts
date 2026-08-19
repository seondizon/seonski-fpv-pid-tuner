/** Decode Betaflight flight-mode flag bits. Ported from SmartTune CLI's
 * bbl_parser.py (see constants.ts for attribution).
 */
import { BF_MODE_FLAGS } from './constants';

export function decodeFlightModes(flags: number): string[] {
  const modes: string[] = [];
  for (const [bit, name] of Object.entries(BF_MODE_FLAGS)) {
    if (flags & (1 << Number(bit))) modes.push(name);
  }
  return modes;
}

export function getPrimaryMode(flags: number): string {
  if (!(flags & 1)) return 'DISARMED';
  if (flags & (1 << 1)) return 'ANGLE';
  if (flags & (1 << 2)) return 'HORIZON';
  if (flags & (1 << 15)) return 'FAILSAFE';
  return 'ACRO';
}
