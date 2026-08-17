# FPV Tuner

A Betaflight Blackbox log analyzer and PID tuning assistant, built to run offline on a Raspberry Pi 2B with a touchscreen. Connects to a flight controller over USB (serial CLI + MSP) for config backup/version detection, decodes Blackbox logs, and analyzes step response, noise/FFT, and tracking error — surfacing tuning suggestions as advisory, human-reviewed recommendations, never auto-applied.

## Status

Early scaffold. Research phase and initial module implementation are done; the FC-write path, real hardware validation, and the tuning-recommendation engine itself are not yet built. See [Roadmap](#roadmap) below.

## Architecture

- **Backend**: Python (FastAPI), serving both the JSON API and the frontend static files from one process.
- **Frontend**: A single-page, dependency-free HTML/CSS/vanilla-JS app (`backend/static/`), meant to run in a browser in kiosk mode on the Pi's touchscreen. No build step, no framework — deliberately light for a 1GB-RAM Pi 2B already running a full browser engine.
- **FC connection**: USB serial, both MSP (live version/telemetry) and CLI (config backup/restore via `diff all`/`dump all`).
- **Blackbox decoding**: shells out to Betaflight's own `blackbox_decode` binary (GPL-3.0) as an external process rather than reimplementing or vendoring its C source — see [`docs/research/licenses.md`](docs/research/licenses.md).
- **Analysis**: clean-room Python/NumPy/SciPy reimplementation of Wiener-deconvolution step response, throttle-binned FFT noise heatmaps, D-term noise metrics, and PID tracking-error statistics, synthesized from PIDtoolbox/PID-Analyzer/SmartTune CLI research — see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md).

These decisions (USB-serial FC link, local web UI in kiosk mode) were made deliberately up front rather than assumed — see [`docs/research/reference-analysis.md`](docs/research/reference-analysis.md) for the full research this project is built on.

## Repository layout

```
backend/
  app/
    blackbox/     decode.py (blackbox_decode subprocess wrapper), logdata.py (CSV -> BlackboxLog)
    analysis/     step_response.py, fft_noise.py, tracking.py, setpoint.py
    fc/           serial_transport.py, msp.py, version.py, cli_client.py
    api/          routes.py (the HTTP API)
    main.py       FastAPI app entrypoint
    config.py     paths, env-var overrides
  static/         kiosk frontend (index.html, app.js, styles.css) -- see static/README.md for the API contract it's built against
  tests/          pytest suite (68 tests as of this writing)
  requirements.txt
scripts/
  build_blackbox_decode.sh   clones + builds betaflight/blackbox-tools (not vendored into this repo)
docs/research/
  reference-analysis.md      per-project findings (Betaflight blackbox-tools, PIDtoolbox, PID-Analyzer, SmartTune CLI, FPVtune/autotuning projects, official docs)
  tuning-algorithms.md        cross-project algorithm synthesis -- what we implement and why
  licenses.md                 what we can/can't reuse from each reference project, and why
```

## Getting started (development)

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# One-time: build the external blackbox_decode binary (GPL-3.0, kept out of
# this repo -- see docs/research/licenses.md). Requires git, make, and a C
# compiler.
../scripts/build_blackbox_decode.sh

# Run the app
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Then open `http://localhost:8000/` in a browser. On the Pi, this same server would be pointed at by a Chromium/Firefox kiosk-mode session on the touchscreen instead.

Run tests:

```sh
cd backend
python3 -m pytest tests -v
```

## Safety

Per explicit project requirement (see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md#safety-strategies)): tuning recommendations are advisory only. Two independent real-world incidents — the historical Cleanflight in-flight autotune (removed for being "actively dangerous") and a 2026 official Betaflight chirp-autotune run that zeroed out pitch gain — confirm that even rigorous, officially-integrated automatic PID tuning is not safe to auto-apply. This project will never write a config change to a flight controller without an explicit, reviewed confirmation step, and never replays a config diff/dump captured on a different Betaflight version or hardware target without blocking and flagging it for manual review (`app/fc/cli_client.py::apply_config_lines`).

## Roadmap

- [x] Research reference projects and document findings (`docs/research/`)
- [x] Blackbox decode wrapper + CSV parser
- [x] FC serial/MSP/CLI client with version-aware safety gating
- [x] Analysis engine: step response, FFT/noise, tracking error
- [x] FastAPI backend wiring + kiosk frontend scaffold
- [ ] Validate `blackbox_decode` build and CSV parsing against a real Betaflight `.BBL` log (everything so far has been validated against synthetic fixtures only — no real hardware/log was available in this development environment)
- [ ] Validate analysis output against PIDtoolbox/PID-Analyzer/SmartTune CLI on the same real log (see the validation workflow in `docs/research/reference-analysis.md`)
- [ ] Build the tuning-recommendation engine (deliberately not started yet — needs the above validation first)
- [ ] Real hardware testing on Raspberry Pi 2B + touchscreen, in kiosk mode
- [ ] Charting (step-response curves, FFT heatmap) in the frontend — currently placeholder boxes; see `backend/static/README.md` for the recommended lightweight charting approach
