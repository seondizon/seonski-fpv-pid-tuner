# Licenses — Reference Projects

Recorded before copying or adapting any source code from the reference projects, per the project brief. Rule of thumb applied throughout: **shell out to / call external binaries as separate processes** where the underlying tool is copyleft-licensed (avoids derivative-work concerns); **reimplement clean-room from the algorithm description** rather than porting source when a license is informal, ambiguous, or its lineage is unverified; **direct reuse with attribution** is only considered safe for permissively-licensed (MIT/BSD) components.

## Betaflight blackbox-tools

- **License**: GPL-3.0 (confirmed via repo `LICENSE` file and GitHub API `license.spdx_id`).
- **Scope**: Applies to `blackbox_decode` and `blackbox_render` source (C).
- **Additional bundled-library licenses** (relevant only if `blackbox_render` were ever bundled — we do not plan to): macOS binary statically links libbz2 (BSD-like), zlib, libcairo/libpixman (LGPL), libfreetype (BSD-like/GPLv2), libpng16. Windows binary ships libiconv (LGPL), libfontconfig, libxml2 (MIT), liblzma (Public Domain). Bundled font Source Sans Pro Regular (SIL Open Font License). IMU code derived from Baseflight (GPLv3).
- **Our usage**: Cross-compile `blackbox_decode` for ARMv7 and invoke it as a **separate external process** (subprocess), parsing its stdout/CSV output. This is the standard "mere aggregation" pattern — we are not linking against or embedding GPL source, so our own code is not a derivative work under GPLv3.
- **Do NOT**: copy/adapt any `.c`/`.h` source (`parser.c`, `decoders.c`, `blackbox_fielddefs.c`, `stream.c`, `imu.c`, `gpxwriter.c`) into our codebase unless our project itself becomes GPL-compatible. Do not bundle `blackbox_render` (adds an LGPL/BSD/GPLv2-mixed dependency chain for no benefit to us).
- **Attribution**: If we ever redistribute the compiled `blackbox_decode` binary (e.g., as part of a Pi disk image), GPLv3 §6 requires making corresponding source available and preserving copyright/license notices. Document this in our own distribution/build docs when we get there.

## Betaflight Official Documentation / Firmware

