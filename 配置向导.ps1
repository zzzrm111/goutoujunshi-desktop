<#
.SYNOPSIS
  交互式填写 apps/api/.env 与 apps/web/.env.local。
.DESCRIPTION
  只修改本地配置文件，不会写入仓库或提交 Git。直接回车表示保留原值。
#>
param(
    [string]$ApiEnv = "",
    [string]$WebEnv = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $ApiEnv) { $ApiEnv = Join-Path $root "apps\api\.env" }
if (-not $WebEnv) { $WebEnv = Join-Path $root "apps\web\.env.local" }

function Ensure-File($path, $example) {
    if (-not (Test-Path -LiteralPath $path)) {
        Copy-Item -LiteralPath $example -Destination $path
        Write-Host "已创建 $path" -ForegroundColor Green
    }
}

function Get-EnvValue($path, $key) {
    if (-not (Test-Path -LiteralPath $path)) { return "" }
    $line = Get-Content -LiteralPath $path | Where-Object { $_ -match "^\s*$([regex]::Escape($key))\s*=" } | Select-Object -First 1
    if (-not $line) { return "" }
    return ($line -replace "^\s*$([regex]::Escape($key))\s*=", "").Trim()
}

function Set-EnvValue($path, $key, $value) {
    $lines = @(Get-Content -LiteralPath $path)
    $pattern = "^\s*$([regex]::Escape($key))\s*="
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$key=$value"
            $found = $true
        }
    }
    if (-not $found) { $lines += "$key=$value" }
    [IO.File]::WriteAllText($path, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
}

function Read-Value($label, $current) {
    $hint = if ([string]::IsNullOrWhiteSpace($current)) { "" } else { "（当前：$current，回车保留）" }
    $value = Read-Host "$label$hint"
    if ([string]::IsNullOrWhiteSpace($value)) { return $current }
    return $value.Trim()
}

function Read-Secret($label, $current) {
    $hint = if ([string]::IsNullOrWhiteSpace($current)) { "" } else { "（已设置，回车保留）" }
    $secure = Read-Host "$label$hint" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ([string]::IsNullOrWhiteSpace($plain)) { return $current }
    return $plain.Trim()
}

function Read-Choice($label, $choices, $default) {
    Write-Host ""
    Write-Host $label -ForegroundColor Cyan
    for ($i = 0; $i -lt $choices.Count; $i++) {
        Write-Host ("  [{0}] {1}" -f ($i + 1), $choices[$i])
    }
    $raw = Read-Host "选择（默认 $default）"
    if ([string]::IsNullOrWhiteSpace($raw)) { return $default }
    return $raw.Trim()
}

Ensure-File $ApiEnv (Join-Path $root "apps\api\.env.example")
Ensure-File $WebEnv (Join-Path $root "apps\web\.env.example")

Write-Host ""
Write-Host "=== 1/4 对话模型（必填）===" -ForegroundColor Cyan
$base = Read-Value "MODEL_BASE_URL（例如 https://your-provider.example/v1）" (Get-EnvValue $ApiEnv "MODEL_BASE_URL")
$key = Read-Secret "MODEL_API_KEY" (Get-EnvValue $ApiEnv "MODEL_API_KEY")
$model = Read-Value "MODEL_NAME" (Get-EnvValue $ApiEnv "MODEL_NAME")
$realtime = Read-Value "MODEL_REALTIME_NAME（可留空，复用上面的模型）" (Get-EnvValue $ApiEnv "MODEL_REALTIME_NAME")

Set-EnvValue $ApiEnv "MODEL_BASE_URL" $base
Set-EnvValue $ApiEnv "MODEL_API_KEY" $key
Set-EnvValue $ApiEnv "MODEL_NAME" $model
Set-EnvValue $ApiEnv "MODEL_REALTIME_NAME" $realtime

