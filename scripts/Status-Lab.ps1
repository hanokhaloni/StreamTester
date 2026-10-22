<#
.SYNOPSIS
  Reports liveness of every process this lab has started (from pids/*.json),
  plus MediaMTX path health and a one-shot metrics snapshot per running profile.
#>
. "$PSScriptRoot\Lab.Config.ps1"

$pidFiles = Get-ChildItem -Path $Lab.Dirs.Pids -Filter "*.json" -ErrorAction SilentlyContinue
if (-not $pidFiles) { Write-Output "No tracked processes (pids/ is empty). Lab is not running."; return }

Write-Output "=== Tracked processes ==="
$rows = foreach ($f in $pidFiles) {
    $rec = Get-Content $f.FullName -Raw | ConvertFrom-Json
    $live = Get-Process -Id $rec.pid -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Name    = $rec.name
        Pid     = $rec.pid
        Alive   = [bool]$live
        CPU_s   = if ($live -and $live.CPU) { [Math]::Round([double]$live.CPU, 1) } else { $null }
        WS_MB   = if ($live) { [Math]::Round([double]$live.WorkingSet64/1MB, 1) } else { $null }
        File    = $f.Name
    }
}
$rows | Sort-Object Name | Format-Table -AutoSize

Write-Output "=== MediaMTX path health ==="
foreach ($profileName in @("ondemand","remux")) {
    $p = Get-LabProfile -Profile $profileName
    $pidFile = Join-Path $Lab.Dirs.Pids "mediamtx-$profileName.json"
    if (-not (Test-Path $pidFile)) { continue }
    $apiBase = "http://$($p.ApiAddress)"
    try {
        $items = (Invoke-WebRequest -Uri "$apiBase/v3/paths/list" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
        Write-Output "-- profile=$profileName (hlsAlwaysRemux=$($p.HlsAlwaysRemux)) --"
        $items.items | Select-Object name, ready, online, bytesReceived, @{n='tracks';e={$_.tracks -join ','}} | Format-Table -AutoSize
    } catch {
        Write-Output "-- profile=${profileName}: API at $apiBase not reachable ($_) --"
    }
}
