param(
  [string]$Base = "http://localhost:3000",
  [ValidateSet("threads","canon")][string]$Store = "threads"
)

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
$threadsDir = $env:MEKA_THREADS_TXT_DIR
if (-not $threadsDir) { $threadsDir = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_THREADS_TXT_DIR" }
if (-not $threadsDir) { $threadsDir = "C:\\meka\\MEKA_THREADS_TXT" }

$canonDir = $env:MEKA_CANON_TXT_DIR
if (-not $canonDir) { $canonDir = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_CANON_TXT_DIR" }
if (-not $canonDir) { $canonDir = "C:\\meka\\MEKA_CANON_TXT" }

$watchDir = if ($Store -eq "canon") { $canonDir } else { $threadsDir }

if (-not (Test-Path $watchDir)) {
  throw "Watch dir not found: $watchDir"
}

Write-Host ("Watching {0} -> {1}" -f $Store, $watchDir)

$fsw = New-Object System.IO.FileSystemWatcher
$fsw.Path = $watchDir
$fsw.IncludeSubdirectories = $false
$fsw.EnableRaisingEvents = $true
$fsw.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite'

$script:LastEvent = Get-Date "2000-01-01"

$action = {
  $now = Get-Date
  if (($now - $script:LastEvent).TotalSeconds -lt 2) { return }
  $script:LastEvent = $now
  pwsh .\scripts\ps\meka.vs_ingest.ps1 -Base $using:Base -Store $using:Store | Out-Host
}

Register-ObjectEvent -InputObject $fsw -EventName Created -Action $action | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Changed -Action $action | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Renamed -Action $action | Out-Null

while ($true) { Start-Sleep -Seconds 1 }
