$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$port = 3001
$url = "http://localhost:$port/"
$health = "http://localhost:$port/api/health"
$logDir = Join-Path $PSScriptRoot "logs"
$logFile = Join-Path $logDir "java-backend.log"

if (!(Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (!(Test-Health)) {
  Start-Process powershell `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "Set-Location '$PSScriptRoot'; .\start-java.ps1 *> '$logFile'"
    )

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Health) {
      $ok = $true
      break
    }
  }

  if (!$ok) {
    Start-Process notepad $logFile
    throw "Java 后端启动失败，已打开日志：$logFile"
  }
}

Start-Process $url
Write-Host "Java 版网站已打开：$url"
