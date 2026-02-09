Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -------------------------
# Config (override by setting env vars before running if desired)
# -------------------------
$BaseUrl       = if ($env:MEKA_BASEURL) { $env:MEKA_BASEURL } else { "http://localhost:3000" }
$VectorStoreId = if ($env:MEKA_VSID)    { $env:MEKA_VSID }    else { "vs_6959f13cf60c8191bf21144b72dc4bbc" }
$TailLines     = if ($env:MEKA_TAIL)    { [int]$env:MEKA_TAIL } else { 400 }
$MaxDeltaSeconds = if ($env:MEKA_MAXDELTA) { [int]$env:MEKA_MAXDELTA } else { 86400 } # 24h

# -------------------------
# Paths
# -------------------------
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StateDir = Join-Path $Root "state"
$RunsDir  = Join-Path $StateDir "ui_runs"
if (!(Test-Path $RunsDir)) { New-Item -ItemType Directory -Path $RunsDir | Out-Null }

$spPath = Join-Path $StateDir "state_pack.json"
$elPath = Join-Path $StateDir "event_log.jsonl"
$rtPath = Join-Path $StateDir "retrieval_tap.jsonl"

# -------------------------
# Helpers (StrictMode-safe)
# -------------------------
function Get-PropValue {
  param([object]$Obj, [string]$Name)
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Get-PropValuePath {
  param([object]$Obj, [string]$Path)
  $cur = $Obj
  foreach ($seg in ($Path -split "\.")) {
    if ($null -eq $cur) { return $null }
    $cur = Get-PropValue -Obj $cur -Name $seg
  }
  return $cur
}

function Same-KeySet {
  param([string[]]$A, [string[]]$B)
  $aNorm = @($A | Where-Object { $_ -ne $null -and $_ -ne "" } | Sort-Object -Unique)
  $bNorm = @($B | Where-Object { $_ -ne $null -and $_ -ne "" } | Sort-Object -Unique)
  return (($aNorm -join "|") -eq ($bNorm -join "|"))
}

function TailJsonl {
  param([string]$Path, [int]$N)
  if (!(Test-Path $Path)) { return @() }
  Get-Content $Path -Tail $N -Encoding UTF8 | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace($_)) { return $null }
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object { $_ -ne $null }
}

function Parse-EventTs {
  param([object]$Obj)
  foreach ($k in @("ts","timestamp","time","created_at","written_at")) {
    $v = Get-PropValue -Obj $Obj -Name $k
    if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) {
      try { return [DateTime]::Parse([string]$v) } catch { }
    }
  }
  return $null
}

function Get-EventTsString {
  param([object]$Obj)
  foreach ($k in @("ts","timestamp","time","created_at","written_at")) {
    $v = Get-PropValue -Obj $Obj -Name $k
    if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) {
      return [string]$v
    }
  }
  return $null
}

function Get-WritebackEventsCount {
  param([object]$Obj)

  $v = Get-PropValuePath -Obj $Obj -Path "writeback.events_count"
  if ($null -ne $v) { try { return [int]$v } catch { } }

  $v = Get-PropValuePath -Obj $Obj -Path "writeback.state_pack.events_count"
  if ($null -ne $v) { try { return [int]$v } catch { } }

  $v = Get-PropValuePath -Obj $Obj -Path "writeback.delta.events_count"
  if ($null -ne $v) { try { return [int]$v } catch { } }

  foreach ($k in @("events_count","writeback_events_count")) {
    $v = Get-PropValue -Obj $Obj -Name $k
    if ($null -ne $v) { try { return [int]$v } catch { } }
  }

  return $null
}

function Get-InvSha12 {
  param([object]$Obj)
  $v = Get-PropValue -Obj $Obj -Name "inv_sha12"
  if ($null -ne $v -and -not [string]::IsNullOrWhiteSpace([string]$v)) { return [string]$v }
  return $null
}

function Assert-True {
  param([bool]$Cond, [string]$Msg)
  if (-not $Cond) { throw $Msg }
}

# -------------------------
# Sweep begins
# -------------------------
$startedAt = (Get-Date).ToString("o")
$runId = (Get-Date).ToString("yyyyMMdd_HHmmss")
$outPath = Join-Path $RunsDir ("{0}__ui_capability_sweep.json" -f $runId)

# Baselines
$eventBase = TailJsonl -Path $elPath -N $TailLines
$retrBase  = TailJsonl -Path $rtPath -N $TailLines

# 1) API: canon_ops
$canonUrl = "$BaseUrl/api/canon_ops"
$canon = irm $canonUrl -Method GET
Assert-True ($null -ne $canon) "canon_ops: null response"
Assert-True ($canon.ok -eq $true) "canon_ops: ok != true"

# 2) API: vector_store_files
$vsUrl = "$BaseUrl/api/vector_store_files?vector_store_id=$VectorStoreId"
$vs = irm $vsUrl -Method GET
Assert-True ($null -ne $vs) "vector_store_files: null response"
Assert-True ($vs.vector_store_id -eq $VectorStoreId) "vector_store_files: vector_store_id mismatch"
Assert-True ($vs.count -ge 0) "vector_store_files: count missing/invalid"
Assert-True ($null -ne $vs.files) "vector_store_files: files missing"
Assert-True ($vs.files.Count -eq $vs.count) "vector_store_files: files.Count != count"

