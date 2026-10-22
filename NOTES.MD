\#     MediaMTX config:

1\. hlsAlwaysRemux: true is the single highest-leverage server-side setting. Measured: cold on-demand muxer creation added \~2.1s to median per-stream startup and \~1.5s to spread vs. warm; the always-remux profile — hit completely cold from the browser's side — landed close to the warm on-demand numbers (552ms spread vs. 1741ms cold-ondemand spread). If you can afford muxers running continuously, this removes most of the cold-start penalty from the viewer's critical path. If memory/CPU doesn't allow always-remux for all paths, pre-warm each path's .m3u8 once right after the source comes online (before any viewer loads a dashboard), which pays the same cost off-path.

2\. Prefer hlsVariant: mpegts over the default lowLatency unless you need sub-second latency. lowLatency fragments into \~200ms parts, multiplying request count per stream — that directly amplifies any HTTP/1.1 connection-queuing effect when many tiles load at once.

3\. Align GOP/keyframe interval with hlsSegmentDuration (in this lab they were mismatched — 2s GOP vs 1s segment duration — which stretches actual segments to match keyframe boundaries). Keep both small and equal (e.g., 1–2s) for the fastest cold-start-to-first-keyframe wait.

4\. Raise hlsMuxerCloseAfter if viewers reconnect/reload often, so muxers don't get torn down and cold-started again between views.

5\. Explicitly disable unused protocols (moq: false, rtmp: false, webrtc: false, srt: false) — moq in particular defaults to true and binds all interfaces by default, which is a real finding from this lab, not a stylistic preference.

6\. sourceOnDemand/runOnDemand\* are irrelevant for a continuously-publishing source setup (cameras/encoders pushing RTSP) — only matters if MediaMTX itself pulls or spawns the source.



\# Client (hls.js/Chrome)

1\. Confirm player initialization is actually concurrent, not sequential — this is the single biggest lever found. The sequential-init scenario measured a 10.1s spread vs. 1.7s (cold concurrent) / 0.2s (warm concurrent), despite each individual stream starting faster in isolation. If your dashboard awaits one player's mount before starting the next, fixing that will likely outweigh every MediaMTX tweak combined.

2\. Keep dashboard/tile streams muted and video-only (or defer audio) — avoids Chrome's autoplay-with-sound policy stalling startup, same reasoning used for the synthetic sources here.

3\. Distinguish playing from an actual rendered frame in your own instrumentation (via requestVideoFrameCallback) if you want accurate "visible" timing — playing can fire before anything is on screen.

4\. Don't tune hls.js buffer/retry config as a first move — in this data, buffering-related settings weren't the dominant effect; sequential init and MediaMTX cold-start were.

5\. The HTTP/1.1 six-connections-per-origin limit may still be contributing (remux-profile numbers weren't fully explained by muxer state alone), but this lab's HTTP/2 proxy comparison was never completed, so that specific fix (moving HLS behind an HTTP/2 reverse proxy) shouldn't be treated as confirmed — verify sequential-init and hlsAlwaysRemux first, since those are the two effects actually measured here.

