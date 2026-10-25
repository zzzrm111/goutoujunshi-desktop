param(
    [switch]$BackendOnly,
    [string]$RuntimeRoot = $env:VOICESTUDIO_RUNTIME,
    [string]$AppRoot = $env:VOICESTUDIO_HOME,
    [string]$ModelRoot = $env:VOICESTUDIO_MODELS,
    [int]$Port = 3900
)

# VoiceStudio 是第三方项目（AGPL-3.0），本仓库不分发它的程序或模型权重。
# 安装说明见《模型与语音接入指南.md》。
# 路径可用参数或环境变量覆盖，默认放在当前用户目录，避免写死盘符。

$ErrorActionPreference = "Stop"

if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\project" }
if (-not $AppRoot) { $AppRoot = Join-Path $env:LOCALAPPDATA "VoiceStudio" }
if (-not $ModelRoot) { $ModelRoot = Join-Path $env:LOCALAPPDATA "VoiceStudioModels" }

$python = Join-Path $RuntimeRoot ".venv\Scripts\python.exe"
$entry = Join-Path $RuntimeRoot "backend\main.py"
$desktop = Join-Path $AppRoot "VoiceStudio.exe"
$dataRoot = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\data"
$uvCacheRoot = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\cache\uv"
$matplotlibCache = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\cache\matplotlib"
$numbaCache = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\cache\numba"
$uvExe = Join-Path $env:LOCALAPPDATA "VoiceStudioRuntime\tools\uv\uv.exe"
$indexTtsDir = Join-Path $dataRoot "engines\indextts2\index-tts-2.5"

if (-not (Test-Path -LiteralPath $python)) {
    throw "VoiceStudio runtime not found: $python`n请先安装 VoiceStudio，或通过 -RuntimeRoot 指定运行时目录。"
}
if (-not (Test-Path -LiteralPath $entry)) {
    throw "VoiceStudio backend entry not found: $entry"
}
if (-not $BackendOnly -and -not (Test-Path -LiteralPath $desktop)) {
    throw "VoiceStudio desktop app not found: $desktop`n请先安装 VoiceStudio，或通过 -AppRoot 指定安装目录。"
}

New-Item -ItemType Directory -Force -Path `
    $dataRoot, $ModelRoot, $uvCacheRoot, $matplotlibCache, $numbaCache | Out-Null

$env:OMNIVOICE_PORT = "$Port"
$env:OMNIVOICE_DATA_DIR = $dataRoot
$env:OMNIVOICE_CACHE_DIR = $ModelRoot
$env:HF_HOME = $ModelRoot
$env:HF_HUB_CACHE = $ModelRoot
$env:UV_CACHE_DIR = $uvCacheRoot
$env:MPLCONFIGDIR = $matplotlibCache
$env:NUMBA_CACHE_DIR = $numbaCache
$env:OMNIVOICE_BUNDLED_UV = $uvExe
$env:OMNIVOICE_TTS_BACKEND = "omnivoice"
if (Test-Path -LiteralPath (Join-Path $indexTtsDir "pyproject.toml")) {
    $env:OMNIVOICE_INDEXTTS_DIR = $indexTtsDir
}

# Reuse the existing runtime and bypass Electron's first-run dependency setup.
# JSON preserves Windows paths if the runtime is moved into a spaced directory.
$env:OMNIVOICE_BACKEND_CMD = @(
    $python,
    "-m",
    "uvicorn",
    "main:app",
    "--app-dir",
    "backend",
    "--host",
    "127.0.0.1",
    "--port",
    "$Port"
) | ConvertTo-Json -Compress

# 1200 samples at 24 kHz is 50 ms per audio frame; 0.45 s endpoint gives a
# conversational pause without making every sentence wait a full second.
$env:OMNIVOICE_STREAM_CHUNK = "1200"
$env:OMNIVOICE_DICTATION_ENDPOINT_R1 = "0.8"
$env:OMNIVOICE_DICTATION_ENDPOINT_R2 = "0.45"

# Keep the IndexTTS sidecar resident between chat turns.
$env:OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S = "3600"
$env:OMNIVOICE_IDLE_TIMEOUT_S = "3600"

# IndexTTS 2.5 hardcodes 25 diffusion steps. Eight keeps a usable speed on
# smaller GPUs. Set OMNIVOICE_INDEXTTS_DIFFUSION_STEPS=25 to restore quality.
$env:OMNIVOICE_INDEXTTS_DIFFUSION_STEPS = "8"
$env:OMNIVOICE_INDEXTTS_USE_QWEN_EMO = "0"

if ($BackendOnly) {
    Set-Location (Join-Path $RuntimeRoot "backend")
    & $python $entry
    exit $LASTEXITCODE
}

Start-Process -FilePath $desktop -WorkingDirectory (Split-Path -Parent $desktop) -WindowStyle Hidden | Out-Null

$healthUrl = "http://127.0.0.1:$Port/health"
for ($attempt = 1; $attempt -le 60; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($null -ne $health) {
            Write-Host "VoiceStudio is running: $healthUrl" -ForegroundColor Green
            exit 0
        }
    }
    catch {
        # The desktop shell may need time to start Python and expose /health.
    }
}

throw "VoiceStudio did not become ready within 60 seconds. Check the desktop app logs."