"""Safety-critical orchestration for writing approved tuning changes to a
flight controller.

SAFETY: per the UX spec (section 11) and this project's broader safety
principles (docs/research/tuning-algorithms.md "Safety Strategies"): back up
first, write only the approved changes, verify every value was actually
accepted BEFORE saving, and stop immediately -- without saving, without
proceeding to further changes -- if anything doesn't verify. A partially-
applied, unverified tune must never be persisted to flash.

This module builds and tests the orchestration. It does NOT decide whether
recommendations are safe to apply in the first place (that's
app/tuning/engine.py's job, upstream of this) and it is NEVER invoked
against a real physical FC by an automated process in this codebase --
executing it against real hardware is a deliberate, explicit action gated
at the API/caller layer.
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from app.fc.cli_client import BetaflightCliClient
from app.jobs import Job

_STEP_NAMES = [
    "Backup",
    "Writing settings",
    "Verifying",
    "Saving FC",
    "Rebooting",
    "Reconnecting",
    "Final verification",
]

_ERROR_MARKERS = (
    "error in command",
    "unknown command",
    "invalid name",
    "invalid value",
    "out of range",
    "not found",
)


class ApplyAborted(Exception):
    """Raised (and caught internally, surfaced via the returned result dict
    rather than propagated) when a verification step fails -- signals "stop
    here, do not proceed to save/reboot" per the safety spec."""


def _looks_like_error(response: str) -> bool:
    lowered = response.lower()
    return any(marker in lowered for marker in _ERROR_MARKERS)


def _parse_get_value(response: str, key: str) -> Optional[str]:
    import re

    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*?)\s*$", re.MULTILINE | re.IGNORECASE)
    match = pattern.search(response)
    return match.group(1).strip() if match else None


def _values_match(expected: float, actual_text: Optional[str], tolerance: float = 1e-6) -> bool:
    if actual_text is None:
        return False
    try:
        actual = float(actual_text)
    except ValueError:
        return False
    return abs(actual - expected) <= max(tolerance, abs(expected) * 0.01)  # 1% relative tolerance


