Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui

# Paths
$reqPath = ".\state\_req_turn_response.json"
$hdrPath = ".\state\_last_headers.txt"
$outPath = ".\state\_last_response.txt"
$ssePath = ".\state\_last_sse.txt"

# Nonce
$nonce = ([guid]::NewGuid().ToString("N")).Substring(0,8)

# BEFORE
$beforeEvent = Get-Content .\state\event_log.jsonl -Tail 1 -Encoding utf8
$beforeSP = Get-Content .\state\state_pack.json -Raw -Encoding utf8 | ConvertFrom-Json
$beforeMeta = $beforeSP.meta.updated_at
$beforeRoot = $beforeSP.updated_at

# Build request JSON to disk (prevents quoting corruption)
$reqObj = @{
  messages = @(
    @{ role = "user"; content = "Explain ASEM-0 in one paragraph. nonce=$nonce" }
  )
}
$reqJson = $reqObj | ConvertTo-Json -Depth 10
Set-Content -Path $reqPath -Value $reqJson -Encoding utf8 -NoNewline

# Call API (non-stream) and capture
$code = curl.exe -sS -X POST "http://localhost:3000/api/turn_response" `
  -H "Content-Type: application/json" `
  --data-binary "@$reqPath" `
  -D "$hdrPath" `
  -o "$outPath" `
  -w "%{http_code}"

if ($code -ne "200") {
  Write-Host "HTTP status: $code"
  Write-Host "---- RESPONSE HEADERS (first 50 lines) ----"
  Get-Content $hdrPath -Encoding utf8 | Select-Object -First 50
  Write-Host "---- RESPONSE BODY (first 200 lines) ----"
  Get-Content $outPath -Encoding utf8 | Select-Object -First 200
  throw "FAIL: /api/turn_response did not return 200."
}

# Prove request hit server (nonce in retrieval_tap request line)
$hits = Select-String -Path .\state\retrieval_tap.jsonl -Pattern "nonce=$nonce"
if (-not $hits) { throw "FAIL: nonce not found in retrieval_tap.jsonl (request not observed)." }

# Stream and prove suppression (BEGIN/END must NOT appear)
curl.exe -N -sS -X POST "http://localhost:3000/api/turn_response" `
  -H "Content-Type: application/json" `
  --data-binary "@$reqPath" |
  Tee-Object -FilePath $ssePath | Out-Null

$markers = Select-String -Path $ssePath -Pattern "BEGIN_WRITEBACK_JSON|END_WRITEBACK_JSON"
if ($markers) { throw "FAIL: writeback markers leaked into client-visible SSE." }

# AFTER
$afterEvent = Get-Content .\state\event_log.jsonl -Tail 1 -Encoding utf8
$afterSP = Get-Content .\state\state_pack.json -Raw -Encoding utf8 | ConvertFrom-Json
$afterMeta = $afterSP.meta.updated_at
$afterRoot = $afterSP.updated_at

if ($afterMeta -eq $beforeMeta) { throw "FAIL: meta.updated_at did not change." }
if ($afterRoot -eq $beforeRoot) { throw "FAIL: root updated_at did not change." }
if ($afterEvent -eq $beforeEvent) { throw "FAIL: event_log tail did not change." }

Write-Host "PASS Step 11:"
Write-Host "  nonce=$nonce"
Write-Host "  meta.updated_at: $beforeMeta -> $afterMeta"
Write-Host "  updated_at:      $beforeRoot -> $afterRoot"
Write-Host "  event_log advanced"
Write-Host "  SSE markers suppressed"
