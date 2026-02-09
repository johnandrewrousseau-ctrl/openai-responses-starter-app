Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Config ---
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StateDir = Join-Path $Root "state"
$RunsDir  = Join-Path $StateDir "val_runs"
$Ledger   = Join-Path $StateDir "val_ledger.jsonl"

if (!(Test-Path $RunsDir)) { New-Item -ItemType Directory -Path $RunsDir | Out-Null }

function Write-LedgerLine {
  param(
    [Parameter(Mandatory=$true)][hashtable]$Obj
  )
  $json = ($Obj | ConvertTo-Json -Depth 50 -Compress)
  Add-Content -Path $Ledger -Value $json -Encoding utf8
}

function Invoke-Val {
  param(
    [Parameter(Mandatory=$true)][string]$ValId,
    [Parameter(Mandatory=$true)][string]$Title,
    [Parameter(Mandatory=$true)][scriptblock]$Run
  )

  $ts = (Get-Date).ToString("o")
  $safeId = ($ValId -replace '[^A-Za-z0-9_\-]','_')
  $outPath = Join-Path $RunsDir ("{0}__{1}.txt" -f ((Get-Date).ToString("yyyyMMdd_HHmmss")), $safeId)

  $pass = $false
  $outText = ""

  try {
    $result = & $Run 2>&1
    if ($null -ne $result) {
      if ($result -is [string]) {
        $outText = $result
      } else {
        $outText = ($result | ConvertTo-Json -Depth 50)
      }
    }
    $pass = $true
  } catch {
    $outText = $_ | Out-String
    $pass = $false
  }

  Set-Content -Path $outPath -Value $outText -Encoding utf8

  $sha = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash

  Write-LedgerLine @{
    ts     = $ts
    val_id = $ValId
    title  = $Title
    pass   = $pass
    output_file = (Resolve-Path $outPath).Path
    output_sha256 = $sha
  }

  if (-not $pass) {
    throw "VAL FAIL: $ValId ($Title). See $outPath"
  }
}

# -------------------------
# StrictMode-safe helpers
# -------------------------

