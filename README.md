# FPV Tuner

An Android app that tunes a Betaflight flight controller's PID and filter settings directly from your phone over USB-OTG — no laptop, no Betaflight Configurator, no separate ground-station hardware. Plug the quad into the phone, and everything — protocol handling, Blackbox download and decode, flight analysis, tuning recommendations, and the safety-gated write-back — runs on-device.

## Who it's for

FPV pilots flying Betaflight-based quads who want a guided tuning workflow without carrying a laptop to the field — including pilots who know Betaflight basics but aren't PID-tuning experts. The app is built around that: every PID/filter/noise term has a tap-to-explain "i" badge with a plain-English description, and the analysis screen explains what each chart shows and what "good" looks like, rather than assuming tuning theory knowledge.

## What it does

The core loop:

1. **Connect** — plug the FC in over USB-OTG, tap Connect. The app reads craft name, Betaflight version, board target, active PID profile, and Blackbox storage type.
2. **Download & decode** — pulls the Blackbox log directly off the FC's onboard flash over MSP, decodes the binary format on-device, and analyzes it: step response (rise time, overshoot, settling) and tracking error per axis, plus D-term/gyro noise and frequency-domain peak detection.
3. **Understand** — see the current tune graded (Good/Fair/Needs Attention) with real charts: step-response curves against a target line, and noise spectra with detected peaks classified by likely cause (motor, prop blade pass, structural resonance).
4. **Get a recommendation** — an advisory-only rule-based engine proposes specific, bounded changes (e.g. raise D by a capped percentage, or lower a filter cutoff) with a plain-English reason and a confidence score. Nothing is ever computed and applied silently — if the data doesn't support a confident recommendation, the app says so instead of guessing.
5. **Review & confirm** — see exact current → proposed values and an explicit confirmation step before anything is written.
6. **Apply, safely** — backs up the current config, writes only the approved changes, verifies every value was actually accepted **before** saving, and aborts with nothing saved if anything is rejected or fails to verify. After save, it reconnects and re-verifies post-reboot.
7. **Fly again** — next-flight guidance, then the next download is compared against this craft's own history to say whether the tune actually improved, regressed, or is already about as good as it's going to get.

### Multi-craft tuning history

