# 检测角色窗口是否周期性"消失又出现"。
#
# 做法：在角色窗口内取一个网格点阵，从屏幕（合成后的桌面）连续抓取这些点的颜色。
# 对每个点取时间中位数作为"稳定背景/角色"的参考，然后逐帧统计偏离中位数的点比例。
# 角色整块消失的那一帧，几乎所有落在角色上的采样点都会突变，比例会明显跳高。
#
# 用法：pwsh -File measure-pet-flicker.ps1 -Seconds 10 -Hz 12
param(
  [double]$Seconds = 10,
  [double]$Hz = 12,
  [int]$Grid = 34
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PetFlickerEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = @(Get-Process -Name 'companion-desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($targets.Count -eq 0) {
  Write-Output 'FAIL: companion-desktop is not running'
  exit 1
}

function Get-PetRect {
  $script:rect = $null
  $callback = [PetFlickerEnum+EnumWindowsProc] {
    param($handle, $param)
    $owner = [uint32]0
    [PetFlickerEnum]::GetWindowThreadProcessId($handle, [ref]$owner) | Out-Null
    if ($targets -contains [int]$owner) {
      $r = [PetFlickerEnum+RECT]::new()
      [PetFlickerEnum]::GetWindowRect($handle, [ref]$r) | Out-Null
      $w = $r.Right - $r.Left
      $h = $r.Bottom - $r.Top
      if ([PetFlickerEnum]::IsWindowVisible($handle) -and $w -gt 100 -and $w -lt 900 -and $h -gt 150 -and $h -lt 1200) {
        $script:rect = [pscustomobject]@{ Left = $r.Left; Top = $r.Top; Width = $w; Height = $h; Handle = $handle }
      }
    }
    return $true
  }
  [PetFlickerEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $script:rect
}

$frames = [System.Collections.Generic.List[object]]::new()
$intervalMs = [int](1000 / $Hz)
$count = [int]($Seconds * $Hz)

for ($index = 0; $index -lt $count; $index++) {
  $pet = Get-PetRect
  if (-not $pet) {
    $frames.Add([pscustomobject]@{ Index = $index; Missing = $true; Width = 0; Height = 0; Points = $null })
    Start-Sleep -Milliseconds $intervalMs
    continue
  }

  # 采样点避开窗口边缘：只取中间 72% 的区域，这里才可能有角色
  $x0 = $pet.Left + $pet.Width * 0.14
  $y0 = $pet.Top + $pet.Height * 0.14
  $spanX = $pet.Width * 0.72
  $spanY = $pet.Height * 0.72

  $bitmap = New-Object System.Drawing.Bitmap $pet.Width, $pet.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  # 桌宠窗口可能有一部分在屏幕外，CopyFromScreen 会抓不到；PrintWindow
  # 只复制窗口自身图层，因此也能在窗口靠近屏幕边缘时检测角色是否消失。
  $printed = [PetFlickerEnum]::PrintWindow($pet.Handle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  if (-not $printed) {
    $graphics.CopyFromScreen($pet.Left, $pet.Top, 0, 0, $bitmap.Size)
  }
  $graphics.Dispose()

  $points = New-Object 'int[]' ($Grid * $Grid * 3)
  $cursor = 0
  for ($gy = 0; $gy -lt $Grid; $gy++) {
    for ($gx = 0; $gx -lt $Grid; $gx++) {
      $px = [int]($x0 + $spanX * $gx / ($Grid - 1)) - $pet.Left
      $py = [int]($y0 + $spanY * $gy / ($Grid - 1)) - $pet.Top
      $px = [Math]::Min([Math]::Max($px, 0), $pet.Width - 1)
      $py = [Math]::Min([Math]::Max($py, 0), $pet.Height - 1)
      $color = $bitmap.GetPixel($px, $py)
      $points[$cursor] = $color.R
      $points[$cursor + 1] = $color.G
      $points[$cursor + 2] = $color.B
      $cursor += 3
    }
  }
  $bitmap.Dispose()

  $frames.Add([pscustomobject]@{ Index = $index; Missing = $false; Width = $pet.Width; Height = $pet.Height; Points = $points })
  Start-Sleep -Milliseconds $intervalMs
}

$valid = $frames | Where-Object { -not $_.Missing }
if ($valid.Count -lt 5) {
  Write-Output "FAIL: 只抓到 $($valid.Count) 帧有效画面"
  exit 1
}

$pointCount = $Grid * $Grid
$median = New-Object 'int[]' ($pointCount * 3)
for ($point = 0; $point -lt $pointCount; $point++) {
  foreach ($channel in 0, 1, 2) {
    $values = $valid | ForEach-Object { $_.Points[$point * 3 + $channel] } | Sort-Object
    $median[$point * 3 + $channel] = $values[[int]($values.Count / 2)]
  }
}

$rows = foreach ($frame in $frames) {
  if ($frame.Missing) {
    [pscustomobject]@{ Index = $frame.Index; Size = 'MISSING'; Deviation = 1.0; Ink = 0.0 }
    continue
  }
  $deviating = 0
  # "ink"：与这一帧自己的众数颜色差别较大的采样点比例。
  # 角色占窗口很大一块，角色渲染出来时 ink 高；整块没渲染出来时会骤降。
  $histogram = @{}
  for ($point = 0; $point -lt $pointCount; $point++) {
    $key = [int]($frame.Points[$point * 3] / 16) * 256 + [int]($frame.Points[$point * 3 + 1] / 16) * 16 + [int]($frame.Points[$point * 3 + 2] / 16)
    if ($histogram.ContainsKey($key)) { $histogram[$key]++ } else { $histogram[$key] = 1 }
  }
  $modeKey = ($histogram.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
  $modeR = [int]($modeKey / 256) * 16 + 8
  $modeG = ([int]($modeKey / 16) % 16) * 16 + 8
  $modeB = ($modeKey % 16) * 16 + 8
  $inked = 0

  for ($point = 0; $point -lt $pointCount; $point++) {
    $r = $frame.Points[$point * 3]
    $g = $frame.Points[$point * 3 + 1]
    $b = $frame.Points[$point * 3 + 2]
    $delta = [Math]::Abs($r - $median[$point * 3]) +
      [Math]::Abs($frame.Points[$point * 3 + 1] - $median[$point * 3 + 1]) +
      [Math]::Abs($frame.Points[$point * 3 + 2] - $median[$point * 3 + 2])
    if ($delta -gt 70) { $deviating++ }
    if (([Math]::Abs($r - $modeR) + [Math]::Abs($g - $modeG) + [Math]::Abs($b - $modeB)) -gt 70) { $inked++ }
  }
  [pscustomobject]@{
    Index = $frame.Index
    Size = "$($frame.Width)x$($frame.Height)"
    Deviation = [math]::Round($deviating / $pointCount, 4)
    Ink = [math]::Round($inked / $pointCount, 4)
  }
}

$deviations = $rows | ForEach-Object { $_.Deviation }
$sorted = $deviations | Sort-Object
$medianDeviation = $sorted[[int]($sorted.Count / 2)]
$peak = ($deviations | Measure-Object -Maximum).Maximum
$sizes = ($rows | ForEach-Object { $_.Size } | Sort-Object -Unique) -join ', '

Write-Output "frames=$($rows.Count) valid=$($valid.Count) sizes=[$sizes]"
Write-Output "median deviation ratio=$medianDeviation peak=$peak"
$inks = $rows | ForEach-Object { $_.Ink }
$inkStats = $inks | Measure-Object -Minimum -Maximum -Average
Write-Output ("ink: min={0} max={1} avg={2}" -f $inkStats.Minimum, $inkStats.Maximum, [math]::Round($inkStats.Average, 4))
Write-Output ''
Write-Output 'deviation time series (each line = one frame):'
$line = ''
foreach ($row in $rows) {
  $marker = if ($row.Deviation -gt 0.55) { ' <== 大面积变化' } elseif ($row.Deviation -gt 0.35) { ' <-- 明显变化' } else { '' }
  $line = '{0,4} {1,-10} dev={2,6} ink={3,6}{4}' -f $row.Index, $row.Size, $row.Deviation, $row.Ink, $marker
  Write-Output $line
}

$spikes = @($rows | Where-Object { $_.Deviation -gt 0.55 })
Write-Output ''
Write-Output "spike frames (>0.55): $($spikes.Count)"
