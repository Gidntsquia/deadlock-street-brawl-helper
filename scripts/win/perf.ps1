# Idle cost of an installed or portable build: launches it, lets it settle, samples CPU, GPU and windows.
# Usage: powershell -File perf.ps1 -Exe <path> -Label <name> -Out <json> [-Settle 25] [-Seconds 60]
param([string]$Exe, [string]$Label, [string]$Out, [int]$Settle = 25, [int]$Seconds = 60)
$dummy = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'perf-dummy.ps1'),'-Seconds',($Settle + $Seconds + 40) -PassThru
Start-Sleep -Seconds 3
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Visible(HashSet<uint> pids) {
    var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p) && IsWindowVisible(h)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); RECT r; GetWindowRect(h, out r);
        o.Add(p + "|" + s + "|" + (r.R - r.L) + "x" + (r.B - r.T)); } return true; }, IntPtr.Zero);
    return o; }
}
'@
$ncpu = [Environment]::ProcessorCount
$dir = Split-Path $Exe
$p = Start-Process -FilePath $Exe -PassThru
$dummyRect = $null
$rootName = [IO.Path]::GetFileNameWithoutExtension($Exe)
function AppProcs {
  # the launched exe and every descendant (renderers, GPU process, OCR helper)
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $ids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  $roots = @(Get-Process -Name $rootName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  foreach ($r in $roots) { [void]$ids.Add($r) }
  do { $n = $ids.Count; foreach ($q in $all) { if ($ids.Contains([uint32]$q.ParentProcessId)) { [void]$ids.Add([uint32]$q.ProcessId) } } } while ($ids.Count -ne $n)
  return $ids
}
Start-Sleep -Seconds $Settle
function CpuSec($ids) { $t = 0.0; foreach ($i in $ids) { $pr = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($pr) { $t += $pr.TotalProcessorTime.TotalSeconds } }; return $t }
$ids = AppProcs
$c0 = CpuSec $ids; $t0 = Get-Date
$gpu = @(); $sys = @()
$end = $t0.AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  try {
    $c = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples
    $sum = 0.0; foreach ($s in $c) { foreach ($i in $ids) { if ($s.InstanceName -like "pid_${i}_*") { $sum += $s.CookedValue } } }
    $gpu += $sum
  } catch { $gpu += -1 }
  $sys += (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples[0].CookedValue
  Start-Sleep -Seconds 3
}
$c1 = CpuSec $ids; $t1 = Get-Date
$wall = ($t1 - $t0).TotalSeconds
$pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'; foreach ($i in $ids) { [void]$pidSet.Add($i) }
$vis = [W]::Visible($pidSet)
$mem = 0; foreach ($i in $ids) { $pr = Get-Process -Id $i -ErrorAction SilentlyContinue; if ($pr) { $mem += $pr.WorkingSet64 } }
$res = [ordered]@{
  label = $Label; exe = $Exe; processes = $ids.Count; wall_s = [math]::Round($wall, 1)
  cpu_percent_of_machine = [math]::Round(100 * ($c1 - $c0) / $wall / $ncpu, 3)
  cpu_percent_of_one_core = [math]::Round(100 * ($c1 - $c0) / $wall, 3)
  gpu_percent_max = [math]::Round(($gpu | Measure-Object -Maximum).Maximum, 3)
  gpu_percent_mean = [math]::Round(($gpu | Measure-Object -Average).Average, 3)
  game_window = 'Deadlock-titled dummy, black, no draft, foreground'
  visible_windows = @($vis)
  working_set_mb = [math]::Round($mem / 1MB, 1)
  machine_cpu_percent_mean = [math]::Round(($sys | Measure-Object -Average).Average, 1)
  logical_cpus = $ncpu
  at = (Get-Date).ToString('o')
}
Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue
# stop everything the launch started
foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }
$res | ConvertTo-Json -Depth 4 | Set-Content -Path $Out -Encoding utf8
