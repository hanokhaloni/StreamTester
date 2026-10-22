# Central port/path registry for the StreamTester lab. Dot-sourced by all other scripts.
# Everything binds to 127.0.0.1 only (loopback) per lab policy.

$Script:LabRoot = Split-Path -Parent $PSScriptRoot
if (-not $LabRoot) { $LabRoot = (Resolve-Path "$PSScriptRoot\..").Path }

$Lab = [ordered]@{
    Root        = $LabRoot
    Bind        = "127.0.0.1"

    Tools = [ordered]@{
        MediaMTX = Join-Path $LabRoot "tools\mediamtx\mediamtx.exe"
        FFmpeg   = Join-Path $LabRoot "tools\ffmpeg\ffmpeg-N-127790-g56dbd4cd37-win64-gpl\bin\ffmpeg.exe"
        FFprobe  = Join-Path $LabRoot "tools\ffmpeg\ffmpeg-N-127790-g56dbd4cd37-win64-gpl\bin\ffprobe.exe"
        Caddy    = Join-Path $LabRoot "tools\caddy\caddy.exe"
    }

    Dirs = [ordered]@{
        Config    = Join-Path $LabRoot "config"
        Generated = Join-Path $LabRoot "config\generated"
        Logs      = Join-Path $LabRoot "logs"
        Pids      = Join-Path $LabRoot "pids"
        Web       = Join-Path $LabRoot "web"
        Proxy     = Join-Path $LabRoot "proxy"
        Bench     = Join-Path $LabRoot "bench"
        Results   = Join-Path $LabRoot "results"
        Recordings= Join-Path $LabRoot "recordings"
    }

    # Two independent MediaMTX instances so hlsAlwaysRemux (a server-global
    # setting, not per-path) can be compared directly. Each gets its own full
    # port block; only one, or both, may run at a time.
    Profiles = [ordered]@{
        ondemand = [ordered]@{
            Name            = "ondemand"
            Description     = "hlsAlwaysRemux=false: HLS muxer created lazily on first request"
            RtspAddress     = "127.0.0.1:19554"
            HlsAddress      = "127.0.0.1:19888"
            ApiAddress      = "127.0.0.1:19997"
            MetricsAddress  = "127.0.0.1:19998"
            PlaybackAddress = "127.0.0.1:19996"
            HlsAlwaysRemux  = $false
        }
        remux = [ordered]@{
            Name            = "remux"
            Description     = "hlsAlwaysRemux=true: HLS muxer runs continuously from source start"
            RtspAddress     = "127.0.0.1:19564"
            HlsAddress      = "127.0.0.1:19889"
            ApiAddress      = "127.0.0.1:19987"
            MetricsAddress  = "127.0.0.1:19989"
            PlaybackAddress = "127.0.0.1:19986"
            HlsAlwaysRemux  = $true
        }
    }

    Proxy = [ordered]@{
        HttpAddress  = "127.0.0.1:19080"   # plain HTTP, serves UI only (mode A uses direct MediaMTX HLS fetch)
        HttpsAddress = "127.0.0.1:19443"   # TLS via Caddy "tls internal" local CA -> negotiates HTTP/2 with Chrome
    }
}

function Get-LabProfile {
    param([Parameter(Mandatory)][ValidateSet("ondemand","remux")][string]$Profile)
    return $Lab.Profiles[$Profile]
}

function Test-LabPortFree {
    param([Parameter(Mandatory)][int]$Port)
    $inUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return (-not $inUse)
}
