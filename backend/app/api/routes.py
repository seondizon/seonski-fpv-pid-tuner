"""API routes wiring the blackbox/analysis/fc modules together.

Implements the contract documented in backend/static/README.md ("Assumed
backend API contract"), which the frontend was built against. Field names
below intentionally follow that contract closely, with real analysis-module
field names passed through where the contract's placeholder example used a
different label (documented inline where that happens).

Deliberately NOT implemented: `GET /api/tuning/recommendations`. The
recommendation engine itself is out of scope for this scaffold (per the
project's safety-first design -- see docs/research/tuning-algorithms.md
"Safety Strategies" -- recommendation logic needs its own validation pass
before it should produce anything a user sees). The frontend already
degrades gracefully to labeled example cards when this route 404s, so
leaving it unimplemented is the intentionally honest behavior here rather
than faking a 200 with an empty list.
"""

from __future__ import annotations

import re
import uuid
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel
from scipy.signal.windows import hann

from app import config
from app.blackbox.decode import decode_log
from app.blackbox.logdata import BlackboxLog, load_blackbox_csv
from app.analysis.step_response import compute_step_response
from app.analysis.fft_noise import compute_throttle_noise_heatmap, detect_noise_peaks, compute_dterm_noise_metrics
from app.analysis.tracking import compute_tracking_error_stats
from app.analysis import grading
from app.fc.serial_transport import SerialTransport, SerialTransportError
from app.fc.cli_client import BetaflightCliClient
from app.fc.version import parse_version_from_cli_banner
from app.jobs import get_job

router = APIRouter()

_VALID_AXES = ("roll", "pitch", "yaw")

# --- In-memory session store -------------------------------------------
# A single-user kiosk app running on one Pi has no need for a database here;
# decoded logs live in memory for the lifetime of the process. Restarting
# the backend clears sessions -- acceptable for this scaffold, revisit if
# persistence across restarts becomes a real requirement.
_SESSIONS: dict[str, dict] = {}  # session_id -> {"log": BlackboxLog, "duration_s": float, "log_id": str}

# --- FC connection state -------------------------------------------------
_FC_STATE: dict = {"connected": False, "port": None, "firmware_version": None, "target": None}

_TARGET_PATTERN = re.compile(r"Betaflight\s*/\s*(\S+)")


def _require_axis(axis: str) -> str:
    if axis not in _VALID_AXES:
        raise HTTPException(status_code=422, detail=f"axis must be one of {_VALID_AXES}, got {axis!r}")
    return axis


def _require_session(session_id: str) -> BlackboxLog:
    entry = _SESSIONS.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown session_id: {session_id!r}")
    return entry["log"]


def _json_safe(value):
    """Recursively replace NaN/Infinity with None.

    Several analysis-layer functions deliberately return NaN for
    not-well-defined statistics (e.g. an empty stick-deflection bin, per
    tracking.py's compute_tracking_error_stats docstring: "A bin with zero
    samples reports NaN ... rather than raising") -- a sound analysis-layer
    contract, but Starlette's default JSONResponse renders with
    allow_nan=False (strict JSON), so any NaN/Infinity reaching this layer
    unconverted crashes the whole response with a 500. This is the API
    boundary's job to fix, not the analysis layer's.
    """
    if isinstance(value, float):
        return None if (value != value or value in (float("inf"), float("-inf"))) else value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# FC connection
# ---------------------------------------------------------------------------


@router.get("/fc/status")
def get_fc_status():
    return dict(_FC_STATE)


class ConnectRequest(BaseModel):
    port: Optional[str] = None
    baud: int = config.FC_SERIAL_BAUD


@router.post("/fc/connect")
def connect_fc(body: ConnectRequest = ConnectRequest()):
    """Attempt a USB serial + CLI connection to the flight controller.

    Blocking serial I/O -- this is a sync `def` route so FastAPI runs it in
    its worker threadpool rather than blocking the event loop.
    """
    port = body.port or config.FC_SERIAL_PORT
    if not port:
        candidates = _autodetect_ports()
        if not candidates:
            return {"success": False, "message": "No serial port specified and none could be auto-detected."}
        port = candidates[0]

    transport = SerialTransport(port, baud=body.baud)
    try:
        transport.open()
        client = BetaflightCliClient(transport)
        client.enter_cli()
        try:
            # Run `version` once and parse it ourselves (rather than
            # client.get_version(), which parses internally but doesn't
            # expose the raw banner) -- we need the raw text either way to
            # extract the target board, not just the version number.
            # BUG FOUND against a real FC: the previous version of this code
            # only re-ran `version` to get a banner when parsing had already
            # failed, so `target` came out null on every successful connect
            # (confirmed live: a real Betaflight 4.5.1 FC connected fine but
            # reported target: null).
            banner = client.run_command("version")
            version = parse_version_from_cli_banner(banner)
        finally:
            client.exit_cli()
    except SerialTransportError as exc:
        _FC_STATE.update({"connected": False, "port": None, "firmware_version": None, "target": None})
        return {"success": False, "message": str(exc)}
    finally:
        transport.close()

    if version is None:
        _FC_STATE.update({"connected": False, "port": None, "firmware_version": None, "target": None})
        return {"success": False, "message": f"Connected to {port} but could not parse a Betaflight version banner."}

    target_match = _TARGET_PATTERN.search(banner)
    _FC_STATE.update(
        {
            "connected": True,
            "port": port,
            "firmware_version": version.raw,
            "target": target_match.group(1) if target_match else None,
        }
    )
    return {"success": True, "message": f"Connected to Betaflight {version.raw} on {port}."}


