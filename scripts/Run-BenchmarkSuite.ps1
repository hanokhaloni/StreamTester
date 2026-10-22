<#
.SYNOPSIS
  Runs the named benchmark scenarios end-to-end: (re)starts the needed
  MediaMTX profile fresh when a scenario requires a verified-cold HLS state,
  invokes bench/run-benchmark.mjs (real Chrome via Playwright/CDP) against
  web/bench.html, and leaves one JSON result per scenario under results/.

.NOTES
  "Cold" means: MediaMTX for that profile was just (re)started and no HLS
  reader has ever requested these paths before -- the HLS muxer (ondemand
  profile) has not been created yet. We guarantee this by always doing a
  fresh Stop-Lab + Start-Lab immediately before a scenario labelled "cold".
  "Warm" scenarios reuse the same still-running instance right after a cold
  run, so the muxer/segments already exist.

  HTTP/2 proxy scenarios are NOT included here: the Caddy /hls/* reverse
  proxy currently 404s (see README "Known issues"), so that comparison is
  parked, not fabricated.
#>
param(
    [int]$StreamCount = 10,
    [switch]$Headed,   # default false: each run uses an isolated project-local Chrome profile either way (see bench/run-benchmark.mjs)
    [string]$UiBase = "http://127.0.0.1:19080"
)
. "$PSScriptRoot\Lab.Config.ps1"
$resultsDir = $Lab.Dirs.Results
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

function Run-NodeBench($scenario, $streams, $mode, $init, $timeoutMs=20000) {
    Write-Output ">>> running scenario '$scenario' (streams=$streams mode=$mode init=$init)"
    $headedArg = if ($Headed) { "1" } else { "0" }
    & node "$($Lab.Root)\bench\run-benchmark.mjs" `
        "--scenario=$scenario" "--streams=$streams" "--mode=$mode" "--init=$init" `
        "--timeout=$timeoutMs" "--uiBase=$UiBase" "--headed=$headedArg" `
        "--out=$resultsDir\$scenario.json"
}

function Snapshot-Metrics($profileName, $label) {
    $p = Get-LabProfile -Profile $profileName
    try {
        $txt = (Invoke-WebRequest -Uri "http://$($p.MetricsAddress)/metrics" -UseBasicParsing -TimeoutSec 5).Content
        Set-Content -Path (Join-Path $resultsDir "metrics-$label.prom") -Value $txt -Encoding utf8
    } catch { Write-Warning "metrics snapshot failed for ${label}: $_" }
}

Write-Output "=== Scenario 1: one stream, direct, warm source ==="
& "$PSScriptRoot\Stop-Lab.ps1" | Out-Null
& "$PSScriptRoot\Start-Lab.ps1" -Profile ondemand -StreamCount $StreamCount | Out-Null
Start-Sleep -Seconds 2
Invoke-WebRequest -Uri "http://127.0.0.1:19888/cam01/index.m3u8" -UseBasicParsing | Out-Null  # pre-touch -> warm
Start-Sleep -Seconds 1
Run-NodeBench "01-single-direct-warm" 1 "direct-ondemand" "concurrent"
Snapshot-Metrics "ondemand" "01-single-direct-warm"

Write-Output "=== Scenario 2: $StreamCount streams, direct, concurrent, HLS COLD (ondemand profile, fresh restart) ==="
& "$PSScriptRoot\Stop-Lab.ps1" | Out-Null
& "$PSScriptRoot\Start-Lab.ps1" -Profile ondemand -StreamCount $StreamCount | Out-Null
Run-NodeBench "02-multi-direct-concurrent-cold-ondemand" $StreamCount "direct-ondemand" "concurrent"
Snapshot-Metrics "ondemand" "02-multi-direct-concurrent-cold-ondemand"

Write-Output "=== Scenario 3: $StreamCount streams, direct, concurrent, HLS WARM (same instance, muxers now exist) ==="
Run-NodeBench "03-multi-direct-concurrent-warm-ondemand" $StreamCount "direct-ondemand" "concurrent"
Snapshot-Metrics "ondemand" "03-multi-direct-concurrent-warm-ondemand"

Write-Output "=== Scenario 4/5 (HTTP/2 proxy, cold/warm): SKIPPED -- proxy /hls/* path not yet working, see README Known issues ==="

Write-Output "=== Scenario 6: $StreamCount streams, direct, DELIBERATELY SEQUENTIAL init, HLS COLD (fresh restart, fair comparison vs scenario 2) ==="
& "$PSScriptRoot\Stop-Lab.ps1" | Out-Null
& "$PSScriptRoot\Start-Lab.ps1" -Profile ondemand -StreamCount $StreamCount | Out-Null
Run-NodeBench "06-multi-direct-sequential-cold-ondemand" $StreamCount "direct-ondemand" "sequential" 30000
Snapshot-Metrics "ondemand" "06-multi-direct-sequential-cold-ondemand"

Write-Output "=== Extra: $StreamCount streams, direct, concurrent, REMUX profile (hlsAlwaysRemux=true) -- isolates on-demand-muxer cost ==="
& "$PSScriptRoot\Stop-Lab.ps1" | Out-Null
& "$PSScriptRoot\Start-Lab.ps1" -Profile remux -StreamCount $StreamCount | Out-Null
Start-Sleep -Seconds 3   # give the continuously-running muxers a moment to accumulate the configured segment count
Run-NodeBench "07-multi-direct-concurrent-remux" $StreamCount "direct-remux" "concurrent"
Snapshot-Metrics "remux" "07-multi-direct-concurrent-remux"

Write-Output "=== Done. Results in $resultsDir ==="
Get-ChildItem $resultsDir -Filter "*.json" | Select-Object Name, Length, LastWriteTime
