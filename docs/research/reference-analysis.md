# Reference Analysis

Research pass completed 2026-08-17, before any implementation of the Blackbox parser, signal analysis, tuning formulas, or PID recommendation logic. Six parallel research agents inspected the reference projects named in the project brief. This document records what was found, organized per project, per the required fields (Project, Repository, Purpose, Language, License, Useful components, Algorithms worth studying, Dependencies, Pi 2B compatibility, Code we may reuse, Code we should NOT reuse, Limitations, Last relevant Betaflight versions).

See also: [`tuning-algorithms.md`](./tuning-algorithms.md) (algorithm-level synthesis across all projects) and [`licenses.md`](./licenses.md) (license details and attribution requirements).

---

## 1. Betaflight blackbox-tools

- **Project**: `blackbox-tools` (`blackbox_decode` + `blackbox_render`)
- **Repository**: https://github.com/betaflight/blackbox-tools
- **Purpose**: Official reference decoder for Betaflight/Cleanflight/Baseflight Blackbox binary logs. `blackbox_decode` converts `.BBL`/`.BFL`/`.TXT` logs to CSV (+ optional GPX for GPS). `blackbox_render` renders PNG overlay frames for video editing — not relevant to us.
- **Language**: C (gnu99), hand-written GNU Makefile. `blackbox_decode` has **zero external library dependencies**; `blackbox_render` needs libcairo/libfreetype.
- **License**: **GPL-3.0**. See [`licenses.md`](./licenses.md#betaflight-blackbox-tools).
- **Useful components**: `blackbox_decode` CLI. Key flags: `--index`, `--stdout`, `--output-dir`, `--merge-gps`, `--simulate-imu`, `--raw`, and a full `--unit-*` family (`--unit-rotation deg/s`, `--unit-acceleration g`, `--unit-vbat V`, etc.) that lets us request analysis-ready units directly instead of post-processing raw ADC values. Output CSV columns are declared dynamically per-log from the log's own header (`axisP/I/D[0-2]`, `rcCommand[0-3]`, `gyroADC[0-2]`, `motor[0..N]`, `vbatLatest`, etc.) — columns vary by firmware/config, so our parser must read the CSV header, not assume fixed column order.
- **Algorithms worth studying**: the Blackbox frame/predictor/encoding scheme itself (`I`/`P`/`S`/`G`/`H`/`E` frame types; predictors — previous value, straight-line extrapolation, average-of-2, minthrottle, motor[0], always-increment, GPS home, constant-1500, vbatref, etc.; encodings — signed/unsigned variable-byte, Elias-delta/gamma, TAG8_8SVB/TAG2_3S32/TAG8_4S16 tagged groups). Valuable for understanding *why* the format compresses well and for validating any custom decoder later, but see licensing note below.
- **Dependencies**: none for `blackbox_decode` beyond a C99 toolchain (`gcc`, `make`, libc/libm). No prebuilt Linux/ARM binaries or GitHub Releases exist at all (issues #2, #45) — must be built from source.
- **Pi 2B compatibility**: **Good.** Zero-dependency C99, no cairo/graphics stack needed for `blackbox_decode`. Cross-compiles or natively builds on ARMv7 with standard Raspberry Pi OS build tools. No published memory/CPU benchmarks, but architecture (streaming binary decode, no large working set) suggests modest footprint well within 1GB RAM. Avoid `blackbox_render` entirely (unnecessary graphics dependency weight).
- **Code we may reuse**: Cross-compile the `blackbox_decode` binary for ARMv7 and **shell out to it as a separate process** from our Python app, parsing its CSV output. This is the standard "mere aggregation" pattern that avoids GPL derivative-work concerns while still using the trusted, community-maintained decoder.
- **Code we should NOT reuse**: Do not copy/adapt `parser.c`, `decoders.c`, `blackbox_fielddefs.c`, `stream.c`, `imu.c`, etc. into our own codebase unless our project is itself GPL-compatible — this would make our code a GPLv3 derivative work. Do not bundle `blackbox_render`/cairo/freetype.
- **Limitations**: Open bugs directly relevant to trusting its output — #71 (`energyCumulative` wrong ~2.25x on current logs), #72 (mode-flag misdecoding on current Betaflight), #73 (missing DISARM/FLIGHTMODE event types), #74 (parser can loop forever on malformed byte boundary — a hang risk if feeding it arbitrary user-supplied logs unattended on the Pi), #30 (multi-log splitting capped at 31 files). README is measurably behind actual `--help` output (missing several flags). No PID/tuning analysis — decode-only, as expected.
- **Last relevant Betaflight versions**: Actively maintained through July 2026, with version-specific quirk handling added recently (firmware-version-gated voltage scaling fix, `semver.c` added 2025). Given open issues against "current Betaflight logs," do not assume perfect parity with the very latest Betaflight release without our own validation (see [Validation Against Existing Tools](#validation-workflow) below).

---

## 2. Betaflight Official Documentation

- **Project**: Betaflight official wiki, release notes, and source (`betaflight/betaflight`)
- **Repository**: https://betaflight.com/docs/wiki, https://github.com/betaflight/betaflight
- **Purpose**: Source of truth for Blackbox logging config, PID/filter/feedforward behavior, CLI syntax, and firmware/version compatibility. Not a code library we integrate — a documentation reference we validate our assumptions against, continuously.
- **Language / License**: N/A (documentation site + firmware source, GPL-3.0 for the firmware itself, which we do not vendor).
- **Useful components / findings**:
  - **Critical**: Betaflight switched from semver (`4.x`) to **calendar versioning** (`YYYY.M.PATCH`) in September 2025. 4.6 shipped as `2025.12.0`. Our version-detection logic must handle **both** schemes — a naive numeric-major-version comparison breaks across the boundary.
  - Blackbox rate is controlled by `blackbox_sample_rate` (newer) or `blackbox_rate_num`/`blackbox_rate_denom` (older) — itself a renamed/reshaped parameter across versions.
  - `debug_mode` selects which of ~70 debug slots populate — only one active at a time. Relevant modes for us: `GYRO_SCALED`/`GYRO_FILTERED`, `D_LPF`/`DYN_LPF`, `FFT`, `RPM_FILTER`, `D_MAX`, `ITERM_RELAX`, `FEEDFORWARD`. A user wanting both FFT-grade noise data and RPM-filter internals needs two separate logging flights — document this limitation in our own UI.
  - CLI parameter names, valid ranges, and even profile counts change across versions: PID profile count 6→4 in 4.4; TPA folded into PID profile in 4.4; `resource` syntax for soft-serial renamed (breaking) in 4.5; TPA-low variables renamed in 4.5; `save noreboot` only exists from 2025.12+. Official release notes **explicitly warn** that pasting a diff/dump from an older version into a newer one can error or silently misapply.
  - No official CLI command dumps/restores hardware-agnostically — `resource`/`timer`/`dma`/`motor`/`servo` mappings are target-specific and must never be replayed across different boards.
  - Official docs describe filter/PID/feedforward *inputs* thoroughly but do **not** provide a canonical "how to compute a tuning recommendation from a Blackbox log" algorithm — that logic lives entirely in third-party tools and community write-ups. This confirms our recommendation engine must be built from community practice + our own validation, not ported from an official spec.
- **Algorithms worth studying**: gyro-interrupt-driven loop timing model (loop period = 1/gyro_rate, not a fixed timer); two D-term derivative conventions (from-error vs. from-gyro, current default) and why gyro-based D avoids derivative kick; P-term's expected transient signature (spike-then-decay).
- **Pi 2B compatibility**: N/A (documentation, not runtime).
- **Code we may reuse**: N/A — no code to reuse. What we take from this reference is the **version-parameter schema approach**: treat "which CLI parameter/Blackbox field means what" as versioned data (populated/validated at connect time via `version`, `get`/`dump`, MSP API version), not a hardcoded mapping.
- **Limitations**: Official written docs are notably thin on FFT/spectrum-analysis interpretation (points to video content instead) and on filter-phase-delay computation — we must source those from PIDtoolbox/PID-Analyzer/SmartTune instead (see below).
- **Last relevant Betaflight versions**: Documentation tracks current releases (2025.12 / "4.6" and the upcoming 2026.6). Our app must fingerprint the connected FC's exact build via `version`/MSP at connect time and load a per-version parameter map rather than assume any single version's names are universal.

---

## 3. PIDtoolbox

- **Project**: PIDtoolbox (MATLAB/Octave Blackbox visual tuning tool)
- **Repository**: Complicated lineage — see below. Primary references used: `github.com/ianrmurphy/PIDtoolbox` (2019 snapshot, GitHub's recorded fork root) and `github.com/dzikus/PIDscope` (active GPL-3.0 Octave continuation, pushed 2026-08-13).
  - **Important finding**: `github.com/bw1129/PIDtoolbox` — the repo that actually grew the community and was the de-facto "PIDtoolbox" — was **deleted in May 2024** when its author (Brian White) moved development behind a Patreon paywall (`pidtoolbox.com`). A mirror (`github.com/nerdCopter/PIDtoolbox`) preserves bw1129's *final* pre-deletion state, but that state has **stripped/truncated core algorithm files** (`PTstepcalc.m` terminates mid-function; several files are 2-79 byte stubs). Use the **ianrmurphy 2019 snapshot or dzikus/PIDscope** as the source of truth for algorithm text, not the nerdCopter mirror.
- **Purpose**: Human-in-the-loop visual diagnostic tool — throttle-vs-frequency noise heatmaps, a heuristic step-response estimate, PID-error tracking statistics. Does **not** produce automated tuning recommendations.
- **Language**: MATLAB (ianrmurphy/bw1129/nerdCopter lineage); genuinely ported to **GNU Octave** by dzikus/PIDscope.
- **License**: Repo-level GPL-3.0, but nearly every individual algorithm `.m` file carries its own informal "Beer-Ware License" header (do-whatever-you-want). See [`licenses.md`](./licenses.md#pidtoolbox).
- **Useful components**: `PTstepcalc.m` (step response), `PTthrSpec.m`/`PTthrExpo.m` (throttle-binned FFT heatmap + throttle-curve reproduction), `PTplotPIDerror.m` (tracking-error stats), `PTplotStats.m` (descriptive stats), `PTfiltDelay.m`/`PTphaseShiftDeg.m` (filter delay → phase shift).
- **Algorithms worth studying** (full detail in [`tuning-algorithms.md`](./tuning-algorithms.md)):
  - **Step response**: NOT deconvolution — a heuristic "snap-release" detector keyed on stick deceleration, extracting/normalizing/QC-gating ~400ms windows after hard stick releases. The author's own code comment explicitly points to PID-Analyzer's deconvolution method as the *better* approach he hadn't yet adopted.
  - **Throttle-binned FFT noise heatmap** (`PTthrSpec.m`): 200ms Hann-windowed segments, pooled into 100 throttle bins with ±6% overlap, averaged magnitude spectra, 2D box-smoothed. This is the single most portable, well-specified algorithm found across all six references.
  - **Tracking error**: PID-error histograms (peak-normalized), two-sample Kolmogorov-Smirnov test between two logs' error distributions, and stick-deflection-binned mean-absolute-error.
  - **No discrete overshoot%/rise-time/settling-time numbers are computed anywhere** — these are meant to be read visually off the plotted curve. Our app must compute these scalars itself.
- **Dependencies**: MATLAB Image Processing Toolbox, Curve Fitting Toolbox, Statistics and Machine Learning Toolbox (Octave equivalents: `image`, `signal`, `statistics` packages).
- **Pi 2B compatibility**: **None — do not attempt to run.** MATLAB has no ARM32 desktop runtime; Octave's GUI + FFT-heavy processing would struggle badly on a Pi 2B, and PIDscope ships desktop-only binaries. Use purely as an algorithmic reference to reimplement in Python.
- **Code we may reuse**: Nothing verbatim (different language, license ambiguity). Port the *math* clean-room: throttle-binned Hann-windowed FFT heatmap, difference-spectrograms (A/B tune or pre/post-filter comparison via matrix subtraction), cross-axis "quiet sample" gating, PID-error histogram + KS-test, stick-deflection-binned MAE, throttle-expo curve reproduction, delay→phase-shift conversion formula.
- **Code we should NOT reuse**: The step-response heuristic itself (superseded by PID-Analyzer's deconvolution approach, by the original author's own admission). Any GUI/MATLAB-specific code. The nerdCopter mirror's stripped/broken files should not be treated as a complete reference at all.
- **Limitations**: No formal validation of the step-response method; no confidence intervals; filter-delay source computation could not be located (possibly among the stripped pieces — derive our own group-delay formulas from our own filter design instead). Active fork (dzikus/PIDscope) has several open bugs (import hangs/freezes, incomplete Rotorflight support).
- **Last relevant Betaflight versions**: ianrmurphy snapshot straddles the BF 3→4 transition. dzikus/PIDscope explicitly adds Betaflight "2025.12" (calendar-versioned) support and is the only actively-maintained, fully open option today.

---

## 4. PID-Analyzer

- **Project**: PID-Analyzer (Plasmatree)
- **Repository**: https://github.com/Plasmatree/PID-Analyzer
- **Purpose**: Single-file Python tool computing PID step response (setpoint vs. gyro, via Wiener deconvolution) and noise/filter-transmission analysis from Betaflight logs. Outputs two PNGs per log; produces zero numeric tuning recommendations.
- **Lineage note**: Could not verify the claimed "Berry-based predecessor / ilmar / theArtificialCreator" lineage — GitHub metadata marks this repo `fork: false` and the sole credited author is Florian Melsheimer (Plasmatree). Treat provenance as author-original; a clean-room reimplementation is warranted regardless given license informality (see below).
- **Language**: Python (2/3-compatible via `six`), single file `PID-Analyzer.py` (1033 lines, three classes: `Trace`, `CSV_log`, `BB_log`). Pinned deps (numpy 1.11.3, scipy 1.0.0, pandas 0.22.0, matplotlib 2.0.0) are all 2016-2018-era and largely unnecessary — actual live code path only needs NumPy centrally, one `interp1d` call, one `gaussian_filter1d` call, and matplotlib for rendering. `scipy.optimize` and pandas are used minimally/gratuitously and are droppable in a clean rewrite.
- **License**: Informal "Beer-Ware License" (do-whatever-you-want, not OSI-approved, no patent grant). See [`licenses.md`](./licenses.md#pid-analyzer).
- **Useful components**: Shells out to an external `Blackbox_decode.exe` for BBL→CSV (does not parse BBL itself) — validates our own plan to shell out to `blackbox_decode`. `Trace` class does all the DSP.
- **Algorithms worth studying** (full detail in [`tuning-algorithms.md`](./tuning-algorithms.md)):
  - **Setpoint reconstruction** from `axisP` + gyro using a hard-coded Betaflight P-scaling constant (`0.032029`) — legacy approach for logs without a directly-logged setpoint channel; modern logs typically log `setpoint[0-3]` directly and should be preferred when present.
  - **Wiener deconvolution step response**: per-axis, 1s sliding windows (Hann-windowed, ~16x overlap), FFT-based `H*/(|H|²+1/SNR)` deconvolution with a synthetic frequency-dependent SNR mask (cutoff 25Hz), then `cumsum()` of the deconvolved impulse response to get the step response. This is the technically strongest step-response method among all references studied and the one PIDtoolbox's own author cited as superior to his own heuristic.
  - **No maneuver/event detection at all** — deconvolution runs continuously over every window across the whole flight; only a minimum-sample-count gate (low/high stick-input split at 500°/s) and a "too-low input" exclusion from averaging.
  - **Density/mode-seeking robust averaging** (`weighted_mode_avr`): 2D histogram of (time, amplitude) across all windows, Gaussian-smoothed, density²-weighted average — dilutes outlier windows rather than explicitly rejecting them.
  - **No overshoot%/rise-time/settling-time/delay scalars are computed anywhere** (verified: `calc_delay`, `rate_curve`, `weighted_avg_and_std` are all dead code, never called). Any such metrics must be computed independently on top of the extracted curve.
- **Dependencies**: NumPy (essential), matplotlib (essential for plotting), scipy (droppable to `np.interp` + hand-rolled Gaussian smoothing), pandas (droppable — used only for one `read_csv` call), `six` (droppable).
- **Pi 2B compatibility**: **Feasible with trimming.** FFT-based per-window deconvolution is cheap and vectorized; memory is the concern — stacked window arrays for input/gyro/throttle per axis can reach tens-to-hundreds of MB for long/high-rate logs. Recommend float32 downcasting, one-axis-at-a-time processing, and dropping pandas/scipy as noted. The pinned dependency versions themselves are pre-manylinux2014-era and will be painful to install on modern Raspberry Pi OS — target current numpy/matplotlib via apt/piwheels instead of the pinned versions.
- **Code we may reuse**: Clean-room reimplement (not port) the Wiener-deconvolution step-response method, the sliding-window-stacking + Hann-window approach, the impulse-response-to-step-response cumsum trick, and the density/mode-seeking robust-averaging concept (or replace with median/MAD rejection). The BBL multi-session-splitting *pattern* (split on repeated header line, discard sub-500KB fragments) is a useful non-algorithmic parsing idea, though we'll likely rely on `blackbox_decode`/a native parser instead of shelling out to a bundled `.exe`.
- **Code we should NOT reuse**: The hard-coded `0.032029` setpoint-reconstruction constant (version-specific, and unnecessary when `setpoint[]` is logged directly). Any RPM-filter/dynamic-notch/feedforward assumptions — README states testing only against Betaflight 3.15/3.2/3.3 (2017-2018), predating RPM filtering, D_MAX, feedforward, and modern dynamic-notch behavior; the `cutfreq=25Hz` mask and 500°/s D-setpoint threshold were tuned to that era's spectra. The window-count arithmetic (crashes on decimated/low logging rates per an open, unmerged 2026-07-04 PR). Dead-code utilities. The legacy heavy-dependency choices.
- **Limitations**: Not actively maintained (last code commit 2018-06-07); an open, unreviewed 2026-07-04 PR documents multiple crashes against current numpy/matplotlib/scipy APIs and against decimated-rate logs. No automated tests. Limited non-Betaflight firmware support (special-cased for KISS/Raceflight only).
- **Last relevant Betaflight versions**: Tested against **3.15 / 3.2 / 3.3** only (mid-2017). Materially predates RPM filtering (4.0+), feedforward, D_MAX — treat its fixed constants/thresholds as needing re-derivation for modern logs, not direct reuse.

---

## 5. SmartTune CLI

- **Project**: SmartTune CLI (`raylanlin/smarttune-cli`)
- **Repository**: https://github.com/raylanlin/smarttune-cli
- **Disambiguation note**: this is the only project literally named "SmartTune CLI" found. It is broader than a Betaflight-only analyzer — it also supports ArduPilot and PX4 logs and is positioned as an AI-agent tool-calling CLI/MCP server. It is a young project (created 2026-05-03, 27 stars). No forum/Discord-only alternative was found; treat that possibility as unresolved rather than assumed absent.
- **Purpose**: Offline, agent-friendly CLI (`stune`) + optional MCP server for flight-log tuning analysis. Betaflight support requires **no optional extras** — the BBL/BFL parser is pure Python.
- **Language**: Python ≥3.9. Core deps: numpy, scipy, matplotlib, click, rich. matplotlib appears to be **vestigial** — its legacy plotting module was removed in v2.4.2, and HTML report generation doesn't use it — a good candidate to drop entirely for a Pi build.
- **License**: **MIT.** A separate closed-source add-on (`smarttune-knowledge-pro`) is sold separately; the CLI/analysis code itself is fully MIT. See [`licenses.md`](./licenses.md#smarttune-cli).
- **Useful components**:
  - `smarttune/platform/betaflight/bbl_parser.py` (~1500 lines): a **from-scratch, pure-Python, zero-dependency BBL/BFL decoder** — implements the full frame/predictor/encoding scheme described under blackbox-tools above (I/P/S/E/H frames, all predictor types, TAG8_8SVB/TAG2_3S32/TAG8_4S16 encodings, multi-segment logs). This is the single most directly reusable component found across all six references, given the MIT license.
  - `step_response_fft.py`: explicitly reimplements PIDtoolbox's `PTstepcalc.m` lineage (credited in-code) but with proper Wiener-regularized FFT deconvolution — SP-amplitude gating (20-500°/s), zero-padded FFT deconvolution (λ=1e-4×max(Pxx) regularization), steady-state QC, segment averaging.
  - `analyzers/fft_analyzer.py`: generic per-axis gyro FFT (Hann window, configurable overlap), max envelope across 3 axes, peak classification into motor/prop-blade-pass/structural-resonance/high-freq-resonance bands with harmonic-ratio inference. Peak detection via `scipy.signal.find_peaks` (height = noise_floor+30dB, prominence=15, distance=3) with a **pure-numpy fallback already written** if scipy is unavailable — directly useful if we want to drop scipy on the Pi.
  - `analyzers/betaflight_analyzers.py::DTermNoiseAnalyzer`: D-term RMS, D/P ratio, D_min-activation heuristic, high-frequency-energy ratio, with concrete grading thresholds (D/P>0.5 → POOR; D/P>0.3 or HF-ratio>0.3 → MARGINAL).
  - `analyzers/filter_transfer.py`: real z-domain biquad model (Butterworth LPF + notch filters, phase response) — the Betaflight-specific wrapper is explicitly marked "Phase 3 placeholder" and does not model RPM-filter dynamics or the separate D-term filter stack.
- **Algorithms worth studying**: see [`tuning-algorithms.md`](./tuning-algorithms.md) for full detail on the FFT/peak-detection/step-response approaches.
- **Dependencies**: numpy, scipy (droppable per above), matplotlib (droppable), click, rich. No memory/CPU numbers documented; not verified on constrained hardware by the upstream project.
- **Pi 2B compatibility**: **Good, with trimming.** Pure-Python BBL parser has zero deps. numpy/scipy have prebuilt ARMv7 wheels via piwheels on Raspberry Pi OS. Recommend dropping matplotlib (vestigial) and evaluating dropping scipy (fallback path already exists for the one live usage, `find_peaks`).
- **Code we may reuse**: Because MIT-licensed, direct reuse with attribution is legally clean. Prioritize: the BBL/BFL parser (hardest-to-get-right component, pure Python, zero deps — strong candidate to adopt directly rather than reimplement), the FFT peak-detection/source-classification logic, the step-response deconvolution module, the core biquad/notch z-domain filter math.
- **Code we should NOT reuse**: The RPM-filter analyzer — it does **not** correlate actual per-motor eRPM/DShot-bidir telemetry with noise peaks (the parser doesn't extract an eRPM field), instead inferring "RPM filter enabled" from config flags alone and doing a shallow local-maxima scan. We should do meaningfully better by parsing actual eRPM/telemetry if present in the log. The Betaflight `filter_transfer.py` wrapper — explicitly an unfinished placeholder per its own docstring (single LPF + single notch approximation only).
- **Limitations**: No throttle-binned/noise-vs-throttle spectrogram (unlike PIDtoolbox) — single averaged spectrum only. Upstream project's own roadmap admits BBL-parsing accuracy and step-response/FFT output have **not yet been cross-validated** against Blackbox Explorer or Betaflight's built-in spectrum analyzer — validate independently before trusting numeric output (this directly motivates our own validation-workflow requirement below). No CI/CD; not published to PyPI. Young project, small community, unverified track record.
- **Last relevant Betaflight versions**: Code has explicit fallback handling for both BF 4.3-era and BF 4.5+ parameter names side by side (e.g. `d_min_roll`→`d_max_roll`, `gyro_lowpass_hz`→`gyro_lpf1_static_hz`). No stated max/min supported version. Actively maintained (pushed 2026-08-13, days before this research).

---

## 6. FPVtune / Betaflight PID Autotuning Projects

Multiple distinct projects were found under this umbrella; **all are experimental references only, never authoritative**, per the project brief's explicit instruction.

### 6a. FPVtune

- **Repository**: https://github.com/chugzb/betaflight-pid-autotuning (hosted product at fpvtune.com)
- **Purpose/status**: Paid ($20) hosted web service; analyzes a BBL/BFL log with a neural network (author-stated: 28 input features → Dense(128)→Dense(64)→Dense(32) → 18 PID outputs), outputs CLI commands in <30s. Active (updated Aug 2026), young (4 commits, 6 stars). The GitHub repo is a thin marketing wrapper — **the actual model/decision logic is not published**. The Betaflight community itself flagged this on the official GitHub Discussion (#14933): "I cannot find the source code... not so open source without it."
- **License**: MIT (for the thin public repo only; the trained model/service is proprietary).
- **Recommendation logic**: Undisclosed — lives inside an opaque trained neural net, not published rules. The author states a rule-based approach was tried and abandoned for falling apart on edge cases.
- **Confidence scoring / iteration / safety**: Not documented anywhere found. Only a generic claim that outputs are "always within safe operating ranges" plus a motor-thermal-prediction check and advice to hover-test before aggressive flight.
- **Verdict**: Real project with real community presence, but not inspectable — treat as an existence proof (neural-net-from-metrics concept, feature list) only.

### 6b. FPVPIDlab

- **Repository**: https://github.com/eddycek/fpvpidlab
- **Purpose/status**: Open-source Electron desktop app (TypeScript/React), connects via MSP/USB, three tuning modes (Filter Tune/FFT-only, PID Tune/step-response, Flash Tune/parallel FFT+Wiener deconvolution). Explicitly credits the Plasmatree/PID-Analyzer deconvolution technique as prior art. Actively developed (July 2026); self-described as **not yet hardware-validated** ("Phase 5: real hardware validation" ongoing).
- **Language/License**: TypeScript/Electron/React, GPL-3.0.
- **Recommendation logic (most concretely documented rule engine found across all references)** — full detail in [`tuning-algorithms.md`](./tuning-algorithms.md#pid-recommendation-strategies): D-first-then-P-only-if-extreme ordering, damping-ratio (D/P) clamps (0.45–0.85, relaxed to 1.0 for micros), D-effectiveness gating (blocks D increases into noise, redirects to filter tuning), size-aware PID bounds, qualitative confidence tags downgraded by a 0-100 "data quality score" (segment count, hover duration, throttle coverage, segment type), deterministic anchoring to the Blackbox header's logged PIDs (not live FC values) for reproducibility, pre/post-tuning config snapshots for rollback.
- **Trust caveat**: these details come from the project's own README/docs; individual rule-engine source files were not independently opened to confirm. Treat specific numeric thresholds as claims, not verified code behavior.
- **Verdict**: The best available reference for our own recommendation-engine *structure* (ordering, gating, confidence, rollback) — study the pattern, do not port the numbers uncritically.

### 6c. bf_controller_tuning (pichim)

- **Repository**: https://github.com/pichim/bf_controller_tuning
- **Purpose**: MATLAB + Python 3.12 framework for **offline system identification** via a logged chirp excitation (0.2–600Hz sweep injected into setpoint over 20s), producing Bode plots/sensitivity functions. Explicitly **manual, human-in-the-loop** — no automatic recommendation, no confidence scoring.
- **License**: GPL-3.0.
- **Relevance**: Prior art for chirp/system-ID-based tuning (same lineage as the official 2026 Betaflight autotune, below) and for its explicit precondition pattern (filters must be pre-tuned, FF/dynamic-damping disabled, before running an identification flight) — a useful safety/isolation pattern to borrow conceptually.

### 6d. PID_tune (stefapi)

- **Repository**: https://github.com/stefapi/PID_tune
- **Purpose**: Python tool using the `orangebox` library to decode BF/INAV logs and compute step response via deconvolution. **Visualization/diagnostic only — generates no tuning suggestions.** Tested against BF 4.2.8.
- **License**: BSD-2-Clause (its `orangebox` dependency is LGPL — check compatibility if we ever depend on it).
- **Relevance**: Reference implementation of the RC-input/gyro-output deconvolution measurement technique, same lineage as PID-Analyzer/FPVPIDlab.

### 6e. Historical Cleanflight/Betaflight in-flight "AUTOTUNE" (removed feature)

- Inherited from BradWii; drove only the ANGLE/HORIZON attitude controller. Algorithm: rotate to target angle, stop suddenly, measure resulting oscillation, adjust P/I/D live, repeat **in flight, closed-loop, with no independent verification step**.
- Developer consensus (cleanflight/cleanflight#723): "never tunes anything and is actively dangerous" — removed rather than fixed.
- **Direct cautionary prior art**: if our tool ever considers closed-loop in-flight adjustment, this failure mode is the explicit warning sign to design against.

### 6f. Official Betaflight chirp-based autotune (2026 master branch, not yet stable)

- Upstream Betaflight (not third-party), only on master/2026 branch. Uses chirp system-ID (same technique as `bf_controller_tuning`), captured via Blackbox chirp debug mode, producing spectrograms/response graphs and PID suggestions.
- Even the Betaflight team's own reviewers report the *measurement* half works but the *automatic-fix* half is unreliable — one documented test run **zeroed out pitch gain entirely, breaking takeoff**; defaults assume a 5" freestyle platform, unsafe on other sizes without a sane baseline first. Community guidance: read recommendations manually, cross-check against graphs, never apply blindly.
- **This is the strongest possible corroborating evidence, from the most authoritative source available, that even a well-resourced, officially-integrated automatic PID recommendation system is not yet trustworthy for blind auto-apply.** Our own recommendation engine must default to advisory-only output with mandatory human review before anything is written to a flight controller.

### 6g. Not found / ruled out

"OpenTune-FPV" is a manual community archive of pre-tuned CLI presets, unrelated to automated analysis. No other project named "FPVtune" exists beyond chugzb/betaflight-pid-autotuning + fpvtune.com.

### Comparison to established Betaflight tuning guidance

FPVPIDlab's D-first ordering, damping-ratio bounds, and "fix filters before raising D into noise" gate all mirror standard Betaflight PID Tuning Guide principles. The chirp/step-response measurement techniques used by `bf_controller_tuning`, `PID_tune`, official Betaflight autotune, and FPVPIDlab's Flash Tune all trace to the same Melsheimer/Plasmatree lineage underlying PIDtoolbox-adjacent methodology. FPVtune's neural net cannot be checked against tuning-guide principles at all (no interpretable rules). The historical in-flight autotune and even the 2026 official chirp autotune (zeroed-pitch incident) both independently confirm: **automated PID recommendation, generally, still lags manual expert judgment** — reinforcing advisory-only, human-reviewed output as our baseline design.

---

## Validation Workflow

Per the project brief, before allowing our analyzer to produce tuning recommendations, we will validate its output against the same Blackbox file processed independently by:

```
                   ┌─ PIDtoolbox (or dzikus/PIDscope) — visual heatmap comparison
                   │
BBL ───────────────┼─ PID-Analyzer — step response comparison
                   │
                   ├─ SmartTune CLI — FFT/noise/step-response comparison
                   │
                   └─ FPV Tuner (ours)
```

We do not require numerically identical results (algorithms differ meaningfully — see [`tuning-algorithms.md`](./tuning-algorithms.md)), but broad interpretive agreement is required before any tuning recommendation is surfaced to the user. Given SmartTune CLI's own roadmap admits its output hasn't been cross-validated against Blackbox Explorer, and PID-Analyzer's step-response method has no formal event-detection/quality gating, disagreement investigation is expected to be a real, recurring part of this workflow — not an edge case.

---

## Reference Hierarchy (for resolving disagreements)

```
Betaflight official behavior/documentation
        ↓
Betaflight official tools (blackbox-tools)
        ↓
PIDtoolbox / dzikus-PIDscope (established analysis approach)
        ↓
PID-Analyzer (deconvolution step-response reference)
        ↓
SmartTune CLI (closest architectural analog; MIT-licensed reusable parser/analyzers)
        ↓
FPVtune / FPVPIDlab / experimental autotuners (heuristic structure reference only)
        ↓
our own experimental heuristics
```
