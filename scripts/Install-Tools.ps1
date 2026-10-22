<#
.SYNOPSIS
  Downloads the pinned MediaMTX / FFmpeg / Caddy binaries used by this lab
  into tools/, verifying SHA-256 against VERSIONS.md. Idempotent: skips a
  component whose expected binary already exists unless -Force is passed.
  Never touches PATH or any system-wide install location.
#>
param([switch]$Force)

. "$PSScriptRoot\Lab.Config.ps1"

$components = @(
    @{ Name="MediaMTX"; Url="https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip";
       Sha256="A84224F5A490855684E62BA6FB71E80EA2A5E16AED61883BB58380290E93E467"; Dir="tools\mediamtx"; CheckFile="tools\mediamtx\mediamtx.exe" },
    @{ Name="FFmpeg"; Url="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-N-127790-g56dbd4cd37-win64-gpl.zip";
       Sha256="5E05502C3D4CBD899D87331458E43D448C0BED1669990F7A5B6169A0D3D73F12"; Dir="tools\ffmpeg"; CheckFile="tools\ffmpeg\ffmpeg-N-127790-g56dbd4cd37-win64-gpl\bin\ffmpeg.exe" },
    @{ Name="Caddy"; Url="https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip";
       Sha256="0A1EDC0B799512051C57071CE0E798D3F2CF67DC98171366F1D2B326072E3B06"; Dir="tools\caddy"; CheckFile="tools\caddy\caddy.exe" }
)

foreach ($c in $components) {
    $checkPath = Join-Path $Lab.Root $c.CheckFile
    if ((Test-Path $checkPath) -and -not $Force) {
        Write-Output "$($c.Name): already present at $checkPath (skip; use -Force to re-fetch)"
        continue
    }
    $dir = Join-Path $Lab.Root $c.Dir
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $zipPath = Join-Path $dir "$($c.Name).zip"
    Write-Output "$($c.Name): downloading $($c.Url)"
    Invoke-WebRequest -Uri $c.Url -OutFile $zipPath -UseBasicParsing

    $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
    if ($actual -ne $c.Sha256) {
        throw "$($c.Name): SHA-256 mismatch! expected $($c.Sha256) got $actual -- not extracting. Delete $zipPath and investigate before retrying."
    }
    Write-Output "$($c.Name): checksum verified ($actual)"
    Expand-Archive -Path $zipPath -DestinationPath $dir -Force
    Write-Output "$($c.Name): extracted to $dir"
}

$fontDst = Join-Path $Lab.Root "tools\fonts\arial.ttf"
if (-not (Test-Path $fontDst)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $fontDst) | Out-Null
    Copy-Item "C:\Windows\Fonts\arial.ttf" $fontDst
    Write-Output "Copied Windows system font to $fontDst (for FFmpeg drawtext; not modified, not installed anywhere)"
}

Write-Output ""
Write-Output "Now run (once): npm install    # pulls pinned hls.js + Playwright from package.json into node_modules/"
Write-Output "Then: Copy-Item node_modules\hls.js\dist\hls.min.js*  web\vendor\  (already done if web\vendor\hls.min.js exists)"
