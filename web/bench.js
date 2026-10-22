// Page B -- multi-stream benchmark grid. See web/common.js for StreamProbe
// and the canonical definition of every timing field referenced here.

const ENDPOINTS = {
  "direct-ondemand": { base: "http://127.0.0.1:19888" },
  "direct-remux":    { base: "http://127.0.0.1:19889" },
  "proxy-h2":        { base: "https://127.0.0.1:19443/hls" },
};

const gridEl = document.getElementById("grid");
const streamCountBox = document.getElementById("streamCount");
const modeSelect = document.getElementById("modeSelect");
const initModeSelect = document.getElementById("initMode");
const timeoutBox = document.getElementById("timeoutMs");
const hlsConfigBox = document.getElementById("hlsConfigBox");
const runLabelBox = document.getElementById("runLabel");

let tiles = [];        // {name, el, statusEl, metaEl, video, probe, status, timeoutHandle}
let currentRun = null; // {runStart, mode, initMode, streamCount, hlsConfig, label, timeoutMs, finishedAt}
let pollHandle = null;

function streamNames(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push("cam" + String(i).padStart(2, "0"));
  return out;
}

function buildGrid(n) {
  teardownAll();
  gridEl.innerHTML = "";
  tiles = streamNames(n).map((name) => {
    const el = document.createElement("div");
    el.className = "tile";
    el.innerHTML = `
      <div><b>${name}</b> <span class="status-pending" data-role="status">pending</span></div>
      <video muted playsinline></video>
      <div class="meta" data-role="meta"></div>`;
    gridEl.appendChild(el);
    return {
      name, el,
      statusEl: el.querySelector('[data-role="status"]'),
      metaEl: el.querySelector('[data-role="meta"]'),
      video: el.querySelector("video"),
      probe: null,
      status: "pending",
      timeoutHandle: null,
    };
  });
  renderSummary();
}

function teardownAll() {
  for (const t of tiles) {
    if (t.timeoutHandle) { clearTimeout(t.timeoutHandle); t.timeoutHandle = null; }
    if (t.probe) { t.probe.destroy(); t.probe = null; }
  }
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

function setTileStatus(t, status, text) {
  t.status = status;
  t.statusEl.textContent = text || status;
  t.statusEl.className = status === "success" ? "status-ok" : (status === "pending" || status === "running") ? "status-pending" : "status-fail";
}

function urlFor(name) {
  const ep = ENDPOINTS[modeSelect.value];
  return `${ep.base}/${name}/index.m3u8`;
}

function parseHlsConfig() {
  try { return JSON.parse(hlsConfigBox.value || "{}"); } catch (e) { alert("Invalid hls.js config JSON: " + e); return null; }
}

async function startOne(t, runStart, hlsConfig, timeoutMs) {
  setTileStatus(t, "running", "initializing...");
  t.probe = new StreamProbe({ video: t.video, url: urlFor(t.name), hlsConfig, runStart, label: t.name });
  t.probe.start();

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      if (t.status === "running") {
        setTileStatus(t, "timeout", `timed out after ${timeoutMs}ms (no fatal error, just slow/stalled)`);
      }
      resolve();
    }, timeoutMs);
    t.timeoutHandle = deadline;

    const checkDone = () => {
      if (t.probe.timings.firstRenderedFrame != null) {
        clearTimeout(deadline);
        setTileStatus(t, "success", `first frame @ ${(t.probe.timings.firstRenderedFrame - runStart).toFixed(0)}ms`);
        resolve();
        return true;
      }
      const fatal = t.probe.errors.find(e => e.fatal);
      if (fatal) {
        clearTimeout(deadline);
        setTileStatus(t, "failed", `fatal: ${fatal.type}/${fatal.details}`);
        resolve();
        return true;
      }
      return false;
    };
    const iv = setInterval(() => { if (checkDone()) clearInterval(iv); }, 100);
  });
}

