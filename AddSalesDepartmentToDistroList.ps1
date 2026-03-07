#Requires -Modules Microsoft.Graph.Authentication, Microsoft.Graph.Users, ExchangeOnlineManagement

function Ensure-GraphConnection {
    param([string[]]$Scopes = @("User.Read.All"))

    try {
        $ctx = Get-MgContext -ErrorAction Stop
        if (-not $ctx -or -not $ctx.Account) { throw "Not connected." }
    } catch {
        Write-Host "Connecting to Microsoft Graph (interactive)..." -ForegroundColor Cyan
        Connect-MgGraph -Scopes $Scopes | Out-Null
    }

    Write-Host ("Graph connected as: {0}" -f (Get-MgContext).Account) -ForegroundColor Green
}

function Ensure-EXOConnection {
    try {
        Get-EXOOrganizationConfig -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "Connecting to Exchange Online (interactive)..." -ForegroundColor Cyan
        Connect-ExchangeOnline -ShowBanner:$false
    }
    Write-Host "Exchange Online connected." -ForegroundColor Green
}

function Get-UsersByDepartmentFromGraph {
    param([Parameter(Mandatory=$true)][string]$Department)

    $escaped = $Department.Replace("'", "''")
    $filter = "department eq '$escaped'"

    $users = Get-MgUser `
        -Filter $filter `
        -All `
        -Property "displayName,userPrincipalName,mail,department,accountEnabled,userType" `
        -ErrorAction Stop

    $users | Where-Object {
        $_.AccountEnabled -ne $false -and $_.UserType -ne "Guest"
    }
}

function Get-TargetRecipientAddress {
    param([Parameter(Mandatory=$true)][object]$User)
    if (-not [string]::IsNullOrWhiteSpace($User.Mail)) { return $User.Mail }
    return $User.UserPrincipalName
}

# -------------------------
# Main (interactive)
# -------------------------
$defaultDept = "Sales"
$defaultDL   = "studentloanadvocates@yrefy.com"

$dept = Read-Host "Department to include (default: $defaultDept)"
if ([string]::IsNullOrWhiteSpace($dept)) { $dept = $defaultDept }

$dlIdentity = Read-Host "Distribution List identity (name or email) (default: $defaultDL)"
if ([string]::IsNullOrWhiteSpace($dlIdentity)) { $dlIdentity = $defaultDL }

Ensure-GraphConnection
Ensure-EXOConnection

Write-Host "Validating DL exists in Exchange Online..." -ForegroundColor Cyan
$dl = Get-DistributionGroup -Identity $dlIdentity -ErrorAction Stop
Write-Host ("Found DL: {0}  |  PrimarySmtp: {1}" -f $dl.DisplayName, $dl.PrimarySmtpAddress) -ForegroundColor Green

Write-Host "Fetching Graph users where Department = '$dept' ..." -ForegroundColor Cyan
$users = Get-UsersByDepartmentFromGraph -Department $dept

if (-not $users -or $users.Count -eq 0) {
    Write-Warning "No enabled (non-guest) users found with department '$dept'. Nothing to do."
    return
}

Write-Host ("Users found: {0}" -f $users.Count) -ForegroundColor Green
Write-Host "Preview (first 10):" -ForegroundColor Gray
$users | Select-Object -First 10 displayName, userPrincipalName, mail, department | Format-Table -AutoSize

$confirm = Read-Host "Add these users to DL '$($dl.PrimarySmtpAddress)'? Type YES to proceed"
if ($confirm -ne "YES") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    return
}

# No membership pre-load. Just attempt adds and handle duplicates.
$added = 0
$skipped = 0
$failed = 0

foreach ($u in $users) {
    $addr = Get-TargetRecipientAddress -User $u

    try {
        Add-DistributionGroupMember -Identity $dl.Identity -Member $addr -ErrorAction Stop
        $added++
        Write-Host ("Added: {0} <{1}>" -f $u.DisplayName, $addr) -ForegroundColor Green
    } catch {
        $msg = $_.Exception.Message

        if ($msg -match "is already a member" -or $msg -match "already.*member") {
            $skipped++
            Write-Host ("Skipped (already member): {0} <{1}>" -f $u.DisplayName, $addr) -ForegroundColor DarkYellow
        } else {
            $failed++
            Write-Warning ("Failed to add {0} <{1}>: {2}" -f $u.DisplayName, $addr, $msg)
        }
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("Added:   {0}" -f $added)
Write-Host ("Skipped: {0}" -f $skipped)
Write-Host ("Failed:  {0}" -f $failed)
