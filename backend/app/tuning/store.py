"""Persistent per-craft tune-iteration history.

The product's whole philosophy is iterative tuning across multiple flights
(see the UX spec: "Session: Chimera7 / Tune #1 - Baseline / Tune #2 -
Applied / ..."), which means iteration history must survive backend
restarts -- unlike the in-memory Blackbox session store in api/routes.py
(which is fine to lose on restart, since a session is just "the log you're
looking at right now"). A single-user kiosk app on one Pi has no need for a
real database; one JSON file per craft is simple, human-inspectable, and
sufficient.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from app import config


@dataclass
class Iteration:
    number: int                      # 1-based, sequential per craft
    timestamp: float                 # seconds since epoch (time.time())
    label: str                       # "Baseline" | "Applied" | "Current" -- display only
    applied_changes: list = field(default_factory=list)   # [{"parameter":..., "from":..., "to":...}]
    analysis_summary: dict = field(default_factory=dict)  # snapshot of GET /api/analysis/summary


def craft_id_from_name(craft_name: Optional[str]) -> str:
    """Sanitize a craft name into a filesystem-safe id. Unnamed/unknown
    craft still needs a stable id to accumulate history against, rather
    than silently dropping iteration tracking -- "unnamed" is a deliberate,
    stable fallback bucket, not a random/per-session id, so history still
    accumulates across sessions for a craft that never got a name set."""
    if not craft_name or not craft_name.strip():
        return "unnamed"
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", craft_name.strip().lower())
    return slug or "unnamed"


def _store_path(craft_id: str) -> Path:
    return config.TUNING_STORE_DIR / f"{craft_id}.json"


def load_iterations(craft_id: str) -> list[Iteration]:
    path = _store_path(craft_id)
    if not path.exists():
        return []
    with open(path) as f:
        raw = json.load(f)
    return [Iteration(**item) for item in raw]


def save_iteration(craft_id: str, label: str, applied_changes: list, analysis_summary: dict) -> Iteration:
    """Append a new iteration for this craft and persist it. Returns the
    saved Iteration (with its assigned sequential number)."""
    existing = load_iterations(craft_id)
    number = (existing[-1].number + 1) if existing else 1
    iteration = Iteration(
        number=number,
        timestamp=time.time(),
        label=label,
        applied_changes=applied_changes,
        analysis_summary=analysis_summary,
    )
    existing.append(iteration)
    path = _store_path(craft_id)
    with open(path, "w") as f:
        json.dump([asdict(it) for it in existing], f, indent=2)
    return iteration


def get_latest_iteration(craft_id: str) -> Optional[Iteration]:
    iterations = load_iterations(craft_id)
    return iterations[-1] if iterations else None
