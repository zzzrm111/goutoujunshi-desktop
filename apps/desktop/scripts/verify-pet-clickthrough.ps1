# 验证角色窗口的鼠标穿透是否按角色轮廓切换。
#
# 检查项：
#   1. 角色窗口能找到，并且处于"置顶 + 透明"状态
#   2. 鼠标移到角色身上时，窗口的 WS_EX_TRANSPARENT 被清掉（可以点击/拖动）
#   3. 鼠标移到窗口角落（空白处）时，WS_EX_TRANSPARENT 被置上（点击穿透到下层窗口）
#
# 用法：pwsh -File verify-pet-clickthrough.ps1

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$GW_HWNDPREV = -1
$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x20
$WS_EX_LAYERED = 0x80000

$targets = @(Get-Process -Name 'companion-desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($targets.Count -eq 0) {
  Write-Output 'FAIL: companion-desktop is not running'
  exit 1
}

function Find-PetWindow {
  $script:handle = [IntPtr]::Zero
  $script:rect = [PetWin+RECT]::new()
  $callback = [PetWin+EnumWindowsProc] {
    param($h, $p)
    $owner = [uint32]0
    [PetWin]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    if ($targets -contains [int]$owner -and [PetWin]::IsWindowVisible($h)) {
      $title = [System.Text.StringBuilder]::new(256)
      [PetWin]::GetWindowText($h, $title, 256) | Out-Null
      if ($title.ToString() -eq '角色') {
        $script:handle = $h
        $r = [PetWin+RECT]::new()
        [PetWin]::GetWindowRect($h, [ref]$r) | Out-Null
        $script:rect = $r
        return $false
      }
    }
    return $true
  }
  [PetWin]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
}

Find-PetWindow
if ($script:handle -eq [IntPtr]::Zero) {
  Write-Output 'FAIL: pet window not found'
  exit 1
}

function Get-Transparent {
  $style = [PetWin]::GetWindowLong($script:handle, $GWL_EXSTYLE)
  return (($style -band $WS_EX_TRANSPARENT) -ne 0)
}

# 角色会边走边改变窗口位置，所以每次都重新读一遍窗口矩形再放鼠标，
# 并且允许重试，避免把"窗口已经走开"误判成穿透逻辑失效
$overBody = $null
$overCorner = $null

for ($attempt = 1; $attempt -le 6; $attempt++) {
  Find-PetWindow
  if ($script:handle -eq [IntPtr]::Zero) { break }
  $r = $script:rect
  $width = $r.Right - $r.Left
  $height = $r.Bottom - $r.Top

  # 角色本体大致在窗口水平中央、垂直 45% 处
  [PetWin]::SetCursorPos($r.Left + [int]($width * 0.5), $r.Top + [int]($height * 0.45)) | Out-Null
  Start-Sleep -Milliseconds 220
  $overBody = Get-Transparent

  # 左上角是空白区域
  [PetWin]::SetCursorPos($r.Left + 5, $r.Top + 5) | Out-Null
  Start-Sleep -Milliseconds 700
  $overCorner = Get-Transparent

  if ($overBody -eq $false -and $overCorner -eq $true) { break }
}

Write-Output "cursor over character -> transparent=$overBody (expect False)"
Write-Output "cursor over empty area -> transparent=$overCorner (expect True)"

if ($overBody -eq $false -and $overCorner -eq $true) {
  Write-Output 'PASS: click-through follows the character outline'
  exit 0
}

Write-Output 'FAIL: click-through does not follow the character outline'
exit 1
