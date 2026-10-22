// Page A -- single-stream diagnostics. See web/common.js for the
// StreamProbe class and the definition of every timing field used below.

const ENDPOINTS = {
  "direct-ondemand": { base: "http://127.0.0.1:19888", pathTemplate: (s) => `${s}/index.m3u8` },
  "direct-remux":    { base: "http://127.0.0.1:19889", pathTemplate: (s) => `${s}/index.m3u8` },
  "proxy-h2":        { base: "https://127.0.0.1:19443/hls", pathTemplate: (s) => `${s}/index.m3u8` },
};

const streamSelect = document.getElementById("streamSelect");
const streamCountBox = document.getElementById("streamCount");
const modeSelect = document.getElementById("modeSelect");
const urlBox = document.getElementById("urlBox");
const hlsConfigBox = document.getElementById("hlsConfigBox");
const videoEl = document.getElementById("video");

let probe = null;
let pollHandle = null;
let reqStatsHandle = null;

function rebuildStreamOptions() {
  const n = Math.max(1, Math.min(99, parseInt(streamCountBox.value, 10) || 1));
  streamSelect.innerHTML = "";
  for (let i = 1; i <= n; i++) {
    const name = "cam" + String(i).padStart(2, "0");
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    streamSelect.appendChild(opt);
  }
  updateUrlFromSelectors();
}

function updateUrlFromSelectors() {
  const mode = modeSelect.value;
  if (mode === "custom") return;
  const ep = ENDPOINTS[mode];
  const stream = streamSelect.value;
  urlBox.value = `${ep.base}/${ep.pathTemplate(stream)}`;
}

streamCountBox.addEventListener("change", rebuildStreamOptions);
streamSelect.addEventListener("change", updateUrlFromSelectors);
modeSelect.addEventListener("change", updateUrlFromSelectors);
rebuildStreamOptions();

function appendLog(elId, text) {
  const el = document.getElementById(elId);
  const line = document.createElement("div");
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function renderTimings() {
  if (!probe) return;
  const snap = probe.snapshot();
  const tbody = document.querySelector("#timingTable tbody");
  tbody.innerHTML = "";
  const init = snap.timings.initStart;
  for (const [k, v] of Object.entries(snap.timings)) {
    if (k === "firstRenderedFrameFallback") continue;
    const tr = document.createElement("tr");
    const rel = (v != null && init != null) ? (v - init).toFixed(1) : (v == null ? "-" : v);
    tr.innerHTML = `<td>${k}${k === "firstRenderedFrame" && snap.timings.firstRenderedFrameFallback ? " (raf-fallback)" : ""}</td><td>${rel}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById("effectiveConfig").textContent = JSON.stringify(snap.effectiveHlsConfig, null, 2);
  document.getElementById("videoState").textContent =
    `videoWidth=${snap.videoState.videoWidth} videoHeight=${snap.videoState.videoHeight} ` +
    `currentTime=${snap.videoState.currentTime.toFixed(2)} readyState=${snap.videoState.readyState} ` +
    `networkState=${snap.videoState.networkState} paused=${snap.videoState.paused}\n` +
    `buffered=${JSON.stringify(snap.videoState.buffered)}\n` +
    `playbackQuality=${JSON.stringify(snap.playbackQuality)}\n` +
    `rebuffers=${snap.rebuffers.length}`;
}

function pollRequestStats() {
  if (!probe) return;
  let originAndPath;
  try { const u = new URL(probe.url); originAndPath = u.origin + u.pathname.replace(/\/[^/]*$/, ""); } catch (e) { return; }
  const entries = performance.getEntriesByType("resource").filter(e => e.name.startsWith(originAndPath.split("/").slice(0, -1).join("/")) || e.name.includes(probe.url.split("/").slice(-2)[0]));
  const el = document.getElementById("reqStats");
  el.innerHTML = "";
  entries.slice(-30).forEach(e => {
    const line = document.createElement("div");
    line.textContent = `${e.name.split("/").pop()}  proto=${e.nextHopProtocol || "n/a"}  ttfb=${(e.responseStart - e.requestStart).toFixed(1)}ms  dl=${(e.responseEnd - e.responseStart).toFixed(1)}ms  size=${e.transferSize || "n/a"}`;
    el.appendChild(line);
  });
}

document.getElementById("btnStart").addEventListener("click", () => {
  if (probe) probe.destroy();
  document.getElementById("errorLog").innerHTML = "";
  document.getElementById("eventLog").innerHTML = "";
  performance.clearResourceTimings();

  let hlsConfig = {};
  try { hlsConfig = JSON.parse(hlsConfigBox.value || "{}"); } catch (e) { alert("Invalid JSON in hls.js config box: " + e); return; }

  const url = urlBox.value;
  document.getElementById("effectiveUrl").textContent = url;
  document.getElementById("hlsjsVersion").textContent = HLS_VENDOR_VERSION;

  probe = new StreamProbe({ video: videoEl, url, hlsConfig, runStart: performance.now(), label: streamSelect.value });

  const origOn = probe.hls; // placeholder; real wiring happens in start()
  probe.start();
  // Hook the underlying hls instance's events for the live log, after start() created it.
  probe.hls.on(Hls.Events.MANIFEST_LOADING, () => appendLog("eventLog", "MANIFEST_LOADING"));
  probe.hls.on(Hls.Events.MANIFEST_PARSED, () => appendLog("eventLog", "MANIFEST_PARSED"));
  probe.hls.on(Hls.Events.FRAG_LOADING, (_, d) => appendLog("eventLog", `FRAG_LOADING sn=${d.frag && d.frag.sn}`));
  probe.hls.on(Hls.Events.FRAG_LOADED, (_, d) => appendLog("eventLog", `FRAG_LOADED sn=${d.frag && d.frag.sn}`));
  probe.hls.on(Hls.Events.LEVEL_LOADED, () => appendLog("eventLog", "LEVEL_LOADED"));
  probe.hls.on(Hls.Events.BUFFER_APPENDED, () => appendLog("eventLog", "BUFFER_APPENDED"));
  probe.hls.on(Hls.Events.ERROR, (_, d) => appendLog("errorLog", `${d.type} / ${d.details} fatal=${d.fatal}`));

  if (pollHandle) clearInterval(pollHandle);
  if (reqStatsHandle) clearInterval(reqStatsHandle);
  pollHandle = setInterval(renderTimings, 250);
  reqStatsHandle = setInterval(pollRequestStats, 1000);
});

document.getElementById("btnStop").addEventListener("click", () => {
  if (probe && probe.hls) probe.hls.stopLoad();
  if (videoEl) videoEl.pause();
});

document.getElementById("btnDestroy").addEventListener("click", () => {
  if (probe) probe.destroy();
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  if (reqStatsHandle) { clearInterval(reqStatsHandle); reqStatsHandle = null; }
  appendLog("eventLog", "destroyed");
});

document.getElementById("btnRecreate").addEventListener("click", () => {
  document.getElementById("btnDestroy").click();
  setTimeout(() => document.getElementById("btnStart").click(), 50);
});

document.getElementById("btnExport").addEventListener("click", () => {
  if (!probe) { alert("Nothing started yet."); return; }
  downloadJSON(`diagnostics-${probe.label}-${Date.now()}.json`, probe.snapshot());
});