def _autodetect_ports() -> list[str]:
    try:
        from serial.tools import list_ports  # type: ignore
    except ImportError:
        return []
    return [p.device for p in list_ports.comports()]


# ---------------------------------------------------------------------------
# Blackbox log upload
# ---------------------------------------------------------------------------


# Every analysis module (step_response's 20-500 SP-amplitude gate, the D-term
# noise thresholds, etc.) assumes gyro/setpoint are in deg/s and vbat is in
# volts -- blackbox_decode's own defaults are "raw" firmware units for
# rotation/acceleration, which are NOT deg/s/g and would silently break every
# unit-dependent threshold in the analysis layer without ever raising an
# error. This was caught by testing against a real downloaded .bbl log
# (see docs/research -- always request explicit units at decode time, never
# rely on blackbox_decode's raw default.
_DECODE_UNIT_ARGS = ["--unit-rotation", "deg/s", "--unit-acceleration", "g", "--unit-vbat", "V"]


@router.post("/logs/upload")
def upload_log(file: UploadFile = File(...)):
    log_id = uuid.uuid4().hex[:12]
    dest = config.LOG_UPLOAD_DIR / f"{log_id}_{file.filename}"
    with open(dest, "wb") as f:
        f.write(file.file.read())

    output_dir = config.DECODE_OUTPUT_DIR / log_id
    try:
        csv_paths = decode_log(str(dest), output_dir=str(output_dir), extra_args=_DECODE_UNIT_ARGS)
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    sessions = []
    for i, csv_path in enumerate(csv_paths):
        try:
            log = load_blackbox_csv(csv_path)
        except ValueError as exc:
            # Skip a malformed/empty embedded session rather than failing the
            # whole upload -- a multi-session .BBL can contain short garbage
            # fragments (see docs/research/reference-analysis.md, blackbox-tools
            # issue #30 on this exact class of problem).
            continue

        session_id = f"{log_id}-{i}"
        duration_s = float(log.time_s[-1]) if len(log.time_s) else 0.0
        _SESSIONS[session_id] = {"log": log, "duration_s": duration_s, "log_id": log_id}
        sessions.append({"session_id": session_id, "duration_s": duration_s})

    if not sessions:
        raise HTTPException(status_code=422, detail="No usable Blackbox sessions found in this log file.")

    return {"log_id": log_id, "sessions": sessions}


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


@router.get("/analysis/step-response")
def get_step_response(session_id: str, axis: str):
    axis = _require_axis(axis)
    log = _require_session(session_id)
    result = compute_step_response(log, axis)
    return _json_safe(
        {
            "axis": axis,
            "overshoot_pct": result.overshoot_pct,
            "rise_time_s": result.rise_time_s,
            "settling_time_s": result.settling_time_s,
            # Extra fields beyond the frontend's documented contract -- additive,
            # safe for the current UI (it only reads the three keys above) and
            # useful once a richer analysis view is built.
            "steady_state_error_pct": result.steady_state_error_pct,
            "num_segments_used": result.num_segments_used,
            "num_segments_rejected": result.num_segments_rejected,
        }
    )


@router.get("/analysis/noise")
def get_noise(session_id: str, axis: str):
    axis = _require_axis(axis)
    log = _require_session(session_id)

    signal = log.gyro[axis]
    if signal.size < 8:
        return {"axis": axis, "peaks": []}

    # Single whole-session Hann-windowed spectrum for peak-picking (distinct
    # from the throttle-binned heatmap below, which is exposed separately
    # once the frontend grows a heatmap view -- see backend/static/README.md
    # chart-placeholder notes).
    win = hann(signal.size, sym=False)
    spectrum = np.abs(np.fft.rfft(signal * win))
    freq_hz = np.fft.rfftfreq(signal.size, d=1.0 / log.sample_rate_hz)

    peaks = detect_noise_peaks(freq_hz, spectrum)
    return _json_safe(
        {
            "axis": axis,
            "peaks": [
                {
                    "freq_hz": p.freq_hz,
                    # The frontend's placeholder contract called this "amplitude"
                    # (implying a 0-1-ish scale); our detector's native unit is
                    # dB magnitude. Passed through as-is -- the UI just displays
                    # the number, and dB is the more meaningful unit for a real
                    # noise-analysis view.
                    "amplitude": p.magnitude_db,
                    "classification": p.classification,
                }
                for p in peaks
            ],
        }
    )


