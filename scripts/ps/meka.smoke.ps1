param(
  [string]$Base = "http://localhost:3000"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
  param([bool]$Cond, [string]$Name, [string]$Msg)
  if (-not $Cond) { throw "FAIL [$Name] $Msg" }
  Write-Host "PASS [$Name]"
}

function Read-EnvValue {
  param([string]$EnvPath, [string]$Key)
  if (-not (Test-Path $EnvPath)) { return "" }

  $m = Select-String -Path $EnvPath -Pattern ("^\s*" + [regex]::Escape($Key) + "\s*=\s*(.+)\s*$") -AllMatches -ErrorAction SilentlyContinue |
       Select-Object -First 1
  if (-not $m) { return "" }

  $val = $m.Matches[0].Groups[1].Value.Trim()
  if ($val.StartsWith('"') -and $val.EndsWith('"') -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  if ($val.StartsWith("'") -and $val.EndsWith("'") -and $val.Length -ge 2) { $val = $val.Substring(1, $val.Length-2) }
  return $val
}

function Extract-AssistantTextFromSse {
  param([string]$SseContent)

  $deltas = New-Object System.Collections.Generic.List[string]
  $doneText = ""

  foreach ($rawLine in ($SseContent -split "`n")) {
    $line = $rawLine.Trim()
    if (-not $line.StartsWith("data:")) { continue }

    if ($line -notmatch '"response\.output_text\.(delta|done)"') { continue }

    $json = $line.Substring(5).Trim()
    if (-not $json) { continue }

    try { $obj = $json | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if (-not $obj) { continue }

    if ($obj.event -eq "response.output_text.delta") {
      $delta = $obj.data.delta
      if ($null -ne $delta) { $deltas.Add([string]$delta) }
      continue
    }

    if ($obj.event -eq "response.output_text.done") {
      $t = $obj.data.text
      if ($null -ne $t -and ([string]$t).Length -gt 0) { $doneText = [string]$t }
      continue
    }
  }

  if ($doneText) { return $doneText }
  return ($deltas -join "")
}

function SseHasFileSearchEvent {
  param([string]$SseContent)

  foreach ($rawLine in ($SseContent -split "`n")) {
    $line = $rawLine.Trim()
    if (-not $line.StartsWith("data:")) { continue }
    if ($line -match "file_search") { return $true }
  }

  return $false
}

function Invoke-TurnResponse {
  param(
    [string]$BaseUrl,
    [string]$BodyJson,
    [hashtable]$Headers = @{}
  )

  return Invoke-WebRequest "$BaseUrl/api/turn_response" `
    -Method Post `
    -ContentType "application/json" `
    -Body $BodyJson `
    -Headers $Headers `
    -SkipHttpErrorCheck `
    -TimeoutSec 30
}

# Repo root is two levels above scripts/ps/
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$fixtures = Join-Path $Root "meka\fixtures\turn_requests"

# 0) Server readiness
$ts = Invoke-WebRequest "$Base/api/tool_status" -Method Get -SkipHttpErrorCheck -TimeoutSec 30
Assert-True ($ts.StatusCode -eq 200) "server_ready" "GET /api/tool_status expected 200, got $($ts.StatusCode)"

# 1) Baseline: tools off
$baselineBody = Get-Content (Join-Path $fixtures "baseline.json") -Raw
$resp1 = Invoke-TurnResponse -BaseUrl $Base -BodyJson $baselineBody
Assert-True ($resp1.StatusCode -eq 200) "baseline_http_200" "Expected 200, got $($resp1.StatusCode)"

$txt1 = Extract-AssistantTextFromSse $resp1.Content
$txt1Trim = ($txt1 ?? "").Trim()
Assert-True ($txt1Trim -like "*BASELINE_OK*") "baseline_turn_works" "Expected BASELINE_OK. Got: [$txt1Trim]"

# 1.2) Canon mode forces file_search call/event
$canonBody = Get-Content (Join-Path $fixtures "canon_mode.json") -Raw
$resp1canon = Invoke-TurnResponse -BaseUrl $Base -BodyJson $canonBody
Assert-True ($resp1canon.StatusCode -eq 200) "canon_mode_http_200" "Expected 200, got $($resp1canon.StatusCode)"

$canonHdr = $resp1canon.Headers["x-meka-canon-vs"]
Assert-True ($canonHdr -and $canonHdr.Trim().Length -gt 0) "canon_mode_forces_canon_vector_store" "Expected x-meka-canon-vs header to be non-empty. Got: [$canonHdr]"

$canonHasFileSearch = SseHasFileSearchEvent $resp1canon.Content
Assert-True ($canonHasFileSearch) "canon_mode_triggers_file_search" "Expected SSE stream to include file_search."

# 1.3) Thread mode forces file_search call/event
$threadBody = Get-Content (Join-Path $fixtures "thread_mode.json") -Raw
$resp1thread = Invoke-TurnResponse -BaseUrl $Base -BodyJson $threadBody
Assert-True ($resp1thread.StatusCode -eq 200) "thread_mode_http_200" "Expected 200, got $($resp1thread.StatusCode)"

$threadHdr = $resp1thread.Headers["x-meka-threads-vs"]
Assert-True ($threadHdr -and $threadHdr.Trim().Length -gt 0) "thread_mode_forces_threads_vector_store" "Expected x-meka-threads-vs header to be non-empty. Got: [$threadHdr]"

$threadHasFileSearch = SseHasFileSearchEvent $resp1thread.Content
Assert-True ($threadHasFileSearch) "thread_mode_triggers_file_search" "Expected SSE stream to include file_search."

# 1.4) Gold hunt mode forces file_search call/event
$goldBody = Get-Content (Join-Path $fixtures "gold_hunt_mode.json") -Raw
$resp1gold = Invoke-TurnResponse -BaseUrl $Base -BodyJson $goldBody
Assert-True ($resp1gold.StatusCode -eq 200) "gold_hunt_mode_http_200" "Expected 200, got $($resp1gold.StatusCode)"

$goldHdr = $resp1gold.Headers["x-meka-threads-vs"]
Assert-True ($goldHdr -and $goldHdr.Trim().Length -gt 0) "gold_hunt_mode_forces_threads_vector_store" "Expected x-meka-threads-vs header to be non-empty. Got: [$goldHdr]"

$goldHasFileSearch = SseHasFileSearchEvent $resp1gold.Content
Assert-True ($goldHasFileSearch) "gold_hunt_mode_triggers_file_search" "Expected SSE stream to include file_search."

# 1.4.5) Mode conflict must 400
$conflictBody = Get-Content (Join-Path $fixtures "mode_conflict.json") -Raw
$resp1conflict = Invoke-TurnResponse -BaseUrl $Base -BodyJson $conflictBody
Assert-True ($resp1conflict.StatusCode -eq 400) "mode_conflict_400" "Expected 400, got $($resp1conflict.StatusCode)"

$conflictHasCode = ($resp1conflict.Content -match "mode_conflict")
Assert-True ($conflictHasCode) "mode_conflict_code_present" "Expected response to include mode_conflict."

# 1.5) toolsState must reject unknown keys
$extraBody = Get-Content (Join-Path $fixtures "tools_state_extra.json") -Raw
$resp1b = Invoke-TurnResponse -BaseUrl $Base -BodyJson $extraBody
Assert-True ($resp1b.StatusCode -eq 400) "tools_state_rejects_extra" "Expected 400 for unknown toolsState keys. Got $($resp1b.StatusCode)"

# 1.7) Vector store audit must succeed
$auditToken = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
$auditHeaders = @{ Authorization = ("Bearer " + $auditToken) }
$respAudit = Invoke-WebRequest "$Base/api/vs_audit?store=all" -Method Get -Headers $auditHeaders -SkipHttpErrorCheck -TimeoutSec 30
Assert-True ($respAudit.StatusCode -eq 200) "vs_audit_http_200" "Expected 200 from /api/vs_audit. Got $($respAudit.StatusCode)"

$auditJson = $respAudit.Content | ConvertFrom-Json
$canonId = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_VECTOR_STORE_ID_CANON"
$threadsId = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_VECTOR_STORE_ID_THREADS"
$schemaOk = $true
if ($canonId) {
  $schemaOk = $schemaOk -and $auditJson.canon -and ($auditJson.canon.files_total -is [int] -or $auditJson.canon.files_total -is [double])
}
if ($threadsId) {
  $schemaOk = $schemaOk -and $auditJson.threads -and ($auditJson.threads.files_total -is [int] -or $auditJson.threads.files_total -is [double])
}
Assert-True ($schemaOk) "vs_audit_has_schema" "Expected canon/threads keys with numeric files_total when env vars exist."

$paginateOk = $true
if ($canonId) {
  $paginateOk = $paginateOk -and ($auditJson.canon.pages_fetched -ge 1) -and ($auditJson.canon.has_more_final -eq $false)
}
if ($threadsId) {
  $paginateOk = $paginateOk -and ($auditJson.threads.pages_fetched -ge 1) -and ($auditJson.threads.has_more_final -eq $false)
}
Assert-True ($paginateOk) "vs_audit_paginates" "Expected pages_fetched >= 1 and has_more_final = false."

$snapshotOk = $true
if ($canonId) {
  $snapshotOk = $snapshotOk -and ($auditJson.canon.snapshot_sha256 -and ($auditJson.canon.snapshot_sha256.Length -ge 32))
}
if ($threadsId) {
  $snapshotOk = $snapshotOk -and ($auditJson.threads.snapshot_sha256 -and ($auditJson.threads.snapshot_sha256.Length -ge 32))
}
Assert-True ($snapshotOk) "vs_audit_has_snapshot" "Expected snapshot_sha256 to be present."

$truncOk = $true
if ($canonId) {
  $truncOk = $truncOk -and ($auditJson.canon.truncated -eq $false)
}
if ($threadsId) {
  $truncOk = $truncOk -and ($auditJson.threads.truncated -eq $false)
}
Assert-True ($truncOk) "vs_audit_not_truncated" "Expected truncated = false."

$statusOk = $true
if ($canonId) {
  $statusOk = $statusOk -and $auditJson.canon.status_counts -and ($auditJson.canon.files_total -is [int] -or $auditJson.canon.files_total -is [double])
}
if ($threadsId) {
  $statusOk = $statusOk -and $auditJson.threads.status_counts -and ($auditJson.threads.files_total -is [int] -or $auditJson.threads.files_total -is [double])
}
Assert-True ($statusOk) "vs_audit_has_status_counts" "Expected status_counts and numeric files_total."

$indexOk = $true
if ($canonId) {
  $indexOk = $indexOk -and ($auditJson.canon.indexed_sample_checked -is [int] -or $auditJson.canon.indexed_sample_checked -is [double])
  $indexOk = $indexOk -and ($auditJson.canon.indexed_sample_ok -is [int] -or $auditJson.canon.indexed_sample_ok -is [double])
  $indexOk = $indexOk -and ($auditJson.canon.indexed_sample_failed -is [int] -or $auditJson.canon.indexed_sample_failed -is [double])
}
if ($threadsId) {
  $indexOk = $indexOk -and ($auditJson.threads.indexed_sample_checked -is [int] -or $auditJson.threads.indexed_sample_checked -is [double])
  $indexOk = $indexOk -and ($auditJson.threads.indexed_sample_ok -is [int] -or $auditJson.threads.indexed_sample_ok -is [double])
  $indexOk = $indexOk -and ($auditJson.threads.indexed_sample_failed -is [int] -or $auditJson.threads.indexed_sample_failed -is [double])
}
Assert-True ($indexOk) "vs_audit_index_sample_schema" "Expected indexed_sample_* counters."

# 1.6) toolsState must accept dev_bypass_active when present
$devBypassBody = Get-Content (Join-Path $fixtures "tools_state_dev_bypass.json") -Raw
$resp1c = Invoke-TurnResponse -BaseUrl $Base -BodyJson $devBypassBody
Assert-True ($resp1c.StatusCode -eq 200) "tools_state_accepts_dev_bypass" "Expected 200 for dev_bypass_active key. Got $($resp1c.StatusCode)"

$txt1c = Extract-AssistantTextFromSse $resp1c.Content
$txt1cTrim = ($txt1c ?? "").Trim()
Assert-True ($txt1cTrim -like "*DEV_BYPASS_OK*") "tools_state_dev_bypass_text_ok" "Expected DEV_BYPASS_OK. Got: [$txt1cTrim]"

# 2) Unauthorized tools must hard-fail (401)
$toolsBody = Get-Content (Join-Path $fixtures "tools_gate.json") -Raw
$resp2 = Invoke-TurnResponse -BaseUrl $Base -BodyJson $toolsBody
$devFlag = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_DEV_ALLOW_TOOLS_WITHOUT_AUTH"
$devBypassOn = ($devFlag -eq "1")

if ($devBypassOn) {
  Assert-True ($resp2.StatusCode -eq 200) "dev_bypass_allows_tools_without_auth" "Expected 200 when dev bypass is ON. Got $($resp2.StatusCode)"
} else {
  Assert-True ($resp2.StatusCode -eq 401) "unauthorized_tools_must_401" "Expected 401 when dev bypass is OFF. Got $($resp2.StatusCode)"
}# 3) Optional authorized test (uses .env.local value, never prints it)
$token = Read-EnvValue (Join-Path $Root ".env.local") "MEKA_ADMIN_TOKEN"
if (-not $token) {
  Write-Host "SKIP [authorized_tools] (MEKA_ADMIN_TOKEN missing in .env.local)"
} else {
  $headers = @{ Authorization = ("Bearer " + $token) }
  $resp3 = Invoke-TurnResponse -BaseUrl $Base -BodyJson $toolsBody -Headers $headers
  Assert-True ($resp3.StatusCode -eq 200) "authorized_tools_http_200" "Expected 200 with Authorization. Got $($resp3.StatusCode)"

  $txt3 = Extract-AssistantTextFromSse $resp3.Content
  $txt3Trim = ($txt3 ?? "").Trim()

  Assert-True ($txt3Trim -like "*TOOLS_GATE_OK*") "authorized_tools_text_ok" "Expected TOOLS_GATE_OK. Got: [$txt3Trim]"
  Assert-True ($txt3Trim -notmatch "BEGIN_WRITEBACK_JSON|END_WRITEBACK_JSON") "no_writeback_leak" "Writeback markers leaked into visible assistant text."
}

Write-Host "OK: MEKA smoke checks complete."
