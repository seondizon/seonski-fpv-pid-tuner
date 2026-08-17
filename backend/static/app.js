/* ==========================================================================
   FPV Tuner - app.js
   Vanilla JS, no build step, no dependencies. Single HTML page with
   client-side view switching (see README.md for why this approach was
   chosen over multiple static HTML files).

   Every fetch() call below is wrapped so that a missing/erroring backend
   route degrades to a clear "not connected yet" / "no data yet" message
   instead of throwing or leaving the UI blank.
   ========================================================================== */

(function () {
  "use strict";

  // --------------------------------------------------------------------
  // Assumed backend API contract (see README.md for the authoritative,
  // documented version of this list for teammates building the routes).
  // --------------------------------------------------------------------
  const API = {
    FC_STATUS: "/api/fc/status",
    FC_CONNECT: "/api/fc/connect",
    LOGS_UPLOAD: "/api/logs/upload",
    ANALYSIS_STEP: "/api/analysis/step-response",
    ANALYSIS_NOISE: "/api/analysis/noise",
    ANALYSIS_TRACKING: "/api/analysis/tracking",
    TUNING_RECOMMENDATIONS: "/api/tuning/recommendations",
  };

  // --------------------------------------------------------------------
  // App state (in-memory only; a kiosk session doesn't need persistence
  // across a full page reload, and we don't want to assume localStorage
  // survives on read-only Pi filesystems some kiosk setups use).
  // --------------------------------------------------------------------
  const state = {
    sessions: [], // [{session_id, duration_s}]
    selectedSessionId: null,
    selectedAxis: "roll",
    activeAnalysisTab: "step",
    analysisCache: {}, // key -> parsed response, cleared on session change
  };

  // --------------------------------------------------------------------
  // Fetch helper: never throws, always resolves to a normalized result.
  // { ok: true, data } | { ok: false, error }
  // --------------------------------------------------------------------
  async function safeFetchJson(url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      // Network error, backend not running, CORS, etc.
      return { ok: false, error: "network" };
    }
    if (!res.ok) {
      if (res.status === 404) {
        return { ok: false, error: "not_implemented", status: res.status };
      }
      return { ok: false, error: "http_" + res.status, status: res.status };
    }
    try {
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: "bad_json" };
    }
  }

  function errorMessage(result) {
    switch (result.error) {
      case "network":
        return "Backend not reachable yet.";
      case "not_implemented":
        return "This endpoint isn't implemented on the backend yet.";
      case "bad_json":
        return "Backend returned an unexpected response.";
      default:
        return "Backend returned an error (" + (result.status || "unknown") + ").";
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  function fmtNum(n, digits) {
    if (n === null || n === undefined || Number.isNaN(n)) return "-";
    return Number(n).toFixed(digits === undefined ? 2 : digits);
  }

  // ======================================================================
  // Router: hash-based view switching (#dashboard, #upload, #analysis, #tuning)
  // ======================================================================
  const VIEWS = ["dashboard", "upload", "analysis", "tuning"];

  function showView(name) {
    if (VIEWS.indexOf(name) === -1) name = "dashboard";

    VIEWS.forEach(function (v) {
      const el = document.getElementById("view-" + v);
      if (el) el.classList.toggle("active", v === name);
    });

    document.querySelectorAll(".nav-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-nav") === name);
    });

    // Lazy-load data relevant to the view being shown.
    if (name === "dashboard") refreshFcStatus();
    if (name === "analysis") renderAnalysisView();
    if (name === "tuning") loadTuningRecommendations();

    // Keep container scrolled to top on view change (touch UX nicety).
    const container = document.getElementById("view-container");
    if (container) container.scrollTop = 0;
  }

  function navigate(name) {
    if (location.hash.slice(1) === name) {
      showView(name); // same hash, force refresh
    } else {
      location.hash = "#" + name;
    }
  }

  window.addEventListener("hashchange", function () {
    showView(location.hash.slice(1));
  });

  // ======================================================================
  // 1. DASHBOARD
  // ======================================================================
  async function refreshFcStatus() {
    const body = document.getElementById("fc-status-body");
    const pill = document.getElementById("fc-pill");
    const pillText = document.getElementById("fc-pill-text");

    const result = await safeFetchJson(API.FC_STATUS);

    if (!result.ok) {
      pill.className = "unknown";
      pillText.textContent = "Unknown";
      body.innerHTML =
        '<div class="state-box">' +
        '<span class="state-icon">&#128268;</span>' +
        "Flight controller status not available yet.<br>" +
        '<span class="muted">' + escapeHtml(errorMessage(result)) + "</span>" +
        "</div>";
      return;
    }

    const s = result.data || {};
    const connected = !!s.connected;

    pill.className = connected ? "connected" : "disconnected";
    pillText.textContent = connected ? "Connected" : "Disconnected";

    body.innerHTML =
      '<div class="row"><span class="label">Status</span>' +
      '<span class="value">' + (connected ? "Connected" : "Disconnected") + "</span></div>" +
      '<div class="row"><span class="label">Port</span>' +
      '<span class="value">' + escapeHtml(s.port || "-") + "</span></div>" +
      '<div class="row"><span class="label">Firmware</span>' +
      '<span class="value">' + escapeHtml(s.firmware_version || "-") + "</span></div>" +
      '<div class="row"><span class="label">Target</span>' +
      '<span class="value">' + escapeHtml(s.target || "-") + "</span></div>";
  }

  async function handleConnectClick() {
    const feedback = document.getElementById("connect-feedback");
    const btn = document.getElementById("btn-connect");
    btn.disabled = true;
    feedback.textContent = "Attempting to connect...";

    const result = await safeFetchJson(API.FC_CONNECT, { method: "POST" });

    if (!result.ok) {
      feedback.textContent =
        "Could not connect: " + errorMessage(result) +
        " (assumed endpoint: POST " + API.FC_CONNECT + ")";
    } else {
      feedback.textContent = "Connect request sent.";
    }

    btn.disabled = false;
    refreshFcStatus();
  }

  // ======================================================================
  // 2. LOG UPLOAD / SELECT
  // ======================================================================
  function renderSessionsList() {
    const container = document.getElementById("sessions-list");

    if (!state.sessions.length) {
      container.innerHTML =
        '<div class="state-box">' +
        '<span class="state-icon">&#128193;</span>' +
        "No sessions yet. Upload a log above to see decoded flight sessions here." +
        "</div>";
      return;
    }

    container.innerHTML = state.sessions
      .map(function (s) {
        const durationLabel =
          s.duration_s !== undefined && s.duration_s !== null
            ? fmtNum(s.duration_s, 1) + " s"
            : "unknown duration";
        return (
          '<div class="session-item">' +
          "<div>" +
          '<div><strong>' + escapeHtml(s.session_id) + "</strong></div>" +
          '<div class="muted">' + durationLabel + "</div>" +
          "</div>" +
          '<button class="btn btn-primary" data-select-session="' +
          escapeHtml(s.session_id) +
          '">Analyze</button>' +
          "</div>"
        );
      })
      .join("");

    container.querySelectorAll("[data-select-session]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.selectedSessionId = btn.getAttribute("data-select-session");
        state.analysisCache = {};
        navigate("analysis");
      });
    });
  }

  async function handleUploadClick() {
    const input = document.getElementById("log-file-input");
    const status = document.getElementById("upload-status");
    const track = document.getElementById("upload-progress-track");
    const fill = document.getElementById("upload-progress-fill");
    const btn = document.getElementById("btn-upload");

    if (!input.files || !input.files.length) {
      status.textContent = "Choose a file first.";
      return;
    }

    const file = input.files[0];
    const formData = new FormData();
    formData.append("file", file);

    btn.disabled = true;
    track.style.display = "block";
    fill.style.width = "10%";
    status.textContent = "Uploading " + file.name + "...";

    // Use XHR (not fetch) only because it gives us upload progress events,
    // which fetch's basic API does not expose. Falls back gracefully if
    // the endpoint doesn't exist yet.
    const xhr = new XMLHttpRequest();

    const done = new Promise(function (resolve) {
      xhr.upload.addEventListener("progress", function (e) {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          fill.style.width = pct + "%";
        }
      });
      xhr.addEventListener("load", function () {
        resolve({ status: xhr.status, body: xhr.responseText });
      });
      xhr.addEventListener("error", function () {
        resolve({ status: 0, body: null });
      });
      xhr.addEventListener("abort", function () {
        resolve({ status: 0, body: null });
      });
    });

    xhr.open("POST", API.LOGS_UPLOAD);
    xhr.send(formData);

    const result = await done;
    btn.disabled = false;

    if (result.status === 0) {
      status.textContent =
        "Upload failed: backend not reachable yet (assumed endpoint: POST " +
        API.LOGS_UPLOAD + ").";
      fill.style.width = "0%";
      return;
    }

    if (result.status === 404) {
      status.textContent =
        "Upload endpoint isn't implemented on the backend yet (POST " +
        API.LOGS_UPLOAD + ").";
      fill.style.width = "0%";
      return;
    }

    if (result.status < 200 || result.status >= 300) {
      status.textContent = "Upload failed (HTTP " + result.status + ").";
      fill.style.width = "0%";
      return;
    }

    let data;
    try {
      data = JSON.parse(result.body);
    } catch (err) {
      status.textContent = "Upload succeeded but the response was unreadable.";
      return;
    }

    fill.style.width = "100%";
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    status.textContent =
      "Uploaded. Log ID: " + (data.log_id || "unknown") +
      " - " + sessions.length + " session(s) decoded.";

    state.sessions = state.sessions.concat(sessions);
    renderSessionsList();
  }

  // ======================================================================
  // 3. ANALYSIS VIEW
  // ======================================================================
  function renderAnalysisView() {
    const noSession = document.getElementById("analysis-no-session");
    const body = document.getElementById("analysis-body");

    if (!state.selectedSessionId) {
      noSession.style.display = "block";
      body.style.display = "none";
      return;
    }

    noSession.style.display = "none";
    body.style.display = "block";

    document.getElementById("analysis-session-label").textContent =
      "Session: " + state.selectedSessionId + " - Axis: " + state.selectedAxis;

    loadAnalysisTab(state.activeAnalysisTab);
  }

  function switchAnalysisTab(tab) {
    state.activeAnalysisTab = tab;
    document.querySelectorAll("#analysis-tabbar button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });
    document.querySelectorAll(".analysis-tab").forEach(function (panel) {
      panel.style.display = panel.getAttribute("data-tab-panel") === tab ? "block" : "none";
    });
    loadAnalysisTab(tab);
  }

  function switchAxis(axis) {
    state.selectedAxis = axis;
    document.querySelectorAll("#axis-toggle button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-axis") === axis);
    });
    document.getElementById("analysis-session-label").textContent =
      "Session: " + state.selectedSessionId + " - Axis: " + state.selectedAxis;
    loadAnalysisTab(state.activeAnalysisTab);
  }

  function cacheKey(tab) {
    return tab + "|" + state.selectedSessionId + "|" + state.selectedAxis;
  }

  async function loadAnalysisTab(tab) {
    const sessionId = state.selectedSessionId;
    const axis = state.selectedAxis;
    const key = cacheKey(tab);

    let targetId, endpoint, renderFn;
    if (tab === "step") {
      targetId = "step-content";
      endpoint = API.ANALYSIS_STEP;
      renderFn = renderStepResponse;
    } else if (tab === "noise") {
      targetId = "noise-content";
      endpoint = API.ANALYSIS_NOISE;
      renderFn = renderNoise;
    } else {
      targetId = "tracking-content";
      endpoint = API.ANALYSIS_TRACKING;
      renderFn = renderTracking;
    }

    const target = document.getElementById(targetId);

    if (state.analysisCache[key]) {
      renderFn(target, state.analysisCache[key]);
      return;
    }

    target.innerHTML = '<p class="muted">Loading...</p>';

    const url =
      endpoint + "?session_id=" + encodeURIComponent(sessionId) +
      "&axis=" + encodeURIComponent(axis);
    const result = await safeFetchJson(url);

    if (!result.ok) {
      target.innerHTML =
        '<div class="state-box">' +
        '<span class="state-icon">&#128202;</span>' +
        "No data yet.<br>" +
        '<span class="muted">' + escapeHtml(errorMessage(result)) +
        " (assumed endpoint: GET " + escapeHtml(endpoint) + ")</span>" +
        "</div>";
      return;
    }

    state.analysisCache[key] = result.data;
    renderFn(target, result.data);
  }

  function renderStepResponse(target, data) {
    data = data || {};
    target.innerHTML =
      '<div class="stat-grid">' +
      statTile(fmtNum(data.overshoot_pct, 1) + "%", "Overshoot") +
      statTile(fmtNum(data.rise_time_s, 3) + " s", "Rise Time") +
      statTile(fmtNum(data.settling_time_s, 3) + " s", "Settling Time") +
      "</div>";
  }

  function renderNoise(target, data) {
    data = data || {};
    const peaks = Array.isArray(data.peaks) ? data.peaks : [];

    if (!peaks.length) {
      target.innerHTML =
        '<div class="state-box"><span class="state-icon">&#128266;</span>No noise peaks reported.</div>';
      return;
    }

    let rows = peaks
      .map(function (p) {
        return (
          '<div class="row">' +
          '<span class="label">' + escapeHtml(p.classification || "unclassified") + "</span>" +
          '<span class="value">' + fmtNum(p.freq_hz, 1) + " Hz</span>" +
          "</div>"
        );
      })
      .join("");

    target.innerHTML = '<div class="card mt-0">' + rows + "</div>";
  }

  function renderTracking(target, data) {
    data = data || {};
    const bins = Array.isArray(data.stick_bins) ? data.stick_bins : [];

    let html =
      '<div class="stat-grid">' +
      statTile(fmtNum(data.error_std, 3), "Error Std Dev") +
      "</div>";

    if (bins.length) {
      html +=
        '<div class="card mt-0"><h3 class="mt-0">Per-Stick-Bin MAE</h3>' +
        bins
          .map(function (b) {
            return (
              '<div class="row">' +
              '<span class="label">Bin ' + escapeHtml(b.bin) + "</span>" +
              '<span class="value">' + fmtNum(b.mae, 3) + "</span>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    target.innerHTML = html;
  }

  function statTile(value, label) {
    return (
      '<div class="stat-tile">' +
      '<span class="stat-value">' + escapeHtml(value) + "</span>" +
      '<span class="stat-label">' + escapeHtml(label) + "</span>" +
      "</div>"
    );
  }

  // ======================================================================
  // 4. TUNING RECOMMENDATIONS (advisory shell only - see README)
  // ======================================================================
  function confidenceClass(level) {
    const l = (level || "").toLowerCase();
    if (l === "high") return "confidence-high";
    if (l === "low") return "confidence-low";
    return "confidence-medium";
  }

  function recommendationCard(rec, isDemo) {
    const confClass = confidenceClass(rec.confidence);
    return (
      '<div class="rec-card' + (isDemo ? " demo" : "") + '">' +
      '<div class="rec-card-head">' +
      "<h4>" + escapeHtml(rec.parameter) + "</h4>" +
      '<span class="badge ' + confClass + '">' + escapeHtml(rec.confidence || "unknown") + "</span>" +
      "</div>" +
      (isDemo ? '<span class="badge badge-demo" style="margin-bottom:8px;display:inline-block;">Example - backend not connected</span>' : "") +
      '<div class="rec-values">' +
      '<div><span class="v-label">Current</span><span class="v-value">' + escapeHtml(rec.current_value) + "</span></div>" +
      '<div><span class="v-label">Suggested</span><span class="v-value">' + escapeHtml(rec.suggested_value) + "</span></div>" +
      "</div>" +
      '<p class="rec-rationale">' + escapeHtml(rec.rationale || "") + "</p>" +
      '<button class="btn btn-danger-outline btn-block" data-review-apply="' + escapeHtml(rec.parameter) + '">Review &amp; Apply</button>' +
      "</div>"
    );
  }

  const DEMO_RECOMMENDATIONS = [
    {
      parameter: "Roll P",
      current_value: "42",
      suggested_value: "46",
      confidence: "medium",
      rationale: "Example only. A real rationale would explain the observed step-response/noise evidence behind this suggestion.",
    },
    {
      parameter: "Pitch D",
      current_value: "30",
      suggested_value: "27",
      confidence: "low",
      rationale: "Example only. Shown so the card layout can be reviewed before the recommendation engine exists.",
    },
  ];

  async function loadTuningRecommendations() {
    const body = document.getElementById("tuning-body");
    body.innerHTML =
      '<div class="state-box"><span class="state-icon">&#128203;</span>Loading recommendations...</div>';

    if (!state.selectedSessionId) {
      renderDemoRecommendations(body, "Select a session in Analysis to load real recommendations.");
      return;
    }

    const url =
      API.TUNING_RECOMMENDATIONS + "?session_id=" + encodeURIComponent(state.selectedSessionId);
    const result = await safeFetchJson(url);

    if (!result.ok) {
      renderDemoRecommendations(body, errorMessage(result) +
        " (assumed endpoint: GET " + API.TUNING_RECOMMENDATIONS + ")");
      return;
    }

    const recs = Array.isArray(result.data) ? result.data : (result.data.recommendations || []);

    if (!recs.length) {
      renderDemoRecommendations(body, "Backend connected but returned no recommendations for this session yet.");
      return;
    }

    body.innerHTML = recs.map(function (r) { return recommendationCard(r, false); }).join("");
    wireReviewApplyButtons(body);
  }

  function renderDemoRecommendations(body, noticeText) {
    body.innerHTML =
      '<div class="state-box" style="margin-bottom:14px;">' +
      '<span class="state-icon">&#128203;</span>' + escapeHtml(noticeText) +
      "<br><span class=\"muted\">Showing example placeholder cards below so the layout can be reviewed.</span>" +
      "</div>" +
      DEMO_RECOMMENDATIONS.map(function (r) { return recommendationCard(r, true); }).join("");
    wireReviewApplyButtons(body);
  }

  function wireReviewApplyButtons(container) {
    container.querySelectorAll("[data-review-apply]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const param = btn.getAttribute("data-review-apply");
        // Stub only: this project's safety design requires every tuning
        // change to be manually reviewed and test-flown. There is no
        // "apply" API call wired up here on purpose - see README.md.
        window.confirm(
          '"Review & Apply" for ' + param + " is not implemented yet.\n\n" +
          "By design, this scaffold never sends tuning changes to the " +
          "flight controller automatically. When this is built, it will " +
          "still require explicit human confirmation of the exact CLI " +
          "command and a test flight before the change is trusted."
        );
      });
    });
  }

  // ======================================================================
  // Wiring
  // ======================================================================
  function init() {
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      el.addEventListener("click", function () {
        navigate(el.getAttribute("data-nav"));
      });
    });

    document.getElementById("btn-connect").addEventListener("click", handleConnectClick);
    document.getElementById("btn-upload").addEventListener("click", handleUploadClick);

    document.getElementById("log-file-input").addEventListener("change", function (e) {
      const status = document.getElementById("upload-status");
      if (e.target.files && e.target.files.length) {
        status.textContent = "Selected: " + e.target.files[0].name;
      }
    });

    document.querySelectorAll("#axis-toggle button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchAxis(btn.getAttribute("data-axis"));
      });
    });

    document.querySelectorAll("#analysis-tabbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        switchAnalysisTab(btn.getAttribute("data-tab"));
      });
    });

    renderSessionsList();

    const initial = location.hash.slice(1) || "dashboard";
    showView(initial);

    // Lightweight polling of FC status for the header pill. 20s interval
    // is deliberately slow to keep the Pi 2B's CPU/network usage low.
    refreshFcStatus();
    setInterval(refreshFcStatus, 20000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
