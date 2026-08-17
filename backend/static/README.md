# FPV Tuner - Appliance Frontend

Static frontend for the FPV Tuner touchscreen appliance. Plain HTML/CSS/vanilla JS, no build step, no frameworks - served as-is by FastAPI's `StaticFiles` mount.

**This is a full rebuild**, replacing an earlier generic-dashboard-style scaffold (tabs, bottom nav, a scrolling multi-section page). That design was reasonable for an unknown screen size; it is wrong for the actual hardware. The real device is a **320x240 GPIO SPI touchscreen** on a Raspberry Pi 2B (confirmed via an actual framebuffer screenshot taken during this project's kiosk-mode setup - see the repo root README's "Deploying to the Pi" section). Every screen here is designed against that literal resolution: one purpose per screen, one main decision per screen, big buttons, short labels, card pagination instead of dense layouts.

## Architecture: an explicit state machine

`app.js` implements the whole app as a state machine (`STATES`, `goto()`, `onEnter()`), not a router with independent views. This was a deliberate, spec-driven choice: the product is a single guided sequence (connect → download → analyze → review results → optionally tune → apply → fly again), not a set of independently-navigable pages. A state machine makes every transition explicit and auditable, and makes error recovery predictable (`ERROR` is reachable from anywhere, `TRY AGAIN` re-runs whatever the failing state's entry action was).

```
IDLE → FC_DETECTED → CONNECTING → CONNECTED → DOWNLOADING_LOG → ANALYZING
  → ANALYSIS_RESULTS → [EXIT → IDLE] or [TUNE → TUNE_REVIEW]
TUNE_REVIEW → APPLYING_TUNE → TUNE_APPLIED → [DONE → IDLE]
ERROR (reachable from any state that can fail; TRY AGAIN retries, EXIT → IDLE)
HISTORY (reachable from CONNECTED; BACK → CONNECTED)
```

Two states named in the original product spec were folded into existing screens rather than built as separate ones:
- **TUNE_READY** → the last ("Summary") page of `TUNE_REVIEW`. Readiness (`GET /api/tuning/readiness`) is fetched the moment `TUNE_REVIEW` is entered, so the Summary page *is* the ready-to-apply gate, not a separate screen.
- **FC_REBOOTING** → one step ("Rebooting") inside `APPLYING_TUNE`'s job-progress screen, since the backend reports it that way as part of a single apply job rather than as a distinct phase.

Each state's screen is a `render*()` function (returns an HTML string set on `#screen`); each state's entry side effect (if any) is an `onEnter()` branch that fires exactly once per transition into that state. Button wiring is centralized in `wireCurrentScreen()`, called after every render - IDs are stable across screens (`btn-connect`, `btn-download`, `btn-prev`/`btn-next`, `btn-exit`, `btn-tune`, `btn-apply`, `btn-cancel`, `btn-done`, `btn-try-again`), which is also why the button vocabulary stays small by construction rather than by discipline.

## Screens

1. **Idle** - "Waiting for FC...", polls `GET /api/fc/detect` every 2s continuously, no manual refresh.
2. **FC Detected** - explicit CONNECT tap required (never auto-connects).
3. **Connecting** - brief spinner while `POST /api/fc/connect` is in flight.
4. **Connected / FC Information** - craft name, BF version, target, PID profile from `GET /api/fc/status`. Branches on `blackbox_storage`/`blackbox_available`: SPIFLASH-with-a-log-present shows DOWNLOAD BLACKBOX; anything else shows an honest explanation plus a file-upload fallback (`POST /api/logs/upload`). A small "History" link reaches the optional iteration-history screen.
5. **Downloading** - real job-step progress via `POST /api/logs/download-from-fc` + polling `GET /api/jobs/{id}` (steps: Downloading log / Decoding / Registering session).
6. **Analyzing** - a brief spinner around one fast synchronous call, `GET /api/analysis/summary`. See "Adaptation" note below on why this isn't merged into the download job's step list.
7. **Analysis Results** - 6-page card pagination (`GET /api/analysis/summary`): Overview, Roll, Pitch, Noise, Graphs (placeholder), and a final page that lazy-loads `GET /api/tuning/recommendations` + `GET /api/tuning/readiness` and offers EXIT or (only if recommendations exist) TUNE. "No tune required" is rendered as a first-class, non-error outcome when there are zero recommendations.
8. **Tune Review** - recommendations grouped into pages by `category` (Roll changes / Pitch changes / Filter+FF changes, empty categories skipped), plus a final Summary page listing every change with the overall confidence and readiness gate (`GET /api/tuning/readiness` - APPLY is disabled with the block reasons shown if `blocked: true`).
9. **Applying Tune** - real job-step progress via `POST /api/tuning/apply` + polling (steps: Backup / Writing settings / Verifying / Saving FC / Rebooting / Reconnecting / Final verification - the reboot/reconnect steps can take up to ~30s, shown as a patient, non-alarming wait). An `aborted: true` result (nothing was saved, per the backend's safety design) routes to ERROR with the backend's own short `abort_reason`.
10. **Tune Applied / Flight Instructions** - the fixed 5-step instruction list, one DONE button back to IDLE.
11. **History** (nice-to-have, built) - `GET /api/tuning/iterations`: a compact "Tune #N - label" list, best-tune marker, and a TUNE COMPLETE banner when the backend's stopping-criteria evaluation says so.
12. **Error** - generic, reusable. Every thrown error is passed through `shortenMessage()`, which defensively truncates/replaces anything that looks like a raw Python traceback - the backend shouldn't ever send one, but the UI doesn't trust that blindly.

## API contract actually used (all endpoints already implemented on the backend)

- `GET /api/fc/detect` → `{"detected": bool, "port": str|null}`
- `POST /api/fc/connect` `{"port": str|null}` → `{"success": bool, "message": str}`
- `GET /api/fc/status` → `{"connected","port","firmware_version","target","craft_name","pid_profile","blackbox_storage","blackbox_available"}`
- `POST /api/logs/download-from-fc` → `{"job_id"}`; `POST /api/logs/upload` (multipart, field `file`) → `{"log_id","sessions":[{"session_id","duration_s"}]}`
- `GET /api/jobs/{job_id}` → `{"status","percent","steps":[{"name","status","detail"}],"result","error"}`
- `GET /api/analysis/summary?session_id=` → `{"overall_grade","confidence_pct","axes":{"roll":{...},"pitch":{...},"yaw":{...}},"noise":{...}}`
- `GET /api/tuning/recommendations?session_id=` → `{"recommendations":[{"parameter","axis","current_value","proposed_value","change_pct","reason","confidence_pct","category"}]}`
- `GET /api/tuning/readiness?session_id=` → `{"version_supported","settings_read_ok","safety_passed","confidence_pct","blocked","block_reasons"}`
- `POST /api/tuning/apply?session_id=` → `{"job_id"}` (job result includes `aborted`, `abort_reason`, `saved`, `reconnected`, `final_verification_mismatches`, ...)
- `POST /api/tuning/record-iteration` `{"session_id","label"}`; `GET /api/tuning/iterations?craft=` → `{"iterations","best_iteration","current_is_best","tune_complete","stopping_reasons"}`

No contract guessing was needed here - unlike the original scaffold, every one of these routes already exists, is tested, and is deployed, so field names above are copied from the real backend rather than assumed.

## Adaptation note: Downloading vs. Analyzing are two screens, not one

The original UX mockup shows a single "ANALYZING" screen with steps like "Downloading log... / Decoding... / Step response... / Noise analysis...". The real backend doesn't work that way: `POST /api/logs/download-from-fc` is a job with exactly three steps (Downloading log / Decoding / Registering session), and `GET /api/analysis/summary` is a separate, fast, synchronous call with no per-metric step breakdown at all. Fabricating "Step response... ✓ / Noise analysis..." progress lines with no real backend signal behind them would be exactly the "fake animated progress bar" this product's own design brief says not to build. So: `DOWNLOADING_LOG` shows the real 3-step job progress, and a separate, brief `ANALYZING` spinner covers the one quick synchronous call. If the backend ever grows a step-tracked analysis job, this can merge into one screen without any contract changes elsewhere.

## Design rules applied

Every screen: one `.card` (the single content block), an optional `.page-footer` (PREV / page indicator / NEXT, or the Summary page's PREV/CANCEL/APPLY), or an `.action-row` (one or two primary buttons) - never both a page-footer and an unrelated action-row on the same screen. Minimum tap height 40px (`--tap-min`), which is large relative to the 240px-tall canvas and its ~13px base font, not large in some absolute desktop sense. `.scroll-y` is used in exactly three places (the Summary tune-review page, the final analysis-results page, and History) where content length is genuinely variable and unbounded scrolling is the honest alternative to truncating real data - everywhere else, content is sized to fit without scrolling.

## Verification

**Local, headless Chrome at the real 320x240 resolution** (not a generic mobile guess): served `backend/static/` with `python3 -m http.server`, drove the full state machine - idle → detected → connect → connected → download → analyze → all 6 result pages → tune review (all categories + summary) → applying → applied → done, plus the error path and history - against the real backend running locally with synthetic Blackbox sessions injected the same way earlier work in this project's history did. No JS console errors, no horizontal/vertical overflow at 320x240, every primary button comfortably tappable.

**Real hardware.** Deployed via `scripts/deploy_to_pi.sh`. [Fill in per the actual run: whether a kiosk-browser reload was triggered (`xdotool` availability was checked on the Pi) and whether a fresh `fbcat /dev/fb1` framebuffer capture confirmed the new UI rendering correctly on the physical panel, or whether verification was limited to the local headless-browser check plus confirming the real backend responds - be explicit either way rather than implying more than was actually confirmed.]
