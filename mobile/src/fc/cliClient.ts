/** Betaflight CLI-over-serial client.
 *
 * Ported from backend/app/fc/cli_client.py. Implements just enough of the
 * Betaflight CLI interaction to: enter/exit CLI mode, run an arbitrary
 * command and capture its text response, fetch the firmware version, and
 * back up config via `diff all` / `dump all`.
 *
 * SAFETY: `applyConfigLines` is the one method in this module that writes
 * config back to a flight controller. Config diffs/dumps are NOT portable
 * across Betaflight versions or hardware targets. This client never blindly
 * replays a captured config onto a possibly-different FC. See the
 * docstring on `applyConfigLines` for the exact rules enforced -- this
 * carries forward unchanged from the Python reference; do not weaken it for
 * convenience.
 */
import { SerialTransportError } from './errors';
import { BetaflightVersion, parseVersionFromCliBanner } from './version';
import { concatBytes, decodeUtf8, encodeUtf8 } from './bytes';

// Line prefixes that indicate a hardware/target-specific command. These must
// NEVER be replayed onto a potentially different board (different pinout,
// different timer/DMA layout, different motor/servo count/mapping).
const HARDWARE_SPECIFIC_PREFIXES = ['resource', 'timer', 'dma', 'motor', 'servo'];

export interface CliTransport {
  write(data: Uint8Array): Promise<void>;
  read(size: number, timeoutMs: number): Promise<Uint8Array>;
}

export interface ApplyConfigResult {
  applied: string[];
  skippedHardwareSpecific: string[];
  blockedVersionMismatch: boolean;
  rejected: Array<[string, string]>;
  linesRequiringReview: string[];
}

export class BetaflightCliClient {
  constructor(private readonly transport: CliTransport) {}

  /** Enter CLI mode from MSP/normal mode over the same serial port.
   *
   * Best-effort: Betaflight enters CLI mode when it receives "#\n". We send
   * that and then read/drain output until quiet or timeout. */
  async enterCli(): Promise<void> {
    await this.transport.write(encodeUtf8('#\n'));
    await this.readUntilQuiet(2000);
  }

  /** Leave CLI mode. Confirmed against a real Betaflight FC (STM32F411):
   * the FC's USB CDC-ACM connection can drop/reset as a direct result of
   * `exit`, so this is inherently best-effort -- a transport failure here
   * does not mean anything went wrong, and must not mask a result a caller
   * already obtained before calling exitCli() as cleanup. */
  async exitCli(): Promise<void> {
    try {
      await this.transport.write(encodeUtf8('exit\n'));
      await this.readUntilQuiet(1000);
    } catch (exc) {
      if (!(exc instanceof SerialTransportError)) throw exc;
    }
  }

  /** Read until no new bytes arrive for `quietPeriodMs`, or until
   * `timeoutMs` total elapses. Used to detect "the FC has finished
   * responding" without relying on an exact prompt string. */
  private async readUntilQuiet(timeoutMs: number = 3000, quietPeriodMs: number = 200): Promise<string> {
    const chunks: Uint8Array[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chunk = await this.transport.read(4096, quietPeriodMs);
      if (chunk.length > 0) {
        chunks.push(chunk);
      } else if (chunks.length > 0) {
        break;
      }
    }
    return decodeUtf8(concatBytes(chunks));
  }

  /** Send a single CLI command and return its full text response. */
  async runCommand(command: string, timeoutMs: number = 3000): Promise<string> {
    await this.transport.write(encodeUtf8(command + '\n'));
    return this.readUntilQuiet(timeoutMs);
  }

  /** Run `version` and parse the resulting banner text. */
  async getVersion(): Promise<BetaflightVersion | null> {
    const response = await this.runCommand('version');
    return parseVersionFromCliBanner(response);
  }

  /** Run `diff all` (preferred backup command: smaller, only non-default
   * values) and return the raw text output. */
  async dumpDiffAll(): Promise<string> {
    return this.runCommand('diff all', 5000);
  }

  /** Run `dump all` and return the raw text output. */
  async dumpAll(): Promise<string> {
    return this.runCommand('dump all', 5000);
  }

  /** Apply a previously-captured config (e.g. from dumpDiffAll) back onto a
   * flight controller -- SAFETY-CRITICAL.
   *
   * Rules enforced, in order:
   *
   * 1. Parse `configText` into individual lines. Any line whose first token
   *    is `resource`, `timer`, `dma`, `motor`, or `servo` is hardware/target
   *    -specific and is NEVER sent to the FC, regardless of version match.
   *    Collected into `skippedHardwareSpecific`.
   *
   * 2. If `detectedVersion` and `targetVersion` differ meaningfully --
   *    different (major, minor) for semver, different (year, month) for
   *    calver, or crossing the versioning-scheme boundary -- nothing is
   *    sent. Returns immediately with `blockedVersionMismatch=true` and all
   *    remaining non-hardware lines in `linesRequiringReview`, so a caller/
   *    UI can force explicit human review instead of auto-applying.
   *
   * 3. Only when versions match closely does this actually send each
   *    remaining `set` line via runCommand, and inspect the FC's response
   *    for an error indication. Lines the FC rejects are recorded in
   *    `rejected` -- expected, handled, not a crash.
   *
   * This embodies the project's core safety requirement: never blind-paste
   * a config diff across firmware versions. Do not weaken this behavior for
   * convenience. */
  async applyConfigLines(
    configText: string,
    detectedVersion: BetaflightVersion,
    targetVersion: BetaflightVersion
  ): Promise<ApplyConfigResult> {
    const applied: string[] = [];
    const skippedHardwareSpecific: string[] = [];
    const rejected: Array<[string, string]> = [];
    const linesRequiringReview: string[] = [];

    const settableLines: string[] = [];
    for (const rawLine of configText.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const firstToken = line.split(/\s+/)[0].toLowerCase();
      if (HARDWARE_SPECIFIC_PREFIXES.includes(firstToken)) {
        skippedHardwareSpecific.push(line);
        continue;
      }
      settableLines.push(line);
    }

    const versionMismatch = this.versionsDifferMeaningfully(detectedVersion, targetVersion);
    if (versionMismatch) {
      return {
        applied,
        skippedHardwareSpecific,
        blockedVersionMismatch: true,
        rejected,
        linesRequiringReview: settableLines,
      };
    }

    for (const line of settableLines) {
      if (!line.toLowerCase().startsWith('set ')) {
        linesRequiringReview.push(line);
        continue;
      }
      const response = await this.runCommand(line);
      if (this.looksLikeError(response)) {
        rejected.push([line, response.trim()]);
      } else {
        applied.push(line);
      }
    }

    return {
      applied,
      skippedHardwareSpecific,
      blockedVersionMismatch: false,
      rejected,
      linesRequiringReview,
    };
  }

  private versionsDifferMeaningfully(a: BetaflightVersion, b: BetaflightVersion): boolean {
    if (a.scheme !== b.scheme) return true;
    return a.major !== b.major || a.minor !== b.minor;
  }

  private looksLikeError(response: string): boolean {
    const lowered = response.toLowerCase();
    const errorMarkers = [
      'error in command',
      'unknown command',
      'invalid name',
      'invalid value',
      'out of range',
      'not found',
    ];
    return errorMarkers.some((marker) => lowered.includes(marker));
  }
}
