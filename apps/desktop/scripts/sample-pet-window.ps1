# 连续采样角色窗口的位置与尺寸，用来验证桌宠是否在走动。
# 用法：pwsh -File sample-pet-window.ps1 -Samples 8 -IntervalMs 700
param(
  [int]$Samples = 8,
  [int]$IntervalMs = 700
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetWinEnum {
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

function Get-PetWindows {
  $rows = [System.Collections.Generic.List[object]]::new()
  $callback = [PetWinEnum+EnumWindowsProc] {
    param($handle, $param)
    $owner = [uint32]0
    [PetWinEnum]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
    if ($targets -contains [int]$owner) {
      $title = [System.Text.StringBuilder]::new(256)
      [PetWinEnum]::GetWindowText($handle, $title, 256) | Out-Null
      $rect = [PetWinEnum+RECT]::new()
      [PetWinEnum]::GetWindowRect($handle, [ref]$rect) | Out-Null
      $rows.Add([pscustomobject]@{
        Title   = $title.ToString()
        Visible = [PetWinEnum]::IsWindowVisible($handle)
        Width   = $rect.Right - $rect.Left
        Height  = $rect.Bottom - $rect.Top
        Left    = $rect.Left
        Top     = $rect.Top
      })
    }
    return $true
  }
  [PetWinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $rows
}

for ($index = 0; $index -lt $Samples; $index++) {
  # 排除 WebView2 的 22x22 事件窗口，只采样真正的角色窗口。
  $pet = Get-PetWindows |
    Where-Object { $_.Visible -and $_.Title -eq '角色' -and $_.Width -ge 150 -and $_.Height -ge 240 } |
    Select-Object -First 1
  if ($pet) {
    # 窗口中心 x 就是脚底中心的 x：位置 = 脚底 x - 宽度/2
    $center = $pet.Left + $pet.Width / 2
    '{0}  pos=({1},{2}) size={3}x{4} centerX={5}' -f (Get-Date -Format 'HH:mm:ss.fff'), $pet.Left, $pet.Top, $pet.Width, $pet.Height, [math]::Round($center, 1)
  } else {
    '{0}  (pet window not found)' -f (Get-Date -Format 'HH:mm:ss.fff')
  }
  if ($index -ne $Samples - 1) { Start-Sleep -Milliseconds $IntervalMs }
}
