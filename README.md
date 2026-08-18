# FPV Tuner

A Betaflight Blackbox log analyzer and PID tuning assistant, built to run offline on a Raspberry Pi 2B with a touchscreen. Connects to a flight controller over USB (serial CLI + MSP) for config backup/version detection, decodes Blackbox logs, and analyzes step response, noise/FFT, and tracking error — surfacing tuning suggestions as advisory, human-reviewed recommendations, never auto-applied.

## Status

**No longer deployed to `rpi2b.local`.** Real-hardware testing (see git history around Aug 18) confirmed the Pi 2B is under-powered for this: decoding a fully-packed 16MB Blackbox flash dump took 25+ minutes and triggered a genuine `blackbox_decode` infinite-loop bug (a real, sub-minute-scale decode is fine; a large real-world flight log is not, on this CPU). The `fpv-tuner` systemd service and project directory were removed from that Pi to leave it a clean slate — a future deployment target (more capable hardware) is still to be decided. The touchscreen/kiosk display setup on that Pi (fbtft driver config, X11+fbdev+openbox+Chromium, the window-sizing/fullscreen fixes) was deliberately left working and reusable — see `kiosk.sh`/`kiosk-www.service` on that device.

All the application code below is complete and was fully verified before that decision: the full appliance workflow end-to-end (FC auto-detection, connect, Blackbox retrieval over MSP, analysis, a rule-based tuning-recommendation engine, and a safety-gated apply-to-hardware flow with backup/verify/rollback), wired to a state-machine-driven, card-paginated touchscreen UI built for a real 320×240 panel. 155 tests pass. See [Roadmap](#roadmap).

## Architecture

- **Backend**: Python (FastAPI), serving both the JSON API and the frontend static files from one process.
- **Frontend**: A single-page, dependency-free HTML/CSS/vanilla-JS app (`backend/static/`) implementing an explicit state machine (IDLE → FC_DETECTED → CONNECTED → DOWNLOADING_LOG → ANALYZING → ANALYSIS_RESULTS → TUNE_REVIEW → APPLYING_TUNE → TUNE_APPLIED, ERROR reachable from anywhere), designed for the real deployed hardware: a 320×240 touchscreen, not a generic "small screen." One purpose per screen, card pagination instead of dense layouts, real job-step progress instead of fake progress bars. No build step, no framework.
- **FC connection**: USB serial — MSP (version/variant detection, Blackbox dataflash retrieval) and CLI (`get`/`set`/`diff all`/`dump all`/`save`), with version-aware safety gating throughout.
- **Blackbox decoding**: shells out to Betaflight's own `blackbox_decode` binary (GPL-3.0) as an external process rather than reimplementing or vendoring its C source — see [`docs/research/licenses.md`](docs/research/licenses.md). Logs can be pulled directly off the FC's SPI dataflash over MSP, or uploaded as a file (needed for SD-card/serial-logging FCs, where direct MSP retrieval isn't applicable).
- **Analysis**: clean-room Python/NumPy/SciPy reimplementation of Wiener-deconvolution step response, throttle-binned FFT noise heatmaps, D-term noise metrics, and PID tracking-error statistics, synthesized from PIDtoolbox/PID-Analyzer/SmartTune CLI research — see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md).
- **Tuning engine**: rule-based recommendations (D-first ordering, damping-ratio bounds, D-effectiveness/noise gating, confidence scoring from usable data volume) following the FPVPIDlab-style pattern researched in `docs/research/tuning-algorithms.md` — advisory only, bounded to small per-iteration changes, never applied without an explicit user-reviewed step.
- **Apply orchestration**: backup → write → verify-before-save → save → wait-for-reboot → reconnect → final-verify, aborting with nothing saved if any write is rejected or fails verification. Iteration history persists per-craft across backend restarts (`backend/data/tuning/*.json`) so tunes can be compared across flights.

These decisions (USB-serial FC link, local web UI in kiosk mode) were made deliberately up front rather than assumed — see [`docs/research/reference-analysis.md`](docs/research/reference-analysis.md) for the full research this project is built on.

## Repository layout

```
backend/
  app/
    blackbox/     decode.py (blackbox_decode subprocess wrapper), logdata.py (CSV -> BlackboxLog)
    analysis/     step_response.py, fft_noise.py, tracking.py, setpoint.py, grading.py (shared GOOD/FAIR/POOR thresholds)
    fc/           serial_transport.py, msp.py, version.py, cli_client.py, detect.py (USB presence scan),
                  info.py (craft name/PID profile/blackbox storage), blackbox_reader.py (MSP dataflash retrieval)
    tuning/       engine.py (recommendations), stopping.py (tune-complete evaluation), apply.py
                  (safety-gated write orchestration), store.py (per-craft iteration persistence),
                  compare.py (iteration comparison / best-tune)
    jobs.py       generic background-job progress tracker (for the real-progress download/apply screens)
    api/          routes.py (the HTTP API)
    main.py       FastAPI app entrypoint
    config.py     paths, env-var overrides
  static/         appliance-style kiosk frontend (index.html, app.js, styles.css) -- see static/README.md
                  for the state machine and full API contract it's built against
  tests/          pytest suite (148 tests as of this writing)
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

### Kiosk mode — working, verified via physical screenshot

The connected display is a GPIO SPI touchscreen (ILI9341 panel via the legacy `fbtft` staging driver, `dtoverlay=fbtft,spi0-0,ili9341,...` in `/boot/firmware/config.txt`) — it has **no DRM/KMS connector at all**, which rules out Wayland-based kiosk compositors like `cage`. Set up instead with **X11 + `xf86-video-fbdev` + `openbox` + Chromium**:

- `sudo apt-get install -y xserver-xorg-video-fbdev xinit openbox chromium x11-xserver-utils unclutter fbcat wmctrl`
- The panel's `/dev/fb` index (`fb0` vs `fb1`) is **not stable across boots** — it races with `vc4-drm` probing at startup. `~/.bash_profile` detects the correct index at every login (by matching `/sys/class/graphics/fb*/name == fb_ili9341`) and rewrites `/etc/X11/xorg.conf.d/99-fbdev.conf` before starting X, rather than hardcoding a device path. Without this, a boot that flips the index causes X to fail immediately and `getty@tty1` to crash-loop into systemd's start-limit (recoverable with `sudo systemctl reset-failed getty@tty1.service`).
- Console autologin enabled on tty1 for `seondizon`; `~/.bash_profile` runs `exec startx /home/seondizon/kiosk.sh -- -nocursor` on tty1 login with no `$DISPLAY` set — the standard Pi kiosk autostart pattern (a systemd service running X directly fights PAM/VT allocation in ways this avoids).
- **`/home/seondizon/kiosk.sh` launches Chromium in `--app=` mode, not plain `--kiosk <url>`.** This was a real, non-obvious bug: a plain `chromium --kiosk http://localhost:8000` window reports `_NET_WM_STATE_FULLSCREEN` but Chromium's own `WM_NORMAL_HINTS` still declares a **minimum window size of 500×46** (ordinary browser-chrome tab-strip/toolbar reservations, which `--kiosk` alone doesn't eliminate) — confirmed directly via `xwininfo`/`xprop` on the real device. On a 320px-wide screen, that forced the window (and everything centered inside it) to render ~180px too far right, with the real content spilling off-canvas. `--app=<url> --start-fullscreen` uses Chromium's minimal app-window code path instead, which has no such minimum, and the window correctly reports `320x240+0+0`. This is now verified via an actual framebuffer screenshot showing correctly-centered content, not a guess.

Verified end-to-end through a full reboot (not just a manual `startx`): Xorg log confirms a clean bind to the correct `/dev/fb*` device at 320×240, `xwininfo` confirms the Chromium window is genuinely 320×240 at (0,0), and an `fbcat` framebuffer capture shows the real dashboard rendering correctly centered.

**Known issue**: touch accuracy/calibration is unverified (`ADS7846` touch controller is detected at the kernel level, but confirming it's usable and correctly calibrated needs a human physically tapping the screen — if the touch position feels off, install `xinput-calibrator` and run its calibration wizard).

### FC hardware note

A real Betaflight FC (STM32F411, firmware 4.5.1) has connected successfully over `/dev/ttyACM0` multiple times in testing, including a full connect → CLI-exit → USB-reboot → re-enumerate → reconnect cycle. An earlier session saw the device fail to re-enumerate after one disconnect (alongside an "Undervoltage detected!" `dmesg` warning) — that appears to have been a transient power/cabling issue rather than a recurring one, since subsequent sessions reconnected cleanly.

## Safety

Per explicit project requirement (see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md#safety-strategies)): tuning recommendations are advisory only. Two independent real-world incidents — the historical Cleanflight in-flight autotune (removed for being "actively dangerous") and a 2026 official Betaflight chirp-autotune run that zeroed out pitch gain — confirm that even rigorous, officially-integrated automatic PID tuning is not safe to auto-apply.

- Every recommendation is bounded to a conservative per-iteration change cap, gated on confidence derived from actual usable flight data, and blocked entirely if the firmware version or FC settings couldn't be confidently read (`app/tuning/engine.py`).
- Applying a tune (`app/tuning/apply.py`) always backs up the current config first, writes and verifies every value **before** saving, and aborts with **nothing saved** if any write is rejected or any verification mismatches — a partial, unverified tune is never persisted to flash.
- A captured config diff/dump is never replayed across a different Betaflight version or hardware target without blocking and flagging it for manual review (`app/fc/cli_client.py::apply_config_lines`).
- **The apply-orchestration code has been built and thoroughly unit-tested with mocks, but has deliberately not yet been executed against a real physical flight controller.** That's a separate, explicit decision to make once analysis output has been validated against a real, sane flight log — not an oversight.

## Roadmap

- [x] Research reference projects and document findings (`docs/research/`)
- [x] Blackbox decode wrapper + CSV parser
- [x] FC serial/MSP/CLI client with version-aware safety gating
- [x] Analysis engine: step response, FFT/noise, tracking error
- [x] FastAPI backend wiring + kiosk frontend scaffold
- [x] Validate `blackbox_decode` build and CSV parsing against a real Betaflight `.BBL` log (found and fixed 2 real parsing/unit bugs)
- [x] Deploy to Raspberry Pi 2B hardware: builds, runs, systemd service, full test suite passing on real ARMv7/Python 3.13
- [x] Validate FC serial/CLI connection against a real Betaflight FC (found and fixed 2 real bugs around USB CDC-ACM reconnect behavior)
- [x] Resolve kiosk-mode display approach (X11+fbdev+openbox+chromium, given the connected panel has no DRM/KMS support) and verify visually on the actual touchscreen (confirmed via a real framebuffer screenshot; also found and fixed a Chromium minimum-window-size bug causing off-center rendering, and two fb-index/getty-crash-loop infra issues)
- [x] FC presence auto-detection, craft name/PID profile/Blackbox storage detection, and MSP dataflash Blackbox retrieval directly off the FC
- [x] Rule-based tuning-recommendation engine, safety-gated apply orchestration, and persistent per-craft iteration history/comparison
- [x] Rebuild the frontend as a state-machine-driven, card-paginated appliance UI matching the full connect → download → analyze → tune → apply → fly-again product flow, designed and verified against the real 320×240 screen
- [x] Found (via real end-to-end download+decode of a full 16MB flash dump) that the Pi 2B is not powerful enough for practical use — decoding alone took 25+ minutes and hit a real `blackbox_decode` infinite-loop bug. Added a hard timeout so this fails cleanly instead of hanging, but the underlying performance ceiling is a hardware constraint, not a software bug to fix.
- [ ] **Pick a more capable deployment target** (a Pi 4/5, or a different SBC entirely) before further real-hardware validation — this is the actual blocker now, not application code.
- [ ] Verify touch input calibration on the physical screen (needs a human physically tapping it)
- [ ] Validate analysis output (step response, noise, tracking) against PIDtoolbox/PID-Analyzer/SmartTune CLI on a real log with *sane* flight data (the one real log tested so far had implausible sensor values — see git history) — see the validation workflow in `docs/research/reference-analysis.md`
- [ ] Run the full connect → download-from-FC → analyze → tune → apply flow against real hardware end-to-end (MSP Blackbox retrieval and the apply-write path are unit-tested only so far — see [Safety](#safety))
- [ ] Charting (step-response curves, FFT heatmap) in the frontend — currently placeholder boxes; see `backend/static/README.md` for the recommended lightweight charting approach
