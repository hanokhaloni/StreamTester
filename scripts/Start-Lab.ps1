<#
.SYNOPSIS
  Brings up one full lab stack: MediaMTX (one profile) + N FFmpeg generators,
  optionally + the Caddy HTTP/2 proxy. Verifies every source is ready before
  reporting success. Tracks every PID it starts under pids/ for Stop-Lab.ps1.

.EXAMPLE
  .\scripts\Start-Lab.ps1 -Profile ondemand -StreamCount 10
#>
param(
    [ValidateSet("ondemand","remux")][string]$Profile = "ondemand",
    [int]$StreamCount = 10,
    [ValidateSet("Standard","High")][string]$LoadProfile = "Standard",
    [ValidateSet("mpegts","lowLatency")][string]$HlsVariant = "mpegts",
    [switch]$WithRecordingDemo,
    [int]$ReadyTimeoutSec = 30
)

. "$PSScriptRoot\Lab.Config.ps1"
$p = Get-LabProfile -Profile $Profile
New-Item -ItemType Directory -Force -Path $Lab.Dirs.Logs, $Lab.Dirs.Pids | Out-Null

function Write-PidRecord($name, $proc, $extra) {
    $rec = [ordered]@{
        name        = $name
        pid         = $proc.Id
        processName = $proc.ProcessName
        startedAtUtc= [DateTimeOffset]::UtcNow.ToString("o")
    }
    foreach ($k in $extra.Keys) { $rec[$k] = $extra[$k] }
    $rec | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Lab.Dirs.Pids "$name.json") -Encoding utf8
}

# --- sanity: make sure this profile's ports are actually free -------------
$portsToCheck = @(
    [int]($p.RtspAddress -split ':')[1],
    [int]($p.HlsAddress -split ':')[1],
    [int]($p.ApiAddress -split ':')[1],
    [int]($p.MetricsAddress -split ':')[1],
    [int]($p.PlaybackAddress -split ':')[1]
)
foreach ($port in $portsToCheck) {
    if (-not (Test-LabPortFree -Port $port)) {
        throw "Port $port is already in use. Run scripts\Stop-Lab.ps1 first, or check for a leftover process (Get-NetTCPConnection -LocalPort $port)."
    }
}

# --- 1. generate config -----------------------------------------------------
$cfgArgs = @{ Profile=$Profile; StreamCount=$StreamCount; HlsVariant=$HlsVariant }
if ($WithRecordingDemo) { $cfgArgs.EnableRecordingDemo = $true }
$cfgFile = & "$PSScriptRoot\Generate-MediaMTXConfig.ps1" @cfgArgs

