# STATE_HEALTH_NO_EXIT_V1
Set-Location C:\meka\meka-ui

$spPath = ".\state\state_pack.json"
if (!(Test-Path $spPath)) {
  Write-Host "Missing: $spPath"
$global:LASTEXITCODE = 1; return
}

$sp = Get-Content $spPath -Raw -Encoding utf8 | ConvertFrom-Json

$metaUpdated = $sp.meta.updated_at
$rootUpdated = $sp.updated_at

Write-Host "state_pack.json"
Write-Host "  meta.updated_at: $metaUpdated"
Write-Host "  updated_at:      $rootUpdated"

$queue = $sp.queue
if ($null -eq $queue) {
  Write-Host "  queue: <missing>"
return
}

$keys = @($queue.PSObject.Properties.Name)

Write-Host "  queue keys: $($keys -join ', ')"

function Count-Any($v) {
  if ($null -eq $v) { return 0 }
  if ($v -is [System.Array]) { return @($v).Count }
  # treat scalars/objects as 1
  return 1
}

foreach ($k in $keys) {
  $cnt = Count-Any $queue.$k
  Write-Host ("    {0,-16} {1,6}" -f $k, $cnt)
}

$expected = @("now","next","parked")
$unexpected = $keys | Where-Object { $_ -notin $expected }

if (@($unexpected).Count -gt 0) {
  Write-Host "  WARN unexpected queue keys: $($unexpected -join ', ')"
  foreach ($k in $unexpected) {
    $cnt = Count-Any $queue.$k
    if ($cnt -gt 0) {
      Write-Host "  WARN unexpected key has data: $k (count=$cnt)"
    }
  }
}


