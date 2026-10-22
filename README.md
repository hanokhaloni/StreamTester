# StreamTester

A reproducible local lab for diagnosing why Chrome + hls.js playback of 10+
concurrent MediaMTX HLS streams starts slowly and staggered. Everything runs
natively on Windows, bound to `127.0.0.1` only, with pinned/local tool
versions (see `VERSIONS.md`).

**Status: core live-HLS lab is built, launched, and benchmarked with real
measurements below (direct HTTP/1.1, both MediaMTX HLS profiles, concurrent
and sequential init). The HTTP/2 reverse-proxy comparison is implemented but
currently broken (404 on the proxied path) -- see "Known issues".** The
recorded-footage playback API was investigated and confirmed working, but is
intentionally not wired into a UI page (out of scope for the live-HLS
priority).

## 0. One-time setup

```powershell
cd C:\temp\StreamTester
.\scripts\Install-Tools.ps1      # downloads MediaMTX/FFmpeg/Caddy into tools\, verifies SHA-256
npm install                      # pulls pinned hls.js + Playwright into node_modules\
Copy-Item node_modules\hls.js\dist\hls.min.js, node_modules\hls.js\dist\hls.min.js.map web\vendor\   # already done, re-run if hls.js is upgraded
```

## 1. Day-to-day commands

```powershell
# Bring up MediaMTX (one profile) + N synthetic sources + the UI server, verify health:
.\scripts\Start-Lab.ps1 -Profile ondemand -StreamCount 10

# Check on it:
.\scripts\Status-Lab.ps1

# Tear down everything this lab started (and only that):
.\scripts\Stop-Lab.ps1

# Open in a browser:
#   http://127.0.0.1:19080/diagnostics.html   (Page A: single-stream diagnostics)
#   http://127.0.0.1:19080/bench.html         (Page B: multi-stream benchmark grid)

# Run the full named benchmark suite end-to-end (restarts MediaMTX as needed
# for true cold-state scenarios, drives real headless Chrome via Playwright,
# writes one JSON per scenario to results\):
.\scripts\Run-BenchmarkSuite.ps1 -StreamCount 10
```

`-Profile` is `ondemand` or `remux` (see section 3). `-StreamCount` accepts
1, 4, 6, 8, 10, 12, 16, or any other positive integer.

## 2. Architecture

```
FFmpeg x N (one process per stream, H.264 video-only, synthetic testsrc2)
   │  RTSP publish
   ▼
MediaMTX  (one profile at a time: "ondemand" or "remux")
   │  HLS over its own HTTP server (HTTP/1.1)        │  API (read-only)      │ metrics (read-only)     │ playback (recordings)
   ▼                                                  ▼                       ▼                          ▼
http://127.0.0.1:19888 or :19889/<cam>/index.m3u8   :19997/v3/...         :19998/metrics            :19996/list,/get

Caddy (always running alongside the lab)
   │  plain HTTP, serves web/ statically            │  HTTPS (tls internal), serves web/ + reverse_proxy /hls/* (BROKEN, see below)
   ▼                                                 ▼
http://127.0.0.1:19080/                              https://127.0.0.1:19443/

Browser (Chrome) -> diagnostics.html / bench.html -> hls.js (vendored locally) -> fetches HLS directly from MediaMTX (mode A)
Playwright (bench/run-benchmark.mjs) drives the SAME pages in an isolated, project-local Chrome profile and reads
negotiated protocol / timing from the real Chrome DevTools Protocol (Network domain).
```

All ports are loopback-only and were chosen to avoid every port already in
use on this machine at setup time (see `scripts/Lab.Config.ps1` for the
single source of truth on ports/paths).

| | ondemand profile | remux profile |
|---|---|---|
| RTSP publish | 127.0.0.1:19554 | 127.0.0.1:19564 |
| HLS (direct) | 127.0.0.1:19888 | 127.0.0.1:19889 |
| API | 127.0.0.1:19997 | 127.0.0.1:19987 |
| Metrics | 127.0.0.1:19998 | 127.0.0.1:19989 |
| Playback (recordings) | 127.0.0.1:19996 | 127.0.0.1:19986 |
| `hlsAlwaysRemux` | `false` | `true` |

Caddy: UI at `127.0.0.1:19080` (HTTP) / `127.0.0.1:19443` (HTTPS, `tls internal`).

