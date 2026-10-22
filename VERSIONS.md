# Version manifest

All binaries are pinned, downloaded once, and kept local to this project under
`tools/` (not installed system-wide, not on PATH). Re-running `scripts/Install-Tools.ps1`
(if you need to re-fetch) will pull the exact same pinned versions below.

| Component | Version | Source | SHA-256 of downloaded archive |
|---|---|---|---|
| MediaMTX | v1.21.2 | https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip | `a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467` |
| FFmpeg / ffprobe | BtbN autobuild-2026-10-20-13-08 (`ffmpeg-N-127790-g56dbd4cd37`) | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-N-127790-g56dbd4cd37-win64-gpl.zip | `5e05502c3d4cbd899d87331458e43d448c0bed1669990f7a5b6169a0d3d73f12` |
| Caddy | v2.11.7 | https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip | `0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06` |
| hls.js | 1.7.3 | npm (`hls.js@1.7.3`), vendored to `web/vendor/hls.min.js` | n/a (npm-resolved, see `package-lock.json`) |
| Playwright | 1.56.0 | npm (`playwright@1.56.0`) | n/a |

Not pinned/installed by this project (pre-existing on the host, recorded for context):

| Component | Version observed on this machine |
|---|---|
| OS | Windows 11 Home, build 10.0.26200, x64 |
| CPU | Intel Core i7-9750H, 6 cores / 12 logical processors |
| RAM | 32,619 MB |
| Node.js | v20.11.0 |
| npm | 10.2.4 |
| Google Chrome | **154.0.8037.99** -- the task brief said "Chrome 140"; the actually-installed browser on this machine is 154. All measurements below are against the real installed 154, not 140. If you specifically need 140, that is a separate Chrome install this lab does not manage. |

Font asset `tools/fonts/arial.ttf` is a local copy of the Windows system font
(`C:\Windows\Fonts\arial.ttf`), copied (not modified, not installed) so FFmpeg's
`drawtext` filter can reference it via a relative path -- seeded from the OS,
not downloaded.
