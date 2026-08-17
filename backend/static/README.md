# FPV Tuner - Frontend Scaffold

Static frontend for the FPV Tuner kiosk UI. Plain HTML/CSS/vanilla JS, no
build step, no frameworks - meant to be served as-is by FastAPI's
`StaticFiles` mount, and to run comfortably in a kiosk browser on a
Raspberry Pi 2B (1GB RAM) driving a small touchscreen (800x480 / 1024x600).

This is a **scaffold**, not a finished app. The Blackbox analysis backend
and the FC-connection backend are being built in parallel and don't exist
yet, so every view here fetches from an assumed API (documented below) and
degrades to a clear "not connected yet" / "no data yet" state instead of
crashing when a route 404s, errors, or the backend isn't running at all.

## Files

- `index.html` - the entire app shell: header, four view `<section>`s, bottom nav.
- `styles.css` - all styling (theme variables, layout, components).
- `app.js` - all behavior (routing, fetch calls, rendering), vanilla JS, IIFE-wrapped.
- `README.md` - this file.

## View-switching approach

**Single HTML page with client-side view switching**, not four separate
`.html` files. Reasoning:

- A persistent bottom nav bar and header (FC status pill) need to stay on
  screen across every view on a small touchscreen - a multi-page site
  would either duplicate that chrome in every file or reload/flash it on
  every tap, which feels bad on a kiosk touchscreen and wastes cycles on a
  Pi 2B re-parsing/re-rendering the whole document on every navigation.
- Shared state (selected session id, selected axis, cached analysis
  responses) is simplest to keep as one in-memory JS object when it's one
  page; across separate HTML files it would need `sessionStorage`/URL
  params, which adds complexity for no real benefit at this scale.
- Routing is intentionally trivial: view names map 1:1 to `location.hash`
  (`#dashboard`, `#upload`, `#analysis`, `#tuning`). Four `<section class="view">`
  blocks are shown/hidden with a CSS class toggle in `showView()`. No
  virtual DOM, no diffing, no history API tricks - just class toggles.
- Each of the four required views is exactly one hash route, and
  tabs/toggles within a view (analysis tabs, axis selector) are handled
  as plain show/hide within that view's own markup - so there is never
  more than one level of navigation depth, per the "no nested menus"
  constraint.

If this ever needs deep-linking from outside the app (e.g. a notification
linking straight to an analysis result), the hash scheme already supports
extending to something like `#analysis/<session_id>/<axis>` without
restructuring anything.

## Assumed backend API contract

None of these routes exist yet. This is the contract the frontend was
built against - please treat it as a first draft, not a spec handed down
from on high; happy to adjust field names to match whatever the analysis
and FC modules naturally produce (`backend/app/analysis/`,
`backend/app/fc/`, `backend/app/blackbox/`).

### FC connection

- `GET /api/fc/status`
  Response 200:
  ```json
  {"connected": false, "port": null, "firmware_version": null, "target": null}
  ```
  Used to populate the Dashboard status card and the small header pill
  (polled every 20s while the app is open - kept slow deliberately to
  avoid wasting Pi 2B CPU/network on a page that's just sitting idle on a
  shelf).

- `POST /api/fc/connect`
  Assumed to kick off a connection attempt (serial port autodetect, MSP
  handshake, etc. - whatever `backend/app/fc/serial_transport.py` /
  `msp.py` end up doing). Frontend does not assume a request body or a
  particular response shape yet - it just re-fetches `GET /api/fc/status`
  afterward and shows whatever that says. If the real implementation
  wants to return an immediate `{"success": bool, "message": str}` instead,
  the frontend can easily be updated to surface `message` directly.

### Blackbox logs

- `POST /api/logs/upload` (multipart/form-data, field name `file`)
  Response 200:
  ```json
  {
    "log_id": "abc123",
    "sessions": [
      {"session_id": "abc123-0", "duration_s": 42.7},
      {"session_id": "abc123-1", "duration_s": 118.2}
    ]
  }
  ```
  A single Blackbox log file can contain multiple arm/disarm sessions;
  the frontend lists each one separately with an "Analyze" button that
  selects it for the Analysis view.

  Upload is done via `XMLHttpRequest` rather than `fetch()` specifically
  to get `upload.progress` events for the progress bar - this is the one
  place the frontend doesn't use plain `fetch()`.

### Analysis (all three take the same query params)

Common query params: `session_id` (string, required), `axis` (`roll` |
`pitch` | `yaw`, required).

- `GET /api/analysis/step-response?session_id=...&axis=roll`
  ```json
  {"axis": "roll", "overshoot_pct": 12.4, "rise_time_s": 0.038, "settling_time_s": 0.091}
  ```

