#!/usr/bin/env node
/*
 * Drives one benchmark scenario in the REAL installed Chrome (via Playwright's
 * `channel: "chrome"`, not the bundled Chromium) against web/bench.html, and
 * captures CDP-level network evidence (negotiated protocol, timing) alongside
 * the in-page hls.js/video timing captured by web/common.js.
 *
 * This is the only place negotiated HTTP protocol is determined -- it is read
 * from Chrome's own Network.responseReceivedExtraInfo / response.protocol via
 * CDP, never inferred from hls.js statistics or Resource Timing alone.
 *
 * Usage:
 *   node bench/run-benchmark.mjs --scenario=NAME --streams=10 --mode=direct-ondemand
 *        --init=concurrent --timeout=20000 --uiBase=http://127.0.0.1:19080
 *        --headed=1 --out=results/NAME.json
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
}));

const scenario = args.scenario || `run-${Date.now()}`;
const streams = parseInt(args.streams || "10", 10);
const mode = args.mode || "direct-ondemand";
const init = args.init || "concurrent";
const timeoutMs = parseInt(args.timeout || "20000", 10);
const uiBase = args.uiBase || "http://127.0.0.1:19080";
const headed = args.headed === "1";   // default headless=true: see README "Known issues" -- channel:"chrome"
                                        // can redirect into an already-running real Chrome window via its
                                        // single-instance mechanism, which is NOT isolated. We always force
                                        // a dedicated, project-local --user-data-dir (below) to prevent that
                                        // regardless of this flag, but default to headless as a second layer.
const outFile = args.out || path.join(__dirname, "..", "results", `${scenario}.json`);
const profileDir = path.join(__dirname, ".chrome-profile", scenario.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + Date.now());

function sampleProcesses() {
  try {
    const json = execSync(
      `powershell -NoProfile -Command "Get-Process mediamtx,ffmpeg,chrome -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json"`,
      { encoding: "utf8", windowsHide: true }
    );
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { error: String(e) };
  }
}

async function main() {
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    await run();
  } finally {
    // Always remove the isolated profile dir, including on error paths --
    // these are real (if small) Chrome user-data directories and must not
    // accumulate on disk or get picked up by a future `git add`.
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function run() {
  // launchPersistentContext with an explicit, project-local, never-reused
  // user-data-dir guarantees a fully isolated instance -- it cannot hit
  // Chrome's single-instance-per-profile redirect into any other running
  // Chrome window (real Chrome launched with channel:"chrome" but no
  // explicit profile dir has been observed doing exactly that).
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome", headless: headed ? false : true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  // requestId -> accumulating record. We keep every request whose URL path
  // contains "/camNN/" so this covers both direct-MediaMTX and proxied URLs.
  const netRecords = new Map();
  cdp.on("Network.requestWillBeSent", (e) => {
    netRecords.set(e.requestId, {
      url: e.request.url, method: e.request.method,
      requestWillBeSentWallTime: e.wallTime, initiatorType: e.initiator && e.initiator.type,
    });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = netRecords.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.protocol = e.response.protocol; // actual negotiated ALPN protocol, e.g. "h2", "http/1.1"
    r.mimeType = e.response.mimeType;
    r.timing = e.response.timing; // CDP ResourceTiming: requestTime + deltas incl. dnsStart/connectStart/sslStart/sendStart/receiveHeadersEnd
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = netRecords.get(e.requestId);
    if (r) { r.encodedDataLength = e.encodedDataLength; r.finishedTimestamp = e.timestamp; }
  });
  cdp.on("Network.loadingFailed", (e) => {
    const r = netRecords.get(e.requestId);
    if (r) { r.failed = true; r.errorText = e.errorText; }
  });

  const beforeProcs = sampleProcesses();
  const beforeT = Date.now();

  const url = `${uiBase}/bench.html?streams=${streams}&mode=${mode}&init=${init}&timeout=${timeoutMs}&label=${encodeURIComponent(scenario)}&autostart=1`;
  await page.goto(url, { waitUntil: "load" });

  const hardDeadline = Date.now() + timeoutMs + 15000;
  while (Date.now() < hardDeadline) {
    const done = await page.evaluate(() => window.__benchDone === true);
    if (done) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const results = await page.evaluate(() => window.__benchGetResults());
  const afterProcs = sampleProcesses();
  const afterT = Date.now();

  const camPathRe = /\/(cam\d+)\//;
  const networkEvidence = [...netRecords.values()]
    .filter(r => camPathRe.test(r.url))
    .map(r => ({ ...r, stream: (r.url.match(camPathRe) || [])[1] }));

  const out = {
    scenario, capturedAtUtc: new Date().toISOString(),
    params: { streams, mode, init, timeoutMs, uiBase, url },
    chrome: { userAgent: await page.evaluate(() => navigator.userAgent) },
    processSamples: { before: beforeProcs, after: afterProcs, wallMsElapsed: afterT - beforeT },
    benchResults: results,
    networkEvidence,
    networkEvidenceNote: "Captured via CDP Network domain on the real installed Chrome (channel: chrome), not Resource Timing / hls.js stats. 'protocol' field is the actual negotiated ALPN protocol per response.",
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`Summary: success=${results.summary?.successCount} failed=${results.summary?.failedCount} timedOut=${results.summary?.timedOutCount} ` +
              `timeToFirstVisible=${results.summary?.timeToFirstVisibleMs}ms timeToAllVisible=${results.summary?.timeToAllVisibleMs}ms spread=${results.summary?.startupSpreadMs}ms`);

  await context.close();
}

main().catch(e => { console.error(e); process.exit(1); });
