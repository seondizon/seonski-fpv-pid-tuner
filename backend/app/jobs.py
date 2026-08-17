"""Generic in-memory background job tracker.

Several workflows (downloading + analyzing a Blackbox log, applying a tune)
are multi-step and slow enough that the touchscreen UI needs to show real
progress -- per the UX spec, "show real progress stages rather than a fake
animated progress bar." This module is the shared mechanism: a job has a
fixed list of named steps, each independently marked pending/in_progress/
done/error, polled by the frontend via GET /api/jobs/{job_id}.

Single-process, single-user kiosk app -- an in-memory dict is sufficient,
same reasoning as the session store in api/routes.py. Jobs run in a plain
background thread (not asyncio) because the work they wrap is blocking
(serial I/O, subprocess calls, numpy-heavy analysis).
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class JobStep:
    name: str
    status: str = "pending"  # pending | in_progress | done | error
    detail: Optional[str] = None


class Job:
    def __init__(self, job_id: str, step_names: list[str]):
        self.id = job_id
        self.steps = [JobStep(name=n) for n in step_names]
        self.status = "running"  # running | done | error
        self.error: Optional[str] = None
        self.result: Optional[dict] = None
        # RLock, not Lock: to_dict() calls percent() while already holding
        # the lock -- a plain Lock would deadlock on that self-reacquire.
        self._lock = threading.RLock()

    def set_step(self, name: str, status: str, detail: Optional[str] = None) -> None:
        with self._lock:
            for step in self.steps:
                if step.name == name:
                    step.status = status
                    step.detail = detail
                    return
            raise KeyError(f"Job {self.id} has no step named {name!r}")

    def percent(self) -> int:
        with self._lock:
            if not self.steps:
                return 0
            done = sum(1 for s in self.steps if s.status == "done")
            return int(round(done / len(self.steps) * 100))

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "status": self.status,
                "error": self.error,
                "percent": self.percent(),
                "steps": [{"name": s.name, "status": s.status, "detail": s.detail} for s in self.steps],
                "result": self.result,
            }


_JOBS: dict[str, Job] = {}


def create_job(step_names: list[str]) -> Job:
    job = Job(uuid.uuid4().hex[:12], step_names)
    _JOBS[job.id] = job
    return job


def get_job(job_id: str) -> Optional[Job]:
    return _JOBS.get(job_id)


def run_in_background(job: Job, fn: Callable[[Job], dict]) -> None:
    """Run `fn(job)` on a daemon thread. `fn` is expected to call
    job.set_step(...) as it progresses and return a result dict on success.
    Any exception marks the job as errored (with the exception message, not
    a raw traceback -- callers must never expose stack traces to the
    touchscreen UI, per the UX spec's error-handling rules) rather than
    crashing the thread silently."""

    def _runner() -> None:
        try:
            job.result = fn(job)
            job.status = "done"
        except Exception as exc:  # noqa: BLE001 -- intentionally broad: this is a thread boundary
            job.status = "error"
            job.error = str(exc)

    threading.Thread(target=_runner, daemon=True).start()
