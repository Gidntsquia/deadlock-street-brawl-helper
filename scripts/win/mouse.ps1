# Reads the pointer settings that decide mouse feel, for one phase (closed / open / overlay). Prints one JSON object.
# SPI_GETMOUSE (threshold1, threshold2, acceleration), SPI_GETMOUSESPEED, the registry copies, raw input device count,
# system DPI, and the DPI awareness of every process whose name is given in -Names (the app under test).
param([string]$Phase, [string]$NamesCsv = '')
$Names = @($NamesCsv -split ',' | Where-Object { $_ })
Add-Type @'
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint p, int[] v, uint f);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint p, ref int v, uint f);
  [DllImport("user32.dll")] public static extern uint GetRawInputDeviceList(IntPtr l, ref uint n, uint sz);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(IntPtr h, out int a);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint acc, bool inh, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  public static string[] Visible(int[] pids) {
    var o = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(pids, (int)p) >= 0 && IsWindowVisible(h)) { var s = new System.Text.StringBuilder(256); GetWindowText(h, s, 256);
        o.Add(s.ToString() + "|exstyle=" + (GetWindowLong(h, -20) & 0x80020).ToString("X")); } return true; }, IntPtr.Zero);
    return o.ToArray(); }
}
'@
$m = New-Object 'int[]' 3; [void][M]::SystemParametersInfo(0x0003, 0, $m, 0)
$sp = 0; [void][M]::SystemParametersInfo(0x0070, 0, [ref]$sp, 0)
$n = [uint32]0; [void][M]::GetRawInputDeviceList([IntPtr]::Zero, [ref]$n, [uint32]16)
$reg = Get-ItemProperty 'HKCU:\Control Panel\Mouse'
$aware = @(); $pids = @()
foreach ($name in $Names) {
  foreach ($pr in Get-Process -Name $name -ErrorAction SilentlyContinue) {
    $pids += $pr.Id
    $h = [M]::OpenProcess(0x1000, $false, $pr.Id)
    if ($h -ne [IntPtr]::Zero) { $a = -1; [void][M]::GetProcessDpiAwareness($h, [ref]$a); [void][M]::CloseHandle($h); $aware += "$($pr.ProcessName):$a" }
  }
}
[ordered]@{
  phase = $Phase
  spi_getmouse_threshold1 = $m[0]; spi_getmouse_threshold2 = $m[1]; spi_getmouse_acceleration_pointer_precision = $m[2]
  spi_getmousespeed = $sp
  registry = [ordered]@{ MouseSpeed = $reg.MouseSpeed; MouseThreshold1 = $reg.MouseThreshold1; MouseThreshold2 = $reg.MouseThreshold2; MouseSensitivity = $reg.MouseSensitivity }
  raw_input_devices = $n
  system_dpi = [M]::GetDpiForSystem()
  cursor_size_px = [M]::GetSystemMetrics(13)
  app_process_dpi_awareness = @($aware | Sort-Object -Unique)
  visible_app_windows = @([M]::Visible([int[]]$pids))
} | ConvertTo-Json -Compress