def apply_tuning_changes(
    cli_client: BetaflightCliClient,
    recommendations: list,  # list of engine.Recommendation-like objects (duck-typed: .parameter, .proposed_value)
    job: Job,
    reconnect_fn: Optional[Callable[[], Optional[BetaflightCliClient]]] = None,
    reconnect_timeout_s: float = 30.0,
    reconnect_poll_interval_s: float = 2.0,
) -> dict:
    """Apply `recommendations` to the FC `cli_client` is already connected
    to (must already be in CLI mode -- same calling convention as the rest
    of this project's CliClient usage).

    `reconnect_fn`, if given, is called repeatedly (up to reconnect_timeout_s,
    polling every reconnect_poll_interval_s) after the FC reboots, and should
    attempt to open a fresh connection and return a new, already-in-CLI-mode
    BetaflightCliClient, or None if the FC isn't back yet. This function owns
    the retry loop; `reconnect_fn` just owns "try once, right now." If
    reconnect_fn is None, the Reconnecting/Final verification steps are
    marked done with detail="not attempted" and the caller is expected to
    handle reconnection as a separate, later action.

    Returns a result dict:
        {
            "backup_text": str,
            "applied": [str],                        # parameters successfully set and verified
            "rejected": [(str, str)],                 # (parameter, error_text) the FC rejected on write
            "verification_mismatches": [(str, str, str)],  # (parameter, expected, actual) pre-save mismatches
            "saved": bool,
            "reconnected": bool | None,                # None if reconnect_fn wasn't given
            "final_verification_mismatches": [(str, str, str)],
            "aborted": bool,
            "abort_reason": str | None,
        }

    Stops immediately (without calling `save`) if ANY write is rejected or
    ANY pre-save verification mismatches -- per the safety spec, a partial/
    unverified tune must never be persisted to flash.
    """
    for name in _STEP_NAMES:
        assert name in [s.name for s in job.steps], f"job must be created with all apply steps, missing {name!r}"

    result = {
        "backup_text": "",
        "applied": [],
        "rejected": [],
        "verification_mismatches": [],
        "saved": False,
        "reconnected": None,
        "final_verification_mismatches": [],
        "aborted": False,
        "abort_reason": None,
    }

    def _abort(step_name: str, reason: str) -> dict:
        job.set_step(step_name, "error", reason)
        result["aborted"] = True
        result["abort_reason"] = reason
        return result

    # --- 1. Backup -----------------------------------------------------
    job.set_step("Backup", "in_progress")
    try:
        result["backup_text"] = cli_client.dump_diff_all()
    except Exception as exc:  # noqa: BLE001 -- surfaced via result, not raised, per jobs.py convention
        return _abort("Backup", f"Could not back up current configuration: {exc}")
    job.set_step("Backup", "done")

    # --- 2. Writing settings --------------------------------------------
    job.set_step("Writing settings", "in_progress")
    for rec in recommendations:
        command = f"set {rec.parameter} = {rec.proposed_value}"
        response = cli_client.run_command(command)
        if _looks_like_error(response):
            result["rejected"].append((rec.parameter, response.strip()))
        else:
            result["applied"].append(rec.parameter)

    if result["rejected"]:
        return _abort(
            "Writing settings",
            f"The FC rejected {len(result['rejected'])} setting(s): "
            + ", ".join(p for p, _ in result["rejected"]),
        )
    job.set_step("Writing settings", "done")

    # --- 3. Verifying (BEFORE saving) -----------------------------------
    job.set_step("Verifying", "in_progress")
    for rec in recommendations:
        response = cli_client.run_command(f"get {rec.parameter}")
        actual_text = _parse_get_value(response, rec.parameter)
        if not _values_match(rec.proposed_value, actual_text):
            result["verification_mismatches"].append((rec.parameter, str(rec.proposed_value), str(actual_text)))

    if result["verification_mismatches"]:
        return _abort(
            "Verifying",
            f"{len(result['verification_mismatches'])} setting(s) did not verify after being written "
            "-- nothing was saved.",
        )
    job.set_step("Verifying", "done")

    # --- 4. Saving FC ----------------------------------------------------
    job.set_step("Saving FC", "in_progress")
    cli_client.run_command("save", timeout=2.0)  # FC reboots on save; a lack of response here is expected
    result["saved"] = True
    job.set_step("Saving FC", "done")

    # --- 5. Rebooting ------------------------------------------------------
    # The FC's USB connection drops as a direct, expected result of `save`
    # rebooting the board (same behavior already confirmed for `exit` -- see
    # app/fc/cli_client.py's exit_cli() docstring). Nothing to actively do
    # here except mark the step and move on to reconnecting.
    job.set_step("Rebooting", "done", "FC is rebooting (USB disconnect expected)")

    # --- 6. Reconnecting ---------------------------------------------------
    if reconnect_fn is None:
        job.set_step("Reconnecting", "done", "not attempted (no reconnect function provided)")
        job.set_step("Final verification", "done", "not attempted")
        return result

    job.set_step("Reconnecting", "in_progress")
    new_client: Optional[BetaflightCliClient] = None
    deadline = time.monotonic() + reconnect_timeout_s
    while time.monotonic() < deadline:
        new_client = reconnect_fn()
        if new_client is not None:
            break
        time.sleep(reconnect_poll_interval_s)

    if new_client is None:
        result["reconnected"] = False
        job.set_step(
            "Reconnecting",
            "error",
            f"FC did not reconnect within {reconnect_timeout_s}s -- the tune was saved, "
            "but final verification could not run. Reconnect manually to confirm.",
        )
        job.set_step("Final verification", "error", "skipped (not reconnected)")
        return result

    result["reconnected"] = True
    job.set_step("Reconnecting", "done")

    # --- 7. Final verification ---------------------------------------------
    job.set_step("Final verification", "in_progress")
    for rec in recommendations:
        response = new_client.run_command(f"get {rec.parameter}")
        actual_text = _parse_get_value(response, rec.parameter)
        if not _values_match(rec.proposed_value, actual_text):
            result["final_verification_mismatches"].append(
                (rec.parameter, str(rec.proposed_value), str(actual_text))
            )
    job.set_step(
        "Final verification",
        "done" if not result["final_verification_mismatches"] else "error",
        None if not result["final_verification_mismatches"] else f"{len(result['final_verification_mismatches'])} mismatch(es) after reboot",
    )

    return result


def apply_job_step_names() -> list[str]:
    """Step names to pass to jobs.create_job() for an apply-tune job --
    exposed as a function (not just the module-level list) so callers don't
    accidentally mutate the shared list."""
    return list(_STEP_NAMES)
