param([Parameter(Mandatory=$true)][int]$Port)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "Port $Port is free."
  exit 0
}

foreach ($c in $conns) {
  $procId = $c.OwningProcess
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $name = if ($p) { $p.ProcessName } else { "unknown" }
  Write-Host "Killing PID $procId ($name) on port $Port"
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}
Write-Host "Done."