function Get-PropValue {
  param(
    [Parameter(Mandatory=$true)][object]$Obj,
    [Parameter(Mandatory=$true)][string]$Name
  )
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Get-PropValuePath {
  # dotted path like "writeback.events_count"
  param(
    [Parameter(Mandatory=$true)][object]$Obj,
    [Parameter(Mandatory=$true)][string]$Path
  )
  $cur = $Obj
  foreach ($seg in ($Path -split "\.")) {
    if ($null -eq $cur) { return $null }
    $cur = Get-PropValue -Obj $cur -Name $seg
  }
  return $cur
}

function Same-KeySet {
  param(
    [Parameter(Mandatory=$true)][string[]]$A,
    [Parameter(Mandatory=$true)][string[]]$B
  )
  $aNorm = @($A | Where-Object { $_ -ne $null -and $_ -ne "" } | Sort-Object -Unique)
  $bNorm = @($B | Where-Object { $_ -ne $null -and $_ -ne "" } | Sort-Object -Unique)
  return (($aNorm -join "|") -eq ($bNorm -join "|"))
}

# --- VAL-11: writeback loop (existing script) ---
Invoke-Val -ValId "VAL-11" -Title "writeback loop (test_step11_writeback.ps1)" -Run {
  $script = Join-Path $Root "scripts\test_step11_writeback.ps1"
  & powershell -ExecutionPolicy Bypass -File $script | Out-String
}

# --- VAL-12: vector_store_files endpoint ---
Invoke-Val -ValId "VAL-12" -Title "GET /api/vector_store_files?vector_store_id=..." -Run {
  $vsid = "vs_6959f13cf60c8191bf21144b72dc4bbc"
  $url = "http://localhost:3000/api/vector_store_files?vector_store_id=$vsid"
  $r = irm $url -Method GET

  if ($null -eq $r.vector_store_id -or $r.vector_store_id -ne $vsid) { throw "vector_store_id mismatch" }
  if ($null -eq $r.count -or $r.count -lt 1) { throw "count missing/invalid" }
  if ($null -eq $r.files) { throw "files missing" }
  if ($r.files.Count -ne $r.count) { throw "files.Count != count" }

  @{
    vector_store_id = $r.vector_store_id
    count = $r.count
    first_file = $r.files[0]
  }
}

# --- VAL-13: continuity correlation + hygiene ---
Invoke-Val -ValId "VAL-13" -Title "event_log + state_pack hygiene" -Run {
  $spPath = Join-Path $StateDir "state_pack.json"
  $elPath = Join-Path $StateDir "event_log.jsonl"

  if (-not (Test-Path $spPath)) { throw "missing: state/state_pack.json" }
  if (-not (Test-Path $elPath)) { throw "missing: state/event_log.jsonl" }

  $sp = Get-Content $spPath -Raw -Encoding utf8 | ConvertFrom-Json

  $meta = Get-PropValue -Obj $sp -Name "meta"
  $metaUpdated = Get-PropValue -Obj $meta -Name "updated_at"
  $spUpdated   = Get-PropValue -Obj $sp -Name "updated_at"

  if ($null -eq $metaUpdated) { throw "state_pack: meta.updated_at missing" }
  if ($null -eq $spUpdated)   { throw "state_pack: updated_at missing" }
  if ($metaUpdated -ne $spUpdated) { throw "state_pack: meta.updated_at != updated_at" }

  # Queue keys hygiene: allow legacy/current/current+
  $queue = Get-PropValue -Obj $sp -Name "queue"
  $keys = @()
  if ($null -ne $queue) { $keys = @($queue.PSObject.Properties.Name) }
  $keysSorted = @($keys | Sort-Object -Unique)

  $allowedLegacy      = @("now","next")
  $allowedCurrent     = @("now","next","parked")
  $allowedCurrentPlus = @("now","next","parked","parked_append")

  if (-not (Same-KeySet $keysSorted $allowedLegacy) -and
      -not (Same-KeySet $keysSorted $allowedCurrent) -and
      -not (Same-KeySet $keysSorted $allowedCurrentPlus)) {
    throw ("state_pack queue keys unexpected: " + ($keysSorted -join ","))
  }

  $tState = [DateTime]::Parse([string]$spUpdated)

  function Get-EventTs([object]$obj) {
    foreach ($k in @("ts","timestamp","time","created_at","written_at")) {
      $v = Get-PropValue -Obj $obj -Name $k
      if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) {
        try { return [DateTime]::Parse([string]$v) } catch { }
      }
    }
    return $null
  }

  function Get-EventTsString([object]$obj) {
    foreach ($k in @("ts","timestamp","time","created_at","written_at")) {
      $v = Get-PropValue -Obj $obj -Name $k
      if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) {
        return [string]$v
      }
    }
    return $null
  }

  function Get-WritebackEventsCount([object]$obj) {
    # preferred shapes
    $v = Get-PropValuePath -Obj $obj -Path "writeback.events_count"
    if ($null -ne $v) { try { return [int]$v } catch { } }

    $v = Get-PropValuePath -Obj $obj -Path "writeback.state_pack.events_count"
    if ($null -ne $v) { try { return [int]$v } catch { } }

    $v = Get-PropValuePath -Obj $obj -Path "writeback.delta.events_count"
    if ($null -ne $v) { try { return [int]$v } catch { } }

    # flattened fallbacks
    foreach ($k in @("events_count","writeback_events_count")) {
      $v = Get-PropValue -Obj $obj -Name $k
      if ($null -ne $v) { try { return [int]$v } catch { } }
    }

    return $null
  }

  function Get-InvSha12([object]$obj) {
    $v = Get-PropValue -Obj $obj -Name "inv_sha12"
    if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) { return [string]$v }
    return $null
  }

  $MaxDeltaSeconds = 86400  # 24 hours

  $best = $null
  $bestDelta = [double]::PositiveInfinity
  $bestEvents = $null

  for ($i = 0; $i -lt 10; $i++) {
    $lines = Get-Content $elPath -Tail 400 -Encoding utf8
    foreach ($line in $lines) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }

      $obj = $null
      try { $obj = $line | ConvertFrom-Json } catch { continue }
      if ($null -eq $obj) { continue }

      $tEvent = Get-EventTs $obj
      if ($null -eq $tEvent) { continue }

      $evCount = Get-WritebackEventsCount $obj
      if ($null -eq $evCount) { continue }

      $delta = [Math]::Abs(($tEvent - $tState).TotalSeconds)
      if ($delta -lt $bestDelta) {
        $bestDelta = $delta
        $best = $obj
        $bestEvents = $evCount
      }
    }

    if ($null -ne $best -and $bestDelta -le $MaxDeltaSeconds -and $bestEvents -ge 1) {
      break
    }

    Start-Sleep -Milliseconds 300
  }

  if ($null -eq $best) { throw "event_log: could not find any entry with a detectable events_count in last 400 lines" }
  if ($bestEvents -lt 1) { throw "event_log: best nearby entry has events_count < 1 (bestDelta=${bestDelta}s)" }
  if ($bestDelta -gt $MaxDeltaSeconds) { throw "event_log ts too far from state_pack updated_at (bestDelta=${bestDelta}s, max=${MaxDeltaSeconds}s)" }

  $bestTsStr = Get-EventTsString $best
  $bestInv   = Get-InvSha12 $best
  $sessionId = Get-PropValue -Obj $meta -Name "session_id"

  @{
    state_pack_updated_at = $spUpdated
    best_event_log_ts     = $bestTsStr
    best_delta_seconds    = $bestDelta
    max_delta_seconds     = $MaxDeltaSeconds
    queue_keys            = $keysSorted
    best_events_count     = $bestEvents
    best_inv_sha12        = $bestInv
    state_pack_session_id = $sessionId
  }
}

