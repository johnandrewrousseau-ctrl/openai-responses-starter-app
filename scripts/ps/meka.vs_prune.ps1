param(
  [string]$Base = "http://localhost:3000",
  [ValidateSet("threads","canon")][string]$Store = "threads"
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

$body = @{ store = $Store } | ConvertTo-Json
$headers = @{ Authorization = ("Bearer " + $token) }
$resp = Invoke-WebRequest "$Base/api/vs_prune" -Method Post -Headers $headers -ContentType "application/json" -Body $body -SkipHttpErrorCheck -TimeoutSec 120

if ($resp.StatusCode -ne 200) {
  Write-Host ("FAIL [vs_prune_{0}] status={1}" -f $Store, $resp.StatusCode)
  Write-Host $resp.Content
  exit 1
}

$obj = $resp.Content | ConvertFrom-Json
$failCount = @($obj.failures).Count
Write-Host ("PASS [vs_prune_{0}] detached={1} groups={2} failures={3}" -f $Store, $obj.detached, $obj.groups_with_dupes, $failCount)
if ($failCount -gt 0) { exit 2 }
exit 0
