"""Integration tests for the wired-together FastAPI app (app/main.py,
app/api/routes.py). These exercise the actual HTTP layer end-to-end, on top
of a synthetic BlackboxLog injected directly into the in-memory session
store -- distinct from the per-module unit tests in test_blackbox_decode.py,
test_analysis.py, and test_fc.py.
"""
from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.blackbox.logdata import BlackboxLog
from app.main import app
import app.api.routes as routes


@pytest.fixture
def client():
    return TestClient(app)


def _make_synthetic_log(fs: float = 2000.0, duration_s: float = 4.0) -> BlackboxLog:
    """A first-order-lag step response on roll, with some high-frequency
    noise and a slowly varying throttle -- just enough structure to exercise
    every analysis function without asserting on exact numeric output (that's
    what the analysis unit tests are for)."""
    t = np.arange(0, duration_s, 1.0 / fs)
    n = len(t)
    setpoint_roll = (np.floor(t / 1.0) % 2) * 300.0

    tau = 0.05
    gyro_roll = np.zeros(n)
    alpha = (1.0 / fs) / tau
    for i in range(1, n):
        gyro_roll[i] = gyro_roll[i - 1] + alpha * (setpoint_roll[i] - gyro_roll[i - 1])
    gyro_roll += 5.0 * np.sin(2 * np.pi * 150 * t)

    throttle = 50 + 10 * np.sin(2 * np.pi * 0.05 * t)
    motor = np.tile((throttle / 100 * 2000).reshape(-1, 1), (1, 4))
    zeros = np.zeros(n)

    return BlackboxLog(
        time_s=t,
        sample_rate_hz=fs,
        setpoint={"roll": setpoint_roll, "pitch": zeros.copy(), "yaw": zeros.copy()},
        gyro={"roll": gyro_roll, "pitch": zeros.copy(), "yaw": zeros.copy()},
        axis_p={"roll": zeros.copy(), "pitch": zeros.copy(), "yaw": zeros.copy()},
        axis_i={"roll": zeros.copy(), "pitch": zeros.copy(), "yaw": zeros.copy()},
        axis_d={"roll": zeros.copy(), "pitch": zeros.copy(), "yaw": zeros.copy()},
        axis_f={"roll": zeros.copy(), "pitch": zeros.copy(), "yaw": zeros.copy()},
        throttle_pct=throttle,
        motor=motor,
        vbat_v=None,
        headers={},
        firmware_version="4.5.0",
    )


@pytest.fixture
def synthetic_session():
    session_id = "test-session-0"
    routes._SESSIONS[session_id] = {
        "log": _make_synthetic_log(),
        "duration_s": 4.0,
        "log_id": "test-log",
    }
    yield session_id
    routes._SESSIONS.pop(session_id, None)


def test_fc_status_default(client):
    r = client.get("/api/fc/status")
    assert r.status_code == 200
    assert r.json() == {"connected": False, "port": None, "firmware_version": None, "target": None}


def test_index_serves_frontend(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


@pytest.mark.parametrize(
    "path",
    ["/api/analysis/step-response", "/api/analysis/noise", "/api/analysis/tracking", "/api/analysis/noise/heatmap"],
)
def test_analysis_unknown_session_404s(client, path):
    r = client.get(path, params={"session_id": "does-not-exist", "axis": "roll"})
    assert r.status_code == 404


@pytest.mark.parametrize(
    "path",
    ["/api/analysis/step-response", "/api/analysis/noise", "/api/analysis/tracking", "/api/analysis/noise/heatmap"],
)
def test_analysis_bad_axis_422s(client, path, synthetic_session):
    r = client.get(path, params={"session_id": synthetic_session, "axis": "bogus"})
    assert r.status_code == 422


def test_step_response_endpoint_end_to_end(client, synthetic_session):
    r = client.get("/api/analysis/step-response", params={"session_id": synthetic_session, "axis": "roll"})
    assert r.status_code == 200
    body = r.json()
    assert body["axis"] == "roll"
    assert body["rise_time_s"] is None or body["rise_time_s"] > 0


def test_noise_endpoint_end_to_end(client, synthetic_session):
    r = client.get("/api/analysis/noise", params={"session_id": synthetic_session, "axis": "roll"})
    assert r.status_code == 200
    assert r.json()["axis"] == "roll"


def test_noise_heatmap_endpoint_end_to_end(client, synthetic_session):
    r = client.get("/api/analysis/noise/heatmap", params={"session_id": synthetic_session, "axis": "roll"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["throttle_bins_pct"]) == 100


def test_tracking_endpoint_does_not_crash_on_nan_stick_bins(client, synthetic_session):
    """Regression test: compute_tracking_error_stats intentionally returns
    NaN for stick-deflection bins with zero samples (see
    app/analysis/tracking.py docstring). Starlette's default JSONResponse
    uses allow_nan=False, so an un-sanitized NaN anywhere in the response
    previously crashed this endpoint with a 500
    ("ValueError: Out of range float values are not JSON compliant").
    The synthetic fixture's two-level step setpoint guarantees several empty
    stick-deflection bins, reliably reproducing the case that broke this.
    """
    r = client.get("/api/analysis/tracking", params={"session_id": synthetic_session, "axis": "roll"})
    assert r.status_code == 200
    body = r.json()
    assert body["axis"] == "roll"
    assert isinstance(body["error_std"], float)
    assert len(body["stick_bins"]) == 10
    # At least one bin should have been empty (None) for this synthetic
    # signal, and none should have leaked a raw NaN/Infinity float.
    maes = [b["mae"] for b in body["stick_bins"]]
    assert any(m is None for m in maes)
    assert all(m is None or (m == m and abs(m) != float("inf")) for m in maes)
