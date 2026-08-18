# FPV Tuner

A Betaflight Blackbox log analyzer and PID tuning assistant. Connects to a flight controller over USB for config backup/version detection, decodes Blackbox logs, and analyzes step response, noise/FFT, and tracking error — surfacing tuning suggestions as advisory, human-reviewed recommendations, never auto-applied.

## Status

**Pivoting to a standalone Android app.** The project was originally built as a Python (FastAPI) backend deployed to a Raspberry Pi 2B driving a small touchscreen over USB/kiosk-mode Chromium. Real-hardware testing confirmed the Pi 2B isn't powerful enough for practical use (a single 16MB Blackbox decode took 25+ minutes and hit a real infinite-loop bug in the decoder) — see git history around Aug 18 for the full deployment, debugging, and eventual decommissioning of that Pi.

Rather than find bigger embedded hardware, the tuner is being rebuilt as a **single self-contained Android app** (Expo/React Native): the flight controller plugs into the phone's USB-C port via USB-OTG, and everything — protocol handling, Blackbox decoding, analysis, tuning, the safety-gated write-back — runs on-device. No backend server, no separate hardware to carry to the field.

The original Python backend (`backend/`) is **kept in the repo, but no longer runs as a server** — it's now the reference implementation and numerical oracle every TypeScript port is checked against. Its 128 tests (pruned from 155 — removed only the HTTP-API/kiosk-frontend tests, kept everything testing ported logic) are the ground truth for the mobile rewrite.

## Architecture

**Mobile app** (`mobile/` — in progress):
- **USB serial**: a native Android module (Kotlin, Expo Modules API, built on `usb-serial-for-android`) talks to the FC's USB CDC-ACM interface directly from the phone.
- **FC protocol layer**: TypeScript port of `backend/app/fc/*` — MSP framing (including jumbo frames and the exact-size-read fix found the hard way on real hardware), CLI text parsing, semver/calver feature-gating, dataflash retrieval.
- **Blackbox decoder**: a from-scratch, clean-room TypeScript implementation of Betaflight's binary log format (frame types, predictors, Elias-gamma/delta and tagged bit-level encodings) — the one genuinely new piece of engineering here, since the Python version always shelled out to Betaflight's own `blackbox_decode` binary, which can't run on Android.
- **Analysis + tuning engine**: TypeScript port of `backend/app/analysis/*` and `backend/app/tuning/*` — Wiener-deconvolution step response, throttle-binned FFT noise heatmaps, D-term metrics, tracking error, the rule-based recommendation engine, and the safety-gated backup → write → verify → save apply orchestration.
- **UI**: a redesigned dashboard (tabs + side-by-side comparisons, real charts via React Native Skia) replacing the Pi's strict one-card-per-screen pagination, now that there's a real screen to work with.

**Python reference** (`backend/`, kept, not deployed):
- `app/blackbox/`, `app/analysis/`, `app/fc/`, `app/tuning/` — the original, real-hardware-validated implementations every TS module is ported from.
- `app/jobs.py` — generic progress-tracking used by the apply orchestration; the mobile app needs an equivalent concept for its own progress screens.
- `tests/` — 128 tests acting as the numerical oracle for the port (same fixtures can be reproduced in TS to verify parity).
- `scripts/build_blackbox_decode.sh` — still useful on a dev machine to build the real `blackbox_decode` binary and cross-validate the new TS decoder's output against it.

These decisions (USB-serial FC link, clean-room decoder, keeping Python as an oracle rather than deleting it) were made deliberately — see [`docs/research/`](docs/research/) for the original research this project is built on, all of which still applies.

## Repository layout

```
backend/                      Python reference implementation + cross-validation oracle (not deployed)
  app/
    blackbox/     decode.py (blackbox_decode subprocess wrapper, dev-machine only), logdata.py (CSV -> BlackboxLog)
    analysis/     step_response.py, fft_noise.py, tracking.py, setpoint.py, grading.py
    fc/           serial_transport.py, msp.py, version.py, cli_client.py, detect.py,
                  info.py, blackbox_reader.py
    tuning/       engine.py, stopping.py, apply.py, store.py, compare.py
    jobs.py       generic progress tracker (used by apply.py)
    config.py     paths for the dev-machine cross-validation tooling
  tests/          pytest suite (128 tests) -- the numerical oracle for the TS port
  requirements.txt
scripts/
  build_blackbox_decode.sh   clones + builds betaflight/blackbox-tools, for dev-machine cross-validation
mobile/                        Expo/React Native Android app (in progress -- see below)
docs/research/
  reference-analysis.md      per-project findings (Betaflight blackbox-tools, PIDtoolbox, PID-Analyzer, SmartTune CLI, FPVtune/autotuning projects, official docs)
  tuning-algorithms.md        cross-project algorithm synthesis -- what we implement and why
  licenses.md                 what we can/can't reuse from each reference project, and why
```