async function startAll() {
  const n = Math.max(1, Math.min(99, parseInt(streamCountBox.value, 10) || 1));
  if (tiles.length !== n) buildGrid(n); else teardownAll(), tiles.forEach(t => setTileStatus(t, "pending", "pending"));

  const hlsConfig = parseHlsConfig();
  if (hlsConfig === null) return;
  const timeoutMs = parseInt(timeoutBox.value, 10) || 20000;
  const initMode = initModeSelect.value;
  const runStart = performance.now();

  currentRun = {
    runStart, mode: modeSelect.value, initMode, streamCount: n,
    hlsConfigRequested: hlsConfig, timeoutMs, label: runLabelBox.value,
    startedAtWallClock: new Date().toISOString(), finishedAt: null,
  };

  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(() => { renderTileMeta(); renderSummary(); }, 300);

  if (initMode === "concurrent") {
    // All tiles initialize within the same synchronous loop -- no awaiting
    // between them -- so any observed stagger is not caused by our own
    // scheduling.
    await Promise.all(tiles.map(t => startOne(t, runStart, hlsConfig, timeoutMs)));
  } else {
    // Deliberately sequential: each tile waits for the previous one to reach
    // first-frame (or its own timeout) before starting.
    for (const t of tiles) await startOne(t, runStart, hlsConfig, timeoutMs);
  }

  currentRun.finishedAt = performance.now();
  renderTileMeta();
  renderSummary();
}

function renderTileMeta() {
  for (const t of tiles) {
    if (!t.probe) continue;
    const s = t.probe.snapshot();
    t.metaEl.textContent =
      `${s.videoState.videoWidth}x${s.videoState.videoHeight} rs=${s.videoState.readyState} ` +
      `rebuf=${s.rebuffers.length} drop=${s.playbackQuality.droppedVideoFrames != null ? s.playbackQuality.droppedVideoFrames : "n/a"}`;
  }
}

function computeSummary() {
  if (!currentRun) return null;
  const successes = tiles.filter(t => t.status === "success");
  const failed = tiles.filter(t => t.status === "failed");
  const timedOut = tiles.filter(t => t.status === "timeout");
  const firstFrameAbs = successes.map(t => t.probe.timings.firstRenderedFrame);
  const perStreamStartup = successes.map(t => t.probe.timings.firstRenderedFrame - t.probe.timings.initStart);
  const relToRunStart = firstFrameAbs.map(v => v - currentRun.runStart);
  let totalDropped = 0, totalFrames = 0, dropAvailable = false;
  let totalRebufferMs = 0, totalRebufferCount = 0;
  for (const t of tiles) {
    if (!t.probe) continue;
    const q = t.probe.video.getVideoPlaybackQuality ? t.probe.video.getVideoPlaybackQuality() : null;
    if (q) { dropAvailable = true; totalDropped += q.droppedVideoFrames; totalFrames += q.totalVideoFrames; }
    totalRebufferCount += t.probe.rebuffers.length;
    totalRebufferMs += t.probe.rebuffers.reduce((a, r) => a + r.durationMs, 0);
  }
  return {
    streamCount: currentRun.streamCount,
    mode: currentRun.mode, initMode: currentRun.initMode, label: currentRun.label,
    successCount: successes.length, failedCount: failed.length, timedOutCount: timedOut.length,
    timeToFirstVisibleMs: relToRunStart.length ? Math.min(...relToRunStart) : null,
    timeToAllVisibleMs: relToRunStart.length ? Math.max(...relToRunStart) : null,
    startupSpreadMs: firstFrameAbs.length ? (Math.max(...firstFrameAbs) - Math.min(...firstFrameAbs)) : null,
    perStreamStartupMs: { median: median(perStreamStartup), p95: percentile(perStreamStartup, 95), min: perStreamStartup.length ? Math.min(...perStreamStartup) : null, max: perStreamStartup.length ? Math.max(...perStreamStartup) : null, all: perStreamStartup },
    rebuffers: { totalCount: totalRebufferCount, totalDurationMs: Math.round(totalRebufferMs) },
    droppedFrames: dropAvailable ? { totalDropped, totalFrames, ratio: totalFrames ? totalDropped / totalFrames : 0 } : "unavailable on this browser/build",
    runDurationMs: currentRun.finishedAt ? (currentRun.finishedAt - currentRun.runStart) : (performance.now() - currentRun.runStart),
    stillRunning: !currentRun.finishedAt,
  };
}

