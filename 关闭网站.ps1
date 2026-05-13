$ErrorActionPreference = 'SilentlyContinue'
$port = 3000
$connections = Get-NetTCPConnection -LocalPort $port -State Listen
foreach ($connection in $connections) {
  Stop-Process -Id $connection.OwningProcess -Force
}
