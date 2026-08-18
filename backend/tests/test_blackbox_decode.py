"""Tests for app.blackbox.decode (path resolution / error handling only --
decode_log() is NOT exercised end-to-end here since that requires a real
compiled blackbox_decode binary and a real .bbl log file, neither of which
exist in this environment) and app.blackbox.logdata (CSV parsing, against a
hand-crafted synthetic fixture)."""

from pathlib import Path

import numpy as np
import pytest

from app.blackbox import decode as decode_module
from app.blackbox.logdata import load_blackbox_csv

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
SAMPLE_CSV = FIXTURES_DIR / "sample_blackbox.csv"


# --- find_blackbox_decode_binary -------------------------------------------------


def test_find_binary_raises_when_nothing_configured(monkeypatch):
    """With no env override, no vendor binary, and nothing on PATH, we must
    raise a clear RuntimeError (never silently return None or crash with an
    unrelated error)."""
    monkeypatch.setattr(decode_module, "BLACKBOX_DECODE_BIN", None)
    monkeypatch.setattr(decode_module, "_VENDOR_BIN", Path("/nonexistent/vendor/blackbox_decode"))
    monkeypatch.setattr(decode_module.shutil, "which", lambda name: None)

    with pytest.raises(RuntimeError) as exc_info:
        decode_module.find_blackbox_decode_binary()

    message = str(exc_info.value)
    assert "blackbox_decode" in message
    assert "build_blackbox_decode.sh" in message


def test_find_binary_prefers_env_override(monkeypatch, tmp_path):
    fake_binary = tmp_path / "blackbox_decode"
    fake_binary.write_text("#!/bin/sh\necho fake\n")

    monkeypatch.setattr(decode_module, "BLACKBOX_DECODE_BIN", str(fake_binary))
    # Even if a vendor binary and PATH binary both "exist", env override wins.
    monkeypatch.setattr(decode_module, "_VENDOR_BIN", Path("/nonexistent/vendor/blackbox_decode"))
    monkeypatch.setattr(decode_module.shutil, "which", lambda name: "/usr/bin/blackbox_decode")

    assert decode_module.find_blackbox_decode_binary() == str(fake_binary)


def test_find_binary_ignores_env_override_when_path_missing(monkeypatch, tmp_path):
    """If the env var points at a path that doesn't exist, we must fall
    through to the next priority tier rather than returning a bad path."""
    missing_path = tmp_path / "does-not-exist"

    monkeypatch.setattr(decode_module, "BLACKBOX_DECODE_BIN", str(missing_path))
    monkeypatch.setattr(decode_module, "_VENDOR_BIN", Path("/nonexistent/vendor/blackbox_decode"))
    monkeypatch.setattr(decode_module.shutil, "which", lambda name: "/usr/bin/blackbox_decode")

    assert decode_module.find_blackbox_decode_binary() == "/usr/bin/blackbox_decode"


def test_find_binary_uses_vendor_path_before_which(monkeypatch, tmp_path):
    vendor_binary = tmp_path / "vendor" / "blackbox-tools" / "obj" / "blackbox_decode"
    vendor_binary.parent.mkdir(parents=True)
    vendor_binary.write_text("#!/bin/sh\necho fake\n")

    monkeypatch.setattr(decode_module, "BLACKBOX_DECODE_BIN", None)
    monkeypatch.setattr(decode_module, "_VENDOR_BIN", vendor_binary)
    monkeypatch.setattr(decode_module.shutil, "which", lambda name: "/usr/bin/blackbox_decode")

    assert decode_module.find_blackbox_decode_binary() == str(vendor_binary)


def test_find_binary_falls_back_to_which(monkeypatch, tmp_path):
    monkeypatch.setattr(decode_module, "BLACKBOX_DECODE_BIN", None)
    monkeypatch.setattr(decode_module, "_VENDOR_BIN", tmp_path / "nonexistent" / "blackbox_decode")
    monkeypatch.setattr(decode_module.shutil, "which", lambda name: "/usr/local/bin/blackbox_decode")

    assert decode_module.find_blackbox_decode_binary() == "/usr/local/bin/blackbox_decode"