function renderSummary() {
  const s = computeSummary();
  if (!s) { document.getElementById("summary").textContent = "No run yet."; return; }
  document.getElementById("summary").innerHTML = `
    <b>${s.label}</b> | mode=${s.mode} | init=${s.initMode} | streams=${s.streamCount} | ${s.stillRunning ? "RUNNING" : "DONE"} (${s.runDurationMs.toFixed(0)}ms elapsed)<br>
    success=${s.successCount} failed=${s.failedCount} timedOut=${s.timedOutCount}<br>
    timeToFirstVisible=${fmt(s.timeToFirstVisibleMs)}ms&nbsp; timeToAllVisible=${fmt(s.timeToAllVisibleMs)}ms&nbsp; startupSpread=${fmt(s.startupSpreadMs)}ms<br>
    perStreamStartup: median=${fmt(s.perStreamStartupMs.median)}ms p95=${fmt(s.perStreamStartupMs.p95)}ms min=${fmt(s.perStreamStartupMs.min)}ms max=${fmt(s.perStreamStartupMs.max)}ms<br>
    rebuffers: count=${s.rebuffers.totalCount} totalDuration=${s.rebuffers.totalDurationMs}ms<br>
    droppedFrames: ${typeof s.droppedFrames === "string" ? s.droppedFrames : `dropped=${s.droppedFrames.totalDropped}/${s.droppedFrames.totalFrames} (${(s.droppedFrames.ratio*100).toFixed(2)}%)`}
  `;
}
function fmt(v) { return v == null ? "-" : v.toFixed(0); }

document.getElementById("btnStartAll").addEventListener("click", () => startAll());
document.getElementById("btnStopAll").addEventListener("click", () => {
  for (const t of tiles) { if (t.probe && t.probe.hls) t.probe.hls.stopLoad(); t.video.pause(); }
});
document.getElementById("btnReset").addEventListener("click", () => {
  currentRun = null;
  buildGrid(Math.max(1, Math.min(99, parseInt(streamCountBox.value, 10) || 1)));
});
document.getElementById("btnExport").addEventListener("click", () => {
  if (!currentRun) { alert("No run yet."); return; }
  downloadJSON(`bench-${currentRun.label}-${Date.now()}.json`, {
    run: currentRun,
    summary: computeSummary(),
    tiles: tiles.map(t => ({ name: t.name, status: t.status, snapshot: t.probe ? t.probe.snapshot() : null })),
  });
});

// --- automation hooks for the Playwright benchmark runner (bench/run-benchmark.mjs) ---
// Query params let the runner configure+launch a run without simulating UI
// clicks; window.__bench* globals let it poll status/results via CDP evaluate
// instead of needing to catch a file download.
window.__benchDone = false;
window.__benchGetResults = () => ({ run: currentRun, summary: computeSummary(), tiles: tiles.map(t => ({ name: t.name, status: t.status, snapshot: t.probe ? t.probe.snapshot() : null })) });

const qp = new URLSearchParams(location.search);
if (qp.has("streams")) streamCountBox.value = qp.get("streams");
if (qp.has("mode")) modeSelect.value = qp.get("mode");
if (qp.has("init")) initModeSelect.value = qp.get("init");
if (qp.has("timeout")) timeoutBox.value = qp.get("timeout");
if (qp.has("label")) runLabelBox.value = qp.get("label");
if (qp.has("hlsConfig")) hlsConfigBox.value = qp.get("hlsConfig");

buildGrid(parseInt(streamCountBox.value, 10) || 10);

if (qp.get("autostart") === "1") {
  setTimeout(() => { startAll().then(() => { window.__benchDone = true; }); }, 100);
}
