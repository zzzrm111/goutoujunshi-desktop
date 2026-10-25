<#
.SYNOPSIS
  启动后端与前端（可选启动 VoiceStudio）。
.EXAMPLE
  .\启动全部.ps1
  .\启动全部.ps1 -ApiPort 8002 -WebPort 5174
  .\启动全部.ps1 -SkipInstall -SkipVoiceStudio
#>
param(
    [int]$ApiPort = 8001,
    [int]$WebPort = 5173,
    [int]$VoicePort = 3900,
    [switch]$SkipInstall,
    [switch]$SkipVoiceStudio,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$apiDir = Join-Path $root "apps\api"
$webDir = Join-Path $root "apps\web"
$logDir = Join-Path $root "launcher-logs"
$runDir = Join-Path $root ".run"
New-Item -ItemType Directory -Force -Path $logDir, $runDir | Out-Null

function Wait-Http($url, $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-PortFree($port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync("127.0.0.1", $port)
        return -not ($pending.Wait(400) -and $client.Connected)
    }
    catch { return $true }
    finally { $client.Dispose() }
}

# 1. 配置文件
$apiEnv = Join-Path $apiDir ".env"
if (-not (Test-Path -LiteralPath $apiEnv)) {
    Copy-Item -LiteralPath (Join-Path $apiDir ".env.example") -Destination $apiEnv
    Write-Host "已生成 apps/api/.env，请先运行 .\配置向导.ps1 填写模型配置。" -ForegroundColor Yellow
}
$webEnv = Join-Path $webDir ".env.local"
if (-not (Test-Path -LiteralPath $webEnv)) {
    Copy-Item -LiteralPath (Join-Path $webDir ".env.example") -Destination $webEnv
}

$envText = Get-Content -LiteralPath $apiEnv -Raw
if ($envText -notmatch "MODEL_BASE_URL=\S" -or $envText -notmatch "MODEL_API_KEY=\S" -or $envText -notmatch "MODEL_NAME=\S") {
    Write-Host "警告：MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME 尚未填全，文字聊天会返回“模型尚未配置”。" -ForegroundColor Yellow
}

# 2. Python 环境
$python = Join-Path $apiDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "创建 Python 虚拟环境…" -ForegroundColor Cyan
    & python -m venv (Join-Path $apiDir ".venv")
    if ($LASTEXITCODE -ne 0) { throw "创建虚拟环境失败，请确认已安装 Python 3.11+。" }
    $SkipInstall = $false
}
if (-not $SkipInstall) {
    Write-Host "安装后端依赖…" -ForegroundColor Cyan
    & $python -m pip install --disable-pip-version-check -q -r (Join-Path $apiDir "requirements.txt")
}

# 3. 数据库迁移
Push-Location $apiDir
try {
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "数据库迁移失败。" }
}
finally { Pop-Location }

# 4. 启动后端
if (-not (Test-PortFree $ApiPort)) { throw "端口 $ApiPort 已被占用，请用 -ApiPort 指定其他端口。" }
$apiLog = Join-Path $logDir "api.out.log"
$apiErr = Join-Path $logDir "api.err.log"
$apiProc = Start-Process -FilePath $python `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$ApiPort" `
    -WorkingDirectory $apiDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $apiLog -RedirectStandardError $apiErr
Set-Content -LiteralPath (Join-Path $runDir "api.pid") -Value $apiProc.Id
Write-Host "后端 PID $($apiProc.Id)，日志 $apiLog" -ForegroundColor Green

# 5. 启动 VoiceStudio（可选）
if (-not $SkipVoiceStudio) {
    $vsScript = Join-Path $root "scripts\start-voicestudio.ps1"
    $vsDefault = Join-Path $env:LOCALAPPDATA "VoiceStudio\VoiceStudio.exe"
    if (Test-Path -LiteralPath $vsDefault) {
        Write-Host "启动 VoiceStudio…" -ForegroundColor Cyan
        try { & $vsScript -Port $VoicePort } catch { Write-Host "VoiceStudio 启动失败（可忽略）：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    else {
        Write-Host "未检测到 VoiceStudio，跳过本地语音服务。" -ForegroundColor DarkGray
    }
}

# 6. 前端依赖与启动
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) { throw "未找到 npm，请安装 Node.js 20+。" }
if (-not (Test-Path -LiteralPath (Join-Path $webDir "node_modules"))) {
    Write-Host "安装前端依赖…" -ForegroundColor Cyan
    Push-Location $webDir
    try { & npm.cmd install; if ($LASTEXITCODE -ne 0) { throw "npm install 失败。" } }
    finally { Pop-Location }
}
if (-not (Test-PortFree $WebPort)) { throw "端口 $WebPort 已被占用，请用 -WebPort 指定其他端口。" }
$webLog = Join-Path $logDir "web.out.log"
$webErr = Join-Path $logDir "web.err.log"
$webProc = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev", "--", "--host", "127.0.0.1", "--port", "$WebPort" `
    -WorkingDirectory $webDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $webLog -RedirectStandardError $webErr
Set-Content -LiteralPath (Join-Path $runDir "web.pid") -Value $webProc.Id
Write-Host "前端 PID $($webProc.Id)，日志 $webLog" -ForegroundColor Green

# 7. 等待就绪
$apiUrl = "http://127.0.0.1:$ApiPort/health"
if (-not (Wait-Http $apiUrl 90)) {
    Write-Host "后端未在 90 秒内就绪，请查看 $apiErr" -ForegroundColor Red
    exit 1
}
Write-Host "后端就绪：$apiUrl" -ForegroundColor Green
if (-not (Wait-Http "http://127.0.0.1:$WebPort" 90)) {
    Write-Host "前端未在 90 秒内就绪，请查看 $webErr" -ForegroundColor Red
    exit 1
}
Write-Host "前端就绪：http://127.0.0.1:$WebPort" -ForegroundColor Green

if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$WebPort" | Out-Null }
Write-Host "停止服务：.\停止全部.ps1" -ForegroundColor Cyan