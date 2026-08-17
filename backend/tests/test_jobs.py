from __future__ import annotations

import time

from app.jobs import create_job, get_job, run_in_background


def test_job_lifecycle_success():
    job = create_job(["a", "b"])
    assert job.to_dict()["status"] == "running"
    assert job.percent() == 0

    def work(j):
        j.set_step("a", "in_progress")
        j.set_step("a", "done")
        j.set_step("b", "done")
        return {"ok": True}

    run_in_background(job, work)
    deadline = time.monotonic() + 2.0
    while job.status == "running" and time.monotonic() < deadline:
        time.sleep(0.01)

    assert job.status == "done"
    assert job.percent() == 100
    assert job.result == {"ok": True}
    assert get_job(job.id) is job


def test_job_lifecycle_error_does_not_leak_traceback():
    job = create_job(["a"])

    def work(j):
        raise ValueError("boom")

    run_in_background(job, work)
    deadline = time.monotonic() + 2.0
    while job.status == "running" and time.monotonic() < deadline:
        time.sleep(0.01)

    assert job.status == "error"
    assert job.error == "boom"
    assert "Traceback" not in (job.error or "")


def test_unknown_step_raises():
    job = create_job(["a"])
    try:
        job.set_step("nope", "done")
        assert False, "expected KeyError"
    except KeyError:
        pass


def test_get_job_unknown_returns_none():
    assert get_job("does-not-exist") is None
