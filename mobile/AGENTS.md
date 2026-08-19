# FPV Tuner — Android/Expo mobile app

Standalone handheld Betaflight tuning tool. The project **pivoted away from
the Raspberry Pi + Flask/FastAPI web-UI kiosk design** (see `../backend` —
kept only as a reference for ported logic, not run anymore) to a phone app
that talks to the flight controller directly over USB-OTG. `../docs` has the
original research; the mobile app is the active codebase.

## Before writing any code

**Expo HAS CHANGED.** Read the exact versioned docs at
https://docs.expo.dev/versions/v57.0.0/ before assuming anything about Expo
APIs — this project is on SDK 57, and general Expo knowledge from training
data is frequently stale.

## Architecture

```
src/fc/          USB-serial transport, MSP v1 protocol, Betaflight CLI client,
                  FC info/version detection, CLI/MSP name-compatibility shims
src/blackbox/     Binary Blackbox (BBL) log decoder (I/P/S/E/H frames)
src/analysis/     FFT, step response, tracking error, noise, grading — pure
                  math, no FC/UI dependencies
src/tuning/       Recommendation engine, safety-critical apply-to-FC
                  orchestration, iteration compare/stopping, SQLite store
src/controller/   useTunerController.ts — the ENTIRE app state machine and
                  orchestration layer; types.ts — the screen prop contracts
src/screens/      Pure presentational screens (Waiting → FcInfo → Analysis →
                  Recommendation → Applying → Applied), driven only by props
                  from useTunerController — never call src/fc|blackbox|
                  analysis|tuning directly
src/components/charts/  Hand-rolled SVG charts (react-native-svg), no
                  charting library
src/theme/        Design system (Seonski brand — see below)
modules/usb-serial/  Native Expo module wrapping usb-serial-for-android
```

Screens are dumb; `useTunerController.ts` owns every FC/blackbox/analysis/
tuning call. If you're adding a feature that needs new FC interaction, it
goes in the controller (or a new `src/fc`/`src/tuning` module the controller
calls), not in a screen component.

## Real-hardware findings (do not re-discover these the hard way)

All confirmed by live testing against multiple real Betaflight FCs across
this project's development, not guessed:

- **usb-serial-for-android's blocking `read()` does not work** for these
  CDC-ACM devices — reliably returns 0 bytes regardless of timeout or
  whether the FC already replied. Fix (already in
  `modules/usb-serial/.../UsbSerialModule.kt`): use the library's async
  `SerialInputOutputManager` with an `onNewData` callback, buffer bytes
  into a queue, and have `read()` wait on that queue. Do not revert to
  direct blocking reads.
- **DTR/RTS must be asserted explicitly** on port open — usb-serial-for-
  android does not do this automatically (pyserial does). STM32 CDC-ACM VCP
  firmware gates serial output on DTR; without it the port opens fine but
  the FC never sends anything back. Already handled in `UsbSerialModule.kt`.
- **Exiting CLI mode, and `save`, both cause the FC's USB connection to
  drop/re-enumerate.** This is expected Betaflight behavior, not a bug —
  every code path that does this (`onConnect`'s CLI info read, `apply.ts`'s
  save step) must close and reopen the transport afterward
  (`reopenFcTransport` in `useTunerController.ts`), and a fresh device
  reopen may re-trigger the Android USB permission dialog even for a device
  the user already granted permission to (a new re-enumeration can be seen
  as a "new" device instance).
