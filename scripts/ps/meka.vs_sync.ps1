Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui

function Read-EnvValue {
  param([string]$EnvPath, [string]$Key)
  if (-not (Test-Path $EnvPath)) { return "" }

  $raw = Get-Content -Path $EnvPath -Raw
  if (-not $raw) { return "" }

  $pattern = "^\s*(export\s+)?"+ [regex]::Escape($Key) + "\s*=\s*(.+)\s*$"
  $m = [regex]::Match($raw, $pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if (-not $m.Success) { return "" }

  $val = $m.Groups[2].Value.Trim()
  if ($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  if ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  return $val
}

$Root = (Resolve-Path ".").Path
$token = $env:MEKA_ADMIN_TOKEN
if (-not $token) {
  $token = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
}
if (-not $token) {
  throw "MEKA_ADMIN_TOKEN missing (set env var or .env.local)"
}

function Invoke-Ingest($store) {
  $body = @{ store = $store; replace = $true; reconcile = $true } | ConvertTo-Json
  $headers = @{ Authorization = ("Bearer " + $token) }
  $resp = Invoke-WebRequest "http://localhost:3000/api/vs_ingest" -Method Post -Headers $headers -ContentType "application/json" -Body $body -SkipHttpErrorCheck -TimeoutSec 120
  if ($resp.StatusCode -ne 200) {
    Write-Host ("FAIL [vs_ingest_{0}_http] status={1}" -f $store, $resp.StatusCode)
    Write-Host $resp.Content
    return @{ ok = $false; failures = @("http_error") }
  }
  $obj = $resp.Content | ConvertFrom-Json
  $failCount = @($obj.failures).Count
  Write-Host ("{0} store_id={1} source_dir={2} scanned={3} uploaded={4} attached={5} skipped={6} replaced={7} failures={8}" -f $store, $obj.vector_store_id, $obj.source_dir, $obj.scanned, $obj.uploaded, $obj.attached, $obj.skipped, $obj.replaced, $failCount)
  return $obj
}

$t = Invoke-Ingest "threads"
$c = Invoke-Ingest "canon"

$invT = Invoke-WebRequest "http://localhost:3000/api/vs_inventory?store=threads&include_filenames=1" -Method Get -SkipHttpErrorCheck -TimeoutSec 30
$invC = Invoke-WebRequest "http://localhost:3000/api/vs_inventory?store=canon&include_filenames=1" -Method Get -SkipHttpErrorCheck -TimeoutSec 30

if ($invT.StatusCode -eq 200 -and $invC.StatusCode -eq 200) {
  $tInv = ($invT.Content | ConvertFrom-Json).threads
  $cInv = ($invC.Content | ConvertFrom-Json).canon
  Write-Host ("threads files_total={0} | canon files_total={1}" -f $tInv.files_total, $cInv.files_total)
} else {
  Write-Host ("inventory check failed: threads={0} canon={1}" -f $invT.StatusCode, $invC.StatusCode)
}

$tFail = @($t.failures).Count
$cFail = @($c.failures).Count
if ($t.ok -eq $true -and $c.ok -eq $true -and $tFail -eq 0 -and $cFail -eq 0) { exit 0 }
exit 1
