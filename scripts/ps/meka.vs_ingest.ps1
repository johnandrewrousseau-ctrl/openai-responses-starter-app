param(
  [string]$Base = "http://localhost:3000",
  [ValidateSet("threads","canon")][string]$Store = "threads",
  [switch]$Replace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

Set-Location C:\meka\meka-ui
$Root = (Resolve-Path ".").Path
$token = $env:MEKA_ADMIN_TOKEN
if (-not $token) {
  $token = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
}
if (-not $token) {
  throw "MEKA_ADMIN_TOKEN missing (set env var or .env.local)"
}

$body = @{
  store = $Store
  replace = [bool]$Replace.IsPresent
  reconcile = $true
} | ConvertTo-Json

$headers = @{ Authorization = ("Bearer " + $token) }
$resp = Invoke-WebRequest "$Base/api/vs_ingest" -Method Post -Headers $headers -ContentType "application/json" -Body $body -SkipHttpErrorCheck -TimeoutSec 120

if ($resp.StatusCode -ne 200) {
  Write-Host ("FAIL [vs_ingest_http] status={0}" -f $resp.StatusCode)
  Write-Host $resp.Content
  exit 1
}

$obj = $resp.Content | ConvertFrom-Json
$failCount = @($obj.failures).Count
if ($obj.ok -ne $true) {
  Write-Host "FAIL [vs_ingest_ok_false]"
  Write-Host $resp.Content
  exit 1
}

Write-Host ("PASS [vs_ingest_{0}] scanned={1} uploaded={2} attached={3} skipped={4} replaced={5} failures={6}" -f $Store, $obj.scanned, $obj.uploaded, $obj.attached, $obj.skipped, $obj.replaced, $failCount)
if ($failCount -gt 0) {
  $obj.failures | ForEach-Object { Write-Host ("FAILURE {0}: {1}" -f $_.file, $_.error) }
  exit 2
}

exit 0
