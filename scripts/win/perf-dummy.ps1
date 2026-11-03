# A small borderless black window titled exactly "Deadlock" that holds the foreground for -Seconds: the stand-in for a
# game with no draft on screen (the app finds it by title, probes it, sees no draft). Never the real game.
param([int]$Seconds = 120)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Deadlock'; $f.FormBorderStyle = 'None'; $f.BackColor = 'Black'
$f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(0, 0); $f.Size = New-Object System.Drawing.Size(640, 360)
$f.ShowInTaskbar = $false
$t = New-Object System.Windows.Forms.Timer; $t.Interval = $Seconds * 1000; $t.Add_Tick({ $f.Close() }); $t.Start()
$f.Add_Shown({ $f.Activate() })
[System.Windows.Forms.Application]::Run($f)
