# FPV Tuner

A Betaflight Blackbox log analyzer and PID tuning assistant, built to run offline on a Raspberry Pi 2B with a touchscreen. Connects to a flight controller over USB (serial CLI + MSP) for config backup/version detection, decodes Blackbox logs, and analyzes step response, noise/FFT, and tracking error — surfacing tuning suggestions as advisory, human-reviewed recommendations, never auto-applied.

## Status

**Deployed and running on the Raspberry Pi 2B** (`rpi2b.local`) as a systemd service (`fpv-tuner.service`), verified reachable at `http://rpi2b.local:8000`. Full test suite passes on-device (real ARMv7/Python 3.13 hardware). Verified a live connection to a real Betaflight FC (4.5.1) over USB serial/CLI. Kiosk-mode display is blocked on a driver decision — see [Deploying to the Pi](#deploying-to-the-pi) below. The tuning-recommendation engine itself is not yet built (deliberately — needs validation against a real, sane Blackbox log first). See [Roadmap](#roadmap) below.

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
  tests/          pytest suite (71 tests as of this writing)
  requirements.txt
scripts/
  build_blackbox_decode.sh   clones + builds betaflight/blackbox-tools (not vendored into this repo)
  deploy_to_pi.sh            rsyncs this repo to the Pi and restarts the systemd service
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

## Deploying to the Pi

```sh
scripts/deploy_to_pi.sh          # rsyncs to rpi2b.local and restarts the service
```

One-time setup on a fresh Pi (already done on `rpi2b.local` as of this writing):

```sh
ssh rpi2b.local
sudo apt-get update && sudo apt-get install -y git build-essential python3-venv python3-pip python3-numpy python3-scipy
python3 -m venv --system-site-packages ~/fpv-tuner/backend/.venv   # --system-site-packages: use apt's numpy/scipy, don't pip-build them on a Pi 2B
source ~/fpv-tuner/backend/.venv/bin/activate
pip install fastapi uvicorn pyserial pydantic python-multipart pytest httpx
cd ~/fpv-tuner && ./scripts/build_blackbox_decode.sh
```

Then set up `fpv-tuner.service` (systemd unit running `uvicorn app.main:app --host 0.0.0.0 --port 8000` from the venv, `Restart=on-failure`, enabled at boot).

**Known deviation from `requirements.txt`**: install plain `uvicorn`, not `uvicorn[standard]` — the `[standard]` extra pulls in `uvloop`, which has no prebuilt wheel for armv7l and compiles from source for several minutes on a Pi 2B for no benefit this app needs.

### Kiosk mode — blocked on a driver decision

The connected display is a GPIO SPI touchscreen (ILI9341 panel via the legacy `fbtft` staging driver, `dtoverlay=fbtft,spi0-0,ili9341,...` in `/boot/firmware/config.txt`), exposed only as `/dev/fb1` — **it has no DRM/KMS connector at all**. This rules out Wayland-based kiosk compositors like `cage`. The standard fallback for this class of panel is **X11 + `xf86-video-fbdev` + a minimal window manager (`openbox`) + Chromium in kiosk mode** (not Wayland/`--ozone-platform=wayland`); all packages are available in the Trixie apt repos but not yet installed. This needs a decision before proceeding, since it's a real (if small) architecture change from the originally planned Wayland/`cage` approach.

### FC hardware note

A real Betaflight FC connected fine once (STM32F411, firmware 4.5.1) over `/dev/ttyACM0`, but its USB device did not re-enumerate after that session ended — `dmesg` showed a disconnect with no follow-up, alongside an "Undervoltage detected!" warning. This looks like a power/cabling issue on the physical connection, not a software one — worth checking before the next connection test.

## Safety

Per explicit project requirement (see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md#safety-strategies)): tuning recommendations are advisory only. Two independent real-world incidents — the historical Cleanflight in-flight autotune (removed for being "actively dangerous") and a 2026 official Betaflight chirp-autotune run that zeroed out pitch gain — confirm that even rigorous, officially-integrated automatic PID tuning is not safe to auto-apply. This project will never write a config change to a flight controller without an explicit, reviewed confirmation step, and never replays a config diff/dump captured on a different Betaflight version or hardware target without blocking and flagging it for manual review (`app/fc/cli_client.py::apply_config_lines`).

## Roadmap

- [x] Research reference projects and document findings (`docs/research/`)
- [x] Blackbox decode wrapper + CSV parser
- [x] FC serial/MSP/CLI client with version-aware safety gating
- [x] Analysis engine: step response, FFT/noise, tracking error
- [x] FastAPI backend wiring + kiosk frontend scaffold
- [x] Validate `blackbox_decode` build and CSV parsing against a real Betaflight `.BBL` log (found and fixed 2 real parsing/unit bugs)
- [x] Deploy to Raspberry Pi 2B hardware: builds, runs, systemd service, full test suite passing on real ARMv7/Python 3.13
- [x] Validate FC serial/CLI connection against a real Betaflight FC (found and fixed 2 real bugs around USB CDC-ACM reconnect behavior)
- [ ] Resolve kiosk-mode display approach (X11+fbdev+openbox+chromium, given the connected panel has no DRM/KMS support) and verify visually on the actual touchscreen
- [ ] Validate analysis output (step response, noise, tracking) against PIDtoolbox/PID-Analyzer/SmartTune CLI on a real log with *sane* flight data (the one real log tested so far had implausible sensor values — see git history) — see the validation workflow in `docs/research/reference-analysis.md`
- [ ] Build the tuning-recommendation engine (deliberately not started yet — needs the above validation first)
- [ ] Charting (step-response curves, FFT heatmap) in the frontend — currently placeholder boxes; see `backend/static/README.md` for the recommended lightweight charting approach
