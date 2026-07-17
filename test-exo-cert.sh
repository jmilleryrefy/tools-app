#!/usr/bin/env bash
# Tests Exchange Online app-only certificate authentication using the same
# env vars the tools-app passes to scripts. Run after completing the Entra
# portal setup (cert upload, Exchange.ManageAsApp consent, role assignment).
set -u

ENV_FILE="/home/yrefy-it/tools-app/.env"

get_var() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'
}

export EXO_APP_ID="$(get_var AUTH_MICROSOFT_ENTRA_ID_ID)"
export EXO_ORGANIZATION="$(get_var EXO_ORGANIZATION)"
[ -z "$EXO_ORGANIZATION" ] && export EXO_ORGANIZATION="$(get_var AUTH_MICROSOFT_ENTRA_ID_TENANT_ID)"
export EXO_CERT_PATH="$(get_var EXO_CERT_PATH)"
export EXO_CERT_PASSWORD="$(get_var EXO_CERT_PASSWORD)"

echo "AppId:        $EXO_APP_ID"
echo "Organization: $EXO_ORGANIZATION"
echo "Cert path:    $EXO_CERT_PATH"

pwsh -NoProfile -NonInteractive -Command '
  Import-Module ExchangeOnlineManagement
  try {
    Connect-ExchangeOnline -AppId $env:EXO_APP_ID `
      -CertificateFilePath $env:EXO_CERT_PATH `
      -CertificatePassword (ConvertTo-SecureString $env:EXO_CERT_PASSWORD -AsPlainText -Force) `
      -Organization $env:EXO_ORGANIZATION `
      -ShowBanner:$false -SkipLoadingFormatData -ErrorAction Stop
    Write-Host "CONNECT OK" -ForegroundColor Green
    Get-DistributionGroup -ResultSize 1 | Select-Object DisplayName, PrimarySmtpAddress
    Disconnect-ExchangeOnline -Confirm:$false
    Write-Host "TEST PASSED" -ForegroundColor Green
  } catch {
    Write-Host "TEST FAILED:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
  }
'
