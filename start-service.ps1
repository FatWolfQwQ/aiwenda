$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3000

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  exit 0
}

Set-Location $projectRoot
Start-Process -FilePath 'node' -ArgumentList 'server\index.js' -WorkingDirectory $projectRoot -WindowStyle Hidden