## Working with the Python reference

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest tests -v
```

For cross-validating the TS Blackbox decoder against the real tool (dev machine only, never shipped in the app):

```sh
./scripts/build_blackbox_decode.sh   # requires git, make, a C compiler
```

## Historical: Raspberry Pi kiosk deployment

The project previously ran as a live FastAPI backend + kiosk-mode touchscreen UI on a Raspberry Pi 2B (`rpi2b.local`). That deployment (including the real bugs found and fixed along the way — MSP round-trip timeouts, dataflash field-offset errors, jumbo-frame chunking, a `blackbox_decode` infinite-loop hang, and several kiosk-mode X11/Chromium rendering quirks) is preserved in git history but no longer active; the Pi was reset to a clean slate, with only its touchscreen driver setup (`kiosk.sh`/`kiosk-www.service`) left working for whatever project uses that hardware next.

## Safety

Per explicit project requirement (see [`docs/research/tuning-algorithms.md`](docs/research/tuning-algorithms.md#safety-strategies)): tuning recommendations are advisory only. Two independent real-world incidents — the historical Cleanflight in-flight autotune (removed for being "actively dangerous") and a 2026 official Betaflight chirp-autotune run that zeroed out pitch gain — confirm that even rigorous, officially-integrated automatic PID tuning is not safe to auto-apply. This carries forward unchanged into the mobile app:

- Every recommendation is bounded to a conservative per-iteration change cap, gated on confidence derived from actual usable flight data, and blocked entirely if the firmware version or FC settings couldn't be confidently read (`app/tuning/engine.py`, to be ported faithfully).
- Applying a tune (`app/tuning/apply.py`) always backs up the current config first, writes and verifies every value **before** saving, and aborts with **nothing saved** if any write is rejected or any verification mismatches — a partial, unverified tune is never persisted to flash.
- A captured config diff/dump is never replayed across a different Betaflight version or hardware target without blocking and flagging it for manual review (`app/fc/cli_client.py::apply_config_lines`).
- The write path to the flight controller gets the same scrutiny in TypeScript that it got in Python — this is not a place to cut corners during the port.

## Roadmap

- [x] Research reference projects and document findings (`docs/research/`)
- [x] Build and validate the full Python backend: Blackbox decode/parse, FC serial/MSP/CLI client, analysis engine, tuning-recommendation engine, safety-gated apply orchestration
- [x] Deploy to Raspberry Pi 2B hardware, build a kiosk-mode touchscreen UI, validate against real FC hardware
- [x] Determine the Pi 2B isn't powerful enough for real use; decommission it back to a clean slate
- [x] Decide on the Android/Expo/USB-OTG architecture for the rebuild; scope the phased plan
- [x] Clean up the repo: remove the HTTP API/kiosk-frontend layer, keep the Python analysis/FC/tuning code as reference + oracle
- [ ] **Phase 0**: Expo project scaffold + native USB-serial module; prove raw byte read/write to a real FC over USB-OTG
- [ ] **Phase 1**: port the FC protocol layer (MSP/CLI/detect/version/dataflash retrieval) to TypeScript, validated live
- [ ] **Phase 2**: Blackbox binary decoder — the new, high-risk piece; validate by diffing against `blackbox_decode`'s own output
- [ ] **Phase 3**: port the analysis engine, cross-checked against the existing Python test fixtures for numerical parity
- [ ] **Phase 4**: port the tuning engine, apply orchestration, and on-device persistence (SQLite)
- [ ] **Phase 5**: build the redesigned dashboard UI (tabs, side-by-side comparisons, real charts)
- [ ] **Phase 6**: real hardware end-to-end — connect → download → analyze → tune → apply, on an actual phone over USB-OTG
