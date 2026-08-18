"""API routes wiring the blackbox/analysis/fc/tuning modules together for
the appliance-style touchscreen UI (see docs/ for the UX flow this backs:
IDLE -> FC_DETECTED -> CONNECTED -> DOWNLOADING_LOG -> ANALYZING ->
ANALYSIS_RESULTS -> TUNE_REVIEW -> TUNE_READY -> APPLYING_TUNE -> ...).

Field names below intentionally follow the frontend's documented contract
closely (see backend/static/README.md for the original scaffold contract;
this file has since grown well beyond it as the appliance rebuild added
FC-info/blackbox-retrieval/tuning endpoints).
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path
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
from app.fc.detect import detect_fc_port
from app.fc.info import get_blackbox_storage_type, get_craft_name, get_pid_profile_index
from app.fc.blackbox_reader import BlackboxNotAvailableError, read_blackbox_from_fc
from app.fc.msp import (
    MSP_DATAFLASH_SUMMARY,
    build_msp_v1_request,
    parse_dataflash_summary_payload,
    parse_msp_v1_response,
    read_msp_v1_frame,
)
from app.jobs import create_job, get_job, run_in_background
from app.tuning.engine import compute_readiness, generate_recommendations
from app.tuning.stopping import evaluate_tune_complete
from app.tuning.store import craft_id_from_name, get_latest_iteration, load_iterations, save_iteration
from app.tuning.compare import find_best_iteration
from app.tuning.apply import apply_job_step_names, apply_tuning_changes

router = APIRouter()

_VALID_AXES = ("roll", "pitch", "yaw")

# --- In-memory session store -------------------------------------------
# A single-user kiosk app running on one Pi has no need for a database here;
# decoded logs live in memory for the lifetime of the process. Restarting
# the backend clears sessions -- acceptable for this scaffold, revisit if
# persistence across restarts becomes a real requirement.
_SESSIONS: dict[str, dict] = {}  # session_id -> {"log": BlackboxLog, "duration_s": float, "log_id": str}

# --- FC connection state -------------------------------------------------
_FC_STATE: dict = {
    "connected": False,
    "port": None,
    "firmware_version": None,
    "target": None,
    "craft_name": None,
    "pid_profile": None,
    "blackbox_storage": None,
    "blackbox_available": None,
}

# Live PID values read at connect time, e.g. {"p_roll": 45, "d_roll": 38, ...}.
# Used by the tuning engine to show absolute before/after values instead of
# relative-only changes. Cleared on disconnect, same lifetime as _FC_STATE.
_CURRENT_PIDS: dict = {}

_TARGET_PATTERN = re.compile(r"Betaflight\s*/\s*(\S+)")

_PID_PARAM_NAMES = ("p_roll", "d_roll", "p_pitch", "d_pitch")


def _reset_fc_state() -> None:
    _FC_STATE.update(
        {
            "connected": False,
            "port": None,
            "firmware_version": None,
            "target": None,
            "craft_name": None,
            "pid_profile": None,
            "blackbox_storage": None,
            "blackbox_available": None,
        }
    )
    _CURRENT_PIDS.clear()


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


@router.get("/fc/detect")
def detect_fc():
    """Passive, non-connecting poll for the touchscreen UI's IDLE ->
    FC_DETECTED transition -- see app/fc/detect.py. Intended to be polled
    every couple of seconds by the frontend while idle; does not open the
    port or affect _FC_STATE at all."""
    port = detect_fc_port()
    return {"detected": port is not None, "port": port}


class ConnectRequest(BaseModel):
    port: Optional[str] = None
    baud: int = config.FC_SERIAL_BAUD


def _query_dataflash_available(transport: SerialTransport) -> Optional[bool]:
    """Best-effort MSP_DATAFLASH_SUMMARY check, run OUTSIDE CLI mode (MSP is
    only served in normal operating mode). Returns None if it can't be
    determined (e.g. the FC doesn't respond to this MSP command) rather than
    guessing -- the UI should show honest "unknown" messaging in that case,
    not a false positive/negative."""
    try:
        transport.write(build_msp_v1_request(MSP_DATAFLASH_SUMMARY))
        # read_msp_v1_frame, not a raw oversized transport.read(4096, ...):
        # pyserial's read(n) blocks for the full timeout when fewer than n
        # bytes will ever arrive, which made this stall for a flat 2s on
        # every connect (confirmed against real hardware) instead of
        # returning as soon as the ~20-byte response actually showed up.
        raw = read_msp_v1_frame(transport, timeout=2.0)
        _, payload = parse_msp_v1_response(raw)
        summary = parse_dataflash_summary_payload(payload)
        return summary.ready and summary.used_size_bytes > 0
    except (SerialTransportError, ValueError):
        return None


@router.post("/fc/connect")
def connect_fc(body: ConnectRequest = ConnectRequest()):
    """Attempt a USB serial + CLI connection to the flight controller, and
    gather everything the Connected/FC-Information screen needs in one
    round trip: version, target, craft name, PID profile, blackbox storage
    type/availability, and current roll/pitch PID values (used later by the
    tuning engine to show absolute before/after values).

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

            craft_name = get_craft_name(client)
            blackbox_storage = get_blackbox_storage_type(client)
            pid_profile = get_pid_profile_index(client)

            current_pids: dict = {}
            for param in _PID_PARAM_NAMES:
                response = client.run_command(f"get {param}")
                match = re.search(rf"{re.escape(param)}\s*=\s*(-?\d+(?:\.\d+)?)", response, re.IGNORECASE)
                if match:
                    current_pids[param] = float(match.group(1))
        finally:
            client.exit_cli()

        blackbox_available: Optional[bool] = None
        if blackbox_storage == "SPIFLASH":
            blackbox_available = _query_dataflash_available(transport)
    except SerialTransportError as exc:
        _reset_fc_state()
        return {"success": False, "message": str(exc)}
    finally:
        transport.close()

    if version is None:
        _reset_fc_state()
        return {"success": False, "message": f"Connected to {port} but could not parse a Betaflight version banner."}

    target_match = _TARGET_PATTERN.search(banner)
    _FC_STATE.update(
        {
            "connected": True,
            "port": port,
            "firmware_version": version.raw,
            "target": target_match.group(1) if target_match else None,
            "craft_name": craft_name,
            "pid_profile": pid_profile,
            "blackbox_storage": blackbox_storage,
            "blackbox_available": blackbox_available,
        }
    )
    _CURRENT_PIDS.clear()
    _CURRENT_PIDS.update(current_pids)
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


def _decode_and_register_sessions(log_path: Path, log_id: str) -> list[dict]:
    """Shared by /logs/upload and the FC-download job: decode a raw
    .bbl/.bfl file and register each usable embedded session. Raises
    RuntimeError/FileNotFoundError on decode failure; returns [] (not an
    error) if decode succeeded but no session was usable, so callers can
    decide the right error framing for their own endpoint."""
    output_dir = config.DECODE_OUTPUT_DIR / log_id
    csv_paths = decode_log(str(log_path), output_dir=str(output_dir), extra_args=_DECODE_UNIT_ARGS)

    sessions = []
    for i, csv_path in enumerate(csv_paths):
        try:
            log = load_blackbox_csv(csv_path)
        except ValueError:
            # Skip a malformed/empty embedded session rather than failing the
            # whole upload -- a multi-session .BBL can contain short garbage
            # fragments (see docs/research/reference-analysis.md, blackbox-tools
            # issue #30 on this exact class of problem).
            continue

        session_id = f"{log_id}-{i}"
        duration_s = float(log.time_s[-1]) if len(log.time_s) else 0.0
        _SESSIONS[session_id] = {"log": log, "duration_s": duration_s, "log_id": log_id}
        sessions.append({"session_id": session_id, "duration_s": duration_s})

    return sessions


@router.post("/logs/upload")
def upload_log(file: UploadFile = File(...)):
    log_id = uuid.uuid4().hex[:12]
    dest = config.LOG_UPLOAD_DIR / f"{log_id}_{file.filename}"
    with open(dest, "wb") as f:
        f.write(file.file.read())

    try:
        sessions = _decode_and_register_sessions(dest, log_id)
    except (FileNotFoundError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if not sessions:
        raise HTTPException(status_code=422, detail="No usable Blackbox sessions found in this log file.")

    return {"log_id": log_id, "sessions": sessions}


@router.post("/logs/download-from-fc")
def download_log_from_fc():
    """Kick off a Job that pulls the Blackbox log directly off the
    currently-connected FC's SPI dataflash (see app/fc/blackbox_reader.py),
    decodes it, and registers session(s) -- the backend for the touchscreen's
    "DOWNLOAD BLACKBOX" button. Returns immediately with a job_id; poll
    GET /api/jobs/{job_id} for progress, per the UX spec's real-progress-
    stages requirement (Downloading log / Decoding / Registering session).
    """
    if not _FC_STATE["connected"] or not _FC_STATE["port"]:
        raise HTTPException(status_code=409, detail="No flight controller is connected.")
    if _FC_STATE["blackbox_storage"] != "SPIFLASH":
        storage = _FC_STATE["blackbox_storage"] or "unknown"
        raise HTTPException(
            status_code=422,
            detail=(
                f"This FC's Blackbox storage is {storage}, not onboard SPI flash -- "
                "direct download isn't supported for this storage type. "
                "Use the file-upload option instead."
            ),
        )
    if _FC_STATE["blackbox_available"] is False:
        raise HTTPException(status_code=422, detail="No Blackbox log is stored on this FC yet.")

    port = _FC_STATE["port"]
    baud = config.FC_SERIAL_BAUD
    job = create_job(["Downloading log", "Decoding", "Registering session"])

    def _work(job) -> dict:
        job.set_step("Downloading log", "in_progress")
        transport = SerialTransport(port, baud=baud)
        try:
            transport.open()

            def on_progress(done: int, total: int) -> None:
                pct = int(round(done / total * 100)) if total else 0
                job.set_step("Downloading log", "in_progress", f"{pct}%")

            try:
                raw_bytes = read_blackbox_from_fc(transport, on_progress=on_progress)
            except BlackboxNotAvailableError as exc:
                raise RuntimeError(str(exc)) from exc
        finally:
            transport.close()
        job.set_step("Downloading log", "done")

        job.set_step("Decoding", "in_progress")
        log_id = uuid.uuid4().hex[:12]
        dest = config.LOG_UPLOAD_DIR / f"{log_id}_fc_download.bbl"
        with open(dest, "wb") as f:
            f.write(raw_bytes)
        sessions = _decode_and_register_sessions(dest, log_id)
        job.set_step("Decoding", "done")

        job.set_step("Registering session", "in_progress")
        if not sessions:
            raise RuntimeError("Downloaded log decoded but contained no usable sessions.")
        job.set_step("Registering session", "done")

        return {"log_id": log_id, "sessions": sessions}

    run_in_background(job, _work)
    return {"job_id": job.id}


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


# ---------------------------------------------------------------------------
# Tuning: recommendations, readiness, apply, iteration history
# ---------------------------------------------------------------------------


def _recommendation_inputs_for_session(log: BlackboxLog) -> tuple[dict, dict, dict]:
    """Gather the per-axis analysis objects the tuning engine consumes,
    for roll/pitch only (v1 scope -- see app/tuning/engine.py)."""
    step_by_axis, dterm_by_axis, tracking_by_axis = {}, {}, {}
    for axis in ("roll", "pitch"):
        step_by_axis[axis] = compute_step_response(log, axis)
        dterm_by_axis[axis] = compute_dterm_noise_metrics(log, axis)
        tracking_by_axis[axis] = compute_tracking_error_stats(log, axis)
    return step_by_axis, dterm_by_axis, tracking_by_axis


def _recommendation_to_dict(rec) -> dict:
    return {
        "parameter": rec.parameter,
        "axis": rec.axis,
        "current_value": rec.current_value,
        "proposed_value": rec.proposed_value,
        "change_pct": rec.change_pct,
        "reason": rec.reason,
        "confidence_pct": rec.confidence_pct,
        "category": rec.category,
    }


@router.get("/tuning/recommendations")
def get_tuning_recommendations(session_id: str):
    log = _require_session(session_id)
    step_by_axis, dterm_by_axis, tracking_by_axis = _recommendation_inputs_for_session(log)
    current_pids = dict(_CURRENT_PIDS) if _FC_STATE["connected"] else None
    recommendations = generate_recommendations(step_by_axis, dterm_by_axis, tracking_by_axis, current_pids)
    return _json_safe({"recommendations": [_recommendation_to_dict(r) for r in recommendations]})


@router.get("/tuning/readiness")
def get_tuning_readiness(session_id: str):
    log = _require_session(session_id)
    step_by_axis, dterm_by_axis, tracking_by_axis = _recommendation_inputs_for_session(log)
    current_pids = dict(_CURRENT_PIDS) if _FC_STATE["connected"] else None
    recommendations = generate_recommendations(step_by_axis, dterm_by_axis, tracking_by_axis, current_pids)

    # "Version supported" and "settings read ok" are judged here (not in the
    # engine, which has no FC-connection knowledge) using what /fc/connect
    # already gathered -- see app/tuning/engine.py's compute_readiness
    # docstring for why this split exists.
    version_supported = bool(_FC_STATE["connected"] and _FC_STATE["firmware_version"])
    settings_read_ok = bool(_FC_STATE["connected"] and _CURRENT_PIDS)

    readiness = compute_readiness(recommendations, version_supported, settings_read_ok)
    return _json_safe(
        {
            "version_supported": readiness.version_supported,
            "settings_read_ok": readiness.settings_read_ok,
            "safety_passed": readiness.safety_passed,
            "confidence_pct": readiness.confidence_pct,
            "blocked": readiness.blocked,
            "block_reasons": readiness.block_reasons,
        }
    )


@router.post("/tuning/apply")
def apply_tuning(session_id: str):
    """Write the currently-recommended changes to the connected FC --
    SAFETY-CRITICAL, see app/tuning/apply.py. Blocked entirely if
    /tuning/readiness would report blocked=True (re-checked here, not just
    trusted from an earlier UI read, since state may have changed)."""
    log = _require_session(session_id)
    if not _FC_STATE["connected"] or not _FC_STATE["port"]:
        raise HTTPException(status_code=409, detail="No flight controller is connected.")

    step_by_axis, dterm_by_axis, tracking_by_axis = _recommendation_inputs_for_session(log)
    current_pids = dict(_CURRENT_PIDS)
    recommendations = generate_recommendations(step_by_axis, dterm_by_axis, tracking_by_axis, current_pids)
    if not recommendations:
        raise HTTPException(status_code=422, detail="No tuning changes to apply for this session.")

    version_supported = bool(_FC_STATE["firmware_version"])
    settings_read_ok = bool(_CURRENT_PIDS)
    readiness = compute_readiness(recommendations, version_supported, settings_read_ok)
    if readiness.blocked:
        raise HTTPException(status_code=409, detail={"message": "Tune is not ready to apply.", "reasons": readiness.block_reasons})

    port = _FC_STATE["port"]
    baud = config.FC_SERIAL_BAUD
    craft_id = craft_id_from_name(_FC_STATE["craft_name"])

    # Snapshot the pre-apply analysis summary now (while we still have the
    # session) so the iteration record reflects "what this tune was based
    # on", per store.py's docstring -- the post-flight result becomes its
    # own later iteration once the user re-analyzes after flying.
    pre_apply_summary = get_analysis_summary(session_id)

    job = create_job(apply_job_step_names())

    def _reconnect() -> Optional[BetaflightCliClient]:
        candidate = SerialTransport(port, baud=baud)
        try:
            candidate.open()
        except SerialTransportError:
            return None
        try:
            client = BetaflightCliClient(candidate)
            client.enter_cli()
            return client
        except SerialTransportError:
            candidate.close()
            return None

    def _work(job) -> dict:
        transport = SerialTransport(port, baud=baud)
        transport.open()
        client = BetaflightCliClient(transport)
        client.enter_cli()
        try:
            outcome = apply_tuning_changes(client, recommendations, job, reconnect_fn=_reconnect)
        finally:
            try:
                transport.close()
            except SerialTransportError:
                pass

        if not outcome["aborted"]:
            save_iteration(
                craft_id,
                label="Applied",
                applied_changes=[
                    {"parameter": r.parameter, "from": r.current_value, "to": r.proposed_value}
                    for r in recommendations
                ],
                analysis_summary=pre_apply_summary,
            )
        return outcome

    run_in_background(job, _work)
    return {"job_id": job.id}


class RecordIterationRequest(BaseModel):
    session_id: str
    label: str = "Baseline"


@router.post("/tuning/record-iteration")
def record_iteration(body: RecordIterationRequest):
    """Explicitly record the current session's analysis as a named
    iteration for the connected craft -- called by the frontend at specific
    UX moments (e.g. the first-ever analysis for a craft with no history
    yet becomes "Baseline"), rather than any GET endpoint having the side
    effect of silently persisting history."""
    log = _require_session(body.session_id)  # validates the session exists
    summary = get_analysis_summary(body.session_id)
    craft_id = craft_id_from_name(_FC_STATE["craft_name"])
    iteration = save_iteration(craft_id, label=body.label, applied_changes=[], analysis_summary=summary)
    return {"craft_id": craft_id, "iteration_number": iteration.number}


@router.get("/tuning/iterations")
def get_tuning_iterations(craft: Optional[str] = None):
    """Iteration history for the given craft (or the currently-connected
    FC's craft name if not specified), plus best-tune and tune-complete
    evaluation -- see UX spec sections 13-15."""
    craft_name = craft if craft is not None else _FC_STATE["craft_name"]
    craft_id = craft_id_from_name(craft_name)
    iterations = load_iterations(craft_id)

    best_number = find_best_iteration(iterations)
    latest = iterations[-1] if iterations else None
    previous = iterations[-2] if len(iterations) >= 2 else None

    if latest is not None:
        stopping = evaluate_tune_complete(latest.analysis_summary, previous.analysis_summary if previous else None)
    else:
        stopping = {"tune_complete": False, "reasons": ["No analysis recorded yet for this craft."], "improvement_pct": None}

    return _json_safe(
        {
            "craft_id": craft_id,
            "iterations": [
                {
                    "number": it.number,
                    "timestamp": it.timestamp,
                    "label": it.label,
                    "applied_changes": it.applied_changes,
                    "analysis_summary": it.analysis_summary,
                }
                for it in iterations
            ],
            "best_iteration": best_number,
            "current_is_best": (best_number == latest.number) if latest else None,
            "tune_complete": stopping["tune_complete"],
            "stopping_reasons": stopping["reasons"],
        }
    )
