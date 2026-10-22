<#
.SYNOPSIS
  Launches N independent FFmpeg processes, each publishing one synthetic
  H.264 video-only RTSP stream into a running MediaMTX instance.

.NOTES
  One process per stream, not shared encoding: a single ffmpeg process
  multiplexing N outputs would serialize encode scheduling for all streams
  behind one process's CPU scheduling slice and one failure domain, and
  would make per-stream CPU overhead unobservable in Task Manager / process
  counters. Separate processes also let us launch all N without waiting on
  any one of them to exit (Start-Process -PassThru, no -Wait), so generator
  startup itself is not a source of artificial staggering.

  No audio track (video-only) - avoids Chrome autoplay-with-sound policy
  from interfering with the video-startup measurement.

  tune=zerolatency disables B-frames/lookahead and -sc_threshold 0 disables
  scene-cut-triggered extra keyframes, so the GOP length (keyframe interval)
  is exact and reproducible instead of content-dependent.
#>
param(
    [int]$StreamCount = 10,
    [ValidateSet("ondemand","remux")][string]$Profile = "ondemand",
    [ValidateSet("Standard","High")][string]$LoadProfile = "Standard",
    [int]$Width = 0,       # 0 = use LoadProfile default
    [int]$Height = 0,
    [int]$Fps = 0,
    [int]$BitrateKbps = 0,
    [double]$GopSeconds = 2.0,
    [string]$FontFile = "tools/fonts/arial.ttf"   # relative to Lab.Root; avoids the "C:" drive-colon
                                                   # colliding with ffmpeg's own filter-option ':' separator
)

. "$PSScriptRoot\Lab.Config.ps1"
$p = Get-LabProfile -Profile $Profile

switch ($LoadProfile) {
    "Standard" { $defW=640; $defH=360; $defFps=15; $defKbps=600 }
    "High"     { $defW=1280; $defH=720; $defFps=30; $defKbps=2500 }
}
if ($Width -eq 0)       { $Width = $defW }
if ($Height -eq 0)      { $Height = $defH }
if ($Fps -eq 0)         { $Fps = $defFps }
if ($BitrateKbps -eq 0) { $BitrateKbps = $defKbps }
$gopFrames = [int][Math]::Round($Fps * $GopSeconds)

New-Item -ItemType Directory -Force -Path $Lab.Dirs.Logs | Out-Null
New-Item -ItemType Directory -Force -Path $Lab.Dirs.Pids | Out-Null

$records = @()
$launchedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")

Write-Host "Launching $StreamCount generator(s) -> rtsp://$($p.RtspAddress)/camNN  [$($Width)x$($Height)@$($Fps)fps, $($BitrateKbps)kbps, GOP=$gopFrames frames (${GopSeconds}s)]"

for ($i = 1; $i -le $StreamCount; $i++) {
    $name = "cam{0:D2}" -f $i
    $label = "CAM$('{0:D2}' -f $i)"
    $logOut = Join-Path $Lab.Dirs.Logs "ffmpeg-$name-stdout.log"
    $logErr = Join-Path $Lab.Dirs.Logs "ffmpeg-$name-stderr.log"

    # Distinct seed per stream so tiles are visually distinguishable (not just the text label).
    $seed = $i * 97

    # %{pts:hms} would need a literal ':' inside the value, which this ffmpeg
    # build's filtergraph parser won't honor even when quoted/escaped -- use
    # the colon-free %{pts} (raw seconds) expansion instead.
    $drawtext = "drawtext=fontfile=${FontFile}:text=$label  frame=%{n}  t=%{pts}s:x=10:y=10:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6"
    $vf = "$drawtext"

    $ffArgs = @(
        "-hide_banner", "-loglevel", "warning", "-nostats",
        "-f", "lavfi", "-i", "testsrc2=size=${Width}x${Height}:rate=${Fps}",
        "-vf", "`"$vf`"",
        "-an",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-sc_threshold", "0",
        "-g", "$gopFrames",
        "-keyint_min", "$gopFrames",
        "-b:v", "${BitrateKbps}k",
        "-maxrate", "${BitrateKbps}k",
        "-bufsize", "$([int]($BitrateKbps*2))k",
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        "rtsp://$($p.RtspAddress)/$name"
    )

    $proc = Start-Process -FilePath $Lab.Tools.FFmpeg -ArgumentList $ffArgs `
        -PassThru -WindowStyle Hidden -WorkingDirectory $Lab.Root `
        -RedirectStandardOutput $logOut -RedirectStandardError $logErr

    $records += [ordered]@{
        stream       = $name
        pid          = $proc.Id
        width        = $Width
        height       = $Height
        fps          = $Fps
        bitrateKbps  = $BitrateKbps
        gopFrames    = $gopFrames
        rtspUrl      = "rtsp://$($p.RtspAddress)/$name"
        launchedAtUtc= $launchedAtUtc
        stdoutLog    = $logOut
        stderrLog    = $logErr
    }
}

$pidFile = Join-Path $Lab.Dirs.Logs "generators-$Profile.json"   # summary manifest only, not a Status/Stop-Lab pid record
$records | ConvertTo-Json -Depth 5 | Set-Content -Path $pidFile -Encoding utf8
Write-Host "Tracked $($records.Count) generator PIDs -> $pidFile"
return $records
