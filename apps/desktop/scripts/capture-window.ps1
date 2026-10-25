# 截取桌面应用某个窗口的画面，用于确认角色是否真的渲染出来。
# 用法：pwsh -File capture-window.ps1 -TitleLike '角色' -OutPath '<输出目录>\pet.png'
param(
  [string]$TitleLike = '角色',
  [string]$OutPath = "$env:TEMP\companion-window.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = @(Get-Process -Name 'companion-desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($targets.Count -eq 0) {
  Write-Output 'companion-desktop is not running'
  exit 1
}

$found = [IntPtr]::Zero
$foundRect = [WinCap+RECT]::new()
$callback = [WinCap+EnumWindowsProc] {
  param($handle, $param)
  $owner = [uint32]0
  [WinCap]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
  if ($targets -contains [int]$owner -and [WinCap]::IsWindowVisible($handle)) {
    $title = [System.Text.StringBuilder]::new(256)
    [WinCap]::GetWindowText($handle, $title, 256) | Out-Null
    if ($title.ToString() -like "*$TitleLike*") {
      $script:found = $handle
      $rect = [WinCap+RECT]::new()
      [WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null
      $script:foundRect = $rect
      return $false
    }
  }
  return $true
}

[WinCap]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($found -eq [IntPtr]::Zero) {
  Write-Output "window matching '$TitleLike' not found"
  exit 1
}

$width = $foundRect.Right - $foundRect.Left
$height = $foundRect.Bottom - $foundRect.Top
Write-Output "capturing '$TitleLike' ${width}x${height} at ($($foundRect.Left),$($foundRect.Top))"

[WinCap]::SetForegroundWindow($found) | Out-Null
Start-Sleep -Milliseconds 700

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# PrintWindow 只复制该窗口自己的图层；透明桌宠不会把后面 Codex 的聊天文字拍进来。
# 0x2 = PW_RENDERFULLCONTENT，WebView2 需要这个标志才能抓到完整内容。
$printed = [WinCap]::PrintWindow($found, $hdc, 2)
$graphics.ReleaseHdc($hdc)
if (-not $printed) {
  $graphics.CopyFromScreen($foundRect.Left, $foundRect.Top, 0, 0, $bitmap.Size)
}
$graphics.Dispose()
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output "saved $OutPath"
