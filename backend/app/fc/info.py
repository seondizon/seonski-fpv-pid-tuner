"""Craft name, PID profile, and Blackbox storage type detection.

All of these run over the Betaflight CLI (`get <name>`, `status`) and must
be called while the CLI client is already in CLI mode -- same calling
convention as the rest of BetaflightCliClient's usage in api/routes.py's
connect flow (enter_cli() ... these calls ... exit_cli()).
"""
from __future__ import annotations

import re
from typing import Optional

from .cli_client import BetaflightCliClient

# Betaflight's `get <name>` output looks like:
#     name = Chimera7
# possibly followed by blank lines or an "Allowed range"/help line depending
# on version. This matches the first "key = value" style line and captures
# everything after '=' up to end of line.
_GET_VALUE_PATTERN = re.compile(r"^\s*(\S+)\s*=\s*(.*?)\s*$", re.MULTILINE)

# Betaflight's actual blackbox_device CLI enum values.
_KNOWN_BLACKBOX_STORAGE = {"SPIFLASH", "SDCARD", "SERIAL", "NONE"}


def _parse_get_value(response: str, key: str) -> Optional[str]:
    for match in _GET_VALUE_PATTERN.finditer(response):
        if match.group(1).lower() == key.lower():
            value = match.group(2).strip()
            return value or None
    return None


def get_craft_name(cli_client: BetaflightCliClient) -> Optional[str]:
    """Run `get name` and return the craft name, or None if it's unset
    (empty) or the response couldn't be parsed -- an unset craft name is a
    normal, expected state, not an error."""
    response = cli_client.run_command("get name")
    return _parse_get_value(response, "name")


def get_blackbox_storage_type(cli_client: BetaflightCliClient) -> Optional[str]:
    """Run `get blackbox_device` and return one of SPIFLASH/SDCARD/SERIAL/
    NONE, or None if it can't be determined. If the FC returns a value
    outside that known set, still return the raw (uppercased) value rather
    than silently mapping it to a guess -- callers should treat any value
    not in that known set as "unrecognized" and fall back to honest
    "can't tell if a log is available" messaging."""
    response = cli_client.run_command("get blackbox_device")
    value = _parse_get_value(response, "blackbox_device")
    return value.upper() if value else None


# Matches Betaflight `status` output lines mentioning the active PID
# profile, e.g. "PID profile: 1" or "profile 1". Exact wording has drifted
# across versions (see docs/research/reference-analysis.md section 2 on
# profile-count/naming changes) -- this pattern is deliberately loose
# (case-insensitive, tolerant of "PID profile"/"profile" wording and an
# optional colon) rather than pinned to one exact phrasing.
_PID_PROFILE_PATTERN = re.compile(r"(?:pid\s+)?profile\s*:?\s*(\d+)", re.IGNORECASE)


def get_pid_profile_index(cli_client: BetaflightCliClient) -> Optional[int]:
    """Best-effort: run `status` and try to find the active PID profile
    index in its output. Returns None (never a guessed default) if the
    pattern can't be found -- an incorrect profile number shown to the user
    is worse than an honest "unknown"."""
    response = cli_client.run_command("status")
    match = _PID_PROFILE_PATTERN.search(response)
    if match is None:
        return None
    return int(match.group(1))
