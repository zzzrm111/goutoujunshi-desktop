<#
.SYNOPSIS
  公开前的本地自检：密钥、敏感文件、写死路径、角色模型授权。
.EXAMPLE
  .\scripts\check-public-release.ps1
#>
param(
    [switch]$SkipVrm
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$fail = 0
$warn = 0

function Fail($message) { Write-Host "[FAIL] $message" -ForegroundColor Red; $script:fail++ }
function Warn($message) { Write-Host "[WARN] $message" -ForegroundColor Yellow; $script:warn++ }
function Pass($message) { Write-Host "[ OK ] $message" -ForegroundColor Green }

Write-Host "== 1. 必需文件 ==" -ForegroundColor Cyan
foreach ($rel in @("LICENSE", "README.md", "模型与语音接入指南.md", "本地启动说明.md", "公开版说明.md")) {
    if (Test-Path -LiteralPath (Join-Path $root $rel)) { Pass $rel } else { Fail "缺少 $rel" }
}

Write-Host "`n== 2. 不应存在的文件 ==" -ForegroundColor Cyan
$forbidden = @(
    "apps/api/.env",
    "apps/web/.env.local",
    "apps/web/public/models/character.vrm",
    "companion-data",
    "downloads",
    "backups"
)
foreach ($rel in $forbidden) {
    if (Test-Path -LiteralPath (Join-Path $root $rel)) { Fail "存在敏感/不可分发内容：$rel" } else { Pass "无 $rel" }
}

Write-Host "`n== 3. 密钥与令牌 ==" -ForegroundColor Cyan
$textExtensions = @(".md", ".py", ".ts", ".tsx", ".js", ".cjs", ".json", ".yml", ".yaml", ".ps1", ".psm1", ".toml", ".ini", ".cfg", ".txt", ".example", ".env")
$secretPatterns = @(
    @{ Name = "[OI] 风格密钥"; Pattern = "sk-[A-Za-z0-9]{20,}" },
    @{ Name = "GitHub Token"; Pattern = "gh[pousr]_[A-Za-z0-9]{20,}" },
    @{ Name = "AWS Access Key"; Pattern = "AKIA[0-9A-Z]{16}" },
    @{ Name = "私钥"; Pattern = "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
    @{ Name = "Bearer 长令牌"; Pattern = "Bearer\s+[A-Za-z0-9_\-\.]{30,}" }
)

$files = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    $_.FullName -notmatch "\\node_modules\\|\\\.venv\\|\\\.git\\|\\target\\|\\launcher-logs\\|\\\.run\\" -and
    $_.Name -ne "check-public-release.ps1" -and
    ($textExtensions -contains $_.Extension -or $_.Name -like ".env*") -and
    $_.Length -lt 2MB
}
$hits = 0
foreach ($file in $files) {
    $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($item in $secretPatterns) {
        if ($content -match $item.Pattern) {
            Fail "$($item.Name)：$($file.FullName.Substring($root.Length + 1))"
            $hits++
        }
    }
}
if ($hits -eq 0) { Pass "未发现密钥模式" }

Write-Host "`n== 4. 写死的本机路径 ==" -ForegroundColor Cyan
$pathHits = 0
foreach ($file in $files) {
    $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    if ($content -match "[A-Z]:\\\\Users\\\\|E:\\\\桌面\\\\|C:\\\\Users\\\\") {
        Warn "可能写死本机路径：$($file.FullName.Substring($root.Length + 1))"
        $pathHits++
    }
}
if ($pathHits -eq 0) { Pass "未发现写死路径" }

Write-Host "`n== 5. 模型与音色占位 ==" -ForegroundColor Cyan
$apiExample = Join-Path $root "apps\api\.env.example"
if (Test-Path -LiteralPath $apiExample) {
    $example = Get-Content -LiteralPath $apiExample -Raw
    if ($example -match "(?m)^MODEL_API_KEY=\S") { Fail ".env.example 里 MODEL_API_KEY 不是空值" } else { Pass "MODEL_API_KEY 为空" }
    if ($example -match "(?m)^TTS_VOICE=\S") { Fail ".env.example 里 TTS_VOICE 不是空值" } else { Pass "TTS_VOICE 为空" }
}

Write-Host "`n== 6. 角色模型授权 ==" -ForegroundColor Cyan
if (-not $SkipVrm) {
    $models = Get-ChildItem -LiteralPath (Join-Path $root "apps\web\public\models") -Filter "*.vrm" -File -ErrorAction SilentlyContinue
    foreach ($model in $models) {
        $python = (Get-Command python -ErrorAction SilentlyContinue)
        if (-not $python) { Warn "未找到 python，跳过 $($model.Name)"; continue }
        & $python.Source (Join-Path $root "scripts\check-vrm-license.py") $model.FullName
        if ($LASTEXITCODE -ne 0) { Fail "$($model.Name) 不允许公开分发" }
    }
}

Write-Host ""
if ($fail -gt 0) {
    Write-Host "检查未通过：$fail 个错误，$warn 个警告。" -ForegroundColor Red
    exit 1
}
Write-Host "检查通过（$warn 个警告）。" -ForegroundColor Green