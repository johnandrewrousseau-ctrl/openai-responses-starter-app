param(
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference="Stop"
$Root="C:\meka\meka-ui"
Set-Location $Root

function Head([string]$s,[int]$n){
  if([string]::IsNullOrEmpty($s)){"<empty>"} else {$s.Substring(0,[Math]::Min($n,$s.Length))}
}

# Admin token
$line  = (Select-String -Path ".\.env.local" -Pattern '^\s*MEKA_ADMIN_TOKEN\s*=' -ErrorAction Stop | Select-Object -First 1).Line
$token = ($line -split "=",2)[1].Trim()
if([string]::IsNullOrWhiteSpace($token)){ throw "MEKA_ADMIN_TOKEN empty in .env.local" }
$hAdmin = @{ Authorization = "Bearer $token" }

# Wait for server
for($i=0;$i -lt 80;$i++){
  if((Test-NetConnection -ComputerName "localhost" -Port 3000).TcpTestSucceeded){ break }
  Start-Sleep -Milliseconds 250
}
if(-not (Test-NetConnection -ComputerName "localhost" -Port 3000).TcpTestSucceeded){
  throw "Server not reachable on :3000"
}

# Force tool flags ON via tool_status (admin)
$bodyEnable = @{
  fileSearchEnabled = $true
  webSearchEnabled = $false
  functionsEnabled = $true
  googleIntegrationEnabled = $false
  mcpEnabled = $false
  codeInterpreterEnabled = $false
} | ConvertTo-Json -Depth 10

$tsAdmin = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/tool_status" -Headers $hAdmin `
  -ContentType "application/json" -Body $bodyEnable -TimeoutSec 15

if(-not $tsAdmin.ok){ throw "tool_status admin POST failed" }
if(-not $tsAdmin.functions_enabled){ throw "Expected functions_enabled true after admin tool_status POST" }

# Prepare turn_response body (inline tool)
$turnBody = @{
  messages = @(@{ role="user"; content="fs_list root=repo path=." })
  toolsState = @{}
} | ConvertTo-Json -Depth 10

# NO AUTH call: must NOT include entries/abs_path (plain or escaped)
$rNo = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/turn_response" `
  -ContentType "application/json" -Body $turnBody -TimeoutSec 30 -SkipHttpErrorCheck
$cNo = [string]$rNo.Content

if($rNo.StatusCode -ne 200){ throw "NO AUTH expected HTTP 200; got $($rNo.StatusCode)" }
if(($cNo -match '\\\"entries\\\"') -or ($cNo -match '\\\"abs_path\\\"') -or ($cNo -match '"entries"\s*:') -or ($cNo -match '"abs_path"\s*:')){
  throw ("NO AUTH regression: inline tool executed. head=" + (Head $cNo 260))
}

# ADMIN call: must include entries/abs_path (escaped OR plain)
$rAd = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/turn_response" `
  -Headers $hAdmin -ContentType "application/json" -Body $turnBody -TimeoutSec 30 -SkipHttpErrorCheck
$cAd = [string]$rAd.Content

if($rAd.StatusCode -ne 200){ throw "ADMIN expected HTTP 200; got $($rAd.StatusCode)" }
$hasEntries = ($cAd -match '\\\"entries\\\"') -or ($cAd -match '"entries"\s*:')
$hasAbsPath = ($cAd -match '\\\"abs_path\\\"') -or ($cAd -match '"abs_path"\s*:')
if(-not ($hasEntries -and $hasAbsPath)){
  throw ("ADMIN regression: inline tool did not execute. head=" + (Head $cAd 260))
}

"OK: inline tool gate enforced (NO AUTH blocked, ADMIN allowed) + tool_status admin enable confirmed."
