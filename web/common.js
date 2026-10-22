/*
 * Shared stream-probe logic used by both diagnostics.html (Page A) and
 * bench.html (Page B). One StreamProbe wraps one hls.js instance bound to
 * one <video>, and records a fixed set of monotonic-clock timestamps.
 *
 * Timing origins (all via performance.now(), a monotonic clock):
 *   runStart        - caller-supplied: the one shared timestamp for the whole
 *                      benchmark run (captured once, outside any player).
 *   initStart       - when THIS player's Hls object is constructed and
 *                      loadSource()+attachMedia() are invoked. In "concurrent"
 *                      mode all tiles call this within the same synchronous
 *                      loop as runStart; in "sequential" mode each tile's
 *                      initStart is deliberately delayed until the previous
 *                      tile reached `playing`.
 *   manifestLoading / manifestParsed - Hls.Events.MANIFEST_LOADING / _PARSED.
 *   firstFragLoading / firstFragLoaded - first Hls.Events.FRAG_LOADING / _LOADED.
 *   firstBufferAppended - first Hls.Events.BUFFER_APPENDED (proxy for "first
 *                      media data buffered"; hls.js appends to the
 *                      MediaSource SourceBuffer, this fires once that append
 *                      completes).
 *   loadeddata      - native <video> 'loadeddata' event.
 *   playing         - native <video> 'playing' event. This is "decoder says
 *                      playback started", NOT the same as a rendered frame
 *                      being on screen.
 *   firstRenderedFrame - first requestVideoFrameCallback() callback, i.e. a
 *                      frame actually submitted for presentation. Treated as
 *                      DISTINCT from `playing`. If rVFC is unsupported, we
 *                      fall back to (playing-event time + one
 *                      requestAnimationFrame tick) and set fallbackUsed=true
 *                      on the record -- this is a measurement approximation,
 *                      not a verified render timestamp.
 *
 * startupDuration (per stream) = firstRenderedFrame - initStart.
 * All "vs runStart" figures used for multi-stream aggregates are computed by
 * the caller as firstRenderedFrame - runStart (so a shared origin is used
 * across tiles), not by substituting video.currentTime (currentTime is
 * stream-internal media time, not wall-clock capture time, and is NOT used
 * anywhere here for cross-stream synchronization).
 */

const HLS_VENDOR_VERSION = (typeof Hls !== "undefined" && Hls.version) ? Hls.version : "unknown";

class StreamProbe {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {string} opts.url
   * @param {object} [opts.hlsConfig]
   * @param {number} opts.runStart - performance.now() origin shared across a run
   * @param {string} [opts.label]
   */
  constructor(opts) {
    this.video = opts.video;
    this.url = opts.url;
    this.label = opts.label || opts.url;
    this.runStart = opts.runStart;
    this.hlsConfig = opts.hlsConfig || {};
    this.hls = null;
    this.destroyed = false;

    this.events = [];           // {t, name, detail}
    this.errors = [];           // {t, type, details, fatal}
    this.timings = {
      initStart: null,
      manifestLoading: null,
      manifestParsed: null,
      firstFragLoading: null,
      firstFragLoaded: null,
      firstBufferAppended: null,
      loadeddata: null,
      playing: null,
      firstRenderedFrame: null,
      firstRenderedFrameFallback: false,
    };
    this.rebuffers = [];         // {startT, endT, durationMs}
    this._waitingSinceT = null;
    this._hasPlayedOnce = false;
    this._rvfcHandle = null;

    this._onLoadedData = () => this._mark("loadeddata");
    this._onPlaying = () => {
      this._mark("playing");
      this._hasPlayedOnce = true;
      if (this._waitingSinceT != null) {
        const endT = now();
        this.rebuffers.push({ startT: this._waitingSinceT, endT, durationMs: endT - this._waitingSinceT });
        this._waitingSinceT = null;
      }
      this._armFirstFrameCapture();
    };
    this._onWaiting = () => {
      if (this._hasPlayedOnce && this._waitingSinceT == null) this._waitingSinceT = now();
    };
    this._onError = (e) => this.errors.push({ t: now(), type: "video-element-error", details: String(this.video.error && this.video.error.message), fatal: true });
  }

  _mark(name) {
    if (this.timings[name] == null) this.timings[name] = now();
    this.events.push({ t: now(), name });
  }

