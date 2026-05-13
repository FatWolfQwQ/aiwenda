param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$MaxPages = 80
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1)
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1)

function Await-Operation($Operation, [type]$ResultType) {
  $task = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Await-Action($Operation) {
  $task = $asTaskAction.Invoke($null, @($Operation))
  $task.GetAwaiter().GetResult() | Out-Null
}

function Get-OcrTextFromBitmap($Bitmap, $Engine) {
  $result = Await-Operation ($Engine.RecognizeAsync($Bitmap)) ([Windows.Media.Ocr.OcrResult])
  return $result.Text
}

function Get-OcrTextFromImageFile($File, $Engine) {
  $stream = Await-Operation ($File.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  try {
    $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    return Get-OcrTextFromBitmap $bitmap $Engine
  } finally {
    if ($stream -ne $null) { $stream.Dispose() }
  }
}

function Get-OcrTextFromPdfFile($File, $Engine, [int]$MaxPages) {
  $pdf = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($File)) ([Windows.Data.Pdf.PdfDocument])
  $count = [Math]::Min([int]$pdf.PageCount, $MaxPages)
  $texts = New-Object System.Collections.Generic.List[string]

  for ($i = 0; $i -lt $count; $i++) {
    $page = $pdf.GetPage([uint32]$i)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    try {
      $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $options.DestinationWidth = [uint32]([Math]::Max(1, [Math]::Round($page.Size.Width * 2.5)))
      $options.DestinationHeight = [uint32]([Math]::Max(1, [Math]::Round($page.Size.Height * 2.5)))
      Await-Action ($page.RenderToStreamAsync($stream, $options))
      $stream.Seek(0) | Out-Null
      $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $text = Get-OcrTextFromBitmap $bitmap $Engine
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        $texts.Add("第 $($i + 1) 页`n$text")
      }
    } finally {
      if ($page -ne $null) { $page.Dispose() }
      if ($stream -ne $null) { $stream.Dispose() }
    }
  }

  return ($texts -join "`n`n")
}

if (-not (Test-Path -LiteralPath $Path)) {
  throw "文件不存在：$Path"
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  throw '当前系统没有可用 OCR 语言包，请在 Windows 设置中安装中文 OCR/语言包。'
}

$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Path).Path)) ([Windows.Storage.StorageFile])
$ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()

if ($ext -eq '.pdf') {
  $text = Get-OcrTextFromPdfFile $file $engine $MaxPages
} else {
  $text = Get-OcrTextFromImageFile $file $engine
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Write($text)
