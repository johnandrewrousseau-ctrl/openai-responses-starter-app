param(
  [string]$Base = "http://localhost:3000",
  [string]$Store = "all",
  [string]$Query = "drift countermeasure",
  [int]$Limit = 5,
  [string]$OutPath = ".\\meka\\out\\vs_audit.json",
  [switch]$Names
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

function Print-StoreSummary {
  param([string]$Name, [object]$Obj)
  if (-not $Obj) { return }

  $id = $Obj.vector_store_id
  $total = $Obj.files_total
  $pages = $Obj.pages_fetched
  $snap = $Obj.snapshot_sha256
  $resolved = $Obj.filenames_resolved
  $missing = $Obj.filenames_missing
  $capped = $Obj.filenames_resolution_capped
  Write-Host ("{0}: {1} (files_total={2}, pages_fetched={3})" -f $Name, $id, $total, $pages)
  if ($snap) { Write-Host ("snapshot_sha256: " + $snap) }
  if ($null -ne $resolved -or $null -ne $missing) {
    Write-Host ("filenames_resolved={0} filenames_missing={1} capped={2}" -f $resolved, $missing, $capped)
  }

  $hits = @()
  if ($Obj.search_probe -and $Obj.search_probe.results) {
    foreach ($r in $Obj.search_probe.results) {
      $fid = $r.file_id
      if ($fid) { $hits += $fid }
    }
  }

  if ($hits.Count -gt 0) {
    $uniq = $hits | Select-Object -Unique
    Write-Host ("top probe hits: " + ($uniq -join ", "))
  }

  $names = @($Obj.files | % { $_.filename }) | ? { $_ } | Sort-Object -Unique
  $namesCount = @($names).Count
  if ($namesCount -gt 0) {
    $preview = $names | Select-Object -First 20
    Write-Host ("filenames preview ({0}): {1}" -f $namesCount, ($preview -join ", "))
  }
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$token = $env:MEKA_ADMIN_TOKEN
if (-not $token) {
  $token = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
}
if (-not $token) {
  throw "MEKA_ADMIN_TOKEN missing (set env var or .env.local)"
}

$headers = @{ Authorization = ("Bearer " + $token) }
$url = "$Base/api/vs_audit?store=$Store&q=$Query&limit=$Limit"
if ($Names) { $url = $url + "&names=1" }
$resp = Invoke-WebRequest $url -Method Get -Headers $headers -SkipHttpErrorCheck -TimeoutSec 30

if ($resp.StatusCode -ne 200) {
  Write-Host "HTTP $($resp.StatusCode)"
  Write-Host $resp.Content
  exit 1
}

$obj = $resp.Content | ConvertFrom-Json
if ($obj.canon) { Print-StoreSummary "canon" $obj.canon }
if ($obj.threads) { Print-StoreSummary "threads" $obj.threads }

if ($OutPath) {
  $dir = Split-Path -Parent $OutPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $resp.Content | Set-Content -Path $OutPath -Encoding UTF8
  Write-Host "wrote: $OutPath"
}