# --- 2. start MediaMTX -------------------------------------------------------
$mmtxOut = Join-Path $Lab.Dirs.Logs "mediamtx-$Profile-stdout.log"
$mmtxErr = Join-Path $Lab.Dirs.Logs "mediamtx-$Profile-stderr.log"
$mmtxProc = Start-Process -FilePath $Lab.Tools.MediaMTX -ArgumentList "`"$cfgFile`"" `
    -PassThru -WindowStyle Hidden -WorkingDirectory $Lab.Root `
    -RedirectStandardOutput $mmtxOut -RedirectStandardError $mmtxErr
Write-PidRecord "mediamtx-$Profile" $mmtxProc @{ profile=$Profile; configFile=$cfgFile; apiAddress=$p.ApiAddress }
Write-Output "Started MediaMTX [$Profile] pid=$($mmtxProc.Id)"

# wait for API to come up
$apiBase = "http://$($p.ApiAddress)"
$deadline = (Get-Date).AddSeconds(15)
$apiUp = $false
while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -Uri "$apiBase/v3/paths/list" -UseBasicParsing -TimeoutSec 2 | Out-Null; $apiUp = $true; break }
    catch { Start-Sleep -Milliseconds 300 }
}
if (-not $apiUp) { throw "MediaMTX API at $apiBase did not come up within 15s. Check $mmtxErr" }
Write-Output "MediaMTX API is up at $apiBase"

# --- 3. start generators ------------------------------------------------------
$gens = & "$PSScriptRoot\Start-Generators.ps1" -StreamCount $StreamCount -Profile $Profile -LoadProfile $LoadProfile
foreach ($g in $gens) {
    $rec = [ordered]@{
        name = "ffmpeg-$($g.stream)"; pid = $g.pid; processName = "ffmpeg"
        startedAtUtc = $g.launchedAtUtc; stream = $g.stream; profile = $Profile
    }
    $rec | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Lab.Dirs.Pids "ffmpeg-$($g.stream)-$Profile.json") -Encoding utf8
}

# --- 4. start Caddy: always serves the static UI on plain HTTP (mode A needs
# this regardless of -WithProxy); the HTTPS/HTTP-2 site is included too since
# it only adds a second listener and doesn't block the HTTP one from working,
# but its /hls/* proxy path is a known-broken 404 right now (see README).
& "$PSScriptRoot\Generate-Caddyfile.ps1" -Profile $Profile | Out-Null
$caddyOut = Join-Path $Lab.Dirs.Logs "caddy-stdout.log"
$caddyErr = Join-Path $Lab.Dirs.Logs "caddy-stderr.log"
$caddyfile = Join-Path $Lab.Dirs.Proxy "Caddyfile.generated"
$caddyProc = Start-Process -FilePath $Lab.Tools.Caddy -ArgumentList @("run","--config","`"$caddyfile`"","--adapter","caddyfile") `
    -PassThru -WindowStyle Hidden -WorkingDirectory $Lab.Root `
    -RedirectStandardOutput $caddyOut -RedirectStandardError $caddyErr
Write-PidRecord "caddy" $caddyProc @{ caddyfile=$caddyfile }
Write-Output "Started Caddy pid=$($caddyProc.Id) -> UI at http://$($Lab.Proxy.HttpAddress)/ (and https://$($Lab.Proxy.HttpsAddress)/, proxy path not yet functional)"
Start-Sleep -Seconds 1

# --- 5. verify every source is healthy before declaring ready ---------------
Write-Output "Waiting up to ${ReadyTimeoutSec}s for all $StreamCount source(s) to report ready via MediaMTX API..."
$names = 1..$StreamCount | ForEach-Object { "cam{0:D2}" -f $_ }
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$statusByName = @{}
do {
    try {
        $items = (Invoke-WebRequest -Uri "$apiBase/v3/paths/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
        foreach ($it in $items.items) { $statusByName[$it.name] = $it }
    } catch {}
    $notReady = $names | Where-Object { -not ($statusByName.ContainsKey($_) -and $statusByName[$_].ready) }
    if ($notReady.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

$notReady = $names | Where-Object { -not ($statusByName.ContainsKey($_) -and $statusByName[$_].ready) }
if ($notReady.Count -gt 0) {
    Write-Warning "NOT all sources became ready within ${ReadyTimeoutSec}s: $($notReady -join ', ')"
    Write-Warning "Lab is UP but NOT fully healthy. Check logs\ffmpeg-<stream>-stderr.log and logs\mediamtx-$Profile-stderr.log"
} else {
    Write-Output "READY: all $StreamCount source(s) are ready and online (profile=$Profile, hlsAlwaysRemux=$($p.HlsAlwaysRemux))."
}

Write-Output ""
Write-Output "Direct HLS base   : http://$($p.HlsAddress)/camNN/index.m3u8"
Write-Output "MediaMTX API      : http://$($p.ApiAddress)/v3/paths/list"
Write-Output "MediaMTX metrics  : http://$($p.MetricsAddress)/metrics"
Write-Output "UI (HTTP/1.1)     : http://$($Lab.Proxy.HttpAddress)/"
Write-Output "UI (HTTP/2, TLS)  : https://$($Lab.Proxy.HttpsAddress)/ (proxy path /hls/* not yet functional, see README)"
Write-Output ""
Write-Output "Run scripts\Status-Lab.ps1 to re-check health, scripts\Stop-Lab.ps1 to tear down."
