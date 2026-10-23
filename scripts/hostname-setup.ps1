# Yubikiri hostname-mode SETUP (Windows, PowerShell).
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
  Write-Error "CA証明書が見つかりません: $CaCert`n先に 'npm run hostname-agent' を起動して生成してください。"
}

# 1) trust the root CA (CurrentUser\Root)
$thumb = (Import-Certificate -FilePath $CaCert -CertStoreLocation 'Cert:\CurrentUser\Root').Thumbprint
Write-Host "ルートCAを信頼登録しました (Thumbprint=$thumb)"

# 2) enable system proxy -> PAC
$iePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $iePath -Name ProxyEnable -Type DWord -Value 1
Set-ItemProperty -Path $iePath -Name AutoConfigURL -Type String -Value $PacUrl
Write-Host "システムプロキシをPACへ設定しました: $PacUrl"

Write-Host ''
Write-Host '設定完了。ブラウザを一度再起動すると反映されます。'
Write-Host '解除は .\scripts\hostname-teardown.ps1 を実行してください。'
