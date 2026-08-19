/** Betaflight version parsing and version-gated feature detection.
 *
 * Ported from backend/app/fc/version.py. Betaflight switched from semantic
 * versioning (4.x) to calendar versioning (YYYY.M.PATCH) in September 2025
 * (4.6 shipped as 2025.12.0). Any version comparison must handle both
 * schemes -- see the Python reference's docstring for the full rationale;
 * the scheme-rank-first ordering here is ported unchanged.
 */

const CALVER_YEAR_THRESHOLD = 2000;

export type VersionScheme = 'semver' | 'calver';

/** Maps a feature name to [scheme, componentA, componentB] meaning "first
 * available in this scheme's version componentA.componentB (or later, same
 * scheme)". scheme 'semver': componentA=major, componentB=minor. scheme
 * 'calver': componentA=year, componentB=month. */
export const FEATURE_MIN_VERSION: Record<string, [VersionScheme, number, number]> = {
  resource_syntax_v2: ['semver', 4, 5],
  tpa_low_rename: ['semver', 4, 5],
  pid_profile_count_4: ['semver', 4, 4],
  anti_gravity_p_gain: ['semver', 4, 4],
  save_noreboot: ['calver', 2025, 12],
};

export class BetaflightVersion {
  constructor(
    public readonly raw: string,
    public readonly scheme: VersionScheme,
    public readonly major: number,
    public readonly minor: number,
    public readonly patch: number
  ) {}

  /** Assumption (documented per spec): calver superseded semver in Sept
   * 2025, so ANY calver version is treated as newer than ANY semver 4.x
   * version, regardless of numeric component values -- encoded by comparing
   * a scheme rank first (0=semver, 1=calver), only falling back to
   * major/minor/patch when ranks match. */
  private sortKey(): [number, number, number, number] {
    const schemeRank = this.scheme === 'semver' ? 0 : 1;
    return [schemeRank, this.major, this.minor, this.patch];
  }

  private compare(other: BetaflightVersion): number {
    const a = this.sortKey();
    const b = other.sortKey();
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  lt(other: BetaflightVersion): boolean {
    return this.compare(other) < 0;
  }
  le(other: BetaflightVersion): boolean {
    return this.compare(other) <= 0;
  }
  gt(other: BetaflightVersion): boolean {
    return this.compare(other) > 0;
  }
  ge(other: BetaflightVersion): boolean {
    return this.compare(other) >= 0;
  }

  /** Returns true if this version is at or above the minimum version
   * recorded for `feature` in FEATURE_MIN_VERSION.
   *
   * Cross-scheme rule: since calver strictly supersedes semver, a calver
   * version always satisfies a semver-gated feature, and a semver (4.x)
   * version never satisfies a calver-gated feature.
   *
   * Throws if `feature` is not in FEATURE_MIN_VERSION -- callers should
   * treat unknown feature names as a programming error, not a silent
   * false. */
  supportsFeature(feature: string): boolean {
    const entry = FEATURE_MIN_VERSION[feature];
    if (!entry) {
      throw new Error(`Unknown feature: ${feature}`);
    }
    const [featureScheme, featA, featB] = entry;
    if (featureScheme !== this.scheme) {
      return this.scheme === 'calver';
    }
    return this.major > featA || (this.major === featA && this.minor >= featB);
  }
}

const VERSION_COMPONENTS_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse a version string like "4.5.0" (semver) or "2025.12.0" (calver).
 *
 * Heuristic: if the first numeric component is >= CALVER_YEAR_THRESHOLD
 * (2000), treat the string as calver (year.month.patch); otherwise treat it
 * as semver. Throws on unparseable input. */
export function parseBetaflightVersion(versionString: string): BetaflightVersion {
  const trimmed = versionString.trim();
  const match = VERSION_COMPONENTS_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Could not parse Betaflight version string "${versionString}": expected a dotted 'X.Y.Z' form (semver e.g. '4.5.0' or calver e.g. '2025.12.0')`
    );
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const scheme: VersionScheme = a >= CALVER_YEAR_THRESHOLD ? 'calver' : 'semver';
  return new BetaflightVersion(trimmed, scheme, a, b, c);
}

// Matches a dotted X.Y.Z version token anywhere in free text, e.g. within a
// CLI `version` banner such as:
//   "# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 (abcdef1234) MSP API: 1.45"
//   "# Betaflight / STM32F405 2025.12.0 Dec 10 2025 / 09:00:00 (0123456789) MSP API: 1.47"
const BANNER_VERSION_RE = /\b(\d{1,4}\.\d{1,2}\.\d{1,3})\b/;

/** Extract a Betaflight version from a CLI `version` command's banner text.
 * Returns null (never throws) if no plausible version pattern is found. */
export function parseVersionFromCliBanner(bannerText: string): BetaflightVersion | null {
  if (!bannerText) return null;
  const match = BANNER_VERSION_RE.exec(bannerText);
  if (!match) return null;
  try {
    return parseBetaflightVersion(match[1]);
  } catch {
    return null;
  }
}
