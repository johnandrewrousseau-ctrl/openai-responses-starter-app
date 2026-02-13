Param(
  [string]$TaskFile = "",
  [string]$Task = "",
  [string]$Sandbox = "workspace-write",
  [ValidateSet("never","on-request","untrusted")]
  [string]$Approval = "never",
  [switch]$Json,
  [switch]$RequireSandbox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui
$Root = (Resolve-Path ".").Path

if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) {
  Write-Host "FAIL [codex_exec_fail] exit=2 err=missing_task"
  exit 2
}

if (-not [string]::IsNullOrWhiteSpace($TaskFile)) {
  $Task = Get-Content -Path $TaskFile -Raw -Encoding UTF8
}

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
  Write-Host "FAIL [codex_exec_fail] exit=3 err=codex_not_found"
  exit 3
}

$helpText = ""
try {
  $helpText = (& codex exec --help 2>&1 | Out-String)
} catch {
  $helpText = ""
}

$hasSandbox = ($helpText -match "(?m)^\s*--sandbox(?:[\s=]|$)")
$hasFullAuto = ($helpText -match "(?m)^\s*--full-auto(?:[\s=]|$)")
$hasJson = ($helpText -match "(?m)^\s*--json(?:[\s=]|$)")

$approvalFlag = $null
foreach ($candidate in @("--ask-for-approval", "--approval-mode", "--approval-policy", "--approval")) {
  if ($helpText -match ("(?m)^\s*{0}(?:[\s=]|$)" -f [regex]::Escape($candidate))) {
    $approvalFlag = $candidate
    break
  }
}

$execArgs = @("exec")
if ($hasFullAuto) {
  $execArgs += "--full-auto"
}
if ($hasSandbox) {
  $execArgs += @("--sandbox", $Sandbox)
}
if ($approvalFlag) {
  $execArgs += @($approvalFlag, $Approval)
}
if ($Json -and $hasJson) {
  $execArgs += "--json"
}
$execArgs += $Task

& codex @execArgs 2>&1 | Tee-Object -Variable codexOut | Out-Null
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

if ($RequireSandbox) {
  $outText = ""
  if ($codexOut) { $outText = ($codexOut -join "`n") }
  $looksReadOnly = $false
  $hasMismatch = $false
  if ($effectiveSandbox -and $effectiveSandbox.ToLowerInvariant() -ne $Sandbox.ToLowerInvariant()) {
    $hasMismatch = $true
  }
  if ($outText -match "sandbox:\s*read-only" -or $outText -match "blocked by policy" -or $outText -match "read-only") {
    $looksReadOnly = $true
  }
  if ($looksReadOnly -and $Sandbox.ToLowerInvariant() -ne "read-only") {
    $hasMismatch = $true
  }
  if ($hasMismatch) {
    $effective = if ($effectiveSandbox) { $effectiveSandbox } elseif ($looksReadOnly) { "read-only" } else { "unknown" }
    Write-Host ("FAIL [codex_exec_sandbox_mismatch] requested={0} effective={1}" -f $Sandbox, $effective)
    exit 4
  }
}

if ($exitCode -eq 0) {
  Write-Host "PASS [codex_exec_ok] exit=$exitCode"
  exit 0
}

$firstErrorLine = ""
if ($codexOut) {
  foreach ($line in $codexOut) {
    $trimmed = "$line".Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    if ($trimmed -match "(?i)\b(error|failed|failure|invalid|unknown|usage)\b") {
      $firstErrorLine = $trimmed
      break
    }
    if (-not $firstErrorLine) {
      $firstErrorLine = $trimmed
    }
  }
}
if (-not $firstErrorLine) {
  $firstErrorLine = "codex_exec_failed"
}

Write-Host ("FAIL [codex_exec_fail] exit={0} err={1}" -f $exitCode, $firstErrorLine)
exit $exitCode