# --- VAL-21: canon ops outputs exist + are parseable ---
Invoke-Val -ValId "VAL-21" -Title "canon_ops outputs present + parseable" -Run {
  $opsPath = Join-Path $StateDir "canon_ops.json"
  $colPath = Join-Path $StateDir "canon_ops.collisions.json"

  if (-not (Test-Path $opsPath)) { throw "missing: state/canon_ops.json" }
  if (-not (Test-Path $colPath)) { throw "missing: state/canon_ops.collisions.json" }

  $ops = Get-Content $opsPath -Raw -Encoding utf8 | ConvertFrom-Json
  $col = Get-Content $colPath -Raw -Encoding utf8 | ConvertFrom-Json

  if ($null -eq $ops.generated_at) { throw "canon_ops.json missing generated_at" }
  if ($null -eq $ops.inputs) { throw "canon_ops.json missing inputs" }

  $docCount = $null
  if ($null -ne $ops.inputs.manifest_document_count) { $docCount = $ops.inputs.manifest_document_count }
  elseif ($null -ne $ops.inputs.manifest_doc_count) { $docCount = $ops.inputs.manifest_doc_count }
  elseif ($null -ne $ops.manifest_doc_count) { $docCount = $ops.manifest_doc_count }
  elseif ($null -ne $ops.manifest -and $null -ne $ops.manifest.document_count) { $docCount = $ops.manifest.document_count }

  if ($null -eq $docCount) { throw "canon_ops.json missing manifest document count (inputs.manifest_document_count / manifest.document_count)" }
  if ($null -eq $ops.artifact_count) { throw "canon_ops.json missing artifact_count" }

  $collisionTotal = $null

  if ($null -ne $col.collisions_categories) {
    $collisionTotal = 0
    foreach ($p in $col.collisions_categories.PSObject.Properties) {
      $v = 0
      try { $v = [int]$p.Value } catch { $v = 0 }
      $collisionTotal += $v
    }
  } elseif ($null -ne $col.collisions) {
    $collisionTotal = @($col.collisions).Count
  } else {
    $known = @(
      "duplicate_artifact_id",
      "duplicate_source_doc",
      "source_doc_missing_in_manifest",
      "invalid_authority_tier",
      "invalid_kind",
      "tombstone_unknown_artifact_id",
      "supersedes_unknown_from",
      "supersedes_unknown_to",
      "supersedes_self_edge",
      "supersedes_multiple_successors",
      "supersedes_cycle",
      "supersedes_to_tombstoned",
      "tombstoned_has_successor"
    )

    $collisionTotal = 0
    $foundAny = $false
    foreach ($k in $known) {
      if ($null -ne $col.$k) {
        $foundAny = $true
        $collisionTotal += @($col.$k).Count
      }
    }
    if (-not $foundAny) { throw "canon_ops.collisions.json missing collisions_categories and no recognized category arrays" }
  }

  @{
    canon_ops_generated_at = $ops.generated_at
    manifest_doc_count     = $docCount
    artifact_count         = $ops.artifact_count
    collisions_total       = $collisionTotal
  }
}

# --- VAL-22: GET /api/canon_ops returns ok + categories ---
Invoke-Val -ValId "VAL-22" -Title "GET /api/canon_ops" -Run {
  $url = "http://localhost:3000/api/canon_ops"
  $r = irm $url -Method GET

  if ($null -eq $r.ok -or $r.ok -ne $true) { throw "api/canon_ops: ok != true" }
  if ($null -eq $r.generated_at) { throw "api/canon_ops: generated_at missing" }
  if ($null -eq $r.collisions_categories) { throw "api/canon_ops: collisions_categories missing" }

  foreach ($k in @("duplicate_artifact_id","duplicate_source_doc","source_doc_missing_in_manifest","invalid_authority_tier","invalid_kind")) {
    if ($null -eq $r.collisions_categories.$k) { throw "api/canon_ops: missing category $k" }
  }

  @{
    ok = $r.ok
    generated_at = $r.generated_at
    collisions_categories = $r.collisions_categories
  }
}

"VAL SUITE PASS"