# 3) Scripted writeback loop (known-good)
$wbScript = Join-Path $Root "scripts\test_step11_writeback.ps1"
Assert-True (Test-Path $wbScript) "missing: scripts/test_step11_writeback.ps1"
$wbOut = & powershell -ExecutionPolicy Bypass -File $wbScript 2>&1 | Out-String

# 4) Read state_pack + hygiene checks
Assert-True (Test-Path $spPath) "missing: state/state_pack.json"
$sp = Get-Content $spPath -Raw -Encoding UTF8 | ConvertFrom-Json

$meta = Get-PropValue -Obj $sp -Name "meta"
$metaUpdated = Get-PropValue -Obj $meta -Name "updated_at"
$spUpdated   = Get-PropValue -Obj $sp -Name "updated_at"

Assert-True ($null -ne $metaUpdated) "state_pack: meta.updated_at missing"
Assert-True ($null -ne $spUpdated)   "state_pack: updated_at missing"
Assert-True ($metaUpdated -eq $spUpdated) "state_pack: meta.updated_at != updated_at"

$queue = Get-PropValue -Obj $sp -Name "queue"
$queueKeys = @()
if ($null -ne $queue) { $queueKeys = @($queue.PSObject.Properties.Name) }
$queueKeysSorted = @($queueKeys | Sort-Object -Unique)

$allowedLegacy      = @("now","next")
$allowedCurrent     = @("now","next","parked")
$allowedCurrentPlus = @("now","next","parked","parked_append")

Assert-True (
  (Same-KeySet $queueKeysSorted $allowedLegacy) -or
  (Same-KeySet $queueKeysSorted $allowedCurrent) -or
  (Same-KeySet $queueKeysSorted $allowedCurrentPlus)
) ("state_pack: queue keys unexpected: " + ($queueKeysSorted -join ","))

# 5) Correlate event_log writeback entry near state_pack.updated_at
Assert-True (Test-Path $elPath) "missing: state/event_log.jsonl"
$tState = [DateTime]::Parse([string]$spUpdated)

$eventNow = TailJsonl -Path $elPath -N $TailLines
$best = $null
$bestDelta = [double]::PositiveInfinity
$bestEvents = $null

foreach ($obj in $eventNow) {
  $tEvent = Parse-EventTs -Obj $obj
  if ($null -eq $tEvent) { continue }

  $evCount = Get-WritebackEventsCount -Obj $obj
  if ($null -eq $evCount) { continue }

  $delta = [Math]::Abs(($tEvent - $tState).TotalSeconds)
  if ($delta -lt $bestDelta) {
    $bestDelta = $delta
    $best = $obj
    $bestEvents = $evCount
  }
}

Assert-True ($null -ne $best) "event_log: no entry with detectable writeback events_count found in tail"
Assert-True ($bestDelta -le $MaxDeltaSeconds) ("event_log: best ts too far from state_pack.updated_at (bestDelta=${bestDelta}s)")
Assert-True ($bestEvents -ge 1) ("event_log: correlated entry has events_count < 1 (bestDelta=${bestDelta}s)")

$bestTsStr = Get-EventTsString -Obj $best
$bestInv   = Get-InvSha12 -Obj $best
$sessionId = Get-PropValue -Obj $meta -Name "session_id"

# 6) retrieval_tap existence + parseable tail
Assert-True (Test-Path $rtPath) "missing: state/retrieval_tap.jsonl"
$retrNow = TailJsonl -Path $rtPath -N $TailLines
Assert-True ($retrNow.Count -ge 1) "retrieval_tap: no parseable entries found in tail"

$finishedAt = (Get-Date).ToString("o")

$report = [ordered]@{
  ok = $true
  started_at  = $startedAt
  finished_at = $finishedAt

  api = @{
    base_url = $BaseUrl
    canon_ops = @{
      ok = $canon.ok
      generated_at = $canon.generated_at
      artifact_count = $canon.artifact_count
      collisions_total = $canon.collisions_total
    }
    vector_store_files = @{
      vector_store_id = $vs.vector_store_id
      count = $vs.count
      first_file = if ($vs.count -gt 0) { $vs.files[0] } else { $null }
    }
  }

  state_pack = @{
    updated_at = $spUpdated
    queue_keys = $queueKeysSorted
    session_id = $sessionId
  }

  correlation = @{
    best_event_log_ts = $bestTsStr
    best_inv_sha12 = $bestInv
    best_events_count = $bestEvents
    best_delta_seconds = $bestDelta
    max_delta_seconds = $MaxDeltaSeconds
  }

  logs = @{
    event_log_tail_parseable = $eventNow.Count
    retrieval_tap_tail_parseable = $retrNow.Count
    event_log_tail_parseable_baseline = $eventBase.Count
    retrieval_tap_tail_parseable_baseline = $retrBase.Count
  }

  writeback_loop = @{
    script = $wbScript
    output = $wbOut
  }
}

$reportJson = ($report | ConvertTo-Json -Depth 20)
Set-Content -Path $outPath -Value $reportJson -Encoding UTF8
$sha = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash

"=== UI CAPABILITY SWEEP: PASS ==="
"report_file: $outPath"
"report_sha256: $sha"
$reportJson
