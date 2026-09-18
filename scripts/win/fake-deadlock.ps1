# Opens (or, with -Stop, closes) a 1280x720 window titled exactly "Deadlock" with a solid magenta
# (#FF00FF) background - the game stand-in for the e2e harness (item 3's not-self / capture-found checks
# sample this exact colour). Never touches any other window.
# ASCII only in this file: Windows PowerShell 5.1's default script encoding mangles non-ASCII bytes
# (em dashes, curly quotes) into parser errors.
param(
  [switch]$Stop
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutexName = 'BrawlHelperFakeDeadlock'
$pidFile = Join-Path $env:TEMP 'brawl-fake-deadlock.pid'

if ($Stop) {
  if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile
    Stop-Process -Id $procId -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
  # Belt-and-braces: also close by exact title, in case the pid file is stale.
  Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' } | Stop-Process -ErrorAction SilentlyContinue
  exit 0
}

# Guard against colliding with a real Deadlock game window before opening the fake one.
$existing = Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' }
if ($existing) {
  Write-Error "A window titled 'Deadlock' already exists (pid $($existing.Id)) - close the real game before running the harness."
  exit 1
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Deadlock'
$form.ClientSize = New-Object System.Drawing.Size(1280, 720)
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(0, 0)
$form.FormBorderStyle = 'Sizable'

[System.IO.File]::WriteAllText($pidFile, [string]$PID)
$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
