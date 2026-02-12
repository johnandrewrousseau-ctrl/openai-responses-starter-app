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
  Write-Host ("PASS [{0}]" -f $Name)
}

function Write-Fail {
  param([string]$Name, [string]$Msg, [int]$ExitCode = 1)
  if ($Msg) {
    Write-Host ("FAIL [{0}] {1}" -f $Name, $Msg)
  } else {
    Write-Host ("FAIL [{0}]" -f $Name)
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
  param([string]$BaseUrl, [int]$TimeoutSec = 90)
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
  if (Test-Path (Join-Path $Root "pnpm-lock.yaml")) { return @{ FilePath = "pnpm"; Args = @("dev") } }
  if (Test-Path (Join-Path $Root "yarn.lock")) { return @{ FilePath = "yarn"; Args = @("dev") } }
  return @{ FilePath = "npm"; Args = @("run", "dev") }
}

$childProcs = @()

try {
  & pwsh -File .\scripts\ps\meka.killport.ps1 -Port $Port | Out-Host

  $dev = Get-DevCommand
  $serverProc = Start-Process -FilePath $dev.FilePath -ArgumentList $dev.Args -WorkingDirectory $Root -PassThru
  $childProcs += $serverProc

  if (-not (Wait-ServerReady -BaseUrl $Base -TimeoutSec 120)) {
    Stop-Children -Procs $childProcs
    Write-Fail "server_ready" "Server did not become ready at $Base/api/tool_status."
  }
  Write-Pass "server_ready"

  $watchThreads = Start-Process -FilePath "pwsh" -ArgumentList @("-File", ".\scripts\ps\meka.vs_watch.ps1", "-Base", $Base, "-Store", "threads") -WorkingDirectory $Root -PassThru
  $childProcs += $watchThreads
  Write-Pass "watch_threads_started"

  $watchCanon = Start-Process -FilePath "pwsh" -ArgumentList @("-File", ".\scripts\ps\meka.vs_watch.ps1", "-Base", $Base, "-Store", "canon") -WorkingDirectory $Root -PassThru
  $childProcs += $watchCanon
  Write-Pass "watch_canon_started"

  & pwsh -File .\scripts\ps\meka.smoke.ps1 -Base $Base | Out-Host
  $smokeExit = $LASTEXITCODE
  if ($smokeExit -ne 0) {
    Stop-Children -Procs $childProcs
    Write-Fail "meka_up_smoke" "Smoke failed." $smokeExit
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
