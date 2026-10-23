# Yubikiri hostname-mode TEARDOWN (Windows, PowerShell).
# Keep ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.
# Reverts everything the setup did: removes the trusted root CA, resets the
# system proxy to disabled, and deletes the local CA key/cert folder so the
# browser returns to normal behavior. Run this, then stop the agent
# (Ctrl+C in the hostname-agent window).

$ErrorActionPreference = 'SilentlyContinue'
$CaDir = Join-Path $HOME '.yubikiri-hostname'
$CaCert = Join-Path $CaDir 'ca.cert.pem'

# 1) remove the trusted root CA (by thumbprint of our ca.cert.pem)
if (Test-Path $CaCert) {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CaCert
  if ($cert) {
    Get-ChildItem 'Cert:\CurrentUser\Root' | Where-Object { $_.Thumbprint -eq $cert.Thumbprint } | Remove-Item
    Write-Host "Removed the trusted root CA (Thumbprint=$($cert.Thumbprint))"
  }
}

# 2) reset system proxy
$iePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $iePath -Name ProxyEnable -Type DWord -Value 0
Remove-ItemProperty -Path $iePath -Name AutoConfigURL
Write-Host 'System proxy disabled.'

# 3) delete local CA folder (key + cert)
if (Test-Path $CaDir) {
  Remove-Item -Recurse -Force $CaDir
  Write-Host "Deleted the local CA folder: $CaDir"
}

Write-Host ''
Write-Host 'Done. Restart your browser to return to normal.'
