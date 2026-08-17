/* ==========================================================================
   FPV Tuner - app.js

   Appliance UI, driven by an explicit state machine (not scattered UI
   callbacks) -- see STATES below and goto()/onEnter(). Each state defines
   what's shown (a render*() function), what happens on entry (onEnter, for
   states that kick off an API call/job), and how it transitions out
   (button handlers in wireCurrentScreen(), or automatic transitions once
   an async call/job resolves).

   Real screen: a 320x240 GPIO touchscreen (verified via an actual
   framebuffer screenshot during this project's kiosk-mode setup) -- every
   screen here is designed for exactly that size, not a generic "small
   screen" guess.
   ========================================================================== */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------
  var STATES = {
    IDLE: "IDLE",
    FC_DETECTED: "FC_DETECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    DOWNLOADING_LOG: "DOWNLOADING_LOG",
    ANALYZING: "ANALYZING",
    ANALYSIS_RESULTS: "ANALYSIS_RESULTS",
    TUNE_REVIEW: "TUNE_REVIEW",
    APPLYING_TUNE: "APPLYING_TUNE",
    TUNE_APPLIED: "TUNE_APPLIED",
    HISTORY: "HISTORY",
    ERROR: "ERROR",
  };
  // Note: the product spec also names TUNE_READY and FC_REBOOTING as
  // distinct states. TUNE_READY is folded into TUNE_REVIEW's last
  // ("Summary") page -- readiness is fetched as soon as TUNE_REVIEW is
  // entered, so the Summary page IS the tune-ready gate, not a separate
  // screen. FC_REBOOTING is folded into APPLYING_TUNE as one of its job
  // steps ("Rebooting"), since the backend already reports it that way
  // via the single apply job rather than as a separate phase.

  var RESULT_PAGE_COUNT = 6;

  var state = STATES.IDLE;
  var ctx = freshCtx();
  var detectTimer = null;
  var activePollTimer = null;

  function freshCtx() {
    return {
      detectedPort: null,
      fcStatus: {},
      jobId: null,
      job: null,
      sessionId: null,
      summary: null,
      resultsPage: 0,
      recommendations: [],
      finalPageLoaded: false,
      finalPageLoading: false,
      readiness: null,
      tunePage: 0,
      tuneGroups: null,
      readinessForApply: null,
      applyResult: null,
      historyData: null,
      errorMessage: "",
      errorRetry: null,
    };
  }

  function goto(newState, patch) {
    if (activePollTimer) {
      clearInterval(activePollTimer);
      activePollTimer = null;
    }
    if (state === STATES.IDLE && newState !== STATES.IDLE) stopDetectPolling();
    state = newState;
    if (patch) Object.assign(ctx, patch);
    render();
    onEnter(newState);
  }

  function onEnter(s) {
    if (s === STATES.IDLE) {
      ctx = freshCtx();
      startDetectPolling();
    } else if (s === STATES.CONNECTING) {
      doConnect();
    } else if (s === STATES.DOWNLOADING_LOG) {
      doStartDownloadJob();
    } else if (s === STATES.ANALYZING) {
      doAnalyze();
    } else if (s === STATES.TUNE_REVIEW) {
      onEnterTuneReview();
    } else if (s === STATES.APPLYING_TUNE) {
      doStartApplyJob();
    } else if (s === STATES.HISTORY) {
      onEnterHistory();
    }
  }

  // ------------------------------------------------------------------
  // Fetch helper: throws a short, human-readable Error on any failure
  // (network, non-2xx, bad JSON) -- callers catch once and show it,
  // never a raw stack trace, per the error-handling spec.
  // ------------------------------------------------------------------
  async function apiFetch(path, opts) {
    var res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error("Network error - backend not reachable.");
    }
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* no/invalid JSON body */
    }
    if (!res.ok) {
      var msg = "HTTP " + res.status;
      if (data) {
        if (typeof data.detail === "string") msg = data.detail;
        else if (data.detail && typeof data.detail === "object") {
          msg = data.detail.message || JSON.stringify(data.detail);
        } else if (data.message) {
          msg = data.message;
        }
      }
      throw new Error(shortenMessage(String(msg)));
    }
    return data;
  }

  function shortenMessage(msg) {
    if (!msg) return "Something went wrong.";
    if (msg.indexOf("Traceback (most recent call last)") !== -1) {
      return "An internal error occurred.";
    }
    if (msg.length > 160) return msg.slice(0, 160) + "...";
    return msg;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s === null || s === undefined ? "" : String(s);
    return d.innerHTML;
  }

  function fmtNum(n, digits) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
    return Number(n).toFixed(digits === undefined ? 1 : digits);
  }

  function fmtPct(n) {
    return n === null || n === undefined ? "-" : fmtNum(n, 1) + "%";
  }

  function fmtMs(n) {
    return n === null || n === undefined ? "-" : fmtNum(n, 0) + " ms";
  }

  function el(id) {
    return document.getElementById(id);
  }

  function on(id, evt, fn) {
    var e = el(id);
    if (e) e.addEventListener(evt, fn);
  }

  function metricRow(label, value) {
    return (
      '<div class="metric-row"><span class="m-label">' + esc(label) +
      '</span><span class="m-value">' + esc(value) + "</span></div>"
    );
  }

  function gradeRow(label, grade) {
    var g = (grade || "UNKNOWN").toString();
    return (
      '<div class="metric-row"><span class="m-label">' + esc(label) +
      '</span><span class="grade grade-' + esc(g.toLowerCase()) + '">' + esc(g) + "</span></div>"
    );
  }

  // ------------------------------------------------------------------
  // Idle -- continuous background FC-presence polling, no manual refresh.
  // ------------------------------------------------------------------
  function startDetectPolling() {
    stopDetectPolling();
    checkDetect();
    detectTimer = setInterval(checkDetect, 2000);
  }

  function stopDetectPolling() {
    if (detectTimer) {
      clearInterval(detectTimer);
      detectTimer = null;
    }
  }

  async function checkDetect() {
    try {
      var d = await apiFetch("/api/fc/detect");
      if (d.detected && state === STATES.IDLE) {
        goto(STATES.FC_DETECTED, { detectedPort: d.port });
      }
    } catch (e) {
      /* transient network hiccup while idle -- keep polling silently */
    }
  }

  function renderIdle() {
    return (
      '<div class="center-card">' +
      '<div class="big-line">FPV TUNER</div>' +
      '<div class="sub-line">Waiting for FC...</div>' +
      '<div class="spinner"></div>' +
      "</div>"
    );
  }

  // ------------------------------------------------------------------
  // FC Detected -- explicit tap required, never auto-connect.
  // ------------------------------------------------------------------
  function renderFcDetected() {
    return (
      '<div class="center-card">' +
      '<div class="big-line">FC DETECTED</div>' +
      '<div class="sub-line">Betaflight device found on USB</div>' +
      "</div>" +
      '<div class="action-row"><button class="btn btn-primary" id="btn-connect">CONNECT</button></div>'
    );
  }

  function renderConnecting() {
    return (
      '<div class="center-card"><div class="spinner"></div><div class="sub-line">Connecting...</div></div>'
    );
  }

  async function doConnect() {
    try {
      var resp = await apiFetch("/api/fc/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: ctx.detectedPort }),
      });
      if (!resp.success) {
        goto(STATES.ERROR, {
          errorMessage: resp.message || "Could not connect to FC.",
          errorRetry: function () { goto(STATES.CONNECTING); },
        });
        return;
      }
      var status = await apiFetch("/api/fc/status");
      goto(STATES.CONNECTED, { fcStatus: status });
    } catch (e) {
      goto(STATES.ERROR, { errorMessage: e.message, errorRetry: function () { goto(STATES.CONNECTING); } });
    }
  }

  // ------------------------------------------------------------------
  // Connected / FC Information
  // ------------------------------------------------------------------
  function renderConnected() {
    var s = ctx.fcStatus || {};
    var craft = s.craft_name || "Unnamed";
    var fw = s.firmware_version || "-";
    var target = s.target || "-";
    var profile = s.pid_profile === null || s.pid_profile === undefined ? "-" : s.pid_profile;

    var notice = "";
    var action;
    if (s.blackbox_storage && s.blackbox_storage !== "SPIFLASH") {
      notice = '<div class="notice warn">Blackbox on ' + esc(s.blackbox_storage) + " - use Upload instead.</div>";
      action = '<button class="btn btn-primary" id="btn-upload-trigger">UPLOAD LOG FILE</button>' + uploadInputHtml();
    } else if (s.blackbox_available === false) {
      notice = '<div class="notice warn">No log stored yet - fly first.</div>';
      action = '<button class="btn btn-primary" id="btn-upload-trigger">UPLOAD LOG FILE</button>' + uploadInputHtml();
    } else {
      action = '<button class="btn btn-primary" id="btn-download">DOWNLOAD BLACKBOX</button>';
    }

    // A single stacked action area (not two separate .action-row blocks)
    // -- found via real 320x240 headless-browser testing that two
    // full-margin action rows plus the header pushed the card's last
    // metric row ("Profile") off the bottom of the screen. One primary
    // button plus a compact secondary link, sharing one margin, fixes it.
    // Found via real 320x240 testing: with all 4 metric rows AND a notice
    // line present, the card overflows and the notice (the most important
    // content when it's shown -- it explains why the button below isn't
    // DOWNLOAD BLACKBOX) gets silently clipped. Profile is the
    // least-essential row here, so it's the one dropped when a notice
    // needs the space.
    return (
      '<div class="card">' +
      "<h2>FC CONNECTED</h2>" +
      metricRow("Craft", craft) +
      metricRow("BF", fw) +
      metricRow("Target", target) +
      (notice ? "" : metricRow("Profile", profile)) +
      notice +
      "</div>" +
      '<div class="action-stack">' + action +
      '<button class="btn btn-link" id="btn-history-link">History</button>' +
      "</div>"
    );
  }

  function uploadInputHtml() {
    return '<input type="file" id="upload-input" accept=".bbl,.bfl,.txt,.log" style="display:none">';
  }

  async function handleFileUpload(file) {
    var btn = el("btn-upload-trigger");
    if (btn) btn.disabled = true;
    try {
      var fd = new FormData();
      fd.append("file", file);
      var res = await fetch("/api/logs/upload", { method: "POST", body: fd });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) {
        var msg = (data && (data.detail || data.message)) || "HTTP " + res.status;
        goto(STATES.ERROR, {
          errorMessage: shortenMessage(String(msg)),
          errorRetry: function () { goto(STATES.CONNECTED); },
        });
        return;
      }
      var sessions = (data && data.sessions) || [];
      if (!sessions.length) {
        goto(STATES.ERROR, {
          errorMessage: "No usable sessions found in that file.",
          errorRetry: function () { goto(STATES.CONNECTED); },
        });
        return;
      }
      goto(STATES.ANALYZING, { sessionId: sessions[0].session_id });
    } catch (e) {
      goto(STATES.ERROR, {
        errorMessage: "Upload failed - network error.",
        errorRetry: function () { goto(STATES.CONNECTED); },
      });
    }
  }

  // ------------------------------------------------------------------
  // Job progress screens (Downloading, Applying) -- real steps polled
  // from GET /api/jobs/{id}, never a fake animated bar.
  // ------------------------------------------------------------------
  function stepRow(s) {
    var mark = s.status === "done" ? "✓" : s.status === "error" ? "✗" : s.status === "in_progress" ? "…" : "·";
    var detail = s.detail ? " (" + esc(s.detail) + ")" : "";
    return (
      '<div class="step-row ' + esc(s.status) + '"><span class="step-mark">' + mark +
      "</span><span>" + esc(s.name) + detail + "</span></div>"
    );
  }

  function renderJobProgress(title) {
    var job = ctx.job;
    var steps = (job && job.steps) || [];
    var pct = job ? job.percent : 0;
    return (
      '<div class="card">' +
      "<h2>" + esc(title) + "</h2>" +
      '<div class="step-list">' + steps.map(stepRow).join("") + "</div>" +
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      "</div>"
    );
  }

  function pollJobUntilDone(jobId, onDone, onError) {
    activePollTimer = setInterval(async function () {
      var job;
      try {
        job = await apiFetch("/api/jobs/" + encodeURIComponent(jobId));
      } catch (e) {
        return; // transient -- keep polling
      }
      ctx.job = job;
      render();
      if (job.status === "done") {
        clearInterval(activePollTimer);
        activePollTimer = null;
        onDone(job);
      } else if (job.status === "error") {
        clearInterval(activePollTimer);
        activePollTimer = null;
        onError(job);
      }
    }, 700);
  }

  async function doStartDownloadJob() {
    ctx.job = null;
    render();
    try {
      var resp = await apiFetch("/api/logs/download-from-fc", { method: "POST" });
      ctx.jobId = resp.job_id;
      pollJobUntilDone(
        ctx.jobId,
        function (job) {
          var sessions = (job.result && job.result.sessions) || [];
          if (!sessions.length) {
            goto(STATES.ERROR, {
              errorMessage: "No usable sessions found in the downloaded log.",
              errorRetry: function () { goto(STATES.DOWNLOADING_LOG); },
            });
            return;
          }
          goto(STATES.ANALYZING, { sessionId: sessions[0].session_id });
        },
        function (job) {
          goto(STATES.ERROR, {
            errorMessage: job.error || "Download failed.",
            errorRetry: function () { goto(STATES.DOWNLOADING_LOG); },
          });
        }
      );
    } catch (e) {
      goto(STATES.ERROR, { errorMessage: e.message, errorRetry: function () { goto(STATES.DOWNLOADING_LOG); } });
    }
  }

  // ------------------------------------------------------------------
  // Analyzing -- a single fast synchronous call, shown as a brief spinner
  // (not merged into the download job's progress list, since the backend
  // doesn't expose per-metric analysis steps -- fabricating "Step
  // response... Noise analysis..." progress lines here would violate the
  // "real progress, not fake" rule just as much as an animated bar would).
  // ------------------------------------------------------------------
  function renderAnalyzing() {
    return '<div class="center-card"><div class="spinner"></div><div class="sub-line">Analyzing...</div></div>';
  }

  async function doAnalyze() {
    try {
      var summary = await apiFetch("/api/analysis/summary?session_id=" + encodeURIComponent(ctx.sessionId));

      // First-ever analysis for this craft becomes the "Baseline" iteration.
      try {
        var craft = ctx.fcStatus && ctx.fcStatus.craft_name;
        var q = craft ? "?craft=" + encodeURIComponent(craft) : "";
        var existing = await apiFetch("/api/tuning/iterations" + q);
        if (existing && Array.isArray(existing.iterations) && existing.iterations.length === 0) {
          await apiFetch("/api/tuning/record-iteration", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: ctx.sessionId, label: "Baseline" }),
          });
        }
      } catch (e) {
        /* best-effort -- history bookkeeping should never block showing results */
      }

      goto(STATES.ANALYSIS_RESULTS, { summary: summary, resultsPage: 0 });
    } catch (e) {
      goto(STATES.ERROR, { errorMessage: e.message, errorRetry: function () { goto(STATES.ANALYZING); } });
    }
  }

  // ------------------------------------------------------------------
  // Analysis Results -- 6-page card pagination.
  // ------------------------------------------------------------------
  function renderPageFooter(idx, count) {
    return (
      '<div class="page-footer">' +
      '<button class="btn" id="btn-prev"' + (idx === 0 ? " disabled" : "") + ">PREV</button>" +
      '<span class="page-indicator">' + (idx + 1) + " / " + count + "</span>" +
      '<button class="btn btn-primary" id="btn-next">NEXT</button>' +
      "</div>"
    );
  }

  function renderAnalysisResults() {
    var idx = ctx.resultsPage;
    var s = ctx.summary || {};
    var title, body;

    if (idx === 0) {
      title = "FLIGHT RESULT";
      body =
        gradeRow("Overall", s.overall_grade) +
        metricRow("Confidence", s.confidence_pct != null ? s.confidence_pct + "%" : "-") +
        gradeRow("Roll", s.axes && s.axes.roll && s.axes.roll.grade) +
        gradeRow("Pitch", s.axes && s.axes.pitch && s.axes.pitch.grade) +
        gradeRow("Noise", s.noise && s.noise.dterm_grade);
    } else if (idx === 1 || idx === 2) {
      var axisKey = idx === 1 ? "roll" : "pitch";
      title = axisKey.toUpperCase();
      var a = (s.axes && s.axes[axisKey]) || {};
      body =
        metricRow("Tracking", fmtPct(a.tracking_pct)) +
        metricRow("Overshoot", fmtPct(a.overshoot_pct)) +
        metricRow("Settling", fmtMs(a.settling_time_ms)) +
        metricRow("Oscillation", a.oscillation || "UNKNOWN") +
        metricRow("Events", a.events_used != null ? a.events_used : "-");
    } else if (idx === 3) {
      title = "NOISE";
      var n = s.noise || {};
      body =
        gradeRow("Gyro", n.gyro_grade) +
        gradeRow("D-term", n.dterm_grade) +
        metricRow("Main Peak", n.main_peak_hz != null ? fmtNum(n.main_peak_hz, 0) + " Hz" : "-") +
        metricRow("Motor harmonic", n.motor_harmonic_likely ? "Yes" : "No");
    } else if (idx === 4) {
      title = "GRAPHS";
      body =
        '<div class="notice">Roll step response</div>' + chartPlaceholder() +
        '<div class="notice" style="margin-top:4px;">FFT / noise spectrum</div>' + chartPlaceholder();
    } else {
      title = "ANALYSIS DONE";
      body = renderFinalPageBody();
    }

    var card = '<div class="card' + (idx === 5 ? " scroll-y" : "") + '"><h2>' + esc(title) + "</h2>" + body + "</div>";
    var footer = idx === 5 ? renderFinalPageFooter() : renderPageFooter(idx, RESULT_PAGE_COUNT);
    return card + footer;
  }

  function chartPlaceholder() {
    return (
      '<div style="flex:0 0 auto;height:50px;border:2px dashed var(--border);border-radius:6px;' +
      'display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:0.75rem;">' +
      "chart coming soon</div>"
    );
  }

  function renderFinalPageBody() {
    if (ctx.finalPageLoading) return '<div class="notice">Loading...</div>';
    var recs = ctx.recommendations || [];
    if (!recs.length) {
      return '<div class="notice">No tune required.</div>';
    }
    var conf = ctx.readiness ? ctx.readiness.confidence_pct : recs[0].confidence_pct;
    return '<div class="notice">Tune recommended</div>' + metricRow("Confidence", conf != null ? conf + "%" : "-");
  }

  function renderFinalPageFooter() {
    var recs = ctx.recommendations || [];
    var prevBtn = '<button class="btn" id="btn-prev">PREV</button>';
    if (ctx.finalPageLoading) {
      return '<div class="page-footer">' + prevBtn + "</div>";
    }
    if (!recs.length) {
      return '<div class="page-footer">' + prevBtn + '<button class="btn btn-primary" id="btn-exit">EXIT</button></div>';
    }
    return (
      '<div class="page-footer">' + prevBtn +
      '<button class="btn" id="btn-exit">EXIT</button>' +
      '<button class="btn btn-primary" id="btn-tune">TUNE</button>' +
      "</div>"
    );
  }

  async function onResultsNext() {
    var nextIdx = ctx.resultsPage + 1;
    if (nextIdx === 5 && !ctx.finalPageLoaded) {
      ctx.resultsPage = 5;
      ctx.finalPageLoading = true;
      render();
      try {
        var recResp = await apiFetch("/api/tuning/recommendations?session_id=" + encodeURIComponent(ctx.sessionId));
        var readinessResp = await apiFetch("/api/tuning/readiness?session_id=" + encodeURIComponent(ctx.sessionId));
        ctx.recommendations = recResp.recommendations || [];
        ctx.readiness = readinessResp;
      } catch (e) {
        ctx.recommendations = [];
        ctx.readiness = null;
      }
      ctx.finalPageLoaded = true;
      ctx.finalPageLoading = false;
      render();
      return;
    }
    ctx.resultsPage = nextIdx;
    render();
  }

  // ------------------------------------------------------------------
  // Tune Review -- grouped-by-category pagination + Summary/Apply gate.
  // ------------------------------------------------------------------
  function tuneGroups() {
    if (ctx.tuneGroups) return ctx.tuneGroups;
    var recs = ctx.recommendations || [];
    var cats = [
      { key: "roll", title: "ROLL CHANGES" },
      { key: "pitch", title: "PITCH CHANGES" },
      { key: "filter_ff", title: "FILTER + FF CHANGES" },
    ];
    var groups = cats
      .map(function (c) {
        return { title: c.title, items: recs.filter(function (r) { return r.category === c.key; }) };
      })
      .filter(function (g) { return g.items.length > 0; });
    groups.push({ title: "SUMMARY", items: recs, isSummary: true });
    ctx.tuneGroups = groups;
    return groups;
  }

  function recChangeLabel(r) {
    if (r.current_value != null && r.proposed_value != null) {
      return fmtNum(r.current_value, 1) + " → " + fmtNum(r.proposed_value, 1);
    }
    return (r.change_pct >= 0 ? "+" : "") + fmtNum(r.change_pct, 1) + "%";
  }

  function recRowFull(r) {
    return (
      '<div class="rec-row"><div class="rec-param">' + esc(r.parameter) + "</div>" +
      '<div class="rec-change">' + esc(recChangeLabel(r)) + "</div>" +
      '<div class="rec-reason">' + esc(r.reason) + "</div></div>"
    );
  }

  function recRowCompact(r) {
    return metricRow(r.parameter, recChangeLabel(r));
  }

  async function onEnterTuneReview() {
    ctx.readinessForApply = null;
    try {
      ctx.readinessForApply = await apiFetch("/api/tuning/readiness?session_id=" + encodeURIComponent(ctx.sessionId));
    } catch (e) {
      ctx.readinessForApply = { blocked: true, block_reasons: [e.message], confidence_pct: 0 };
    }
    if (state === STATES.TUNE_REVIEW) render();
  }

  function renderTuneReview() {
    var groups = tuneGroups();
    var idx = Math.min(ctx.tunePage, groups.length - 1);
    var group = groups[idx];
    var body, footer;

    if (group.isSummary) {
      body = group.items.map(recRowCompact).join("");
      var r = ctx.readinessForApply;
      if (r) {
        body += metricRow("Confidence", r.confidence_pct + "%");
        if (r.blocked) {
          body += '<div class="notice bad">' + (r.block_reasons || []).map(esc).join("<br>") + "</div>";
        }
      } else {
        body += '<div class="notice">Checking readiness...</div>';
      }
      var blocked = !r || r.blocked;
      footer =
        '<div class="page-footer">' +
        '<button class="btn" id="btn-prev">PREV</button>' +
        '<button class="btn" id="btn-cancel">CANCEL</button>' +
        '<button class="btn btn-primary" id="btn-apply"' + (blocked ? " disabled" : "") + ">APPLY</button>" +
        "</div>";
    } else {
      body = group.items.map(recRowFull).join("");
      footer = renderPageFooter(idx, groups.length);
    }

    return '<div class="card scroll-y"><h2>' + esc(group.title) + "</h2>" + body + "</div>" + footer;
  }

  async function doStartApplyJob() {
    ctx.job = null;
    render();
    try {
      var resp = await apiFetch("/api/tuning/apply?session_id=" + encodeURIComponent(ctx.sessionId), { method: "POST" });
      ctx.jobId = resp.job_id;
      pollJobUntilDone(
        ctx.jobId,
        function (job) {
          var result = job.result || {};
          if (result.aborted) {
            goto(STATES.ERROR, {
              errorMessage: result.abort_reason || "Tune could not be applied - nothing was saved.",
              errorRetry: function () { goto(STATES.TUNE_REVIEW); },
            });
            return;
          }
          goto(STATES.TUNE_APPLIED, { applyResult: result });
        },
        function (job) {
          goto(STATES.ERROR, { errorMessage: job.error || "Apply failed.", errorRetry: function () { goto(STATES.TUNE_REVIEW); } });
        }
      );
    } catch (e) {
      goto(STATES.ERROR, { errorMessage: e.message, errorRetry: function () { goto(STATES.TUNE_REVIEW); } });
    }
  }

  // ------------------------------------------------------------------
  // Tune Applied / Flight Instructions
  // ------------------------------------------------------------------
  function instrItem(n, text) {
    return '<div class="instr-item"><span class="instr-num">' + n + ".</span><span>" + esc(text) + "</span></div>";
  }

  function renderTuneApplied() {
    var r = ctx.applyResult || {};
    var caveat = "";
    if (r.final_verification_mismatches && r.final_verification_mismatches.length) {
      caveat = '<div class="notice warn">Some settings may need re-checking after reboot.</div>';
    }
    return (
      '<div class="card">' +
      "<h2>TUNE APPLIED</h2>" +
      '<div class="notice">New tune installed.</div>' + caveat +
      '<div class="instr-list">' +
      instrItem(1, "Disconnect FC") +
      instrItem(2, "Fly test session") +
      instrItem(3, "Perform clean roll/pitch inputs") +
      instrItem(4, "Land") +
      instrItem(5, "Reconnect tuner") +
      "</div>" +
      "</div>" +
      '<div class="action-row"><button class="btn btn-primary" id="btn-done">DONE</button></div>'
    );
  }

  // ------------------------------------------------------------------
  // History (nice-to-have) -- iteration list + tune-complete banner.
  // ------------------------------------------------------------------
  async function onEnterHistory() {
    ctx.historyData = null;
    render();
    try {
      var craft = ctx.fcStatus && ctx.fcStatus.craft_name;
      var q = craft ? "?craft=" + encodeURIComponent(craft) : "";
      ctx.historyData = await apiFetch("/api/tuning/iterations" + q);
    } catch (e) {
      ctx.historyData = { iterations: [], best_iteration: null, tune_complete: false, stopping_reasons: [] };
    }
    if (state === STATES.HISTORY) render();
  }

  function renderHistory() {
    var data = ctx.historyData;
    if (!data) {
      return '<div class="center-card"><div class="spinner"></div><div class="sub-line">Loading...</div></div>';
    }
    var rows =
      (data.iterations || [])
        .map(function (it) {
          var best = it.number === data.best_iteration ? " ★" : "";
          return metricRow("Tune #" + it.number + " - " + it.label + best, "");
        })
        .join("") || '<div class="notice">No history yet.</div>';
    var complete = data.tune_complete
      ? '<div class="notice warn">TUNE COMPLETE - ' + esc((data.stopping_reasons || [])[0] || "") + "</div>"
      : "";
    return (
      '<div class="card scroll-y"><h2>TUNE HISTORY</h2>' + rows + complete + "</div>" +
      '<div class="action-row"><button class="btn btn-primary" id="btn-history-back">BACK</button></div>'
    );
  }

  // ------------------------------------------------------------------
  // Error
  // ------------------------------------------------------------------
  function renderError() {
    return (
      '<div class="card"><h2>ERROR</h2>' +
      '<div class="notice bad scroll-y" style="flex:1;">' + esc(ctx.errorMessage || "Something went wrong.") + "</div>" +
      "</div>" +
      '<div class="action-row">' +
      '<button class="btn" id="btn-try-again">TRY AGAIN</button>' +
      '<button class="btn btn-primary" id="btn-exit-error">EXIT</button>' +
      "</div>"
    );
  }

  // ------------------------------------------------------------------
  // Render dispatch + wiring
  // ------------------------------------------------------------------
  function render() {
    var html;
    switch (state) {
      case STATES.IDLE: html = renderIdle(); break;
      case STATES.FC_DETECTED: html = renderFcDetected(); break;
      case STATES.CONNECTING: html = renderConnecting(); break;
      case STATES.CONNECTED: html = renderConnected(); break;
      case STATES.DOWNLOADING_LOG: html = renderJobProgress("DOWNLOADING"); break;
      case STATES.ANALYZING: html = renderAnalyzing(); break;
      case STATES.ANALYSIS_RESULTS: html = renderAnalysisResults(); break;
      case STATES.TUNE_REVIEW: html = renderTuneReview(); break;
      case STATES.APPLYING_TUNE: html = renderJobProgress("APPLYING TUNE"); break;
      case STATES.TUNE_APPLIED: html = renderTuneApplied(); break;
      case STATES.HISTORY: html = renderHistory(); break;
      case STATES.ERROR: html = renderError(); break;
      default: html = renderIdle();
    }
    el("screen").innerHTML = html;
    wireCurrentScreen();
    updateHeaderDot();
  }

  function updateHeaderDot() {
    var dot = el("fc-dot");
    if (!dot) return;
    var connected = !!(ctx.fcStatus && ctx.fcStatus.connected);
    var cls = connected ? "connected" : state === STATES.IDLE || state === STATES.FC_DETECTED ? "disconnected" : "unknown";
    dot.className = "dot " + cls;
  }

  function wireCurrentScreen() {
    on("btn-connect", "click", function () { goto(STATES.CONNECTING); });
    on("btn-download", "click", function () { goto(STATES.DOWNLOADING_LOG); });
    on("btn-upload-trigger", "click", function () { var i = el("upload-input"); if (i) i.click(); });
    on("upload-input", "change", function (e) {
      if (e.target.files && e.target.files[0]) handleFileUpload(e.target.files[0]);
    });
    on("btn-history-link", "click", function () { goto(STATES.HISTORY); });
    on("btn-history-back", "click", function () { goto(STATES.CONNECTED); });
    on("btn-prev", "click", function () {
      if (state === STATES.ANALYSIS_RESULTS) {
        ctx.resultsPage = Math.max(0, ctx.resultsPage - 1);
        render();
      } else if (state === STATES.TUNE_REVIEW) {
        ctx.tunePage = Math.max(0, ctx.tunePage - 1);
        render();
      }
    });
    on("btn-next", "click", function () {
      if (state === STATES.ANALYSIS_RESULTS) {
        onResultsNext();
      } else if (state === STATES.TUNE_REVIEW) {
        ctx.tunePage = Math.min(tuneGroups().length - 1, ctx.tunePage + 1);
        render();
      }
    });
    on("btn-exit", "click", function () { goto(STATES.IDLE); });
    on("btn-exit-error", "click", function () { goto(STATES.IDLE); });
    on("btn-tune", "click", function () {
      ctx.tunePage = 0;
      ctx.tuneGroups = null;
      ctx.readinessForApply = null;
      goto(STATES.TUNE_REVIEW);
    });
    on("btn-cancel", "click", function () {
      ctx.resultsPage = 5;
      goto(STATES.ANALYSIS_RESULTS);
    });
    on("btn-apply", "click", function () { goto(STATES.APPLYING_TUNE); });
    on("btn-done", "click", function () { goto(STATES.IDLE); });
    on("btn-try-again", "click", function () {
      var fn = ctx.errorRetry;
      if (fn) fn();
      else goto(STATES.IDLE);
    });
  }

  function init() {
    goto(STATES.IDLE);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
