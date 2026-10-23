# Yubikiri hostname-mode TEARDOWN (Windows, PowerShell).
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
    Write-Host "信頼登録したルートCAを削除しました (Thumbprint=$($cert.Thumbprint))"
  }
}

# 2) reset system proxy
$iePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $iePath -Name ProxyEnable -Type DWord -Value 0
Remove-ItemProperty -Path $iePath -Name AutoConfigURL
Write-Host 'システムプロキシを無効化しました。'

# 3) delete local CA folder (key + cert)
if (Test-Path $CaDir) {
  Remove-Item -Recurse -Force $CaDir
  Write-Host "ローカルCAフォルダを削除しました: $CaDir"
}

Write-Host ''
Write-Host '解除完了。ブラウザを一度再起動すると通常動作に戻ります。'
