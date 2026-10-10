# Reads every PNG listed in <dir>/index.json with Windows.Media.Ocr; writes <dir>/out.json [{file,text,ms}].
param([string]$Dir)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]
function Await($op,$t){$m=$asTask.MakeGenericMethod($t);$k=$m.Invoke($null,@($op));$k.Wait()|Out-Null;$k.Result}
$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$idx=Get-Content "$Dir\index.json" -Raw|ConvertFrom-Json
$out=@()
foreach($i in $idx){
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync("$Dir\$($i.file)")) ([Windows.Storage.StorageFile])
  $s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $b=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $r=Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
  $out+=[pscustomobject]@{file=$i.file;text=$r.Text;ms=$sw.Elapsed.TotalMilliseconds}
}
$out|ConvertTo-Json -Compress|Set-Content "$Dir\out.json" -Encoding utf8
"done $($out.Count)"
