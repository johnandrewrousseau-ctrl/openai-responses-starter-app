Param(
  [string]$TaskFile = "",
  [string]$Task = "",
  [string]$Sandbox = "workspace-write",
  [switch]$Json,
  [switch]$RequireSandbox
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

if ($Json) {
  & codex exec --full-auto --sandbox $Sandbox --json $Task 2>&1 | Tee-Object -Variable codexOut
} else {
  & codex exec --full-auto --sandbox $Sandbox $Task 2>&1 | Tee-Object -Variable codexOut
}
$exitCode = $LASTEXITCODE

$effectiveSandbox = $null
if ($codexOut) {
  foreach ($line in $codexOut) {
    if ($line -match "sandbox:\s*([A-Za-z\-]+)") {
      $effectiveSandbox = $Matches[1]
      break
    }
    if ($line -match "`"sandbox`"\\s*:\\s*`"([^`"]+)`"") {
      $effectiveSandbox = $Matches[1]
      break
    }
  }
}

if ($RequireSandbox -and $Sandbox -eq "workspace-write") {
  $outText = ""
  if ($codexOut) { $outText = ($codexOut -join "`n") }
  $looksReadOnly = $false
  if ($effectiveSandbox -and $effectiveSandbox.ToLowerInvariant() -ne $Sandbox.ToLowerInvariant()) {
    $looksReadOnly = $true
  }
  if ($outText -match "sandbox:\s*read-only" -or $outText -match "blocked by policy" -or $outText -match "read-only") {
    $looksReadOnly = $true
  }
  if ($looksReadOnly) {
    $actual = if ($effectiveSandbox) { $effectiveSandbox } else { "read-only" }
    Write-Host ("FAIL [codex_exec_sandbox_mismatch] requested={0} effective={1}" -f $Sandbox, $actual)
    exit 4
  }
}

if ($exitCode -eq 0) {
  Write-Host "PASS [codex_exec_ok] exit=$exitCode"
  exit 0
}

Write-Host "FAIL [codex_exec_fail] exit=$exitCode"
exit $exitCode