Write-Host ""
Write-Host "=== 2/4 语音合成 TTS（可选）===" -ForegroundColor Cyan
$tts = Read-Choice "TTS_PROVIDER" @("mock（不接语音）", "cloud（[OI] 兼容接口）", "voicestudio（本地 VoiceStudio）") "1"
switch ($tts) {
    "2" {
        Set-EnvValue $ApiEnv "TTS_PROVIDER" "cloud"
        Set-EnvValue $ApiEnv "TTS_BASE_URL" (Read-Value "TTS_BASE_URL" (Get-EnvValue $ApiEnv "TTS_BASE_URL"))
        Set-EnvValue $ApiEnv "TTS_API_KEY" (Read-Secret "TTS_API_KEY" (Get-EnvValue $ApiEnv "TTS_API_KEY"))
        Set-EnvValue $ApiEnv "TTS_MODEL" (Read-Value "TTS_MODEL" (Get-EnvValue $ApiEnv "TTS_MODEL"))
        Set-EnvValue $ApiEnv "TTS_VOICE" (Read-Value "TTS_VOICE（留空使用服务端默认音色）" (Get-EnvValue $ApiEnv "TTS_VOICE"))
    }
    "3" {
        Set-EnvValue $ApiEnv "TTS_PROVIDER" "voicestudio"
        Set-EnvValue $ApiEnv "TTS_BASE_URL" (Read-Value "TTS_BASE_URL" "http://127.0.0.1:3900")
        Set-EnvValue $ApiEnv "TTS_MODEL" (Read-Value "TTS_MODEL" "omnivoice")
        Set-EnvValue $ApiEnv "TTS_VOICE" (Read-Value "TTS_VOICE（VoiceStudio voice_id，留空用默认）" (Get-EnvValue $ApiEnv "TTS_VOICE"))
    }
    default { Set-EnvValue $ApiEnv "TTS_PROVIDER" "mock" }
}

Write-Host ""
Write-Host "=== 3/4 语音识别 ASR（可选）===" -ForegroundColor Cyan
$asr = Read-Choice "ASR_PROVIDER" @("mock（不接语音）", "cloud（[OI] 兼容接口）", "voicestudio（本地 VoiceStudio）") "1"
switch ($asr) {
    "2" {
        Set-EnvValue $ApiEnv "ASR_PROVIDER" "cloud"
        Set-EnvValue $ApiEnv "ASR_BASE_URL" (Read-Value "ASR_BASE_URL" (Get-EnvValue $ApiEnv "ASR_BASE_URL"))
        Set-EnvValue $ApiEnv "ASR_API_KEY" (Read-Secret "ASR_API_KEY" (Get-EnvValue $ApiEnv "ASR_API_KEY"))
        Set-EnvValue $ApiEnv "ASR_MODEL" (Read-Value "ASR_MODEL" (Get-EnvValue $ApiEnv "ASR_MODEL"))
    }
    "3" {
        Set-EnvValue $ApiEnv "ASR_PROVIDER" "voicestudio"
        Set-EnvValue $ApiEnv "ASR_BASE_URL" (Read-Value "ASR_BASE_URL" "http://127.0.0.1:3900")
        Set-EnvValue $ApiEnv "ASR_MODEL" (Read-Value "ASR_MODEL" "Systran/faster-whisper-base")
        Set-EnvValue $ApiEnv "ASR_REALTIME_MODEL" (Read-Value "ASR_REALTIME_MODEL" "sherpa-zipformer-bilingual-zh-en")
    }
    default { Set-EnvValue $ApiEnv "ASR_PROVIDER" "mock" }
}

Write-Host ""
Write-Host "=== 4/4 角色模型（可选）===" -ForegroundColor Cyan
$modelUrl = Read-Value "VITE_CHARACTER_MODEL_URL（留空使用示例模型）" (Get-EnvValue $WebEnv "VITE_CHARACTER_MODEL_URL")
Set-EnvValue $WebEnv "VITE_CHARACTER_MODEL_URL" $modelUrl
if ([string]::IsNullOrWhiteSpace((Get-EnvValue $WebEnv "VITE_API_BASE_URL"))) {
    Set-EnvValue $WebEnv "VITE_API_BASE_URL" "http://127.0.0.1:8001/api/v1"
}

Write-Host ""
Write-Host "配置完成：" -ForegroundColor Green
Write-Host "  $ApiEnv"
Write-Host "  $WebEnv"
Write-Host "这两个文件已被 .gitignore 忽略，不要提交。" -ForegroundColor Yellow
Write-Host "接下来运行：.\启动全部.ps1" -ForegroundColor Green