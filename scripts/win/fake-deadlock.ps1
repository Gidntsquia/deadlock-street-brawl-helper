# Opens (or, with -Stop, closes) a 1920x1080 window titled exactly "Deadlock" with a solid magenta
# (#FF00FF) background - the game stand-in for the e2e harness (item 3's not-self / capture-found checks
# sample this exact colour). Never touches any window it did not itself create: -Stop only ever acts on
# the pid recorded in the pid file, and only after confirming that pid is still a powershell process with
# main window title "Deadlock" (i.e. still this script's own window, not some unrelated process that reused
# the pid).
# ASCII only in this file: Windows PowerShell 5.1's default script encoding mangles non-ASCII bytes
# (em dashes, curly quotes) into parser errors.
param(
  [switch]$Stop,
  [string]$Image
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Make this process DPI-aware so Bounds/PointToScreen below return physical pixels, matching what
# koffi's GetWindowRect sees in the real app (electron/gameWindow.ts) - not DIPs scaled by Windows.
# Also brings in SetWindowPos/ShowWindow so the window can be dropped to the bottom of the z-order
# without ever taking focus - desktopCapturer/getDisplayMedia capture a window's content directly from
# its handle regardless of z-order or visibility, so the harness doesn't need this window on top, and
# leaving it (and the app windows) behind whatever the person is already doing keeps the e2e run out of
# their way.
Add-Type @"
using System.Runtime.InteropServices;
public class NativeDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
}
"@
[void][NativeDpi]::SetProcessDPIAware()
$HWND_BOTTOM = [System.IntPtr]0
$SWP_NOMOVE = 0x2
$SWP_NOSIZE = 0x1
$SWP_NOACTIVATE = 0x10
$SW_SHOWNOACTIVATE = 4

$pidFile = Join-Path $env:TEMP 'brawl-fake-deadlock.pid'

if ($Stop) {
  if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'powershell' -and $proc.MainWindowTitle -eq 'Deadlock') {
      Stop-Process -Id $procId -ErrorAction SilentlyContinue
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
  exit 0
}

# Guard against colliding with a real Deadlock game window before opening the fake one.
$existing = Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' }
if ($existing) {
  Write-Error "A window titled 'Deadlock' already exists (pid $($existing.Id)) - close the real game before running the harness."
  exit 1
}

# Borderless: a real Deadlock window is a borderless fullscreen-style window with no title bar, so its
# window rect equals its client rect. desktopCapturer/getDisplayMedia (Chromium's Windows Graphics Capture)
# captures a window's *full bounds*, chrome included -- with FormBorderStyle other than None, that meant the
# captured frame included ~38px of title bar the recogniser's frame-px anchors never accounted for, silently
# shifting every anchor down and breaking icon matching on this frame only (found via item 3's frames case).
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Deadlock'
$form.ClientSize = New-Object System.Drawing.Size(1920, 1080)
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(0, 0)
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $true

# The frame is scaled ONCE, up front, into a client-sized bitmap and set as the form's BackgroundImage, so
# every repaint is a native blit. The earlier version scaled the 2000x1125 PNG with HighQualityBicubic
# inside a PowerShell Paint scriptblock on every WM_PAINT: slow enough that the window sat unpainted (seen
# on screen as a blank dark gradient, and by the app as a frame with no cards) whenever a repaint landed
# mid-run. HighQualityBicubic is still required: GDI's default stretch blurs the card icons past what the
# recogniser's icon matcher accepts.
if ($Image) {
  if (-not (Test-Path $Image)) {
    Write-Error "Image not found: $Image"
    exit 1
  }
  $src = [System.Drawing.Image]::FromFile((Resolve-Path $Image))
  $scaled = New-Object System.Drawing.Bitmap 1920, 1080
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, 1920, 1080)
  $g.Dispose()
  $src.Dispose()
  $form.BackgroundImage = $scaled
  $form.BackgroundImageLayout = 'None'
}

[System.IO.File]::WriteAllText($pidFile, [string]$PID)

$form.Add_Shown({
  $clientTopLeft = $form.PointToScreen([System.Drawing.Point]::Empty)
  $info = @{
    pid = $PID
    client = @{ x = $clientTopLeft.X; y = $clientTopLeft.Y; width = $form.ClientSize.Width; height = $form.ClientSize.Height }
    window = @{ x = $form.Bounds.X; y = $form.Bounds.Y; width = $form.Bounds.Width; height = $form.Bounds.Height }
  }
  [Console]::Out.WriteLine(($info | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  # Never steal focus, and drop to the bottom of the z-order so it doesn't sit on top of whatever
  # windows the person already has open - the harness reads this window's pixels directly, not off the
  # screen, so it doesn't need to be visible on top to be captured correctly.
  [void][NativeDpi]::ShowWindow($form.Handle, $SW_SHOWNOACTIVATE)
  [void][NativeDpi]::SetWindowPos($form.Handle, $HWND_BOTTOM, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
})
$form.WindowState = 'Normal'
[System.Windows.Forms.Application]::Run($form)
