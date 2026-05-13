$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceScript = Join-Path $projectRoot '启动服务-隐藏.ps1'
$url = 'http://localhost:3000'

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $serviceScript

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if (-not $ready) {
  throw '网站后端启动超时，请确认 Node.js 已安装且端口 3000 没有被占用。'
}

Start-Process $url
