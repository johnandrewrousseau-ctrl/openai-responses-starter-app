param([string]$EnvPath = ".\.env.local")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $EnvPath)) { throw "Missing: $EnvPath" }

Get-Content $EnvPath | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  ($_ -split '=',2)[0]
}