- `GET /api/analysis/noise?session_id=...&axis=roll`
  ```json
  {
    "axis": "roll",
    "peaks": [
      {"freq_hz": 143.0, "amplitude": 0.82, "classification": "motor"},
      {"freq_hz": 310.5, "amplitude": 0.31, "classification": "frame_resonance"}
    ]
  }
  ```

- `GET /api/analysis/tracking?session_id=...&axis=roll`
  ```json
  {
    "axis": "roll",
    "error_std": 4.12,
    "stick_bins": [
      {"bin": "-100..-50", "mae": 3.1},
      {"bin": "-50..0", "mae": 2.4},
      {"bin": "0..50", "mae": 2.6},
      {"bin": "50..100", "mae": 3.4}
    ]
  }
  ```

The frontend caches each `(tab, session_id, axis)` response in memory so
flipping between Roll/Pitch/Yaw or between tabs doesn't refetch data that
was already loaded; the cache is cleared whenever a new session is
selected.

### Tuning recommendations

- `GET /api/tuning/recommendations?session_id=...`
  ```json
  [
    {
      "parameter": "Roll P",
      "current_value": "42",
      "suggested_value": "46",
      "confidence": "medium",
      "rationale": "Step response shows 18% overshoot with acceptable rise time; a moderate P increase should tighten tracking without materially increasing overshoot."
    }
  ]
  ```
  (Either a bare array or `{"recommendations": [...]}` is accepted by the
  frontend.)

  **There is intentionally no "apply" endpoint documented or called
  here.** Per the project's safety requirements, recommendations must
  always be advisory and human-reviewed - never auto-applied. The
  "Review & Apply" button per card is a stub: it opens a `confirm()`
  dialog explaining nothing has been changed, and does not call the
  network. When real apply functionality is designed, it should almost
  certainly require the user to see and confirm the exact CLI/MSP command
  before anything is sent to the flight controller - do not wire this up
  as a silent one-tap action.

  If this endpoint isn't reachable (which it won't be until the analysis
  and recommendation logic exists), the Tuning view falls back to showing
  two clearly-labeled example cards ("Example - backend not connected")
  so the card layout itself can be reviewed before the engine exists.
  These are hardcoded in `app.js` (`DEMO_RECOMMENDATIONS`) and are never
  presented as real data.

## Chart placeholders

Step response, noise/FFT, and tracking charts are stubbed as clearly
labeled dashed boxes (`.chart-placeholder` in `styles.css`) rather than
wired to a real charting library, per the scaffold brief.

**Recommendation for later:** a small canvas-based library rather than an
SVG/DOM-heavy one, given the Pi 2B's limited CPU/RAM and the fact it's
already running a full browser engine for the kiosk. Two options worth
evaluating when charts are actually built, both dependency-light and
canvas-based:

- **uPlot** (~45KB, no dependencies) - extremely fast, built specifically
  for large time-series data with minimal CPU/memory overhead. Good fit
  for step-response and tracking-error line charts.
- **Chart.js** (~60-90KB depending on bundle) - canvas-based, more
  batteries-included (legends, tooltips, easier heatmap-ish plugins for
  the FFT view), a bit heavier than uPlot but still light next to
  SVG-based libraries.

Avoid D3 (or anything that renders large SVG DOM trees) here - great
library, wrong constraint: SVG DOM nodes for dense time-series/FFT data
scale badly on a Pi 2B's CPU, and kiosk mode gets zero benefit from D3's
data-binding/transition machinery for what is fundamentally a fixed set
of read-only charts.

## Manual verification performed

No frontend build step exists, so this was checked by serving the
directory with `python3 -m http.server` and driving it with headless
Chrome (via puppeteer-core, temporarily installed outside the repo and
removed afterward) at both 800x480 and 1024x600:

- No JS console errors/exceptions across all four views, axis/tab
  switching, the upload flow, the Connect button, and the Review & Apply
  confirm-dialog stub (the only console output was the *expected* 404s
  from hitting `/api/...` routes that don't exist yet on a plain static
  file server).
- No horizontal overflow at either viewport size.
- All primary tap targets measured >= 48px tall (bottom nav 60px, primary
  buttons 64px, secondary buttons >= 44-48px).
- Dark and light palettes both verified to switch correctly under
  `prefers-color-scheme` with solid text/background contrast in both.

To re-check manually after future edits:
```sh
cd backend/static
python3 -m http.server 8080
# open http://localhost:8080/index.html, use browser devtools' device
# toolbar set to ~800x480 or 1024x600, and check the console for errors.
```
