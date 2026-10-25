<#
.SYNOPSIS
  停止由 启动全部.ps1 拉起的后端与前端进程。
#>
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$runDir = Join-Path $root ".run"

function Stop-FromPidFile($name) {
    $pidFile = Join-Path $runDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) {
        Write-Host "$name：没有记录 PID，跳过。" -ForegroundColor DarkGray
        return
    }
    $processId = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if (-not $processId) { return }
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "$name：进程 $processId 已退出。" -ForegroundColor DarkGray
        Remove-Item -LiteralPath $pidFile -Force
        return
    }
    Write-Host "停止 $name（PID $processId）…" -ForegroundColor Cyan
    Stop-Process -Id $processId -Force
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $pidFile -Force
}

Stop-FromPidFile "web"
Stop-FromPidFile "api"

# 前端由 npm 拉起，父进程退出后可能留下子进程；按端口兜底清理。
foreach ($port in 5173, 8001) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($item in $conn) {
        $proc = Get-Process -Id $item.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -in @("node", "python")) {
            Write-Host "清理端口 $port 上的 $($proc.ProcessName)（PID $($proc.Id)）…" -ForegroundColor Yellow
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "已停止。" -ForegroundColor Green