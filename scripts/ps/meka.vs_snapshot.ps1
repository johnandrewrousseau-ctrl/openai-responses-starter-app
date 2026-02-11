param(
  [string]$Base = "http://localhost:3000"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$outDir = Join-Path $Root "meka\\out"
$lastPath = Join-Path $outDir "vs_audit.LAST.json"
$nowPath = Join-Path $outDir "vs_audit.NOW.json"

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

pwsh (Join-Path $Root "scripts\\ps\\meka.vs_audit.ps1") -Base $Base -Store all -Query "drift countermeasure" -Limit 5

if (-not (Test-Path $lastPath)) {
  Copy-Item (Join-Path $outDir "vs_audit.json") $lastPath -Force
  Write-Host "initialized baseline"
  exit 0
}

Copy-Item (Join-Path $outDir "vs_audit.json") $nowPath -Force

$base = Get-Content $lastPath -Raw | ConvertFrom-Json
$now  = Get-Content $nowPath -Raw  | ConvertFrom-Json

function Get-StoreValue($obj, $name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    foreach ($k in $obj.Keys) {
      if ($k -ieq $name) { return $obj[$k] }
    }
    return $null
  }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Get-IntProp($obj, $name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return ($obj[$name] -as [int]) }
    return $null
  }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return ($prop.Value -as [int])
}

function Diff-Store($name, $bStore, $nStore) {
  Write-Host ""
  Write-Host ("=== {0} ===" -f $name)
  if ($null -eq $bStore -or $null -eq $nStore) {
    Write-Host "missing store in baseline or latest"
    return @{ added = 0; removed = 0 }
  }
  $bIds = @($bStore.file_ids) | ? { $_ } | Sort-Object -Unique
  $nIds = @($nStore.file_ids) | ? { $_ } | Sort-Object -Unique

  $added   = Compare-Object $bIds $nIds | ? SideIndicator -eq "=>" | % InputObject
  $removed = Compare-Object $bIds $nIds | ? SideIndicator -eq "<=" | % InputObject

  $addedCount = @($added).Count
  $removedCount = @($removed).Count
  Write-Host ("added:   {0}" -f $addedCount)
  Write-Host ("removed: {0}" -f $removedCount)

  $counts = $nStore.status_counts
  if ($counts) {
    $c = Get-IntProp $counts "completed"
    $p = Get-IntProp $counts "in_progress"
    $f = Get-IntProp $counts "failed"
    Write-Host ("status_counts: completed={0} in_progress={1} failed={2}" -f $c, $p, $f)
  }

  if ($nStore.failed_files_sample) {
    $ff = @($nStore.failed_files_sample) | ? { $_ }
    if ($ff.Count -gt 0) {
      Write-Host ("failed_files_sample: " + ($ff -join ", "))
    }
  }

  if ($null -ne $nStore.truncated) {
    Write-Host ("truncated: {0}" -f $nStore.truncated)
  }
  if ($null -ne $nStore.has_more_final) {
    Write-Host ("has_more_final: {0}" -f $nStore.has_more_final)
  }
  if ($null -ne $nStore.indexed_sample_failed) {
    Write-Host ("indexed_sample_failed: {0}" -f $nStore.indexed_sample_failed)
  }

  return @{ added = $addedCount; removed = $removedCount }
}

$canonBase = Get-StoreValue $base "canon"
$canonNow = Get-StoreValue $now "canon"
$threadsBase = Get-StoreValue $base "threads"
$threadsNow = Get-StoreValue $now "threads"

if ($null -eq $canonBase -or $null -eq $canonNow -or $null -eq $threadsBase -or $null -eq $threadsNow) {
  $baseHt = Get-Content $lastPath -Raw | ConvertFrom-Json -AsHashtable
  $nowHt = Get-Content $nowPath -Raw | ConvertFrom-Json -AsHashtable
  if ($null -eq $canonBase) { $canonBase = $baseHt["canon"] }
  if ($null -eq $canonNow) { $canonNow = $nowHt["canon"] }
  if ($null -eq $threadsBase) { $threadsBase = $baseHt["threads"] }
  if ($null -eq $threadsNow) { $threadsNow = $nowHt["threads"] }
}

$canonDiff = Diff-Store "canon" $canonBase $canonNow
$threadsDiff = Diff-Store "threads" $threadsBase $threadsNow

Copy-Item $nowPath $lastPath -Force

$healthBad = $false
foreach ($store in @("canon", "threads")) {
  $storeObj = if ($store -eq "canon") { $canonNow } else { $threadsNow }
  if (-not $storeObj) { continue }
  $counts = $storeObj.status_counts
  if ($counts) {
    if ((Get-IntProp $counts "failed") -gt 0) { $healthBad = $true }
    if ((Get-IntProp $counts "in_progress") -gt 0) { $healthBad = $true }
  }
  if ($storeObj.truncated -eq $true) { $healthBad = $true }
  if ($storeObj.has_more_final -eq $true) { $healthBad = $true }
  $idxFails = $storeObj.indexed_sample_failures
  if ($idxFails) {
    $realFails = @($idxFails) | Where-Object {
      if (-not $_) { return $false }
      $err = $_.error
      if (-not $err) { return $true }
      ($err -notmatch "Missing required parameter: 'filters.type'")
    }
    if (@($realFails).Count -gt 0) { $healthBad = $true }
  }
}

$changes = ($canonDiff.added + $canonDiff.removed + $threadsDiff.added + $threadsDiff.removed)

if ($healthBad) { exit 3 }
if ($changes -gt 0) { exit 2 }
exit 0
