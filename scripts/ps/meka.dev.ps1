Set-Location C:\meka\meka-ui
$env:NODE_OPTIONS="--max-old-space-size=8192"
try {
  $portLine = netstat -ano | Select-String -Pattern ":3000\\s"
  if ($portLine) {
    pwsh .\\scripts\\ps\\meka.killport.ps1 -Port 3000
  }
} catch {
  # ignore port check errors
}
npm run dev
