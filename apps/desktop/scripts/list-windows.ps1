# 列出桌面应用当前可见窗口，用于确认主窗口与角色窗口都已创建。
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = @(Get-Process -Name 'companion-desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($targets.Count -eq 0) {
  Write-Output 'companion-desktop is not running'
  exit 1
}

$rows = [System.Collections.Generic.List[object]]::new()
$callback = [WinEnum+EnumWindowsProc] {
  param($handle, $param)
  $owner = [uint32]0
  [WinEnum]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
  if ($targets -contains [int]$owner) {
    $title = [System.Text.StringBuilder]::new(256)
    [WinEnum]::GetWindowText($handle, $title, 256) | Out-Null
    $rect = [WinEnum+RECT]::new()
    [WinEnum]::GetWindowRect($handle, [ref]$rect) | Out-Null
    $rows.Add([pscustomobject]@{
      Title   = $title.ToString()
      Visible = [WinEnum]::IsWindowVisible($handle)
      Width   = $rect.Right - $rect.Left
      Height  = $rect.Bottom - $rect.Top
      Left    = $rect.Left
      Top     = $rect.Top
    })
  }
  return $true
}

[WinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
$rows | Format-Table -AutoSize
