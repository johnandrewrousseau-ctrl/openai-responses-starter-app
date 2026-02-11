Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location C:\meka\meka-ui

Start-Process pwsh -ArgumentList ".\\scripts\\ps\\meka.vs_watch.ps1 -Store threads"
Start-Process pwsh -ArgumentList ".\\scripts\\ps\\meka.vs_watch.ps1 -Store canon"

Write-Host "Started watchers for threads and canon."
