Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Get-Location).Path
$state = Join-Path $root 'state'
$el = Join-Path $state 'event_log.jsonl'
$rt = Join-Path $state 'retrieval_tap.jsonl'
$sp = Join-Path $state 'state_pack.json'

function TailJsonl([string]$path, [int]$n) {
  if (!(Test-Path $path)) { return @() }
  Get-Content $path -Tail $n -Encoding UTF8 | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace($_)) { return $null }
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object { $_ -ne $null }
}

$events = TailJsonl $el 400
$retr   = TailJsonl $rt 400

$spObj = $null
if (Test-Path $sp) { $spObj = Get-Content $sp -Raw -Encoding UTF8 | ConvertFrom-Json }

$toolish = @()
$toolish += $events | Where-Object {
  (($_.PSObject.Properties['type'] -and ($_.type -match 'tool|retrieval|function|web|search|writeback|canon|vector|api')) -or
   ($_.PSObject.Properties['detail'] -and ($_.detail -match 'file_search|web|vector|canon|writeback|retrieval|tool|function')) -or
   ($_.PSObject.Properties['writeback'] -and $_.writeback))
}

$toolish = $toolish | Select-Object -Last 80

$queueKeys = @()
if ($spObj -and $spObj.queue) { $queueKeys = @($spObj.queue.PSObject.Properties.Name) }

$summary = [ordered]@{
  now = (Get-Date).ToString('o')
  state_pack_updated_at = if ($spObj) { $spObj.updated_at } else { $null }
  state_pack_queue_keys = $queueKeys
  event_log_tail_count = $events.Count
  retrieval_tap_tail_count = $retr.Count
  toolish_tail_count = $toolish.Count
}

'=== UI TOOL SMOKE REPORT (AUTO) ==='
($summary | ConvertTo-Json -Depth 10)
'=== TOOLISH TAIL (LAST 80) ==='
($toolish | ConvertTo-Json -Depth 12)
