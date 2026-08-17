from __future__ import annotations

from dataclasses import dataclass

from app.fc.cli_client import BetaflightCliClient
from app.jobs import create_job
from app.tuning.apply import apply_job_step_names, apply_tuning_changes
from tests.test_fc import FakeSerialTransport


@dataclass
class FakeRecommendation:
    parameter: str
    proposed_value: float


def _make_client(responses: dict) -> BetaflightCliClient:
    return BetaflightCliClient(FakeSerialTransport(responses))


def _job():
    return create_job(apply_job_step_names())


def test_apply_happy_path_no_reconnect_fn():
    recs = [FakeRecommendation("d_roll", 42), FakeRecommendation("p_roll", 46)]
    client = _make_client(
        {
            "diff all": "set d_roll = 38\nset p_roll = 45\n",
            "set d_roll = 42": "d_roll set to 42\n",
            "set p_roll = 46": "p_roll set to 46\n",
            "get d_roll": "d_roll = 42\n",
            "get p_roll": "p_roll = 46\n",
            "save": "Saving settings\n",
        }
    )
    job = _job()
    result = apply_tuning_changes(client, recs, job)

    assert result["aborted"] is False
    assert result["applied"] == ["d_roll", "p_roll"]
    assert result["rejected"] == []
    assert result["verification_mismatches"] == []
    assert result["saved"] is True
    assert result["reconnected"] is None  # no reconnect_fn given
    assert job.to_dict()["steps"][5]["detail"] == "not attempted (no reconnect function provided)"


def test_apply_aborts_on_rejected_write_and_does_not_save():
    recs = [FakeRecommendation("bogus_param", 99)]
    client = _make_client(
        {
            "diff all": "# diff all\n",
            "set bogus_param = 99": "ERROR IN COMMAND\n",
        }
    )
    job = _job()
    result = apply_tuning_changes(client, recs, job)

    assert result["aborted"] is True
    assert result["saved"] is False
    assert len(result["rejected"]) == 1
    assert "diff all" not in client.transport.sent_commands or "save" not in client.transport.sent_commands
    assert "save" not in client.transport.sent_commands


def test_apply_aborts_on_verification_mismatch_and_does_not_save():
    recs = [FakeRecommendation("d_roll", 42)]
    client = _make_client(
        {
            "diff all": "# diff all\n",
            "set d_roll = 42": "d_roll set to 42\n",
            "get d_roll": "d_roll = 38\n",  # FC reports the OLD value -- didn't actually take
        }
    )
    job = _job()
    result = apply_tuning_changes(client, recs, job)

    assert result["aborted"] is True
    assert result["saved"] is False
    assert result["verification_mismatches"] == [("d_roll", "42", "38")]
    assert "save" not in client.transport.sent_commands


def test_apply_reconnect_success_after_retries():
    recs = [FakeRecommendation("d_roll", 42)]
    client = _make_client(
        {
            "diff all": "# diff all\n",
            "set d_roll = 42": "ok\n",
            "get d_roll": "d_roll = 42\n",
            "save": "Saving settings\n",
        }
    )
    job = _job()

    reconnect_attempts = {"count": 0}

    def reconnect_fn():
        reconnect_attempts["count"] += 1
        if reconnect_attempts["count"] < 3:
            return None  # FC not back yet
        return _make_client({"get d_roll": "d_roll = 42\n"})

    result = apply_tuning_changes(client, recs, job, reconnect_fn=reconnect_fn, reconnect_poll_interval_s=0.01)

    assert result["reconnected"] is True
    assert result["final_verification_mismatches"] == []
    assert reconnect_attempts["count"] == 3


def test_apply_reconnect_timeout_reports_but_does_not_crash():
    recs = [FakeRecommendation("d_roll", 42)]
    client = _make_client(
        {
            "diff all": "# diff all\n",
            "set d_roll = 42": "ok\n",
            "get d_roll": "d_roll = 42\n",
            "save": "Saving settings\n",
        }
    )
    job = _job()

    result = apply_tuning_changes(
        client,
        recs,
        job,
        reconnect_fn=lambda: None,  # never comes back
        reconnect_timeout_s=0.05,
        reconnect_poll_interval_s=0.02,
    )

    assert result["reconnected"] is False
    assert result["saved"] is True  # the save DID happen -- only reconnect/final-verify failed
    assert job.to_dict()["steps"][5]["status"] == "error"


def test_apply_final_verification_mismatch_after_reconnect_flagged_but_not_aborted():
    """Per the safety spec, we don't 'undo' a save after the fact (there's
    nothing more to abort at that point) -- but a post-reboot mismatch must
    still be visibly reported, not silently swallowed as success."""
    recs = [FakeRecommendation("d_roll", 42)]
    client = _make_client(
        {
            "diff all": "# diff all\n",
            "set d_roll = 42": "ok\n",
            "get d_roll": "d_roll = 42\n",
            "save": "Saving settings\n",
        }
    )
    job = _job()

    def reconnect_fn():
        return _make_client({"get d_roll": "d_roll = 38\n"})  # reverted somehow after reboot

    result = apply_tuning_changes(client, recs, job, reconnect_fn=reconnect_fn, reconnect_poll_interval_s=0.01)

    assert result["reconnected"] is True
    assert result["final_verification_mismatches"] == [("d_roll", "42", "38")]
    assert job.to_dict()["steps"][6]["status"] == "error"