@router.get("/analysis/noise/heatmap")
def get_noise_heatmap(session_id: str, axis: str):
    """Not part of the frontend's current contract (which only stubs a chart
    placeholder for this view) -- exposed now so the throttle-binned heatmap
    the analysis module already computes isn't stranded once a real chart
    (uPlot/Chart.js, per backend/static/README.md) gets wired up."""
    axis = _require_axis(axis)
    log = _require_session(session_id)
    spectrogram = compute_throttle_noise_heatmap(log.gyro[axis], log.throttle_pct, log.sample_rate_hz)
    return _json_safe(
        {
            "axis": axis,
            "throttle_bins_pct": spectrogram.throttle_bins_pct.tolist(),
            "freq_hz": spectrogram.freq_hz.tolist(),
            "magnitude": spectrogram.magnitude.tolist(),
        }
    )


@router.get("/analysis/tracking")
def get_tracking(session_id: str, axis: str):
    axis = _require_axis(axis)
    log = _require_session(session_id)
    stats = compute_tracking_error_stats(log, axis)
    stick_bins = [
        {
            "bin": f"{pct:g}%",
            "mae": stats.mean_abs_error_by_stick_bin[pct],
            "sem": stats.sem_by_stick_bin[pct],
        }
        for pct in sorted(stats.mean_abs_error_by_stick_bin)
    ]
    return _json_safe({"axis": axis, "error_std": stats.error_std, "stick_bins": stick_bins})


@router.get("/analysis/summary")
def get_analysis_summary(session_id: str):
    """Consolidated, pre-graded results for the touchscreen's paginated
    result cards (Overview / Roll / Pitch / Noise) -- one call instead of
    the frontend making 3+ axis-by-axis requests and computing grades
    itself. Grading thresholds live in app/analysis/grading.py so this
    endpoint and the tuning engine agree on what "GOOD"/"FAIR"/"POOR" mean.
    """
    log = _require_session(session_id)

    axes_out: dict[str, dict] = {}
    axis_grades: list[str] = []
    for axis in ("roll", "pitch", "yaw"):
        step = compute_step_response(log, axis)
        tracking = compute_tracking_error_stats(log, axis)
        overshoot_grade = grading.grade_overshoot(step.overshoot_pct)
        tracking_grade = grading.grade_tracking_error_std(tracking.error_std)
        axis_grade = grading.overall_grade([overshoot_grade, tracking_grade])
        axis_grades.append(axis_grade)
        axes_out[axis] = {
            "grade": axis_grade,
            "tracking_pct": grading.tracking_error_std_to_pct(tracking.error_std),
            "overshoot_pct": step.overshoot_pct,
            "settling_time_ms": None if step.settling_time_s is None else round(step.settling_time_s * 1000, 1),
            "oscillation": grading.grade_oscillation(step.overshoot_pct, step.settling_time_s),
            "events_used": step.num_segments_used,
        }

    dterm_roll = compute_dterm_noise_metrics(log, "roll")
    dterm_grade = grading.grade_dterm_noise(dterm_roll.d_p_ratio, dterm_roll.hf_energy_ratio)

    win = hann(log.gyro["roll"].size, sym=False) if log.gyro["roll"].size >= 8 else None
    main_peak = None
    motor_harmonic_likely = False
    if win is not None:
        spectrum = np.abs(np.fft.rfft(log.gyro["roll"] * win))
        freq_hz = np.fft.rfftfreq(log.gyro["roll"].size, d=1.0 / log.sample_rate_hz)
        peaks = detect_noise_peaks(freq_hz, spectrum)
        if peaks:
            top = max(peaks, key=lambda p: p.magnitude_db)
            main_peak = {"freq_hz": top.freq_hz, "classification": top.classification}
            motor_harmonic_likely = top.classification in ("motor", "prop_blade_pass")

    gyro_grade = "GOOD" if dterm_roll.hf_energy_ratio is not None and dterm_roll.hf_energy_ratio < 0.3 else "FAIR"
    noise_out = {
        "gyro_grade": gyro_grade,
        "dterm_grade": dterm_grade,
        "main_peak_hz": main_peak["freq_hz"] if main_peak else None,
        "main_peak_classification": main_peak["classification"] if main_peak else None,
        "motor_harmonic_likely": motor_harmonic_likely,
    }

    overall = grading.overall_grade(axis_grades + [dterm_grade, gyro_grade])
    # Confidence is a simple, honest placeholder here (data volume only) --
    # the real per-recommendation confidence scoring lives in the tuning
    # engine (app/tuning/), which has more context (data-quality score per
    # docs/research/tuning-algorithms.md) to do this properly.
    total_events = sum(axes_out[a]["events_used"] for a in ("roll", "pitch"))
    confidence_pct = min(95, 40 + total_events * 2)

    return _json_safe(
        {
            "overall_grade": overall,
            "confidence_pct": confidence_pct,
            "axes": axes_out,
            "noise": noise_out,
        }
    )


# ---------------------------------------------------------------------------
# Background jobs (shared polling endpoint for long-running work)
# ---------------------------------------------------------------------------


@router.get("/jobs/{job_id}")
def get_job_status(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job_id: {job_id!r}")
    return _json_safe(job.to_dict())
