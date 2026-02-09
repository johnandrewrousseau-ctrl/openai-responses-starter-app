Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Set-MekaRoot {
  param([string]$Root = "C:\meka\meka-ui")
  Set-Location $Root
}

function Repo-Grep {
  param(
    [Parameter(Mandatory=$true)][string]$Pattern,
    [string]$Path = "."
  )
  # Prefer git grep for consistency + speed
  Set-MekaRoot
  git grep -n --full-name --no-color -- $Pattern -- $Path
}

function Get-AdminHeaders {
  param([string]$EnvFile = ".\.env.local")
  Set-MekaRoot
  $line  = (Select-String -Path $EnvFile -Pattern '^\s*MEKA_ADMIN_TOKEN\s*=' -ErrorAction Stop | Select-Object -First 1).Line
  $token = ($line -split "=",2)[1].Trim()
  if([string]::IsNullOrWhiteSpace($token)){ throw "MEKA_ADMIN_TOKEN empty in $EnvFile" }
  return @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
}

function Invoke-ApiPost {
  param(
    [Parameter(Mandatory=$true)][string]$Url,
    [hashtable]$Headers,
    [Parameter(Mandatory=$true)][string]$Body,
    [int]$TimeoutSec = 20
  )
  if(-not $Headers){ $Headers = @{ "Content-Type"="application/json" } }
  return Invoke-WebRequest -Method Post -Uri $Url -Headers $Headers -Body $Body -TimeoutSec $TimeoutSec -SkipHttpErrorCheck -ContentType "application/json"
}

function Invoke-ApiGet {
  param(
    [Parameter(Mandatory=$true)][string]$Url,
    [hashtable]$Headers,
    [int]$TimeoutSec = 20
  )
  if(-not $Headers){ $Headers = @{} }
  return Invoke-WebRequest -Method Get -Uri $Url -Headers $Headers -TimeoutSec $TimeoutSec -SkipHttpErrorCheck
}

function Probe-ApiMethods {
  param([Parameter(Mandatory=$true)][string]$Url)
  $rPost = Invoke-WebRequest -Method Post -Uri $Url -ContentType "application/json" -Body "{}" -TimeoutSec 10 -SkipHttpErrorCheck
  $rGet  = Invoke-WebRequest -Method Get  -Uri $Url -TimeoutSec 10 -SkipHttpErrorCheck
  [pscustomobject]@{
    url       = $Url
    post_code = $rPost.StatusCode
    get_code  = $rGet.StatusCode
  }
}

function Smoke-ToolsGate {
  Set-MekaRoot
  & "scripts\smoke_tools_gate.ps1"
}
