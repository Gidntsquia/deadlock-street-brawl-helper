# Name reader helper: Windows.Media.Ocr over stdin/stdout, started hidden by electron/nameReader.ts.
# In:  one line per read, "<id> <width> <height> <base64 of width*height*4 RGBA bytes>".
# Out: one JSON line per read, {"id":n,"text":"...","ms":n}; first a {"ready":true,"ms":n,"lang":"..."} line once warm.
$ErrorActionPreference = 'Stop'
$sw0 = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0].MakeGenericMethod([Windows.Media.Ocr.OcrResult])
$lang = [Windows.Globalization.Language]::new('en-US')
if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) }
else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { [Console]::Out.WriteLine('{"fatal":"no-ocr-language"}'); [Console]::Out.Flush(); exit 3 }
$stdout = [Console]::Out
function Read-Rgba([int]$w, [int]$h, [byte[]]$bytes) {
  $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
  $rgba = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Rgba8, $w, $h)
  $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($rgba, [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8)
  $task = $asTask.Invoke($null, @($engine.RecognizeAsync($bmp)))
  $task.Wait() | Out-Null
  $rgba.Dispose()
  $bmp.Dispose()
  $task.Result
}
function Ms($sw) { [math]::Round($sw.Elapsed.TotalMilliseconds, 1).ToString([Globalization.CultureInfo]::InvariantCulture) }
# JSON string body, ASCII only: every control and non-ASCII character as \uXXXX, so the console code page cannot mangle it.
function Esc([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $s.ToCharArray()) {
    $n = [int]$c
    if ($c -eq '"') { [void]$sb.Append('\"') }
    elseif ($c -eq '\') { [void]$sb.Append('\\') }
    elseif ($n -lt 32 -or $n -gt 126) { [void]$sb.Append('\u' + $n.ToString('x4')) }
    else { [void]$sb.Append($c) }
  }
  $sb.ToString()
}
# Warm-up: one blank line with a few strokes, so the first real read does not pay the engine's start.
$ww = 160; $wh = 48; $warm = New-Object byte[] ($ww * $wh * 4)
for ($i = 0; $i -lt $warm.Length; $i++) { $warm[$i] = 255 }
for ($x = 14; $x -lt 140; $x += 9) { for ($y = 14; $y -lt 34; $y++) { foreach ($dx in 0, 1) { $o = ($y * $ww + $x + $dx) * 4; $warm[$o] = 0; $warm[$o + 1] = 0; $warm[$o + 2] = 0 } } }
$null = Read-Rgba $ww $wh $warm
$stdout.WriteLine('{"ready":true,"ms":' + [int]$sw0.Elapsed.TotalMilliseconds + ',"lang":"' + $engine.RecognizerLanguage.LanguageTag + '"}')
$stdout.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $parts = $line.Split(' ')
  $id = $parts[0]
  try {
    $r = Read-Rgba ([int]$parts[1]) ([int]$parts[2]) ([Convert]::FromBase64String($parts[3]))
    $stdout.WriteLine('{"id":' + $id + ',"text":"' + (Esc $r.Text) + '","ms":' + (Ms $sw) + '}')
  } catch {
    $stdout.WriteLine('{"id":' + $id + ',"text":"","ms":' + (Ms $sw) + ',"error":"' + (Esc $_.Exception.Message) + '"}')
  }
  $stdout.Flush()
}