- **Betaflight CLI/MSP compatibility is NOT uniform across firmware
  versions** (confirmed via source-diffing Betaflight 4.2.0 through the
  latest calendar-versioned release, and live-tested against 3 different
  real FCs). Concretely:
  - `name` was renamed to `craft_name` at **4.4.0**.
  - `dterm_lowpass_hz`/`dterm_lowpass2_hz`/`gyro_lowpass_hz`/
    `gyro_lowpass2_hz` were renamed to `*_lpf1_static_hz`/`*_lpf2_static_hz`
    at **4.3.0**.
  - `status` has **never** included the active PID profile, in any version
    — use the dedicated `profile` command (`profile %d` reply) instead.
  - `MSP_FC_VERSION`'s payload layout changed at the calver boundary
    (2025.12.0-RC1): legacy 3-byte `[major,minor,patch]` vs. calver
    `[yearSince2000,month,patch,...pString]` — byte-sniff on `payload[0] < 10`
    to tell them apart (see `fc/msp.ts`'s `parseFcVersionPayload`).
  - Name/version compatibility shims live in `fc/paramCompat.ts`
    (`resolveGetParam`/`resolveSetParam`, tried canonical-then-legacy-alias)
    — used by both the read path (`fc/info.ts`, the controller's tune-param
    reads) and the write path (`tuning/apply.ts`). If you add a new CLI
    parameter dependency, check whether it's had a rename in this range
    before hardcoding one name.
  - Betaflight version banner format (`# Betaflight / <board> <version> ...
    MSP API: X.Y`) has been stable since 4.2.0 — safe to hardcode that
    parse.
- **Craft identity uses the FC's hardware UID (`MSP_UID`, opcode 160), not
  craft name.** STM32's factory-programmed 96-bit unique chip ID, read once
  in normal MSP mode before entering CLI (see `readFcUid` in
  `useTunerController.ts`). This is required for the multi-craft workflow —
  tuning history must never merge across two different physical quads, even
  if they share a craft name or are both unnamed. Falls back to a
  name-based slug (`tuning/store.ts`'s `craftIdFromName`) only if the UID
  read fails, which should essentially never happen on real hardware.
- A background "disconnect watchdog" in `useTunerController.ts` detects a
  genuine physical unplug from any screen except `waiting` (has its own
  poll) and `applying` (has its own dedicated reboot/reconnect handling) —
  matches by the specific USB `deviceId`, not just "is some FC-like device
  present," so swapping to a different quad without reconnecting is also
  correctly treated as a disconnect.

## Safety-critical code

`src/tuning/apply.ts` writes real settings to a physical flight controller.
Rules that must never be weakened: back up (`diff all`) before any write;
write only approved changes; verify every value was actually accepted
**before** calling `save`; abort immediately — without saving — if anything
is rejected or fails to verify. A partially-applied, unverified tune must
never reach flash. This module has its own test suite
(`tuning/__tests__/apply.test.ts`) covering the full success/reject/
mismatch/reconnect-timeout matrix; extend it, don't bypass it, when
touching this file.

## Design system

Brand tokens (colors, type scale, spacing) live in `src/theme/`, derived
from the Seonski brand guide (signature red `#CC3D42`, charcoal, off-white
canvas, Montserrat). Screens are built from `src/theme/components.tsx`
primitives (`Screen`, `Card`, `PrimaryButton`, `MetricTile`, `KeyValueRow`,
`InfoBadge`, etc.) — don't hand-roll ad-hoc View/Text styling in a screen
when an equivalent primitive exists. `InfoBadge`/the `hint` prop on
`KeyValueRow`/`MetricTile` is the established pattern for explaining PID/
noise jargon to non-expert users via a tappable "i" → native `Alert` popup;
follow it for any new jargon term rather than inventing a new tooltip
mechanism.

## Dev workflow

- `npx tsc --noEmit` and `npm test` (Jest) after every change — both must
  stay clean.
- **Pure JS/TS changes** (anything under `src/`, `App.tsx`): just reload —
  no native rebuild needed. With Metro running (`npx expo start --dev-client
  --port 8081`) and `adb reverse tcp:8081 tcp:8081` set up, `am force-stop`
  + `am start` on the installed debug APK picks up the new bundle.
- **Native changes** (`modules/usb-serial/android/**`, `app.json` config
  plugins like `expo-splash-screen`): requires `npx expo prebuild
  --platform android` (if a config plugin changed — `android/` is
  gitignored/fully regenerable) then `cd android && ./gradlew
  :app:assembleDebug` and `adb install -r
  android/app/build/outputs/apk/debug/app-debug.apk`.
- `expo run:android` hangs indefinitely with no TTY on stdin — always use
  the manual gradlew/adb workflow above instead, never `expo run:android`
  in a non-interactive session.
- Live hardware testing is the standard way to validate FC-protocol changes
  in this project — prefer testing against a real, physically-connected FC
  over pure unit-test confidence when touching `src/fc/` or the connect/
  apply flows, the same way the compatibility fixes above were found.
