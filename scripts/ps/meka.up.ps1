param(
  [int]$Port = 3000,
  [string]$Base = "http://localhost:3000"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui
$Root = (Resolve-Path ".").Path

if ([string]::IsNullOrWhiteSpace($Base)) {
  $Base = "http://localhost:$Port"
}

function Write-Pass {
  param([string]$Name)
  Write-Output ("PASS [{0}]" -f $Name)
}

function Write-Fail {
  param([string]$Name, [string]$Msg, [int]$ExitCode = 1)
  if ($Msg) {
    Write-Output ("FAIL [{0}] {1}" -f $Name, $Msg)
  } else {
    Write-Output ("FAIL [{0}]" -f $Name)
  }
  exit $ExitCode
}

function Stop-Children {
  param([System.Diagnostics.Process[]]$Procs)
  foreach ($p in $Procs) {
    if ($null -eq $p) { continue }
    if ($p.HasExited) { continue }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Wait-ServerReady {
  param([string]$BaseUrl, [int]$TimeoutSec = 180)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    try {
      $resp = Invoke-WebRequest "$BaseUrl/api/tool_status" -Method Get -SkipHttpErrorCheck -TimeoutSec 5
      if ($resp.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-DevCommand {
  if (Test-Path (Join-Path $Root "pnpm-lock.yaml")) { return @{ FilePath = "cmd.exe"; Args = @("/c", "pnpm dev") } }
  if (Test-Path (Join-Path $Root "yarn.lock")) { return @{ FilePath = "cmd.exe"; Args = @("/c", "yarn dev") } }
  return @{ FilePath = "cmd.exe"; Args = @("/c", "npm run dev") }
}

$childProcs = @()

try {
  & pwsh -File .\scripts\ps\meka.killport.ps1 -Port $Port | Out-Host

  $dev = Get-DevCommand
  $logDir = Join-Path $Root "state"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $serverLog = Join-Path $logDir "meka.up.server.log"
  $serverErr = Join-Path $logDir "meka.up.server.err.log"
  $serverProc = Start-Process -FilePath $dev.FilePath -ArgumentList $dev.Args -WorkingDirectory $Root -PassThru -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
  $childProcs += $serverProc

  Start-Sleep -Seconds 2
  if ($serverProc.HasExited) {
    Stop-Children -Procs $childProcs
    Write-Fail "server_start_failed" "Dev server exited early. Check $serverLog and $serverErr."
  }

  if (-not (Wait-ServerReady -BaseUrl $Base -TimeoutSec 180)) {
    Stop-Children -Procs $childProcs
    Write-Fail "server_ready" "Server did not become ready at $Base/api/tool_status."
  }
  Write-Pass "server_ready"

  $syncLog = Join-Path $logDir "meka.up.vs_sync.log"
  & pwsh -File .\scripts\ps\meka.vs_sync.ps1 2>&1 | Set-Content -Path $syncLog -Encoding UTF8
  $syncExit = $LASTEXITCODE
  if ($syncExit -ne 0) {
    Stop-Children -Procs $childProcs
    Write-Fail "vs_sync_failed" "Initial vector store sync failed. Check $syncLog." $syncExit
  }
  Write-Pass "vs_sync_ok"

  $watchThreads = Start-Process -FilePath "pwsh" -ArgumentList @("-File", ".\scripts\ps\meka.vs_watch.ps1", "-Base", $Base, "-Store", "threads") -WorkingDirectory $Root -PassThru
  $childProcs += $watchThreads
  Write-Pass "watch_threads_started"

  $watchCanon = Start-Process -FilePath "pwsh" -ArgumentList @("-File", ".\scripts\ps\meka.vs_watch.ps1", "-Base", $Base, "-Store", "canon") -WorkingDirectory $Root -PassThru
  $childProcs += $watchCanon
  Write-Pass "watch_canon_started"

  $smokeLog = Join-Path $logDir "meka.up.smoke.log"
  & pwsh -File .\scripts\ps\meka.smoke.ps1 -Base $Base 2>&1 | Set-Content -Path $smokeLog -Encoding UTF8
  $smokeExit = $LASTEXITCODE
  if ($smokeExit -ne 0) {
    Stop-Children -Procs $childProcs
    Write-Fail "meka_up_smoke" "Smoke failed. Check $smokeLog." $smokeExit
  }
  Write-Pass "smoke_ok"
  Write-Pass "meka_up_ready"

  if ($env:MEKA_UP_EXIT_AFTER_SMOKE -eq "1") {
    return
  }

  $script:stopRequested = $false
  $null = Register-EngineEvent -SourceIdentifier "PowerShell.Exiting" -Action { $script:stopRequested = $true }
  [console]::CancelKeyPress += {
    $script:stopRequested = $true
    $_.Cancel = $true
  }

  while (-not $script:stopRequested) {
    if ($serverProc.HasExited) {
      $script:stopRequested = $true
      break
    }
    Start-Sleep -Seconds 1
  }
}
finally {
  Stop-Children -Procs $childProcs
}
