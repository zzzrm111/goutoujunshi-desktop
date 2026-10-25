# 验证角色窗口可以用鼠标拖动。
#
# 步骤：把鼠标放到角色身上 → 按下 → 分几步移动 → 松开，
# 然后比较窗口位置是否跟着移动。
#
# 用法：pwsh -File verify-pet-drag.ps1

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetDrag {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

$targets = @(Get-Process -Name 'companion-desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($targets.Count -eq 0) { Write-Output 'FAIL: companion-desktop is not running'; exit 1 }

function Find-PetWindow {
  $script:handle = [IntPtr]::Zero
  $script:rect = [PetDrag+RECT]::new()
  $cb = [PetDrag+EnumWindowsProc] {
    param($h, $p)
    $owner = [uint32]0
    [PetDrag]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    if ($targets -contains [int]$owner -and [PetDrag]::IsWindowVisible($h)) {
      $title = [System.Text.StringBuilder]::new(256)
      [PetDrag]::GetWindowText($h, $title, 256) | Out-Null
      if ($title.ToString() -eq '角色') {
        $script:handle = $h
        $r = [PetDrag+RECT]::new()
        [PetDrag]::GetWindowRect($h, [ref]$r) | Out-Null
        $script:rect = $r
        return $false
      }
    }
    return $true
  }
  [PetDrag]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
}

# 角色会自己走动，所以窗口矩形要在按下之前立刻读取，并允许重试
$movedX = 0
$movedY = 0
$passed = $false

for ($attempt = 1; $attempt -le 5; $attempt++) {
  Find-PetWindow
  if ($script:handle -eq [IntPtr]::Zero) { break }

  $before = $script:rect
  $width = $before.Right - $before.Left
  $height = $before.Bottom - $before.Top
  $startX = $before.Left + [int]($width * 0.5)
  $startY = $before.Top + [int]($height * 0.45)

  # 尽量缩短"读位置"到"按下"之间的间隔，避免角色走开
  [PetDrag]::SetCursorPos($startX, $startY) | Out-Null
  [PetDrag]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120

  $deltaX = -260
  $deltaY = 140
  for ($step = 1; $step -le 14; $step++) {
    $x = $startX + [int]($deltaX * $step / 14)
    $y = $startY + [int]($deltaY * $step / 14)
    [PetDrag]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 30
  }
  Start-Sleep -Milliseconds 200

  # 还在按住时读一次位置：这才是拖动本身的结果。
  # 松手后走动线程会按"脚踩在地面上"重新校正高度，不能用来判断拖动是否生效。
  Find-PetWindow
  $after = $script:rect

  [PetDrag]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250

  $movedX = $after.Left - $before.Left
  $movedY = $after.Top - $before.Top

  Write-Output "attempt ${attempt}: before=($($before.Left),$($before.Top)) after=($($after.Left),$($after.Top)) dx=$movedX dy=$movedY"

  # 拖动方向是左下方，允许走动线程在拖动结束后继续微调
  if ($movedX -lt -60 -and $movedY -gt 30) { $passed = $true; break }

  # 重新定位角色，给下一次尝试留出时间
  Start-Sleep -Milliseconds 600
}

if ($passed) {
  Write-Output 'PASS: pet window follows the mouse drag'
  exit 0
}

Write-Output 'FAIL: pet window did not follow the drag'
exit 1
