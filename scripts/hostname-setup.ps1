# Yubikiri hostname-mode SETUP (Windows, PowerShell).
# Keep ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.
# 1) installs the local root CA into the CurrentUser trust store (Chrome/Edge
#    trust it; no admin required, but Windows shows a security prompt), and
# 2) points the system proxy at the local relay via its PAC URL.
#
# Run AFTER starting the agent:  npm run hostname-agent
# Revert everything with:        .\scripts\hostname-teardown.ps1

$ErrorActionPreference = 'Stop'
$Port = if ($env:LOCAL_PROXY_PORT) { $env:LOCAL_PROXY_PORT } else { '8899' }
$CaCert = Join-Path $HOME '.yubikiri-hostname\ca.cert.pem'
$PacUrl = "http://127.0.0.1:$Port/proxy.pac"

if (-not (Test-Path $CaCert)) {
  Write-Error "CA cert not found: $CaCert - start 'npm run hostname-agent' first so it is generated."
}

# 1) trust the root CA (CurrentUser\Root)
$thumb = (Import-Certificate -FilePath $CaCert -CertStoreLocation 'Cert:\CurrentUser\Root').Thumbprint
Write-Host "Trusted the root CA (Thumbprint=$thumb)"

# 2) enable system proxy -> PAC
$iePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $iePath -Name ProxyEnable -Type DWord -Value 1
Set-ItemProperty -Path $iePath -Name AutoConfigURL -Type String -Value $PacUrl
Write-Host "System proxy set to PAC: $PacUrl"

Write-Host ''
Write-Host 'Done. Restart your browser to apply.'
Write-Host 'To revert, run scripts\hostname-teardown.ps1'