  _armFirstFrameCapture() {
    if (this.timings.firstRenderedFrame != null) return;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this._rvfcHandle = this.video.requestVideoFrameCallback((nowTs, metadata) => {
        if (this.timings.firstRenderedFrame == null) {
          this.timings.firstRenderedFrame = now();
          this.timings.firstRenderedFrameFallback = false;
          this.events.push({ t: this.timings.firstRenderedFrame, name: "firstRenderedFrame(rvfc)" });
        }
      });
    } else {
      // Fallback: one rAF tick after `playing`. Explicitly flagged as an
      // approximation -- rAF firing does not itself prove a frame was
      // presented, only that the compositor had an opportunity to.
      requestAnimationFrame(() => {
        if (this.timings.firstRenderedFrame == null) {
          this.timings.firstRenderedFrame = now();
          this.timings.firstRenderedFrameFallback = true;
          this.events.push({ t: this.timings.firstRenderedFrame, name: "firstRenderedFrame(raf-fallback)" });
        }
      });
    }
  }

  start() {
    if (!window.Hls || !window.Hls.isSupported()) {
      this.errors.push({ t: now(), type: "unsupported", details: "Hls.isSupported() returned false", fatal: true });
      return;
    }
    this.timings.initStart = now();
    this.video.addEventListener("loadeddata", this._onLoadedData);
    this.video.addEventListener("playing", this._onPlaying);
    this.video.addEventListener("waiting", this._onWaiting);
    this.video.addEventListener("error", this._onError);

    this.hls = new Hls(this.hlsConfig);
    this.effectiveConfig = this.hls.config; // hls.js merges supplied config with defaults

    this.hls.on(Hls.Events.MANIFEST_LOADING, () => this._mark("manifestLoading"));
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => this._mark("manifestParsed"));
    this.hls.on(Hls.Events.FRAG_LOADING, () => this._mark("firstFragLoading"));
    this.hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      this._mark("firstFragLoaded");
      this.events.push({ t: now(), name: "fragLoaded", detail: data && data.frag ? { sn: data.frag.sn, duration: data.frag.duration } : null });
    });
    this.hls.on(Hls.Events.BUFFER_APPENDED, () => this._mark("firstBufferAppended"));
    this.hls.on(Hls.Events.ERROR, (_, data) => {
      this.errors.push({ t: now(), type: data.type, details: data.details, fatal: !!data.fatal });
      this.events.push({ t: now(), name: "error", detail: { type: data.type, details: data.details, fatal: data.fatal } });
    });
    this.hls.on(Hls.Events.FRAG_BUFFERED ? Hls.Events.FRAG_BUFFERED : Hls.Events.BUFFER_APPENDED, () => {});

    this.hls.loadSource(this.url);
    this.hls.attachMedia(this.video);
    this.video.muted = true;
    this.video.play().catch((e) => {
      this.errors.push({ t: now(), type: "play-rejected", details: String(e), fatal: false });
    });
  }

  destroy() {
    this.destroyed = true;
    try { if (this._rvfcHandle != null && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfcHandle); } catch (e) {}
    this.video.removeEventListener("loadeddata", this._onLoadedData);
    this.video.removeEventListener("playing", this._onPlaying);
    this.video.removeEventListener("waiting", this._onWaiting);
    this.video.removeEventListener("error", this._onError);
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
    try { this.video.removeAttribute("src"); this.video.load(); } catch (e) {}
  }

  snapshot() {
    const vq = (this.video.getVideoPlaybackQuality && this.video.getVideoPlaybackQuality()) || null;
    let buffered = [];
    try {
      for (let i = 0; i < this.video.buffered.length; i++) buffered.push([this.video.buffered.start(i), this.video.buffered.end(i)]);
    } catch (e) {}
    return {
      label: this.label,
      url: this.url,
      runStart: this.runStart,
      timings: { ...this.timings },
      startupDurationMs: (this.timings.firstRenderedFrame != null && this.timings.initStart != null)
        ? (this.timings.firstRenderedFrame - this.timings.initStart) : null,
      msFromRunStartToFirstFrame: (this.timings.firstRenderedFrame != null)
        ? (this.timings.firstRenderedFrame - this.runStart) : null,
      videoState: {
        videoWidth: this.video.videoWidth, videoHeight: this.video.videoHeight,
        currentTime: this.video.currentTime, readyState: this.video.readyState,
        networkState: this.video.networkState, paused: this.video.paused, buffered,
      },
      playbackQuality: vq ? { droppedVideoFrames: vq.droppedVideoFrames, totalVideoFrames: vq.totalVideoFrames, corruptedVideoFrames: vq.corruptedVideoFrames } : "unavailable (getVideoPlaybackQuality unsupported)",
      rebuffers: this.rebuffers,
      errors: this.errors,
      eventCount: this.events.length,
      hlsjsVersion: HLS_VENDOR_VERSION,
      effectiveHlsConfig: this.effectiveConfig ? summarizeConfig(this.effectiveConfig) : null,
    };
  }
}

function now() { return performance.now(); }

function summarizeConfig(cfg) {
  // hls.js config objects contain functions/loaders; keep only JSON-safe scalars.
  const out = {};
  for (const k of Object.keys(cfg)) {
    const v = cfg[k];
    const t = typeof v;
    if (t === "number" || t === "string" || t === "boolean" || v === null) out[k] = v;
  }
  return out;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
