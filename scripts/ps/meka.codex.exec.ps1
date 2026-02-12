Param(
  [string]$TaskFile = "",
  [string]$Task = "",
  [string]$Sandbox = "workspace-write"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui
$Root = (Resolve-Path ".").Path

if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) {
  Write-Host "FAIL: Provide -Task or -TaskFile."
  exit 2
}

if (-not [string]::IsNullOrWhiteSpace($TaskFile)) {
  $Task = Get-Content -Path $TaskFile -Raw -Encoding UTF8
}

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
  Write-Host "FAIL: codex not found on PATH. Install or fix PATH, then retry."
  exit 3
}

& codex exec --full-auto --sandbox $Sandbox $Task
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-Host "PASS: codex exec"
  exit 0
}

Write-Host "FAIL: codex exec"
exit $exitCode
