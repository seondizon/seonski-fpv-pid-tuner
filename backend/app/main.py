"""FastAPI application entrypoint.

Serves the kiosk frontend (backend/static/) and the JSON API
(backend/app/api/routes.py) from a single process, per the project's
confirmed architecture: a local Flask/FastAPI backend + browser-in-kiosk-mode
frontend on the Raspberry Pi 2B touchscreen (see saved project memory /
docs/research for the full rationale).

Run for local development with:

    cd backend
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

Then open http://localhost:8000/ in a browser.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router

app = FastAPI(title="FPV Tuner", description="Betaflight Blackbox analysis and tuning assistant")

app.include_router(api_router, prefix="/api")

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="static")