def test_decode_log_raises_when_log_file_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(
        decode_module, "find_blackbox_decode_binary", lambda: "/usr/bin/blackbox_decode"
    )
    missing_log = tmp_path / "missing.bbl"

    with pytest.raises(FileNotFoundError):
        decode_module.decode_log(str(missing_log))


def test_decode_log_raises_on_nonzero_exit(monkeypatch, tmp_path):
    """A failing subprocess must raise (with stdout/stderr surfaced), never
    be swallowed."""
    log_file = tmp_path / "LOG0001.BBL"
    log_file.write_bytes(b"not a real log")

    monkeypatch.setattr(
        decode_module, "find_blackbox_decode_binary", lambda: "/usr/bin/blackbox_decode"
    )

    class FakeCompletedProcess:
        returncode = 1
        stdout = "some stdout"
        stderr = "malformed log error"

    monkeypatch.setattr(decode_module.subprocess, "run", lambda *a, **k: FakeCompletedProcess())

    with pytest.raises(RuntimeError) as exc_info:
        decode_module.decode_log(str(log_file))

    message = str(exc_info.value)
    assert "malformed log error" in message
    assert "some stdout" in message


def test_decode_log_raises_on_timeout_instead_of_hanging(monkeypatch, tmp_path):
    """Regression test: found live against a real FC whose flash reported
    100% used (i.e. likely never erased) -- blackbox_decode went into a
    genuine infinite loop (confirmed via `ps` showing 25+ minutes of
    sustained 99.9% CPU, zero output), matching the known blackbox-tools
    issue #74 hang risk this project flagged in its own research before
    ever hitting it. decode_log must bound the subprocess with a timeout
    and raise a clear, actionable RuntimeError rather than hanging forever."""
    import subprocess

    log_file = tmp_path / "LOG0001.BBL"
    log_file.write_bytes(b"not a real log")

    monkeypatch.setattr(
        decode_module, "find_blackbox_decode_binary", lambda: "/usr/bin/blackbox_decode"
    )

    def fake_run(*args, **kwargs):
        assert "timeout" in kwargs and kwargs["timeout"] is not None
        raise subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs["timeout"], output="partial out", stderr="partial err")

    monkeypatch.setattr(decode_module.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as exc_info:
        decode_module.decode_log(str(log_file), timeout=5)

    message = str(exc_info.value)
    assert "did not finish within 5s" in message
    assert "erase" in message.lower()  # actionable guidance, not just "it timed out"


def test_decode_log_raises_when_no_csv_produced(monkeypatch, tmp_path):
    """Even a zero-exit-code run must be treated as a failure if no CSV
    output can be found -- we should not return an empty list silently."""
    log_file = tmp_path / "LOG0001.BBL"
    log_file.write_bytes(b"not a real log")

    monkeypatch.setattr(
        decode_module, "find_blackbox_decode_binary", lambda: "/usr/bin/blackbox_decode"
    )

    class FakeCompletedProcess:
        returncode = 0
        stdout = "decoded ok"
        stderr = ""

    monkeypatch.setattr(decode_module.subprocess, "run", lambda *a, **k: FakeCompletedProcess())

    with pytest.raises(RuntimeError) as exc_info:
        decode_module.decode_log(str(log_file))

    assert "no CSV output" in str(exc_info.value)


def test_decode_log_returns_sorted_csv_paths(monkeypatch, tmp_path):
    log_file = tmp_path / "LOG0001.BBL"
    log_file.write_bytes(b"not a real log")

    # Simulate blackbox_decode having produced two session CSVs.
    (tmp_path / "LOG0001.02.csv").write_text("a")
    (tmp_path / "LOG0001.01.csv").write_text("a")

    monkeypatch.setattr(
        decode_module, "find_blackbox_decode_binary", lambda: "/usr/bin/blackbox_decode"
    )

    class FakeCompletedProcess:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(decode_module.subprocess, "run", lambda *a, **k: FakeCompletedProcess())

    result = decode_module.decode_log(str(log_file))

    assert result == [
        str(tmp_path / "LOG0001.01.csv"),
        str(tmp_path / "LOG0001.02.csv"),
    ]


# --- load_blackbox_csv -------------------------------------------------------------


def test_load_blackbox_csv_shapes_and_axis_mapping():
    log = load_blackbox_csv(str(SAMPLE_CSV))

    n = 10  # rows in the fixture

    # time / sample rate
    assert log.time_s.shape == (n,)
    assert log.time_s[0] == pytest.approx(0.0)
    assert log.time_s[-1] == pytest.approx(0.009)  # 9000us -> 9ms after zeroing
    assert log.sample_rate_hz == pytest.approx(1000.0, rel=1e-3)  # dt=1ms in fixture

    # axis order: index 0=roll, 1=pitch, 2=yaw
    assert set(log.axis_p.keys()) == {"roll", "pitch", "yaw"}
    np.testing.assert_allclose(log.axis_p["roll"], [10 + i for i in range(n)])
    np.testing.assert_allclose(log.axis_p["pitch"], [-5 + i * 0.5 for i in range(n)])
    np.testing.assert_allclose(log.axis_p["yaw"], [2 + i * 0.2 for i in range(n)])

    np.testing.assert_allclose(log.axis_i["roll"], [1.0 + i * 0.1 for i in range(n)])

    # fixture omits axisD[2] (yaw) entirely -> must be zero-filled, not missing
    assert log.axis_d["yaw"].shape == (n,)
    np.testing.assert_allclose(log.axis_d["yaw"], np.zeros(n))
    np.testing.assert_allclose(log.axis_d["roll"], [3 + i * 0.3 for i in range(n)])

    # fixture has no axisF columns at all -> every axis zero-filled
    assert set(log.axis_f.keys()) == {"roll", "pitch", "yaw"}
    for axis_values in log.axis_f.values():
        assert axis_values.shape == (n,)
        np.testing.assert_allclose(axis_values, np.zeros(n))

    # fixture has no setpoint[0-2] columns at all -> {} signals "reconstruct me"
    assert log.setpoint == {}

    # gyroADC -> gyro dict, deg/s, correct axis mapping
    np.testing.assert_allclose(log.gyro["roll"], [12 + i * 0.5 for i in range(n)])
    np.testing.assert_allclose(log.gyro["pitch"], [-8 + i * 0.3 for i in range(n)])
    np.testing.assert_allclose(log.gyro["yaw"], [3 + i * 0.1 for i in range(n)])

    # throttle: fixture rcCommand[3] is raw RC pulse width 1000-1450us ->
    # (value - 1000) / 1000 * 100
    assert log.throttle_pct.shape == (n,)
    assert log.throttle_pct.min() >= 0.0
    assert log.throttle_pct.max() <= 100.0
    np.testing.assert_allclose(log.throttle_pct[0], 0.0, atol=1e-6)
    np.testing.assert_allclose(log.throttle_pct[-1], 45.0, atol=1e-6)

    # motors: 4 motor columns in the fixture
    assert log.motor.shape == (n, 4)
    np.testing.assert_allclose(log.motor[0], [1400, 1410, 1420, 1430])

    # vbat
    assert log.vbat_v is not None
    assert log.vbat_v.shape == (n,)
    np.testing.assert_allclose(log.vbat_v[0], 16.6)


def test_load_blackbox_csv_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        load_blackbox_csv(str(FIXTURES_DIR / "does_not_exist.csv"))


def test_load_blackbox_csv_empty_file_raises(tmp_path):
    empty_csv = tmp_path / "empty.csv"
    empty_csv.write_text("")

    with pytest.raises(ValueError):
        load_blackbox_csv(str(empty_csv))


def test_load_blackbox_csv_header_only_raises(tmp_path):
    header_only_csv = tmp_path / "header_only.csv"
    header_only_csv.write_text("loopIteration,time (us),axisP[0]\n")

    with pytest.raises(ValueError):
        load_blackbox_csv(str(header_only_csv))


def test_load_blackbox_csv_non_numeric_data_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("loopIteration,time (us),axisP[0]\n0,0,not_a_number\n")

    with pytest.raises(ValueError):
        load_blackbox_csv(str(bad_csv))