- **License**: Firmware itself (`betaflight/betaflight`) is GPL-3.0; documentation content (wiki, release notes) is not code we copy — it is a reference we read and validate our own independent implementation against.
- **Our usage**: We do not vendor or link against Betaflight firmware source. We communicate with a running Betaflight FC over its standard CLI/MSP interfaces (a normal, external, protocol-level interaction — not a code dependency), and separately consult the documentation as a knowledge source. No GPL obligations attach to this usage pattern.
- **Do NOT**: copy firmware source (e.g., PID computation code, MSP protocol constants beyond what's needed to interoperate) into our own codebase without treating it as a GPL derivative-work question first.

## PIDtoolbox

- **License**: **Dual/layered and unusually informal.**
  - Repository-level `LICENSE` file (present in ianrmurphy/PIDtoolbox, dzikus/PIDscope, nerdCopter/PIDtoolbox, and other forks checked): **GPL-3.0**.
  - Nearly every individual algorithm `.m` file (`PTstepcalc.m`, `PTthrSpec.m`, `PTthrExpo.m`, `PTload.m`, `PTprocess.m`, `PTphaseShiftDeg.m`, etc.) carries its own **file-level "Beer-Ware License" (Revision 42)** header, signed `<brian.white@queensu.ca>`: *"As long as you retain this notice you can do whatever you want with this stuff... you can buy me a beer in return."* This is permissive but informal (not OSI-approved, no patent grant), and it coexists uneasily with the repo-level GPL-3.0 file.
  - The de-facto community-maintained fork (`bw1129/PIDtoolbox`) was **deleted** in May 2024 when the author moved development to a paid product (`pidtoolbox.com`, Patreon). Its final public state (mirrored at `nerdCopter/PIDtoolbox`) has stripped/truncated core algorithm files.
  - `dzikus/PIDscope` (active continuation, ported to Octave) is **GPL-3.0**.
- **Our usage**: We do **not** copy any `.m` source, regardless of which license file technically applies to it, given the licensing ambiguity and the confirmed provenance issues (stripped files in the "final" state of the most-forked lineage). We reimplement algorithms **clean-room** from the math descriptions in [`tuning-algorithms.md`](./tuning-algorithms.md), studying the ianrmurphy 2019 snapshot and dzikus/PIDscope as our sources of truth for the *math*, not the code.
- **Attribution**: Credit PIDtoolbox (and Brian White as original author) in our own documentation/about page as the source of the throttle-binned FFT heatmap methodology and tracking-error statistical approach, as a courtesy and for traceability — not because reimplementation from a description legally requires it, but because it's the right thing to do given how much of our noise/tracking-analysis design is inspired by this work.

## PID-Analyzer

- **License**: Informal **"Beer-Ware License"** (do-whatever-you-want, not OSI-approved, no patent grant), stated in the header of `PID-Analyzer.py`, signed `<florian.melsheimer@gmx.de>`. Note: `license.txt` in the repo root is a bundle of *third-party* licenses (Python PSF, NumPy, Matplotlib, PyInstaller) for the frozen `.exe` distributable — it is **not** the license for PID-Analyzer's own code; GitHub's license detector correctly flags the repo as `"NOASSERTION"` at the repo-license level.
- **Our usage**: Given the license's informality and the unverified lineage claims investigated during research (the "Berry-based predecessor" attribution could not be confirmed), we **clean-room reimplement** the Wiener-deconvolution step-response algorithm from the math description in [`tuning-algorithms.md`](./tuning-algorithms.md), rather than porting the actual `Trace`/`CSV_log`/`BB_log` source.
- **Attribution**: Credit Florian Melsheimer / PID-Analyzer in our documentation as the source of the Wiener-deconvolution step-response approach we adapted.

## SmartTune CLI

- **License**: **MIT** (confirmed via `LICENSE` file, copyright Raylan LIN 2026). Standard permissive terms — direct reuse with attribution is legally clean.
- **Scope note**: A separate closed-source add-on, `smarttune-knowledge-pro` (proprietary tuning knowledge base), is sold separately by the same author — **not covered by the MIT license** and **not something we have any rights to or should attempt to access/reuse**. Only the open `smarttune-cli` repository content is MIT.
- **Our usage**: This is the one reference project we may **directly reuse or closely adapt source from**, given the permissive license and strong architectural fit (pure-Python, low-dependency, same target profile as our own project). Priority candidates for direct adoption/adaptation: `bbl_parser.py` (BBL/BFL decoder), `analyzers/fft_analyzer.py` (peak detection + classification), `platform/betaflight/step_response_fft.py` (deconvolution step response), `analyzers/filter_transfer.py` (biquad/notch math).
- **Attribution**: Preserve the MIT license text and copyright notice (Raylan LIN, 2026) in any file we directly copy or substantially derive from `smarttune-cli`, per standard MIT terms. Record which specific files/functions were sourced from SmartTune CLI in our own code comments/commit messages when we do this, so provenance stays traceable.

## FPVtune / Autotuning Projects

- **FPVtune** (`chugzb/betaflight-pid-autotuning`): **MIT** (for the public repo; the trained model/service behind fpvtune.com is proprietary and not published — nothing to reuse from it beyond the publicly stated feature list/architecture, which is not itself copyrightable).
- **FPVPIDlab** (`eddycek/fpvpidlab`): **GPL-3.0**. Given this and the "not yet hardware-validated" status of its own recommendation logic, we treat it as a **structural/heuristic reference only** — study the ordering/gating/confidence-scoring *pattern* described in [`tuning-algorithms.md`](./tuning-algorithms.md) and reimplement clean-room; do not port its TypeScript source.
- **bf_controller_tuning** (`pichim/bf_controller_tuning`): **GPL-3.0**. Reference for chirp/system-ID methodology only; not planning to reuse code (different runtime — MATLAB/Python 3.12 desktop framework, not our target architecture).
- **PID_tune** (`stefapi/PID_tune`): **BSD-2-Clause**, but its dependency `orangebox` is **LGPL** — if we ever considered depending on `orangebox` directly (rather than our own parser or `blackbox_decode`), the LGPL terms on that dependency would need separate review (LGPL permits dynamic linking/use without copyleft spreading to our own code, but static-linking or modification triggers different obligations — revisit if this dependency choice comes up).
- **Official Betaflight chirp-based autotune**: part of upstream Betaflight (GPL-3.0 firmware); we interoperate with it only via CLI/MSP protocol-level interaction (as with all Betaflight firmware), not by embedding its source.
- **Historical Cleanflight autotune**: not a current codebase we'd pull from at all — referenced purely as a cautionary design lesson (see [`tuning-algorithms.md`](./tuning-algorithms.md#safety-strategies)).

## Summary Table

| Project | License | Reuse posture |
|---|---|---|
| Betaflight blackbox-tools | GPL-3.0 | Shell out to compiled binary; never copy source |
| Betaflight docs/firmware | GPL-3.0 (firmware) / N/A (docs) | Protocol-level interoperation only |
| PIDtoolbox / PIDscope | GPL-3.0 (repo) + informal Beerware (per-file) | Clean-room reimplement math; credit in docs |
| PID-Analyzer | Informal Beerware (not OSI) | Clean-room reimplement math; credit in docs |
| SmartTune CLI | **MIT** | **Direct reuse/adaptation OK with attribution** |
| FPVtune | MIT (public repo only; model is proprietary) | Reference feature list only; no code to reuse |
| FPVPIDlab | GPL-3.0 | Structural/heuristic reference only; clean-room reimplement |
| bf_controller_tuning | GPL-3.0 | Methodology reference only |
| PID_tune | BSD-2-Clause (orangebox dep: LGPL) | Reference only; revisit LGPL terms if `orangebox` is ever adopted as a dependency |

**Bottom line**: SmartTune CLI (MIT) is our only cleared-for-direct-reuse source dependency among the analysis-side references. Everything else — including the widely-used PIDtoolbox and PID-Analyzer — gets reimplemented clean-room from documented algorithm descriptions, with credit given in our own docs. `blackbox_decode` (GPL-3.0) is used exclusively as an external, separately-invoked binary, never as embedded/linked source.
