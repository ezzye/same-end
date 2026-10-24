(() => {
  "use strict";
  const $ = (id) => document.getElementById(id), preference = "sameend.test-log-enabled";
  let collector, storage, enabled = true, lastCast = null, hashedCast = null, timer, sending = false;
  const labels = { "sound-heard": "I can hear sound", "picture-ok": "Picture looks good", "chat-ok": "Chat worked", "no-sound": "Sound stopped", "picture-frozen": "Picture froze", "out-of-sync": "We seem out of step", "chat-problem": "Chat problem", "connection-lost": "Connection dropped", "relay-leaving": "A relay is leaving", "network-change": "I changed network" };
  const mediaReasons = { "source-piece-stale": "Source capture has not produced a recent piece", "required-piece-missing": "Required piece was missing at the playback deadline", "decoder-startup-evidence": "Startup/decode readiness evidence: required media was present, but this does not confirm a decoder fault", "no-frame-growth": "No frame growth while target time advanced during visible, unpaused playback", "playback-blocked": "Playback is blocked and may need a user action" };
  const metric = (v, suffix = "") => v === null || v === undefined ? "Unknown" : String(v) + suffix;
  const pieceLead = (v) => v === null || v === undefined ? "Unknown" : v > 0 ? v + " ms ahead of deadline" : v < 0 ? Math.abs(v) + " ms late" : "at deadline";
  const factRows = (title, facts) => "<h3>" + escape(title) + "</h3><table><tbody>" + facts.map(([k, v]) => "<tr><th>" + escape(k) + "</th><td>" + escape(v) + "</td></tr>").join("") + "</tbody></table>";
  function mediaAssessment(report) {
    return window.SameEndDiagnosticsCore.assessMediaDiagnostics(report.status, report.samples);
  }
  function mediaSummaryText(report) {
    const a = mediaAssessment(report);
    if (a.findings.length) return a.findings.map((f) => mediaReasons[f.code]).filter(Boolean).join("; ");
    if (a.state === "observed-playback") return "Required piece and decoded frames were observed.";
    return "Picture path cause is unknown from the retained evidence.";
  }
  function mediaShortLabel(report) {
    const a = mediaAssessment(report);
    return a.state === "evidence" ? "review picture evidence" : a.state === "autoplay-or-user-action" ? "playback needs a user action" : a.state === "observed-playback" ? "picture facts recorded" : "picture cause unknown";
  }
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function tick() {
    if (!collector || !enabled) return render();
    try {
      const snap = window.PrivateCast?.snapshot() || {}, v = $("player");
      const quality = v?.getVideoPlaybackQuality?.();
      collector.observe(snap, { ready: v?.readyState, paused: v?.paused, muted: v?.muted, volume: v?.volume, decodedFrames: quality?.totalVideoFrames ?? v?.webkitDecodedFrameCount, droppedFrames: quality?.droppedVideoFrames, playbackBlocked: snap.playbackBlocked }, { visible: document.visibilityState === "visible", online: navigator.onLine !== false, controlFailures: window.SameEndSocial?.snapshot()?.failures, chatMessageCount: window.SameEndSocial?.snapshot()?.chatCount });
      if (snap.config?.id && snap.config.id !== lastCast) {
        lastCast = snap.config.id;
        hashedCast = null;
        const id = lastCast;
        crypto.subtle.digest("SHA-256", new TextEncoder().encode("same-end-test:" + id)).then((buf) => {
          if (lastCast === id) {
            hashedCast = [...new Uint8Array(buf)].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
            collector.setCastTag(hashedCast);
            render();
          }
        }).catch(() => {
        });
      }
    } catch {
    }
    render();
  }
  function render() {
    const summary = collector?.summary(), status = $("test-log-status");
    if (!status) return;
    $("test-log-record").checked = enabled;
    $("test-log-download").disabled = !summary;
    $("test-log-json").disabled = !summary;
    $("test-log-share").disabled = !summary;
    $("test-log-mark").disabled = !summary || !enabled || !window.PrivateCast?.snapshot()?.config;
    $("test-log-send").disabled = sending || !summary || !window.SameEndSocial?.canSendDeviceReport?.();
    const line = summary ? (enabled ? "Local test log" : "Saved local test log") + " \xB7 " + Math.floor((summary.durationSeconds || 0) / 60) + " min \xB7 " + (summary.counts?.marks || 0) + " marked observations" + (collector.persisted === false ? " \xB7 saving on this device is unavailable; download before closing." : ". Kept on this device; nothing is uploaded automatically.") : enabled ? "Your private test log starts when a room opens." : "Local test logging is off.";
    const forwarding = summary?.lastStatus?.forwardingCount;
    const assessment = collector.report();
    const info = line + (typeof forwarding === "number" ? " Forwarding picture to " + forwarding + " mate" + (forwarding === 1 ? "" : "s") + "." : "") + (assessment ? " Picture check: " + mediaSummaryText(assessment) : "");
    const collapsed = $("test-log").querySelector("summary");
    if (collapsed) collapsed.textContent = "Your test report" + (assessment ? " · " + mediaShortLabel(assessment) : "");
    if (status.textContent !== info) status.textContent = info;
  }
  function download(file) {
    const url = URL.createObjectURL(file), a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e4);
  }
  function fileControls() {
    const status = document.getElementById("file-status");
    const file = () => new File(["<!doctype html>\n" + document.documentElement.outerHTML], "same-end-test-report.html", { type: "text/html" });
    function save(f) {
      const url = URL.createObjectURL(f), a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
    }
    document.getElementById("save").onclick = () => {
      save(file());
      status.textContent = "HTML downloaded. Attach the file privately.";
    };
    document.getElementById("share").onclick = async () => {
      const f = file();
      if (navigator.canShare?.({ files: [f] })) {
        try {
          await navigator.share({ files: [f], title: "Same End test report" });
          status.textContent = "File handed to your device sharing controls.";
          return;
        } catch (e) {
          if (e.name === "AbortError") return;
        }
      }
      save(f);
      status.textContent = "File sharing is unavailable. HTML downloaded; attach it privately.";
    };
  }
  function htmlReport() {
    tick();
    const report = collector.report();
    if (!report) throw Error("Open a room first.");
    const s = report.status || {}, events = report.events || [], device = window.SameEndInviteCheck?.report()?.device || {};
    const summary = [["Test code", report.castTag || "Not available"], ["Device report", report.reportId], ["Build", report.build || "Unknown"], ["Browser / OS", [device.browser, device.browserVersion, device.os, device.version].filter(Boolean).join(" ")], ["Recorded session length", Math.round(report.durationSeconds || 0) + " seconds (includes waiting and pauses)"], ["End state", report.finish || "Still recording"], ["Latest verified picture ahead", (s.reserveSeconds ?? "Unknown") + " seconds"], ["Latest recovery count", s.recoveryCount ?? "Unknown"], ["Latest playback mode", s.playbackMode ?? "Unknown"], ["Latest playback fallback reason", s.playbackFallbackReason ?? "None reported"], ["Latest media error code", s.mediaErrorCode ?? "None"], ["Latest dropped frames", s.droppedFrames ?? "Unknown"], ["Waiting transitions observed", s.stalls ?? "Unknown"], ["Supplier changes observed", report.counts?.supplierChanges ?? 0], ["App errors observed", report.counts?.errors ?? 0], ["History retained", report.samples.length + " samples; " + (report.samplesDropped || 0) + " earlier samples and " + (report.eventsDropped || 0) + " earlier events dropped by the limits"], ["Saved on device", report.persisted === true ? "Yes" : "Not confirmed; keep this downloaded file"]];
    const rows = summary.map(([a, b]) => "<tr><th>" + escape(a) + "</th><td>" + escape(b) + "</td></tr>").join("");
    const timeline = events.map((e) => "<tr><td>" + escape(e.atSeconds ?? "?") + " s</td><td>" + escape(e.type) + "</td><td>" + escape(labels[e.value] || e.value) + "</td></tr>").join("");
    const observations = ["picture-ok", "sound-heard", "chat-ok"].map((code) => "<li>" + escape(labels[code]) + ": <strong>" + (events.some((e) => e.type === "mark" && e.value === code) ? "marked by this tester" : "not recorded in the retained timeline") + "</strong></li>").join("");
    const md = s.mediaDiagnostics || {}, c = md.capture || {}, d = md.delivery || {}, p = md.playback || {}, assessment = mediaAssessment(report);
    const findingRows = assessment.findings.length ? assessment.findings.map((f) => [f.layer === "playback" ? "Startup / decoder" : f.layer === "delivery" ? "Network delivery" : "Source capture", mediaReasons[f.code] || "Evidence recorded"]) : [["Assessment", mediaSummaryText(report)]];
    const mediaTables = "<h3>Reasoning from observed evidence</h3><table><tbody>" + findingRows.map(([a, b]) => "<tr><th>" + escape(a) + "</th><td>" + escape(b) + "</td></tr>").join("") + "</tbody></table>" + factRows("Source capture facts", [["Role", s.role === "source" ? "This device is the source" : s.role === "viewer" ? "Viewer; source capture is not assessed from this device" : "Unknown"], ["Captured width / height", metric(c.width) + " × " + metric(c.height)], ["Observed frame rate", metric(c.frameRate, " fps")], ["Target video rate", metric(c.targetVideoMbps, " Mbps")], ["Measured media rate", metric(c.actualMediaMbps, " Mbps")], ["Last piece age", s.role === "source" ? metric(c.lastPieceAgeSeconds, " s") : "Not assessed on viewer"], ["Recording latency", s.role === "source" ? metric(c.recordingLatencyMs, " ms") : "Not assessed on viewer"], ["Source audio", s.role === "source" ? metric(c.sourceAudio) : "Not assessed on viewer"]]) + factRows("Network delivery facts", [["Required piece present", metric(d.requiredPiecePresent)], ["Required piece lead / lateness", pieceLead(d.requiredPieceLeadMs)], ["Verified reserve", metric(d.verifiedReserveSeconds, " s")]]) + factRows("Playback facts", [["Mode", metric(p.mode)], ["Fallback reason", metric(p.fallbackReason)], ["Media error code", metric(p.errorCode)], ["Decoded width / height", metric(p.width) + " × " + metric(p.height)], ["Playable ahead", metric(p.playableAheadSeconds, " s")], ["Window", metric(p.windowSeconds, " s")], ["Source changes", metric(p.srcChanges)], ["Last load / first frame", metric(p.lastLoadMs, " ms") + " / " + metric(p.firstFrameMs, " ms")], ["Decoded / dropped frames", metric(p.decodedFrames) + " / " + metric(p.droppedFrames)]]);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Same End test report</title><style>body{margin:0;background:#f5f3ec;color:#163e2d;font:17px/1.6 system-ui,sans-serif}header{background:#073d2b;color:white;padding:30px}main{max-width:980px;padding:24px;margin:auto}section{background:white;border:1px solid #cfdbce;border-radius:12px;padding:22px;margin:0 0 20px}h1,h2{line-height:1.2}h3{margin-bottom:4px}button{padding:12px 17px;margin:4px;border:1px solid #98b5a4;border-radius:8px;font:inherit;background:white;color:#073d2b}table{border-collapse:collapse;width:100%;font-size:15px}td,th{text-align:left;vertical-align:top;border-bottom:1px solid #d5dfd3;padding:10px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.scroll{overflow:auto}.note{padding:12px;background:#fff1ce;border-radius:8px}summary{cursor:pointer;font-weight:bold}</style></head><body><header><h1>Same End test report</h1><p>Private observations from one browser. Generated ' + escape((/* @__PURE__ */ new Date()).toLocaleString()) + '</p><button id="save">Save HTML</button><button id="share">Share file</button><p id="file-status">This file opens offline. Send the HTML file itself to share it.</p></header><main><section><h2>This browser\u2019s test</h2><table>' + rows + '</table><p class="note">A report is evidence, not an automatic pass. Different homes, human-audible sound, working chat and a full match need your confirmation. A connected peer or an included audio track does not prove those things.</p><ul>' + observations + '</ul></section><section><h2>Picture path diagnostics</h2><p>' + escape(mediaSummaryText(report)) + '</p>' + mediaTables + '<p class="note">These are separate layer facts. Resolution, frame rate and measured rate are observations, not automatic quality judgments. A viewer cannot establish the source capture state.</p></section><section><h2>What happened</h2><div class="scroll"><table><thead><tr><th>Time from start</th><th>Event</th><th>Observation</th></tr></thead><tbody>' + timeline + "</tbody></table></div><p>Latest two hours at five-second intervals, with at most 200 events and a 2 MiB storage ceiling shared with the previous report. Dropped entries are counted above. Browser suspension can leave sampling gaps. Programme position and target position help compare reports with the same test code; device wall clocks and self-reported data are not independent proof of synchronisation.</p></section><section><h2>What the plan still needs</h2><p>Check: at least three separate networks; 90 minutes of the intended session; the oldest supported device; picture, sound and chat; late join; relay departure; temporary network interruption; sleep/return. Record which steps you actually tried.</p><p>This test does not implement or prove adaptive picture quality, background audio, more than two children per relay, coordinated live delay changes or switching to an independently captured backup.</p></section><details><summary>Full sanitised local measurements</summary><pre>" + escape(JSON.stringify(report, null, 2)) + "</pre></details><p>No programme, audio recording, chat text, invitation, password, peer address or raw error is included. Sharing this file is your choice.</p></main><script>(" + fileControls.toString() + ")();<\/script></body></html>";
  }
  function htmlFile() {
    return new File([htmlReport()], "same-end-test-report.html", { type: "text/html" });
  }
  function init() {
    if (collector || !window.SameEndDiagnosticsCore || !$("settings")) return;
    try {
      storage = localStorage;
      enabled = storage.getItem(preference) !== "off";
    } catch {
    }
    collector = new SameEndDiagnosticsCore.Collector({ storage, now: () => Date.now(), monotonic: () => performance.now(), build: window.SameEndConfig?.buildId || "local" });
    const panel = document.createElement("details");
    panel.id = "test-log";
    panel.className = "test-log";
    panel.innerHTML = '<summary>Your test report</summary><div class="test-log-body"><p id="test-log-status" role="status"></p><label class="test-log-toggle"><input id="test-log-record" type="checkbox"> Keep a private test log on this device</label><p class="micro">No programme or chat is recorded. Reports stay here unless you choose to send them. Download after the test and before clearing browser data.</p><label for="test-log-observation">Mark something you noticed</label><select id="test-log-observation">' + Object.entries(labels).map(([k, v]) => '<option value="' + k + '">' + v + "</option>").join("") + '</select><div class="row"><button id="test-log-mark" type="button" class="secondary">Mark now</button><button id="test-log-download" type="button">Download test report</button><button id="test-log-send" type="button" class="secondary">Send summary to host</button></div><p id="test-log-result" role="status"></p><details><summary>More report options</summary><div class="row"><button id="test-log-share" type="button" class="secondary">Share report file</button><button id="test-log-json" type="button" class="secondary">Download measurements</button><button id="test-log-clear" type="button" class="secondary">Delete saved test logs</button></div></details></div>';
    $("settings").querySelector(".settings-body").prepend(panel);
    $("test-log-record").onchange = () => {
      enabled = $("test-log-record").checked;
      try {
        storage?.setItem(preference, enabled ? "on" : "off");
      } catch {
      }
      if (!enabled) collector.finish("recording-stopped");
      else lastCast = null;
      tick();
    };
    $("test-log-mark").onclick = () => {
      const code = $("test-log-observation").value;
      const marked = collector.mark(code);
      $("test-log-result").textContent = marked ? "Marked: " + labels[code] + "." : "Open a room to mark an observation.";
      render();
    };
    $("test-log-download").onclick = () => {
      download(htmlFile());
      $("test-log-result").textContent = "Test report downloaded. Keep it and send the HTML file privately.";
    };
    $("test-log-json").onclick = () => download(new File([JSON.stringify(collector.report(), null, 2)], "same-end-test-data.json", { type: "application/json" }));
    $("test-log-share").onclick = async () => {
      const file = htmlFile();
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Same End test report" });
          return;
        } catch (e) {
          if (e.name === "AbortError") return;
        }
      }
      download(file);
      $("test-log-result").textContent = "HTML downloaded. Attach it privately in your usual message app.";
    };
    $("test-log-send").onclick = async () => {
      if (sending) return;
      sending = true;
      render();
      try {
        await window.SameEndSocial.sendDeviceReport(window.SameEndInviteCheck.report());
        $("test-log-result").textContent = "Compact summary sent to the host\u2019s Same End help inbox. Download keeps the full local timeline.";
      } catch {
        $("test-log-result").textContent = "Could not send. Try again or download the report.";
      } finally {
        sending = false;
        render();
      }
    };
    $("test-log-clear").onclick = () => {
      collector.clear();
      enabled = false;
      lastCast = null;
      hashedCast = null;
      try {
        storage?.setItem(preference, "off");
      } catch {
      }
      $("test-log-result").textContent = "Saved test logs deleted; logging is off.";
      render();
    };
    window.SameEndDiagnostics = { summary: () => collector.summary(), report: () => collector.report(), mark: (code) => collector.mark(code), html: htmlReport };
    window.addEventListener("sameend:castchange", tick);
    window.addEventListener("online", tick);
    window.addEventListener("offline", tick);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("error", () => collector.appError("error"));
    window.addEventListener("unhandledrejection", () => collector.appError("unhandled-rejection"));
    window.addEventListener("pagehide", () => {
      if (enabled) tick();
    });
    timer = setInterval(tick, 1e3);
    tick();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