## 3. The two MediaMTX profiles, and what actually affects our synthetic sources

Each profile is a **separate MediaMTX process** with its own full port set
(RTSP/HLS/API/metrics/playback), not two paths in one config -- `hlsAlwaysRemux`
is a top-level, server-global setting in MediaMTX, not per-path, so comparing
it requires two instances. Only one profile normally runs at a time (two full
instances can run together if you pick non-overlapping `-Profile` values, but
`scripts/Run-BenchmarkSuite.ps1` always stops one before starting the other
to guarantee a verifiably cold state).

- **`ondemand`** (`hlsAlwaysRemux: false`, MediaMTX's default): the HLS muxer
  for a path is created lazily on the *first* HLS request, and destroyed
  after `hlsMuxerCloseAfter` (60s here) of no readers. The first viewer pays
  a cold-start cost: muxer creation + waiting up to one GOP for a keyframe
  boundary.
- **`remux`** (`hlsAlwaysRemux: true`): the HLS muxer runs continuously from
  the moment the path has a source (regardless of readers). The cold-start
  cost is paid once, at source-start time, off the viewer's critical path.

**Settings that do *not* apply to our setup, confirmed by reading the
installed v1.21.2's own default config, not assumed from memory:**
`sourceOnDemand`, `runOnDemand*` (and their timeouts) only matter when
MediaMTX itself *pulls* a source (e.g. a path configured to pull another
RTSP/HTTP stream) or *spawns* a command on demand. Our FFmpeg processes
*push* continuously via RTSP regardless of whether anyone is watching, so
these settings are irrelevant here and are left at their defaults.

Config is generated, never hand-edited: `scripts/Generate-MediaMTXConfig.ps1
-Profile <ondemand|remux> -StreamCount N [-HlsVariant mpegts|lowLatency]
[-EnableRecordingDemo]` writes `config\generated\mediamtx.<profile>.yml`.
Default `hlsVariant` is classic `mpegts` (one TS segment per
`hlsSegmentDuration`, few requests) rather than MediaMTX's own default
`lowLatency` (fMP4 + ~200ms parts, many more requests per stream) -- this is
a deliberate choice to keep the HTTP/1.1-connection-queuing variable
(hypothesis #1) easy to isolate in a first pass; pass `-HlsVariant
lowLatency` to test the higher-request-volume case.

One setting we had to add that the task didn't ask about: MediaMTX v1.21.2
defaults `moq: true`, binding `:8892`/`:8893` on **all interfaces**. The
generator explicitly sets `moq: false` -- confirmed via a real smoke test
that caught this before it became a loopback-only violation.

## 4. Synthetic sources

`scripts/Start-Generators.ps1` launches **one independent `ffmpeg.exe`
process per stream** (not one process multiplexing N outputs) publishing
RTSP into MediaMTX:

- Source: `lavfi testsrc2` (no camera/file needed), **video-only** (no audio
  track at all, so Chrome's autoplay-with-sound policy can't confound the
  video-startup measurement).
- Per-stream visible identifier + live frame counter/timestamp burned in via
  `drawtext` (`CAM01  frame=1234  t=56.7s`), using a project-local copy of
  Arial (`tools\fonts\arial.ttf`, copied from the OS, not modified/installed)
  referenced by a *relative* path -- MediaMTX's/FFmpeg's filtergraph parser
  treats a literal `C:` drive-colon in an absolute path as its own
  `key:value` separator, which silently breaks `-vf`. Documented in code
  since it cost real debugging time.
- H.264, `yuv420p`, `profile:v main`, `preset veryfast`, `tune zerolatency`,
  `sc_threshold 0` (disables scene-cut-triggered extra keyframes so the GOP
  length is exact and reproducible, not content-dependent).
- Configurable: `-Width -Height -Fps -BitrateKbps -GopSeconds -StreamCount
  -LoadProfile Standard|High`. `Standard` = 640x360@15fps/600kbps (the
  "modest" baseline asked for). `High` = 1280x720@30fps/2500kbps.
- All N processes are started via `Start-Process -PassThru` with no `-Wait`
  in the launch loop, so generator startup itself cannot serialize streams.
- Every generator PID is tracked individually (`pids\ffmpeg-<name>-<profile>.json`),
  separate from MediaMTX's and Caddy's own PID records, and separate from
  whatever Chrome/Playwright is doing.
- `Start-Lab.ps1` polls MediaMTX's own API (`/v3/paths/list`, `ready` field)
  for every expected path before declaring the lab ready; it does not assume
  readiness from the generator processes merely existing.

**Measured, not assumed, CPU cost of source generation** (see section 7):
10 Standard-profile FFmpeg encoders collectively used ~700-870% of one
logical core's CPU-time (i.e., roughly 7-9 of this machine's 12 logical
processors) throughout the benchmark runs. This is not negligible background
noise -- on a lower-core-count machine than this 6-core/12-thread one,
source generation itself would visibly compete with MediaMTX and the browser
for CPU, which is a real confound to keep in mind when interpreting staggered
startup on constrained hardware.

## 5. The two web pages

Both are plain HTML/JS, no framework, hls.js vendored locally
(`web/vendor/hls.min.js`, pinned at 1.7.3 -- no CDN dependency at test time).
Shared timing/measurement logic lives in `web/common.js`; **read the comment
block at the top of that file for the exact definition of every timing field**
(`initStart`, `manifestLoading/Parsed`, `firstFragLoading/Loaded`,
`firstBufferAppended`, `loadeddata`, `playing`, and `firstRenderedFrame` via
`requestVideoFrameCallback` with an explicit `fallbackUsed` flag when rVFC is
unsupported -- `playing` and `firstRenderedFrame` are tracked as genuinely
distinct events, never conflated).

- **`diagnostics.html`** (Page A): pick a stream + endpoint mode, start/stop
  /destroy/recreate the player, see the effective URL, hls.js version,
  effective (merged) hls.js config, a live timing table, video
  dimensions/buffered ranges/readyState/networkState, dropped/total frames
  (`getVideoPlaybackQuality()`), an hls.js event log, a request-statistics
  panel (Resource Timing, filtered to this stream), and an "Export JSON"
  button for the full session.
- **`bench.html`** (Page B): configurable stream count, grid layout, Start
  All / Stop All / Reset / Export Results, muted inline playback, concurrent
  init as the default with a deliberately sequential mode for comparison, one
  shared `runStart` timestamp, per-tile status/timing/errors, and a summary
  panel with time-to-first-visible, time-to-all-visible, startup spread,
  median/p95/min/max per-stream startup, rebuffer count+duration, and dropped-
  frame ratio. Explicitly tears down old `StreamProbe`/hls.js instances on
  every Start All (no reuse across runs) and never silently retries a failed
  tile -- a fatal hls.js error marks that tile `failed` and stops there.
  Accepts `?streams=&mode=&init=&timeout=&label=&autostart=1` query params so
  the Playwright runner can drive it headlessly; exposes
  `window.__benchDone` / `window.__benchGetResults()` for the same reason.

**Explicit, intentional measurement scope limit:** `video.currentTime` is
never used for cross-stream synchronization anywhere in this lab -- it's
each video's own internal media clock, not a capture-time timestamp, and the
task was explicit that substituting one for the other is wrong.

## 6. HTTP/1.1 vs HTTP/2 -- status: direct (A) works, proxy (B) is broken

**Mode A (direct)** works and is what all measurements below use: Chrome
fetches HLS straight from MediaMTX's own HTTP server. **Verified via real
Chrome DevTools Protocol** (not inferred): every captured response in every
scenario negotiated `http/1.1` -- MediaMTX's non-TLS HTTP listener does not
offer h2/h2c.

**Mode B (HTTP/2 proxy) is implemented but not functional right now.**
Caddy (`proxy/Caddyfile.generated`, built by `scripts/Generate-Caddyfile.ps1`)
serves the UI over HTTPS with `tls internal` and successfully negotiates
TLS/HTTP-2 -- confirmed: `GET https://127.0.0.1:19443/diagnostics.html`
returns 200 and Caddy's log shows a completed `tls.obtain` for `127.0.0.1`.
But the `handle_path /hls/* { reverse_proxy <mediamtx-hls-addr> }` block
returns a bare 404 instead of reaching MediaMTX (confirmed: MediaMTX's own
log shows zero incoming requests for that path when hit through the proxy,
while the same path works fine hit directly). The Caddyfile's compiled JSON
route table looks structurally correct on inspection; root cause not yet
found. **This was deprioritized mid-session at your explicit request** ("skip
http2 for now") and parked rather than guessed at further. Scenarios 4/5 (10
streams through the H2 proxy, cold/warm) are explicitly **skipped, not
fabricated**, in `results/suite-run.log` and in the scenario table below.

**To actually fix/finish this**, the next step would be adding `log` with
`format console`/`level debug` to the HTTPS site in
`scripts/Generate-Caddyfile.ps1` and comparing Caddy's per-request routing
decision against a direct `reverse_proxy` test (bypassing `handle_path`) to
isolate whether the matcher, the strip-prefix rewrite, or something about the
upstream dial is at fault.

**A real incident worth knowing about:** the first time Caddy's `tls
internal` was exercised, it silently installed its own root CA into your
Windows `CurrentUser\Root` certificate store -- an unapproved trust-store
change. It was caught immediately, the cert was removed
(`certutil -user -delstore Root <thumbprint>`), and
`scripts/Generate-Caddyfile.ps1` now always emits the global
`skip_install_trust` option, confirmed (via a second clean run) to no longer
touch the cert store. **If you want to browse the HTTPS UI manually without a
Chrome certificate warning**, the safe manual step is: run
`certutil -user -addstore Root <path-to-caddy-root.crt>` yourself (CurrentUser
scope, no admin needed) -- the root cert lives at
`%AppData%\Caddy\pki\authorities\local\root.crt` after Caddy has run at least
once. This repo will not do that for you without being asked again.

## 7. MediaMTX metrics / read-only inspection

Discovered from the running v1.21.2 instance itself (`GET /metrics` on the
profile's metrics port), not assumed from memory. Raw Prometheus-format
snapshots for every benchmark scenario are saved to
`results\metrics-<scenario>.prom`. The API (`/v3/paths/list`,
`/v3/paths/get/<name>`) is used throughout for path/reader/track/byte-counter
state (`ready`, `online`, `tracks`, `bytesReceived`) -- both by the lifecycle
scripts (readiness gating) and by `Status-Lab.ps1`.

**Host CPU, explicitly normalized:** `bench/run-benchmark.mjs` samples
`Get-Process`'s cumulative `CPU` property (seconds of CPU *time*, not a
percentage) for `mediamtx`/`ffmpeg`/`chrome` before and after each scenario.
The README numbers below report `Δcpu_seconds / Δwall_seconds * 100` as
**"% of one logical core"**, explicitly *not* normalized to the machine's 12
logical processors -- e.g. "731%" means roughly 7.3 of the 12 logical
processors were saturated, not 731% of total machine capacity. Both
`mediamtx` and `ffmpeg` process CPU, and `chrome`/`ffmpeg`/`mediamtx` working-
set memory, are included in each scenario's raw JSON
(`processSamples.before`/`after` in `results\*.json`) for anything not
summarized here.

Metrics/API/playback listeners are bound to `127.0.0.1` only in every
profile; nothing proxies or exposes them beyond that.

## 8. Benchmark runner

`bench/run-benchmark.mjs` drives **the real installed Chrome** (Playwright
`channel: "chrome"`), not Playwright's bundled Chromium, inside an isolated,
project-local, always-fresh `--user-data-dir`
(`bench/.chrome-profile/<scenario>-<timestamp>/`, deleted on every run
including error paths). This isolation is not optional decoration: the first
version of this runner omitted the explicit profile dir, and real Chrome's
single-instance-per-profile mechanism silently redirected every automated
run into your **actual, already-open Chrome window** instead of a separate
instance. That was caught, confirmed (process-tree inspection showed every
automation-launched tab parented to your pre-existing `chrome.exe`, not a
fresh root process), and fixed; nothing was closed or modified in your real
browser session, and you confirmed that was fine.

It captures real Chrome DevTools Protocol `Network.*` events -- negotiated
protocol, request/response timing (`Network.responseReceived.timing`),
status, and failures -- for every request whose path matches `/camNN/`, in
addition to the in-page hls.js/video timing from `common.js`. Defaults to
headless (no visible window); pass `--headed=1` to watch it.

`scripts/Run-BenchmarkSuite.ps1` orchestrates the named scenarios end-to-end,
restarting MediaMTX fresh immediately before any scenario that needs a
verified **cold** HLS state (no HLS reader has ever hit that path since
MediaMTX started), and reusing the same still-running instance for the
matching **warm** follow-up. Metrics are snapshotted after every scenario.

## 9. Measured results

Full suite run on this machine (6c/12t, 32GB RAM), `-StreamCount 10`,
`LoadProfile Standard` (640x360@15fps/600kbps/GOP=2s), headless Chrome 154,
HTTP/1.1 direct MediaMTX access -- **every number below is read directly
from `results/*.json`, produced by an actual run, not estimated.**

| # | Scenario | Mode | Init | HLS state | success/fail/timeout | time-to-first-visible | time-to-all-visible | spread (max-min first-frame) | median per-stream startup | rebuffers | dropped/total frames |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | single stream | direct (ondemand) | concurrent | warm (pre-touched once) | 1/0/0 | 1599 ms | 1599 ms | 0 ms | 1598 ms | 0 / 0ms | 0/10 |
| 2 | 10 streams | direct (ondemand) | concurrent | **cold** (fresh restart) | 10/0/0 | 3972 ms | 5712 ms | **1741 ms** | 4250 ms | 0 / 0ms | 10/274 |
| 3 | 10 streams | direct (ondemand) | concurrent | **warm** (same instance, right after #2) | 10/0/0 | 2133 ms | 2334 ms | **202 ms** | 2305 ms | 3 / 34ms | 18/140 |
| 4/5 | 10 streams | HTTP/2 proxy | concurrent | cold/warm | **skipped** -- proxy path non-functional, see section 6 | | | | | | |
| 6 | 10 streams | direct (ondemand) | **sequential** | cold (fresh restart) | 10/0/0 | 1299 ms | **11401 ms** | **10102 ms** | 956 ms | 8 / 4121ms | 11/990 |
| 7 | 10 streams | direct (**remux**, `hlsAlwaysRemux=true`) | concurrent | n/a (muxer never cold) | 10/0/0 | 2612 ms | 3165 ms | **552 ms** | 2948 ms | 1 / 37ms | 11/194 |

Negotiated protocol for every request in every scenario above, confirmed via
CDP: `http/1.1`. Host CPU during the 10-stream scenarios: FFmpeg (10
processes) ~700-870% of one logical core aggregate; MediaMTX ~19-26% of one
logical core (see section 7 for what that means and the raw per-process data).

### What this actually shows (measured) vs. what it suggests (inference) vs. still open (hypothesis)

**Measured:**
- Cold on-demand HLS muxer creation (#2 vs #3) added **~2.1s to median
  per-stream startup and ~1.5s to spread**, with the *same* already-running,
  already-warm FFmpeg sources in both cases. This isolates MediaMTX's
  on-demand-muxer cold start as a real, non-trivial, independently-measurable
  contributor -- not just a plausible-sounding theory.
- Deliberately sequential initialization of 10 streams (#6) produced a
  **10.1-second spread**, by far the largest number in this table, even
  though its *individual* per-stream startup times (median 956ms) were the
  *fastest* of any scenario (each one starts against an otherwise-idle
  browser/CPU, one at a time). If the real application is accidentally
  initializing players one-after-another instead of concurrently, this is
  very likely the dominant effect, dwarfing both the muxer cold-start and
  whatever the HTTP/1.1-connection-limit effect turns out to be.
- The always-remux profile (#7), despite being hit completely cold from the
  browser's perspective (first-ever request to every path), had a spread
  (552ms) and median startup (2948ms) much closer to the *warm* on-demand
  case (#3: 202ms / 2305ms) than the *cold* on-demand case (#2: 1741ms /
  4250ms). This is consistent with `hlsAlwaysRemux=true` removing most of the
  on-demand-muxer-creation cost from the viewer's critical path.

**Inference (reasonable reading of the above, not independently isolated):**
- Scenario #7's median (2948ms) is still ~650ms higher than warm-ondemand's
  median (2305ms) and its spread (552ms) is ~2.7x warm-ondemand's (202ms).
  Something beyond pure muxer-state is contributing when 10 *new* HLS reader
  sessions attach simultaneously even to an already-running muxer -- plausibly
  Chrome's HTTP/1.1 six-connections-per-origin limit queuing some of the 10
  simultaneous playlist/segment requests (hypothesis #1), plausibly per-
  session muxer/reader setup inside MediaMTX, plausibly both. This dataset
  does not cleanly separate those two; the HTTP/2 comparison (section 6)
  would have, which is exactly why that comparison mattered and why it's
  flagged as unfinished rather than silently dropped.
- Dropped-frame ratios are not comparable across these rows at face value:
  total-frame counts differ by run duration (10s run accumulates far more
  frames than a 2.3s one), so e.g. scenario 3's 18/140 (12.9%) vs scenario
  6's 11/990 (1.1%) reflects *when in playback* `getVideoPlaybackQuality()`
  was sampled relative to decoder catch-up after start, not that scenario 3
  "performed worse."

**Still open / not tested here (genuine hypotheses, not claims):**
- Hypothesis #1 (browser HTTP/1.1 connection queuing) in isolation --
  requires the HTTP/2 proxy comparison, which is currently broken (section
  6). Nothing in this document should be read as confirming or ruling out
  this hypothesis specifically.
- Hypothesis #4 (accidental sequential player init) in *your actual
  application* -- this lab shows how severe it would be *if present*
  (scenario 6), but confirming whether your production code is actually
  initializing sequentially requires inspecting your app's own player-
  mounting code or capturing its real network waterfall, which this lab
  cannot do for you.
- Behavior at stream counts other than 10 (1/4/6/8/12/16) -- the generator
  and bench pages support any count via `-StreamCount`, but the full suite
  was only run at 10 in this session due to time; re-running
  `Run-BenchmarkSuite.ps1 -StreamCount <N>` for other counts is a direct,
  no-code-change next step.
- The `High` load profile (1280x720@30fps/2500kbps) -- implemented and
  available via `-LoadProfile High`, not benchmarked this session.
- `recordSegmentDuration` was set to 20s in the recording-playback test but
  MediaMTX produced new recording files roughly every 2.2-5.4s instead
  (confirmed via directory listing timestamps) -- a real, measured
  discrepancy between configured and observed segment duration whose cause
  was not investigated further; noted honestly rather than explained away.

## 10. Recorded-footage playback -- investigated, confirmed working, not built into a page

Per the task's explicit instruction not to confuse this with live HLS: MediaMTX's
recording (`record: true` on a path) and playback server (`playback: true`,
separate `playbackAddress` listener/port) are **completely separate
subsystems from live HLS** -- different config keys, different port, and a
different wire format.

**Verified end-to-end on this machine** (`-WithRecordingDemo` adds `rec01`/
`rec02` paths with `record: true, recordFormat: fmp4`; a generator was
published to `rec01` for ~30s):
- `GET http://<playbackAddress>/list?path=rec01` returns a JSON array of
  recorded segments, each with a `start` (RFC3339), `duration`, and a ready-
  to-use `url`.
- `GET http://<playbackAddress>/get?path=rec01&start=<...>&duration=<...>`
  returns a **plain progressive MP4** (confirmed via `ffprobe`: valid H.264,
  correct 640x360 resolution, correct duration) -- playable directly via
  `<video src="...">`, with **no hls.js, no .m3u8, and no HLS muxer
  involved at any point**.

This was not wired into `diagnostics.html`/`bench.html` since the task's
stated priority is live HLS and recorded playback is explicitly a separate
mode; the API shape above is everything a "Page C" would need (list
segments -> populate a picker -> set `video.src` to the chosen `/get` URL).

## 11. Known issues / honest gaps

- **HTTP/2 proxy `/hls/*` returns 404** instead of reaching MediaMTX (section
  6) -- parked at your request, not fixed.
- **Benchmark suite was only run at `-StreamCount 10`** in this session; 1/4/6/8/12/16
  are supported by every script but weren't all exercised.
- **`High` load profile** exists but wasn't benchmarked.
- Chrome on this machine is **154.0.8037.99**, not the 140 mentioned in the
  original brief -- every measurement above is against 154.
- `recordSegmentDuration` didn't match observed segment file timing (section 9).
- `results/`, `logs/`, `pids/`, `recordings/`, and `tools/` are git-ignored
  (runtime artifacts and large pinned binaries, not source) -- re-run
  `Install-Tools.ps1` + `Start-Lab.ps1` to regenerate them locally; nothing
  in this repo depends on them being committed.
