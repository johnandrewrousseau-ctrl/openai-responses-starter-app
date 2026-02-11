Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui

Start-Process pwsh -ArgumentList ".\\scripts\\ps\\meka.vs_watch.ps1 -Store threads -Replace"
Start-Process pwsh -ArgumentList ".\\scripts\\ps\\meka.vs_watch.ps1 -Store canon -Replace"

Write-Host "Started watchers for threads and canon."
