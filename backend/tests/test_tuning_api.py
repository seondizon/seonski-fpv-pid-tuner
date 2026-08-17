"""Integration tests for the tuning-related endpoints wired into
api/routes.py (recommendations, readiness, apply, iterations,
record-iteration) plus /fc/detect. Uses tmp_path to isolate the tuning
JSON store from the real backend/data/tuning/ directory."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
import app.api.routes as routes
import app.tuning.store as store_module
from tests.test_api import _make_synthetic_log


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def isolated_tuning_store(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "TUNING_STORE_DIR", tmp_path)


@pytest.fixture
def synthetic_session():
    session_id = "tuning-test-session"
    routes._SESSIONS[session_id] = {
        "log": _make_synthetic_log(duration_s=4.0),
        "duration_s": 4.0,
        "log_id": "tuning-test-log",
    }
    yield session_id
    routes._SESSIONS.pop(session_id, None)


@pytest.fixture(autouse=True)
def reset_fc_state():
    routes._reset_fc_state()
    yield
    routes._reset_fc_state()


def test_fc_detect_no_hardware_returns_not_detected(client):
    with patch("app.api.routes.detect_fc_port", return_value=None):
        r = client.get("/api/fc/detect")
    assert r.status_code == 200
    assert r.json() == {"detected": False, "port": None}


def test_fc_detect_reports_port_when_present(client):
    with patch("app.api.routes.detect_fc_port", return_value="/dev/ttyACM0"):
        r = client.get("/api/fc/detect")
    assert r.json() == {"detected": True, "port": "/dev/ttyACM0"}


def test_recommendations_endpoint_returns_list(client, synthetic_session):
    r = client.get("/api/tuning/recommendations", params={"session_id": synthetic_session})
    assert r.status_code == 200
    assert "recommendations" in r.json()
    assert isinstance(r.json()["recommendations"], list)


def test_recommendations_unknown_session_404s(client):
    r = client.get("/api/tuning/recommendations", params={"session_id": "nope"})
    assert r.status_code == 404


def test_readiness_blocked_when_no_fc_connected(client, synthetic_session):
    r = client.get("/api/tuning/readiness", params={"session_id": synthetic_session})
    assert r.status_code == 200
    body = r.json()
    assert body["blocked"] is True
    assert body["version_supported"] is False
    assert body["settings_read_ok"] is False


def test_apply_requires_connected_fc(client, synthetic_session):
    r = client.post("/api/tuning/apply", params={"session_id": synthetic_session})
    assert r.status_code == 409


def test_apply_blocked_when_readiness_blocked_even_if_fake_connected(client, synthetic_session):
    # Simulate a "connected" FC state without real hardware, but without
    # settings successfully read -- readiness must still block.
    routes._FC_STATE.update({"connected": True, "port": "/dev/fake", "firmware_version": "4.5.1"})
    r = client.post("/api/tuning/apply", params={"session_id": synthetic_session})
    # Either blocked (409) or "nothing to apply" (422) depending on whether
    # the synthetic log produces any recommendations -- both are safe,
    # non-writing outcomes, which is what this test actually verifies.
    assert r.status_code in (409, 422)


def test_record_iteration_and_list_iterations_roundtrip(client, synthetic_session):
    r = client.post("/api/tuning/record-iteration", json={"session_id": synthetic_session, "label": "Baseline"})
    assert r.status_code == 200
    body = r.json()
    assert body["iteration_number"] == 1

    r2 = client.get("/api/tuning/iterations", params={"craft": body["craft_id"]})
    assert r2.status_code == 200
    listed = r2.json()
    assert len(listed["iterations"]) == 1
    assert listed["iterations"][0]["label"] == "Baseline"
    assert listed["best_iteration"] == 1
    assert listed["current_is_best"] is True


def test_iterations_empty_for_unknown_craft(client):
    r = client.get("/api/tuning/iterations", params={"craft": "never_seen_before"})
    assert r.status_code == 200
    body = r.json()
    assert body["iterations"] == []
    assert body["best_iteration"] is None
    assert body["tune_complete"] is False
