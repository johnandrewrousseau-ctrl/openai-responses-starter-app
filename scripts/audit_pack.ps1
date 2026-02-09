# scripts/audit_pack.ps1
# Deterministic evidence pack for MEKA tool substrate + routes + injection points
# Run from repo root:  .\scripts\audit_pack.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = "C:\meka\meka-ui"
Set-Location $Root

function Show-Header([string]$t) {
  Write-Host ""
  Write-Host ("=" * 90)
  Write-Host $t
  Write-Host ("=" * 90)
}

function Require-Path([string]$p, [string]$why) {
  if (-not (Test-Path $p)) {
    Write-Host "MISSING: $p"
    throw "Repo root mismatch or missing file: $why"
  }
}

function Slice-Context {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][int]$Line,
    [int]$Before = 30,
    [int]$After = 60
  )
  $lines = Get-Content $Path
  $start = [Math]::Max(1, $Line - $Before)
  $end = [Math]::Min($lines.Length, $Line + $After)
  for ($i=$start; $i -le $end; $i++) {
    $prefix = if ($i -eq $Line) { ">>" } else { "  " }
    "{0}{1,6}: {2}" -f $prefix, $i, $lines[$i-1]
  }
}

function Invoke-LocalJson([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing -TimeoutSec 5
    Write-Host ("OK {0} {1}" -f $r.StatusCode, $url)
    if ($r.Content) { $r.Content }
  } catch {
    Write-Host ("FAIL {0}" -f $url)
    $_.Exception.Message
  }
}

# --- Preflight: prove we're in the right repo root ---
Show-Header "0) PREFLIGHT (REPO IDENTITY)"
Require-Path ".\package.json" "package.json should exist at repo root"
Require-Path ".\app\api" "Next app router api folder should exist"
Require-Path ".\config\tools-list.ts" "tools list must exist"
Require-Path ".\config\functions.ts" "functions map must exist"
Write-Host ("PWD = {0}" -f (Get-Location).Path)
Write-Host ("Node = {0}" -f (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue))
Write-Host ("NPM  = {0}" -f (Get-Command npm  -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue))

Show-Header "A) REPO SNAPSHOT"
git status | Out-Host
git rev-parse --abbrev-ref HEAD | Out-Host
git rev-parse HEAD | Out-Host

Show-Header "B) API ROUTES MAP"
Get-ChildItem -Recurse -File -Filter "route.ts" .\app\api |
  Select-Object -ExpandProperty FullName |
  Sort-Object |
  ForEach-Object { $_ } | Out-Host

Show-Header "C) TOOL DEFINITIONS (WHERE THEY LIVE)"
$toolPatterns = @(
  "handleTool\(",
  "functionsMap",
  "toolsList",
  "MEKA_FS_ENABLE",
  "MEKA_ADMIN_TOKEN",
  "\bfs_read\b",
  "\bfs_list\b",
  "\bfs_prepare\b",
  "\bfs_patch\b",
  "\bfs_replace\b",
  "\bfs_propose_change\b",
  "/api/fs/",
  "/api/tools/"
)

$toolHits = Select-String -Path .\**\*.ts,.\**\*.tsx -Pattern ($toolPatterns -join "|") |
  Sort-Object Path, LineNumber

$toolHits | ForEach-Object { "{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line } | Out-Host

Show-Header "D) TOOL INJECTION POINTS (OPENAI REQUEST CONSTRUCTION)"
$injPatterns = @(
  "responses\.create",
  "\btools\b",
  "tools:",
  "tool_choice",
  "function_call",
  "functionsEnabled",
  "fileSearchEnabled",
  "webSearchEnabled",
  "mcpEnabled",
  "allowed_tools"
)

$inj = Select-String -Path .\app\api\**\*.ts,.\lib\**\*.ts,.\components\**\*.tsx,.\stores\**\*.ts `
  -Pattern ($injPatterns -join "|") |
  Sort-Object Path, LineNumber

$inj | ForEach-Object { "{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line } | Out-Host

Show-Header "E) CONTEXT SLICES AROUND TOOL SURFACE FILES"
$focusFiles = @(
  ".\config\tools-list.ts",
  ".\config\functions.ts",
  ".\lib\fs_guard.ts",
  ".\lib\assistant.ts",
  ".\lib\openai_client.ts",
  ".\stores\useToolsStore.ts",
  ".\components\mcp-config.tsx"
)

foreach ($f in $focusFiles) {
  if (Test-Path $f) {
    Write-Host ""
    Write-Host ("--- FILE: " + $f + " ---")
    $content = Get-Content $f
    $max = [Math]::Min(160, $content.Length)
    for ($i=1; $i -le $max; $i++) {
      "{0,6}: {1}" -f $i, $content[$i-1]
    }
  } else {
    Write-Host ("--- FILE MISSING: " + $f + " ---")
  }
}

Show-Header "F) SERVER RUNTIME EVIDENCE (CROSS-PROCESS; NO SECRETS)"
# These endpoints reflect the *Next server process*, not this PowerShell process.
Invoke-LocalJson "http://localhost:3000/api/fs/self_test"
Invoke-LocalJson "http://localhost:3000/api/tool_status"
Invoke-LocalJson "http://localhost:3000/api/state_pack"
Invoke-LocalJson "http://localhost:3000/api/retrieval_trace"

Show-Header "DONE"
