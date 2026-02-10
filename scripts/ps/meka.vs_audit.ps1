param(
  [string]$Base = "http://localhost:3000",
  [string]$Store = "all",
  [string]$Query = "drift countermeasure",
  [int]$Limit = 5,
  [string]$OutPath = ".\\meka\\out\\vs_audit.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-EnvValue {
  param([string]$EnvPath, [string]$Key)
  if (-not (Test-Path $EnvPath)) { return "" }

  $m = Select-String -Path $EnvPath -Pattern ("^\\s*" + [regex]::Escape($Key) + "\\s*=\\s*(.+)\\s*$") -AllMatches -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if (-not $m) { return "" }

  $val = $m.Matches[0].Groups[1].Value.Trim()
  if ($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  if ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  return $val
}

function Print-StoreSummary {
  param([string]$Name, [object]$Obj)
  if (-not $Obj) { return }

  $id = $Obj.vector_store_id
  $total = $Obj.files_total
  Write-Host "$Name: $id (files_total=$total)"

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
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$token = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
if (-not $token) {
  throw "MEKA_ADMIN_TOKEN missing in .env.local"
}

$headers = @{ Authorization = ("Bearer " + $token) }
$url = "$Base/api/vs_audit?store=$Store&q=$Query&limit=$Limit"
$resp = Invoke-WebRequest $url -Method Get -Headers $headers -SkipHttpErrorCheck

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
