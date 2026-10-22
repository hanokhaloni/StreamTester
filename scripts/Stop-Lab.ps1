<#
.SYNOPSIS
  Stops only the processes this lab started (tracked in pids/*.json), verifying
  PID + process name still match before killing, to avoid touching an unrelated
  process that happens to have reused a PID. Never touches anything not tracked
  here -- it does not call Stop-Process by name/image globally.
#>
param(
    [string[]]$Profile = @("ondemand","remux")  # which mediamtx/ffmpeg profile sets to stop; caddy is always stopped if tracked
)
. "$PSScriptRoot\Lab.Config.ps1"

$pidFiles = Get-ChildItem -Path $Lab.Dirs.Pids -Filter "*.json" -ErrorAction SilentlyContinue
if (-not $pidFiles) { Write-Output "Nothing tracked in pids/ -- nothing to stop."; return }

foreach ($f in $pidFiles) {
    $rec = Get-Content $f.FullName -Raw | ConvertFrom-Json

    if ($rec.profile -and ($Profile -notcontains $rec.profile)) { continue }

    $proc = Get-Process -Id $rec.pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq $rec.processName) {
        Stop-Process -Id $rec.pid -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped $($rec.name) (pid=$($rec.pid))"
    } elseif ($proc) {
        Write-Warning "Skipped $($rec.name): pid $($rec.pid) is now a different process ($($proc.ProcessName)), not touching it."
    } else {
        Write-Output "$($rec.name) (pid=$($rec.pid)) already not running."
    }
    Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
}
Write-Output "Done."
