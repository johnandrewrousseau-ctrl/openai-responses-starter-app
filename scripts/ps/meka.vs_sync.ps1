Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui

pwsh .\scripts\ps\meka.vs_ingest.ps1 -Store threads
$ec1 = $LASTEXITCODE
pwsh .\scripts\ps\meka.vs_ingest.ps1 -Store canon -Replace
$ec2 = $LASTEXITCODE

$invT = Invoke-WebRequest "http://localhost:3000/api/vs_inventory?store=threads&include_filenames=1" -Method Get -SkipHttpErrorCheck -TimeoutSec 30
$invC = Invoke-WebRequest "http://localhost:3000/api/vs_inventory?store=canon&include_filenames=1" -Method Get -SkipHttpErrorCheck -TimeoutSec 30

if ($invT.StatusCode -eq 200 -and $invC.StatusCode -eq 200) {
  $t = ($invT.Content | ConvertFrom-Json).threads
  $c = ($invC.Content | ConvertFrom-Json).canon
  Write-Host ("threads files_total={0} | canon files_total={1}" -f $t.files_total, $c.files_total)
} else {
  Write-Host ("inventory check failed: threads={0} canon={1}" -f $invT.StatusCode, $invC.StatusCode)
}

if ($ec1 -eq 0 -and $ec2 -eq 0) { exit 0 }
exit 1
