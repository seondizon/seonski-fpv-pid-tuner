"""Betaflight CLI-over-serial client.

Implements just enough of the Betaflight CLI interaction to: enter/exit CLI
mode, run an arbitrary command and capture its text response, fetch the
firmware version, and back up config via `diff all` / `dump all`.

SAFETY: `apply_config_lines` is the one function in this module that writes
config back to a flight controller. Per docs/research/tuning-algorithms.md
("Safety Strategies") and docs/research/reference-analysis.md section 2,
config diffs/dumps are NOT portable across Betaflight versions or hardware
targets. This client never blindly replays a captured config onto a
possibly-different FC. See the docstring on `apply_config_lines` for the
exact rules enforced.
"""

from __future__ import annotations

import time
from typing import Optional

from .serial_transport import SerialTransport
from .version import BetaflightVersion, parse_version_from_cli_banner

# CLI prompt Betaflight prints after most commands / on entering CLI mode.
_CLI_PROMPT = "# "

# Line prefixes that indicate a hardware/target-specific command. These must
# NEVER be replayed onto a potentially different board (different pinout,
# different timer/DMA layout, different motor/servo count/mapping).
_HARDWARE_SPECIFIC_PREFIXES = ("resource", "timer", "dma", "motor", "servo")


class BetaflightCliClient:
    def __init__(self, transport: SerialTransport):
        self.transport = transport

    def enter_cli(self) -> None:
        """Enter CLI mode from MSP/normal mode over the same serial port.

        Best-effort implementation: Betaflight enters CLI mode when it
        receives the string "#" (Configurator sends "#\\n"). We send that
        and then read/drain output until we see the CLI prompt or time out.

        KNOWN ROUGH EDGE: the exact handshake is not fully standardized
        across all Betaflight targets/configurations (some setups need a
        preceding MSP_SET_REBOOT or a short settle delay before the FC will
        accept the '#' trigger, and the banner printed on entry varies by
        version). This implementation covers the common case; adjust the
        trigger sequence/timeout per-target if a specific board doesn't
        respond.
        """
        self.transport.write(b"#\n")
        self._read_until_quiet(timeout=2.0)

    def exit_cli(self) -> None:
        """Leave CLI mode. Betaflight's `exit` command returns to the normal
        MSP-serving state (rebooting if there were unsaved staged changes
        that require it, otherwise just closing the CLI)."""
        self.transport.write(b"exit\n")
        self._read_until_quiet(timeout=1.0)

    def _read_until_quiet(self, timeout: float = 3.0, quiet_period: float = 0.2) -> str:
        """Read from the transport until no new bytes arrive for
        `quiet_period` seconds, or until `timeout` total seconds elapse.
        Used to detect "the FC has finished responding" without relying on
        an exact prompt string, since CLI output framing varies by command.
        """
        chunks: list[bytes] = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            chunk = self.transport.read(4096, timeout=quiet_period)
            if chunk:
                chunks.append(chunk)
            else:
                if chunks:
                    break
        return b"".join(chunks).decode("utf-8", errors="replace")

    def run_command(self, command: str, timeout: float = 3.0) -> str:
        """Send a single CLI command and return its full text response.

        Reads until a quiet period (no new bytes) is observed, which in
        practice corresponds to the FC having finished printing output and
        returned to the "# " prompt.
        """
        self.transport.write(command.encode("utf-8") + b"\n")
        return self._read_until_quiet(timeout=timeout)

    def get_version(self) -> Optional[BetaflightVersion]:
        """Run `version` and parse the resulting banner text."""
        response = self.run_command("version")
        return parse_version_from_cli_banner(response)

    def dump_diff_all(self) -> str:
        """Run `diff all` (preferred backup command: smaller, only
        non-default values) and return the raw text output."""
        return self.run_command("diff all", timeout=5.0)

    def dump_all(self) -> str:
        """Run `dump all` and return the raw text output."""
        return self.run_command("dump all", timeout=5.0)

    def apply_config_lines(
        self,
        config_text: str,
        detected_version: BetaflightVersion,
        target_version: BetaflightVersion,
    ) -> dict:
        """Apply a previously-captured config (e.g. from `dump_diff_all`)
        back onto a flight controller -- SAFETY-CRITICAL.

        This function must NOT blindly replay `config_text` if
        `detected_version` and `target_version` differ meaningfully, and
        must NEVER replay hardware/target-specific lines at all. Rules
        enforced, in order:

        1. Parse `config_text` into individual lines. Any line whose first
           token is `resource`, `timer`, `dma`, `motor`, or `servo` is
           hardware/target-specific (pinout/timer/DMA/motor-count/servo-
           mapping) and is NEVER sent to the FC, regardless of version
           match. Such lines are collected into `skipped_hardware_specific`.
           Only `set <name> = <value>` lines (and other non-hardware lines)
           are considered candidates for sending.

        2. If `detected_version` and `target_version` differ meaningfully --
           different (major, minor) for semver, different (year, month) for
           calver, or one is semver and the other calver (crossing the
           versioning-scheme boundary) -- nothing is sent. The function
           returns immediately with `blocked_version_mismatch=True` and all
           remaining non-hardware lines listed in `lines_requiring_review`,
           so a caller/UI can force an explicit human review step instead of
           auto-applying.

        3. Only when versions match closely (same scheme, same major.minor
           or year.month) does this function actually send each remaining
           `set` line via `run_command`, and inspect the FC's response for
           an error indication (Betaflight's CLI echoes text such as
           "ERROR IN COMMAND" / "unknown command" / "invalid" for unknown or
           out-of-range parameters). Lines the FC itself rejects are
           recorded in `rejected` (line, error_text) -- this is an expected,
           handled outcome, not a crash.

        Returns a dict with keys:
            applied: list[str]                        -- lines successfully sent, no error echoed
            skipped_hardware_specific: list[str]       -- resource/timer/dma/motor/servo lines, never sent
            blocked_version_mismatch: bool             -- True if step 2 blocked everything
            rejected: list[tuple[str, str]]            -- (line, error_text) the FC rejected
            lines_requiring_review: list[str]          -- non-hardware lines not (yet) applied,
                                                           either due to version block or because
                                                           they weren't `set` lines this function
                                                           knows how to validate

        This function embodies the project's core safety requirement: never
        blind-paste a config diff across firmware versions. Do not weaken
        this behavior for convenience -- see docs/research/tuning-algorithms.md
        ("Safety Strategies") and docs/research/reference-analysis.md
        (section 2) for the incidents and version-drift hazards that
        motivate it.
        """
        applied: list[str] = []
        skipped_hardware_specific: list[str] = []
        rejected: list[tuple[str, str]] = []
        lines_requiring_review: list[str] = []

        settable_lines: list[str] = []
        for raw_line in config_text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            first_token = line.split(None, 1)[0].lower()
            if first_token in _HARDWARE_SPECIFIC_PREFIXES:
                skipped_hardware_specific.append(line)
                continue
            settable_lines.append(line)

        version_mismatch = self._versions_differ_meaningfully(detected_version, target_version)
        if version_mismatch:
            return {
                "applied": applied,
                "skipped_hardware_specific": skipped_hardware_specific,
                "blocked_version_mismatch": True,
                "rejected": rejected,
                "lines_requiring_review": settable_lines,
            }

        for line in settable_lines:
            if not line.lower().startswith("set "):
                # Not a `set` line we know how to validate (e.g. a bare
                # comment/section header or unrecognized directive) -- flag
                # for human review rather than guessing at safety.
                lines_requiring_review.append(line)
                continue
            response = self.run_command(line)
            if self._looks_like_error(response):
                rejected.append((line, response.strip()))
            else:
                applied.append(line)

        return {
            "applied": applied,
            "skipped_hardware_specific": skipped_hardware_specific,
            "blocked_version_mismatch": False,
            "rejected": rejected,
            "lines_requiring_review": lines_requiring_review,
        }

    @staticmethod
    def _versions_differ_meaningfully(a: BetaflightVersion, b: BetaflightVersion) -> bool:
        """True if the two versions differ enough that a captured config
        should not be auto-replayed: different versioning scheme entirely,
        or different major.minor (semver) / year.month (calver)."""
        if a.scheme != b.scheme:
            return True
        return (a.major, a.minor) != (b.major, b.minor)

    @staticmethod
    def _looks_like_error(response: str) -> bool:
        lowered = response.lower()
        error_markers = (
            "error in command",
            "unknown command",
            "invalid name",
            "invalid value",
            "out of range",
            "not found",
        )
        return any(marker in lowered for marker in error_markers)
