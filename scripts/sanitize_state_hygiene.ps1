$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root "state"

$statePack    = Join-Path $stateDir "state_pack.json"
$eventLog     = Join-Path $stateDir "event_log.jsonl"
$retrievalTap = Join-Path $stateDir "retrieval_tap.jsonl"

# WriteBack markers
$wbStart = "BEGIN_WRITEBACK_JSON"
$wbEnd   = "END_WRITEBACK_JSON"

function Strip-WritebackBlocks([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return "" }
  # (?s) = singleline (dot matches newline)
  return ($s -replace "(?s)$wbStart.*?$wbEnd", "")
}

Write-Host "Sanitizing state hygiene under: $stateDir"

# --- state_pack.json (use node to parse+rewrite safely) ---
if (Test-Path $statePack) {
  Write-Host "Sanitizing state_pack.json via node (parse -> strip -> clamp -> rewrite)..."

  # Node script: strip writeback blocks from full JSON text, parse, clamp notes, rewrite pretty JSON.
  $js = @"
const fs = require("fs");
const p = process.argv[2]; // argv[0]=node, argv[1]=script, argv[2]=first param
if (!p) {
  console.error("missing path argument");
  process.exit(2);
}
let s = fs.readFileSync(p, "utf8");

// strip BOM if present
if (s.length && s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

// remove writeback blocks (dotAll)
s = s.replace(/BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g, "");

// parse + clamp notes tail (keeps JSON valid)
const j = JSON.parse(s);
if (typeof j.notes === "string") {
  const MAX = 200000; // generous, but prevents runaway files
  if (j.notes.length > MAX) j.notes = j.notes.slice(j.notes.length - MAX);
}

// best-effort sanitize text-like fields inside events (if present)
if (Array.isArray(j.events)) {
  for (const ev of j.events) {
    if (!ev || typeof ev !== "object") continue;
    for (const k of ["text","message","content","notes"]) {
      if (typeof ev[k] === "string") {
        ev[k] = ev[k].replace(/BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g, "");
      }
    }
  }
}

fs.writeFileSync(p, JSON.stringify(j, null, 2), "utf8");
"@

  $tmp = Join-Path $env:TEMP ("sanitize_state_pack_" + [guid]::NewGuid().ToString("n") + ".js")
  Set-Content -Path $tmp -Value $js -Encoding UTF8

  try {
    & node $tmp $statePack | Out-Null
    Write-Host "OK: sanitized state_pack.json"
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }
} else {
  Write-Host "SKIP: state_pack.json not present"
}

# --- event_log.jsonl (line sanitize; keep JSONL shape) ---
if (Test-Path $eventLog) {
  Write-Host "Sanitizing event_log.jsonl..."
  $lines = Get-Content $eventLog -Encoding UTF8
  $newLines = foreach ($l in $lines) {
    if ([string]::IsNullOrWhiteSpace($l)) { continue }
    Strip-WritebackBlocks $l
  }
  Set-Content -Path $eventLog -Value $newLines -Encoding UTF8
  Write-Host "OK: sanitized event_log.jsonl"
} else {
  Write-Host "SKIP: event_log.jsonl not present"
}

# --- retrieval_tap.jsonl (line sanitize) ---
if (Test-Path $retrievalTap) {
  Write-Host "Sanitizing retrieval_tap.jsonl..."
  $lines = Get-Content $retrievalTap -Encoding UTF8
  $newLines = foreach ($l in $lines) {
    if ([string]::IsNullOrWhiteSpace($l)) { continue }
    Strip-WritebackBlocks $l
  }
  Set-Content -Path $retrievalTap -Value $newLines -Encoding UTF8
  Write-Host "OK: sanitized retrieval_tap.jsonl"
} else {
  Write-Host "SKIP: retrieval_tap.jsonl not present"
}

Write-Host "Done."
