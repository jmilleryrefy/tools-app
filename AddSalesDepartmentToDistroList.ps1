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
$users | Select-Object displayName, userPrincipalName, mail | Format-Table -AutoSize

$confirm = Read-Host "Add these users to DL '$($dl.PrimarySmtpAddress)'? Type YES to proceed"
if ($confirm -ne "YES") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    return
}

# Pre-load existing DL members so we only make API calls for new additions.
Write-Host "Loading current DL members (bulk fetch)..." -ForegroundColor Cyan
$existingMembers = Get-DistributionGroupMember -Identity $dl.Identity -ResultSize Unlimited -ErrorAction Stop
$existingSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($m in $existingMembers) {
    if ($m.PrimarySmtpAddress) { [void]$existingSet.Add($m.PrimarySmtpAddress) }
    if ($m.WindowsLiveID)      { [void]$existingSet.Add($m.WindowsLiveID) }
}
Write-Host ("Existing DL members loaded: {0}" -f $existingSet.Count) -ForegroundColor Green

# Separate users into those needing adds vs already members.
$toAdd   = [System.Collections.Generic.List[object]]::new()
$toSkip  = [System.Collections.Generic.List[object]]::new()
$noMail  = [System.Collections.Generic.List[object]]::new()

foreach ($u in $users) {
    $addr = Get-TargetRecipientAddress -User $u

    if ([string]::IsNullOrWhiteSpace($u.Mail)) {
        $noMail.Add($u)
    }

    if ($existingSet.Contains($addr)) {
        $toSkip.Add($u)
    } else {
        $toAdd.Add($u)
    }
}

# Report users with no Mail attribute.
if ($noMail.Count -gt 0) {
    Write-Host ""
    Write-Host ("Note: {0} user(s) have no Mail attribute (using UPN instead):" -f $noMail.Count) -ForegroundColor Yellow
    foreach ($u in $noMail) {
        Write-Host ("  - {0} <{1}>" -f $u.DisplayName, $u.UserPrincipalName) -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host ("Already members (skipping): {0}" -f $toSkip.Count) -ForegroundColor DarkYellow
Write-Host ("To be added:               {0}" -f $toAdd.Count) -ForegroundColor Cyan

if ($toAdd.Count -eq 0) {
    Write-Host "All users are already members. Nothing to do." -ForegroundColor Green
    return
}

# Only make API calls for users that actually need to be added.
$added  = 0
$failed = 0

foreach ($u in $toAdd) {
    $addr = Get-TargetRecipientAddress -User $u

    try {
        Add-DistributionGroupMember -Identity $dl.Identity -Member $addr -ErrorAction Stop
        $added++
        Write-Host ("Added: {0} <{1}>" -f $u.DisplayName, $addr) -ForegroundColor Green
    } catch {
        $msg = $_.Exception.Message
        $failed++
        Write-Warning ("Failed to add {0} <{1}>: {2}" -f $u.DisplayName, $addr, $msg)
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("Added:            {0}" -f $added)
Write-Host ("Already members:  {0}" -f $toSkip.Count)
Write-Host ("Failed:           {0}" -f $failed)
Write-Host ("No Mail (used UPN): {0}" -f $noMail.Count)