Tuning history is tracked per **physical flight controller**, identified by its hardware UID (the STM32's factory-programmed unique chip ID, read over MSP) — not by craft name. Two quads with the same name (or both unnamed), reconnected in any order, never mix up their histories. Reconnecting a known craft shows "Recognized — N flight(s) recorded" instead of starting fresh.

### Betaflight version compatibility

Supports Betaflight **4.2 through the latest calendar-versioned release**. This was verified, not assumed: CLI/MSP compatibility across that range was researched directly from Betaflight's own source and cross-checked against Betaflight Configurator's reference implementation, then validated live against multiple real, differently-versioned flight controllers. Real bugs found and fixed this way:

- A PID-profile-reading bug that could never have worked on *any* version — `status` has never actually contained that field; the fix reads the dedicated `profile` command instead.
- The craft-name CLI parameter (`name` → `craft_name`) was renamed at Betaflight 4.4.0.
- Four filter settings (`dterm_lowpass_hz`/`dterm_lowpass2_hz`/`gyro_lowpass_hz`/`gyro_lowpass2_hz` → `*_lpf1_static_hz`/`*_lpf2_static_hz`) were renamed at 4.3.0.
- The binary `MSP_FC_VERSION` payload format changed at the 2025.12 calendar-versioning transition (3-byte legacy layout vs. a year/month/patch + string layout) — handled with the same byte-sniffing heuristic Betaflight Configurator itself uses.

The read and write paths both fall back from the modern CLI parameter name to the legacy one automatically when the connected firmware doesn't recognize it, rather than hardcoding a single name and silently failing on older boards.

## Safety

Tuning recommendations are advisory only, never auto-applied. This isn't a stylistic choice — two real-world incidents make the case: the historical Cleanflight in-flight autotune was removed from the firmware for being "actively dangerous," and even a 2026 official Betaflight chirp-autotune run (a legitimate system-ID technique, built by the Betaflight team itself) produced a test run that zeroed out pitch gain and broke takeoff. Both independently point to the same conclusion, and it's non-negotiable here:

- Every recommendation is bounded to a conservative per-iteration change cap and gated on confidence derived from actual usable flight data; the app blocks the whole recommendation if the firmware version or FC settings couldn't be read reliably.
- Applying a tune (`mobile/src/tuning/apply.ts`) always backs up the current config first, writes and verifies every value **before** saving, and aborts with **nothing saved** if any write is rejected or any verification mismatches — a partial, unverified tune is never persisted to flash.
- A captured config diff/dump is never replayed across a different Betaflight version or hardware target without blocking and flagging it for manual review.
- This module has its own dedicated test suite covering the full success/reject/mismatch/reconnect-timeout matrix, and gets the same scrutiny as anything else that writes to real hardware.

## Design

The visual design is a real brand identity (Seonski), not a generic template: Montserrat type, a specific signature-red/charcoal/off-white palette, card-based layout, a proper splash screen and in-app branding. Design tokens live in `mobile/src/theme/`.

## Tech stack

- **Expo SDK 57 / React Native / TypeScript**
- A custom native Android module (Kotlin, Expo Modules API) for USB-serial/CDC-ACM communication, built on `usb-serial-for-android`
- A hand-rolled MSP v1 + Betaflight CLI protocol implementation (no third-party Betaflight SDK)
- A clean-room TypeScript Blackbox binary decoder (frame types, predictors, tagged bit-level encodings)
- `fft.js` for FFT (power-of-two sizes only — every call site zero-pads, a documented, intentional deviation from numpy's arbitrary-length FFT in the original Python reference)
- `expo-sqlite` for local, per-craft tuning history
- Hand-rolled SVG charts (`react-native-svg`) — no charting library
- Jest (193 tests) for the TypeScript layer, `pytest` (128 tests) for the retained Python reference

## Repository layout

```
mobile/                         Expo/React Native Android app — the active codebase
  src/fc/                       USB-serial transport, MSP v1 protocol, Betaflight CLI client,
                                 FC info/version detection, CLI/MSP name-compatibility shims
  src/blackbox/                 Binary Blackbox (BBL) log decoder (I/P/S/E/H frames)
  src/analysis/                 FFT, step response, tracking error, noise, grading
  src/tuning/                   Recommendation engine, safety-critical apply-to-FC orchestration,
                                 iteration compare/stopping, SQLite store
  src/controller/                useTunerController.ts — the app's state machine and orchestration
                                 layer; types.ts — the screen prop contracts
  src/screens/                  Presentational screens (Waiting → FcInfo → Analysis →
                                 Recommendation → Applying → Applied)
  src/components/charts/        Hand-rolled SVG step-response and noise-spectrum charts
  src/theme/                    Design system (Seonski brand tokens + shared UI primitives)
  modules/usb-serial/           Native Expo module wrapping usb-serial-for-android
  AGENTS.md                     Architecture map, real-hardware findings, and dev workflow
                                 for anyone (human or agent) working in this codebase
backend/                        Python reference implementation + cross-validation oracle (not deployed)
  app/
    blackbox/     decode.py (blackbox_decode subprocess wrapper, dev-machine only), logdata.py
    analysis/     step_response.py, fft_noise.py, tracking.py, setpoint.py, grading.py
    fc/           serial_transport.py, msp.py, version.py, cli_client.py, detect.py,
                  info.py, blackbox_reader.py
    tuning/       engine.py, stopping.py, apply.py, store.py, compare.py
  tests/          pytest suite (128 tests) -- the numerical oracle the TS port was checked against
scripts/
  build_blackbox_decode.sh      clones + builds betaflight/blackbox-tools, for dev-machine
                                 cross-validation only (GPL-3.0, never shipped in the app)
docs/research/
  reference-analysis.md         per-project findings (Betaflight blackbox-tools, PIDtoolbox,
                                 PID-Analyzer, SmartTune CLI, FPVtune/autotuning projects, official docs)
  tuning-algorithms.md          cross-project algorithm synthesis -- what we implement and why
  licenses.md                   what we can/can't reuse from each reference project, and why
```

## Getting started

```sh
cd mobile
npm install
npm test          # 193 Jest tests, no hardware required
npx tsc --noEmit
```

Running the app on a device, native module changes, and the full live-hardware testing workflow are covered in [`mobile/AGENTS.md`](mobile/AGENTS.md) — read it before making changes that touch `src/fc/`, the native USB module, or the connect/apply flows; it documents several real hardware quirks (async USB reads, DTR/RTS, expected USB resets on CLI-exit/save) that are easy to re-break without that context.

## Working with the Python reference

The original Python backend still runs standalone as a reference implementation and numerical oracle — every TypeScript module was checked against it during the port, and it's useful again if you want to validate a change to the analysis math independently:

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m pytest tests -v
```

To cross-validate the TypeScript Blackbox decoder against the real `blackbox_decode` binary (dev machine only, never shipped in the app):

```sh
./scripts/build_blackbox_decode.sh   # requires git, make, a C compiler
```

## Project history

FPV Tuner started as a Python (FastAPI) backend deployed to a Raspberry Pi 2B driving a small kiosk-mode touchscreen over USB. Real-hardware testing showed the Pi 2B wasn't powerful enough for practical use — a single 16MB Blackbox decode took 25+ minutes and hit a real infinite-loop bug in the decoder — so rather than move to bigger embedded hardware, the project pivoted to a self-contained Android app: the same phone that already has a screen, a battery, and a USB port replaces the Pi, the touchscreen, and the kiosk browser entirely.

The Python backend (`backend/`) is kept in the repo but no longer runs as a deployed server — it's the reference implementation and numerical oracle every TypeScript module was ported from and checked against. See [`docs/research/`](docs/research/) for the original cross-project research (Betaflight's own tools, PIDtoolbox, PID-Analyzer, SmartTune CLI, and others) this project is built on, all of which still applies.

## Status

The mobile app is feature-complete for the core tuning loop above and has been validated live against multiple real, differently-versioned Betaflight flight controllers (STM32F405 on Betaflight 4.4.2, STM32G47X on Betaflight 4.5.0), plus targeted compatibility fixes for the 4.2–4.3 and 2025.12+ calendar-versioning boundaries verified against Betaflight's own source rather than a live board on those exact versions. A third real board (STM32F722) turned out to have a hardware-level fault unrelated to this app — it never sent a single byte back over USB regardless of command — which at least confirmed the connection-failure and disconnect-handling paths behave correctly on a genuinely broken connection, not just the happy path. What's still open:

- Live-hardware testing has covered a handful of real boards/firmware versions within the supported 4.2–latest range, not exhaustive coverage of every combination — treat older (4.2.x) firmware as validated by source research and CLI-compatibility fallbacks, not yet by a live board on that exact version.
- No Play Store distribution yet (sideloaded debug builds only).
- iOS is not supported — USB-OTG host mode and the native serial module are Android-specific.
- The recommendation engine covers PID gains and static D-term/gyro filter cutoffs; it doesn't yet reason about the dynamic notch filter or RPM filtering.
