"""Betaflight version parsing and version-gated feature detection.

Betaflight switched from semantic versioning (``4.x``) to calendar
versioning (``YYYY.M.PATCH``) in September 2025 (4.6 shipped as
``2025.12.0``). Any version comparison in this codebase must handle both
schemes -- a naive numeric-major-version comparison silently breaks across
that boundary (e.g. treating "2025" as an enormous major version number
would make every calver release compare as "newer" than any semver release,
which happens to be correct, but treating it as "major=2025, minor=12" and
comparing tuples against a semver "major=4, minor=5" is comparing two
different units and is only safe because 2025 > 4; the code below makes
this comparison an explicit, documented rule rather than an accident).

See docs/research/reference-analysis.md section 2 and
docs/research/tuning-algorithms.md ("Safety Strategies") for the concrete
version-gated hazards this module encodes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Heuristic threshold for distinguishing calver from semver by the first
# version component. Betaflight semver majors have only ever gone 1-4;
# calver years start at 2025. 2000 is a safe, generous cutoff.
_CALVER_YEAR_THRESHOLD = 2000

# Small hardcoded table of version-gated features referenced in
# docs/research/reference-analysis.md. Each entry maps a feature name to
# (scheme, component_a, component_b) meaning "first available in this
# scheme's version component_a.component_b (or later, same scheme)".
#   - scheme == 'semver': component_a = major, component_b = minor
#   - scheme == 'calver':  component_a = year,  component_b = month
FEATURE_MIN_VERSION: dict[str, tuple[str, int, int]] = {
    # Soft-serial `resource` CLI syntax was renamed (breaking change) in 4.5.
    "resource_syntax_v2": ("semver", 4, 5),
    # TPA-low variables were renamed in 4.5 (e.g. tpa_breakpoint handling).
    "tpa_low_rename": ("semver", 4, 5),
    # PID/rate profile count dropped from 6 to 4, and TPA folded into the
    # PID profile, in 4.4.
    "pid_profile_count_4": ("semver", 4, 4),
    # anti_gravity_p_gain was added in 4.4.
    "anti_gravity_p_gain": ("semver", 4, 4),
    # `save noreboot` CLI variant only exists from 2025.12+ (calver).
    "save_noreboot": ("calver", 2025, 12),
}


@dataclass
class BetaflightVersion:
    raw: str
    scheme: str  # 'semver' | 'calver'
    major: int  # semver: major (e.g. 4); calver: year (e.g. 2025)
    minor: int  # semver: minor (e.g. 5); calver: month (e.g. 12)
    patch: int

    def _as_sort_key(self) -> tuple[int, int, int, int, int]:
        """Return a tuple that sorts correctly both within a scheme and
        across the semver->calver boundary.

        Assumption (documented per spec): calver superseded semver in Sept
        2025, so ANY calver version is treated as newer than ANY semver 4.x
        version, regardless of numeric component values. We encode this by
        prefixing with a scheme rank (0 for semver, 1 for calver) so cross-
        scheme comparisons always resolve via that rank first, and only fall
        back to comparing major/minor/patch when ranks match (i.e. within
        the same scheme).
        """
        scheme_rank = 0 if self.scheme == "semver" else 1
        return (scheme_rank, self.major, self.minor, self.patch, 0)

    def __lt__(self, other: "BetaflightVersion") -> bool:
        return self._as_sort_key() < other._as_sort_key()

    def __le__(self, other: "BetaflightVersion") -> bool:
        return self._as_sort_key() <= other._as_sort_key()

    def __gt__(self, other: "BetaflightVersion") -> bool:
        return self._as_sort_key() > other._as_sort_key()

    def __ge__(self, other: "BetaflightVersion") -> bool:
        return self._as_sort_key() >= other._as_sort_key()

    def supports_feature(self, feature: str) -> bool:
        """Return True if this version is at or above the minimum version
        recorded for `feature` in FEATURE_MIN_VERSION.

        Comparison rule when the feature's declared scheme differs from this
        version's own scheme: since calver strictly supersedes semver
        (Sept 2025 cutover), a calver version always satisfies a
        semver-gated feature (it's unambiguously newer), and a semver (4.x)
        version never satisfies a calver-gated feature (it's unambiguously
        older / predates calver's existence). This mirrors the same
        scheme-rank-first ordering used by `_as_sort_key`.

        Raises KeyError if `feature` is not in FEATURE_MIN_VERSION -- callers
        should treat unknown feature names as a programming error, not a
        silent False.
        """
        feature_scheme, feat_a, feat_b = FEATURE_MIN_VERSION[feature]

        if feature_scheme != self.scheme:
            # Cross-scheme: calver is always newer than semver.
            return self.scheme == "calver"

        if self.scheme == "semver":
            return (self.major, self.minor) >= (feat_a, feat_b)
        else:  # calver
            return (self.major, self.minor) >= (feat_a, feat_b)


_VERSION_COMPONENTS_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def parse_betaflight_version(version_string: str) -> BetaflightVersion:
    """Parse a version string like "4.5.0" (semver) or "2025.12.0" (calver).

    Heuristic: if the first numeric component is >= `_CALVER_YEAR_THRESHOLD`
    (2000), treat the string as calver (year.month.patch); otherwise treat
    it as semver (major.minor.patch). Betaflight semver majors never
    exceeded single digits, and calver years start at 2025, so this
    threshold cleanly separates the two schemes with no ambiguous overlap.

    Raises ValueError on unparseable input.
    """
    version_string = version_string.strip()
    match = _VERSION_COMPONENTS_RE.match(version_string)
    if not match:
        raise ValueError(
            f"Could not parse Betaflight version string {version_string!r}: "
            "expected a dotted 'X.Y.Z' form (semver e.g. '4.5.0' or "
            "calver e.g. '2025.12.0')"
        )
    a, b, c = (int(g) for g in match.groups())
    scheme = "calver" if a >= _CALVER_YEAR_THRESHOLD else "semver"
    return BetaflightVersion(raw=version_string, scheme=scheme, major=a, minor=b, patch=c)


# Matches a dotted X.Y.Z version token anywhere in free text, e.g. within a
# CLI `version` banner such as:
#   "# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 (abcdef1234) MSP API: 1.45"
#   "# Betaflight / STM32F405 2025.12.0 Dec 10 2025 / 09:00:00 (0123456789) MSP API: 1.47"
_BANNER_VERSION_RE = re.compile(r"\b(\d{1,4}\.\d{1,2}\.\d{1,3})\b")


def parse_version_from_cli_banner(banner_text: str) -> Optional[BetaflightVersion]:
    """Extract a Betaflight version from a CLI `version` command's banner
    text. Returns None (never raises) if no plausible version pattern is
    found -- this is a best-effort parse of free text; callers should treat
    None as "could not detect" rather than an error.

    Note: the banner also contains an "MSP API: X.Y" token (e.g. "MSP API:
    1.45"), which is a two-component version, not a firmware X.Y.Z version --
    the regex requires three dot-separated components so it won't match
    that token by itself.
    """
    if not banner_text:
        return None
    match = _BANNER_VERSION_RE.search(banner_text)
    if not match:
        return None
    try:
        return parse_betaflight_version(match.group(1))
    except ValueError:
        return None
