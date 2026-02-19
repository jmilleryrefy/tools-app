import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb(process.env.DATABASE_URL!);

const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// New User Provisioning Script
// ---------------------------------------------------------------------------
const NEW_USER_PROVISIONING_SCRIPT = `# =============================================================================
# New User Provisioning - Yrefy / Ignyte / Invessio
# =============================================================================
# Requires: Microsoft.Graph PowerShell module
# Permissions: User.ReadWrite.All, Directory.ReadWrite.All
#
# Input CSV columns: FirstName, LastName, Company, JobTitle, Manager
# Manager column should be the manager's UPN (e.g. ehanna@yrefy.com)
# =============================================================================

param(
    [Parameter(Mandatory = $true)]
    [string]$CsvPath,

    [string]$OutputDir = ".\\\\output",

    [switch]$WhatIf,

    [string]$DefaultPassword = ""
)

# ── Modules & Connection ─────────────────────────────────────────────────────

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Write-Error "Microsoft.Graph module is not installed. Run: Install-Module Microsoft.Graph -Scope CurrentUser"
    exit 1
}

Connect-MgGraph -Scopes "User.ReadWrite.All", "Directory.ReadWrite.All"

# ── Configuration ────────────────────────────────────────────────────────────

$DomainMap = @{
    "Yrefy"    = "yrefy.com"
    "Ignyte"   = "yrefy.com"
    "Invessio" = "invessio.com"
}

# Department assignment rules: pattern → department
$SalesTitlePatterns = @(
    "Student Loan Advocate"
)

$OperationsTitlePatterns = @(
    "Collections",
    "Negotiator",
    "Academic",
    "Client Relationship",
    "Business Development",
    "Servicing",
    "Quality Assurance",
    "Software"
)

$EngineeringTitlePatterns = @(
    "Engineer",
    "Developer",
    "DevOps",
    "Software",
    "Architect",
    "SRE"
)

# ── Helper Functions ─────────────────────────────────────────────────────────

function Get-CleanLastName {
    param([string]$LastName)
    # Remove hyphens, spaces, apostrophes, special characters — keep alpha only
    return ($LastName -replace "[^a-zA-Z]", "").ToLower()
}

function Get-FirstInitial {
    param([string]$FirstName)
    # Handle hyphenated first names (To-Trinh → T), take first alpha char
    $clean = ($FirstName -replace "[^a-zA-Z]", "")
    return $clean.Substring(0, 1).ToLower()
}

function Get-UserPrincipalName {
    param(
        [string]$FirstName,
        [string]$LastName,
        [string]$Company
    )

    $initial = Get-FirstInitial -FirstName $FirstName
    $last    = Get-CleanLastName -LastName $LastName
    $domain  = $DomainMap[$Company]

    if (-not $domain) {
        Write-Warning "Unknown company '$Company' — defaulting to yrefy.com"
        $domain = "yrefy.com"
    }

    return "\${initial}\${last}@\${domain}"
}

function Get-Department {
    param(
        [string]$JobTitle,
        [string]$Company
    )

    # Sales check
    foreach ($pattern in $SalesTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) {
            return "Sales"
        }
    }

    # Operations check
    foreach ($pattern in $OperationsTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) {
            return "Operations"
        }
    }

    # Engineering check (Invessio technical roles)
    if ($Company -eq "Invessio") {
        foreach ($pattern in $EngineeringTitlePatterns) {
            if ($JobTitle -match [regex]::Escape($pattern)) {
                return "Engineering"
            }
        }
    }

    return "General"
}

function Test-UserExists {
    param([string]$UPN)
    try {
        $existing = Get-MgUser -Filter "userPrincipalName eq '$UPN'" -ErrorAction Stop
        return ($null -ne $existing -and $existing.Count -gt 0)
    }
    catch {
        return $false
    }
}

function Get-ManagerByUPN {
    param([string]$ManagerInput)

    # If it looks like a UPN (contains @), search directly
    if ($ManagerInput -match "@") {
        try {
            return Get-MgUser -Filter "userPrincipalName eq '$ManagerInput'" -ErrorAction Stop
        }
        catch {
            Write-Warning "  Manager UPN '$ManagerInput' not found"
            return $null
        }
    }

    # Otherwise try display name match
    try {
        $result = Get-MgUser -Filter "displayName eq '$ManagerInput'" -ErrorAction Stop
        if ($result -and $result.Count -eq 1) {
            return $result
        }
        elseif ($result -and $result.Count -gt 1) {
            Write-Warning "  Multiple users match manager name '$ManagerInput' — skipping manager assignment. Use UPN instead."
            return $null
        }
    }
    catch { }

    Write-Warning "  Manager '$ManagerInput' not found"
    return $null
}

function New-TempPassword {
    if ($DefaultPassword) { return $DefaultPassword }
    # Generate 16-char password: upper + lower + digits + symbols
    return -join ((65..90) + (97..122) + (48..57) + (33, 35, 36, 37, 42) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
}

# ── Main Processing ──────────────────────────────────────────────────────────

# Validate input
if (-not (Test-Path $CsvPath)) {
    Write-Error "CSV file not found: $CsvPath"
    Disconnect-MgGraph
    exit 1
}

$users = Import-Csv -Path $CsvPath
$requiredColumns = @("FirstName", "LastName", "Company", "JobTitle", "Manager")
$csvColumns = ($users | Get-Member -MemberType NoteProperty).Name
foreach ($col in $requiredColumns) {
    if ($col -notin $csvColumns) {
        Write-Error "CSV is missing required column: $col"
        Disconnect-MgGraph
        exit 1
    }
}

# Create output directory
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " New User Provisioning" -ForegroundColor Cyan
Write-Host " Users to process: $($users.Count)" -ForegroundColor Cyan
if ($WhatIf) {
    Write-Host " MODE: DRY RUN (no changes will be made)" -ForegroundColor Yellow
}
else {
    Write-Host " MODE: LIVE — users will be created" -ForegroundColor Red
}
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

$results     = @()
$errors      = @()
$duplicates  = @()

foreach ($row in $users) {
    $firstName  = $row.FirstName.Trim()
    $lastName   = $row.LastName.Trim()
    $company    = $row.Company.Trim()
    $jobTitle   = $row.JobTitle.Trim()
    $managerRef = $row.Manager.Trim()

    $upn         = Get-UserPrincipalName -FirstName $firstName -LastName $lastName -Company $company
    $displayName = "$firstName $lastName"
    $department  = Get-Department -JobTitle $jobTitle -Company $company
    $tempPass    = New-TempPassword

    Write-Host "Processing: $displayName ($upn)" -ForegroundColor White

    # ── Step 1: Duplicate check ──
    $exists = Test-UserExists -UPN $upn
    if ($exists) {
        Write-Host "  DUPLICATE — $upn already exists. Skipping." -ForegroundColor Yellow
        $duplicates += [PSCustomObject]@{
            DisplayName = $displayName
            UPN         = $upn
            Reason      = "UPN already exists in tenant"
        }
        continue
    }

    # ── Step 2: Create user ──
    $userRecord = [PSCustomObject]@{
        FirstName   = $firstName
        LastName    = $lastName
        DisplayName = $displayName
        UPN         = $upn
        JobTitle    = $jobTitle
        Department  = $department
        Company     = $company
        Manager     = $managerRef
        Password    = $tempPass
        Status      = "Pending"
    }

    if ($WhatIf) {
        Write-Host "  [WhatIf] Would create: $upn | Dept: $department | Title: $jobTitle" -ForegroundColor Cyan
        $userRecord.Status = "WhatIf"
        $results += $userRecord
        continue
    }

    try {
        $newUser = New-MgUser -AccountEnabled:$true \`
            -DisplayName $displayName \`
            -GivenName $firstName \`
            -Surname $lastName \`
            -UserPrincipalName $upn \`
            -MailNickname ($upn.Split("@")[0]) \`
            -JobTitle $jobTitle \`
            -Department $department \`
            -CompanyName $company \`
            -UsageLocation "US" \`
            -PasswordProfile @{
                Password                             = $tempPass
                ForceChangePasswordNextSignIn         = $true
                ForceChangePasswordNextSignInWithMfa  = $false
            }

        Write-Host "  CREATED: $upn (ID: $($newUser.Id))" -ForegroundColor Green

        # ── Step 3: Assign manager ──
        if ($managerRef) {
            $manager = Get-ManagerByUPN -ManagerInput $managerRef
            if ($manager) {
                try {
                    Set-MgUserManagerByRef -UserId $newUser.Id -BodyParameter @{
                        "@odata.id" = "https://graph.microsoft.com/v1.0/users/$($manager.Id)"
                    }
                    Write-Host "  Manager set: $($manager.DisplayName)" -ForegroundColor Green
                }
                catch {
                    Write-Warning "  Failed to set manager: $($_.Exception.Message)"
                }
            }
        }

        $userRecord.Status = "Created"
        $results += $userRecord
    }
    catch {
        Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $userRecord.Status = "Failed"
        $errors += $userRecord
    }
}

# ── Generate Output Files ────────────────────────────────────────────────────

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Generating Output Files" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# A) Master Import CSV
$masterPath = Join-Path $OutputDir "master_import_\${timestamp}.csv"
$results | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle, Department, Company, Status |
    Export-Csv -Path $masterPath -NoTypeInformation
Write-Host "  Master CSV:      $masterPath" -ForegroundColor Green

# B) Sales-only CSV
$salesUsers = $results | Where-Object { $_.Department -eq "Sales" }
if ($salesUsers.Count -gt 0) {
    $salesPath = Join-Path $OutputDir "sales_users_\${timestamp}.csv"
    $salesUsers | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle |
        Export-Csv -Path $salesPath -NoTypeInformation
    Write-Host "  Sales CSV:       $salesPath ($($salesUsers.Count) users)" -ForegroundColor Green
}

# C) Operations-only CSV
$opsUsers = $results | Where-Object { $_.Department -eq "Operations" }
if ($opsUsers.Count -gt 0) {
    $opsPath = Join-Path $OutputDir "operations_users_\${timestamp}.csv"
    $opsUsers | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle |
        Export-Csv -Path $opsPath -NoTypeInformation
    Write-Host "  Operations CSV:  $opsPath ($($opsUsers.Count) users)" -ForegroundColor Green
}

# D) Email Lists
$allEmails = ($results | Where-Object { $_.Status -ne "Failed" }).UPN

$commaList     = $allEmails -join ", "
$semicolonList = $allEmails -join "; "

$emailPath = Join-Path $OutputDir "email_list_\${timestamp}.txt"
@(
    "=== Comma-separated ==="
    $commaList
    ""
    "=== Semicolon-separated ==="
    $semicolonList
) | Out-File -FilePath $emailPath -Encoding UTF8
Write-Host "  Email List:      $emailPath" -ForegroundColor Green

# Duplicates report
if ($duplicates.Count -gt 0) {
    $dupPath = Join-Path $OutputDir "duplicates_\${timestamp}.csv"
    $duplicates | Export-Csv -Path $dupPath -NoTypeInformation
    Write-Host "  Duplicates:      $dupPath ($($duplicates.Count) skipped)" -ForegroundColor Yellow
}

# ── Summary ──────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Summary" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Total processed: $($users.Count)" -ForegroundColor White
Write-Host "  Created:         $($results.Where({ $_.Status -eq 'Created' }).Count)" -ForegroundColor Green
Write-Host "  Dry run:         $($results.Where({ $_.Status -eq 'WhatIf' }).Count)" -ForegroundColor Cyan
Write-Host "  Duplicates:      $($duplicates.Count)" -ForegroundColor Yellow
Write-Host "  Errors:          $($errors.Count)" -ForegroundColor $(if ($errors.Count -gt 0) { "Red" } else { "White" })
Write-Host ""
Write-Host "  Sales:           $($salesUsers.Count) users" -ForegroundColor White
Write-Host "  Operations:      $($opsUsers.Count) users" -ForegroundColor White
Write-Host "  Other:           $(($results | Where-Object { $_.Department -notin @('Sales','Operations') }).Count) users" -ForegroundColor White
Write-Host ""

Disconnect-MgGraph
Write-Host "Done." -ForegroundColor Green
`;

async function main() {
  console.log("Seeding database...");

  // Create categories
  const userMgmt = await prisma.category.upsert({
    where: { name: "User Management" },
    update: {},
    create: {
      name: "User Management",
      description: "Scripts for managing M365 user accounts, licenses, and properties",
      icon: "Users",
      sortOrder: 1,
    },
  });

  const mailbox = await prisma.category.upsert({
    where: { name: "Exchange Online" },
    update: {},
    create: {
      name: "Exchange Online",
      description: "Exchange Online mailbox and mail flow management scripts",
      icon: "Mail",
      sortOrder: 2,
    },
  });

  const sharepoint = await prisma.category.upsert({
    where: { name: "SharePoint Online" },
    update: {},
    create: {
      name: "SharePoint Online",
      description: "SharePoint site and document library management",
      icon: "FileText",
      sortOrder: 3,
    },
  });

  const teams = await prisma.category.upsert({
    where: { name: "Microsoft Teams" },
    update: {},
    create: {
      name: "Microsoft Teams",
      description: "Teams administration and configuration scripts",
      icon: "MessageSquare",
      sortOrder: 4,
    },
  });

  const security = await prisma.category.upsert({
    where: { name: "Security & Compliance" },
    update: {},
    create: {
      name: "Security & Compliance",
      description: "Security auditing, compliance, and conditional access scripts",
      icon: "Shield",
      sortOrder: 5,
    },
  });

  const provisioning = await prisma.category.upsert({
    where: { name: "User Provisioning" },
    update: {},
    create: {
      name: "User Provisioning",
      description: "New hire onboarding, user creation, and provisioning automation",
      icon: "UserPlus",
      sortOrder: 6,
    },
  });

  const reporting = await prisma.category.upsert({
    where: { name: "Reporting" },
    update: {},
    create: {
      name: "Reporting",
      description: "Tenant-wide reporting and analytics scripts",
      icon: "BarChart",
      sortOrder: 7,
    },
  });

  // --- User Management Scripts ---

  const script1 = await prisma.script.upsert({
    where: { slug: "get-all-licensed-users" },
    update: {},
    create: {
      name: "Get All Licensed Users",
      slug: "get-all-licensed-users",
      description: "Retrieves a list of all users in the tenant that have at least one license assigned. Outputs display name, UPN, and assigned license SKUs.",
      categoryId: userMgmt.id,
      tags: "users,licenses,audit",
      content: `# Get All Licensed Users
# Requires: Microsoft.Graph PowerShell module
# Permissions: User.Read.All

Connect-MgGraph -Scopes "User.Read.All"

$users = Get-MgUser -All -Property DisplayName, UserPrincipalName, AssignedLicenses -Filter "assignedLicenses/\\$count ne 0" -ConsistencyLevel eventual -CountVariable count

$users | ForEach-Object {
    $licenseSkus = ($_.AssignedLicenses | ForEach-Object { $_.SkuId }) -join ", "
    [PSCustomObject]@{
        DisplayName       = $_.DisplayName
        UserPrincipalName = $_.UserPrincipalName
        LicenseSKUs       = $licenseSkus
    }
} | Format-Table -AutoSize

Write-Host "\\nTotal licensed users: $count" -ForegroundColor Cyan

Disconnect-MgGraph`,
    },
  });

  await prisma.scriptParameter.upsert({
    where: { id: "param-s1-export" },
    update: {},
    create: {
      id: "param-s1-export",
      scriptId: script1.id,
      name: "ExportPath",
      label: "Export CSV Path",
      type: "STRING",
      required: false,
      defaultValue: "",
      description: "Optional file path to export results as CSV",
      sortOrder: 1,
    },
  });

  await prisma.script.upsert({
    where: { slug: "bulk-password-reset" },
    update: {},
    create: {
      name: "Bulk Password Reset",
      slug: "bulk-password-reset",
      description: "Resets passwords for a list of users from a CSV file. Generates temporary passwords and forces change on next login.",
      categoryId: userMgmt.id,
      tags: "users,passwords,bulk",
      requiresAdmin: true,
      content: `# Bulk Password Reset from CSV
# Requires: Microsoft.Graph PowerShell module
# Permissions: UserAuthenticationMethod.ReadWrite.All
# CSV Format: UserPrincipalName column required

param(
    [Parameter(Mandatory=$true)]
    [string]$CsvPath
)

Connect-MgGraph -Scopes "UserAuthenticationMethod.ReadWrite.All"

$users = Import-Csv -Path $CsvPath

foreach ($user in $users) {
    $upn = $user.UserPrincipalName
    $tempPassword = -join ((65..90) + (97..122) + (48..57) + (33,35,36,37) | Get-Random -Count 16 | ForEach-Object { [char]$_ })

    try {
        $passwordProfile = @{
            Password                      = $tempPassword
            ForceChangePasswordNextSignIn  = $true
        }
        Update-MgUser -UserId $upn -PasswordProfile $passwordProfile
        Write-Host "[OK] $upn - Temp password: $tempPassword" -ForegroundColor Green
    }
    catch {
        Write-Host "[FAIL] $upn - $($_.Exception.Message)" -ForegroundColor Red
    }
}

Disconnect-MgGraph`,
    },
  });

  await prisma.script.upsert({
    where: { slug: "disable-inactive-users" },
    update: {},
    create: {
      name: "Disable Inactive Users",
      slug: "disable-inactive-users",
      description: "Finds and optionally disables user accounts that have not signed in for a specified number of days.",
      categoryId: userMgmt.id,
      tags: "users,inactive,cleanup,security",
      requiresAdmin: true,
      content: `# Disable Inactive Users
# Requires: Microsoft.Graph PowerShell module
# Permissions: User.ReadWrite.All, AuditLog.Read.All

param(
    [int]$InactiveDays = 90,
    [switch]$WhatIf
)

Connect-MgGraph -Scopes "User.ReadWrite.All", "AuditLog.Read.All"

$cutoffDate = (Get-Date).AddDays(-$InactiveDays).ToString("yyyy-MM-ddTHH:mm:ssZ")

$inactiveUsers = Get-MgUser -All -Property DisplayName, UserPrincipalName, SignInActivity, AccountEnabled -Filter "accountEnabled eq true" |
    Where-Object {
        $_.SignInActivity.LastSignInDateTime -and
        $_.SignInActivity.LastSignInDateTime -lt $cutoffDate
    }

Write-Host "Found $($inactiveUsers.Count) users inactive for $InactiveDays+ days:" -ForegroundColor Yellow

foreach ($user in $inactiveUsers) {
    $lastSignIn = $user.SignInActivity.LastSignInDateTime
    Write-Host "  $($user.DisplayName) ($($user.UserPrincipalName)) - Last sign-in: $lastSignIn"

    if (-not $WhatIf) {
        Update-MgUser -UserId $user.Id -AccountEnabled:$false
        Write-Host "    -> Account disabled" -ForegroundColor Red
    } else {
        Write-Host "    -> [WhatIf] Would disable account" -ForegroundColor Cyan
    }
}

Disconnect-MgGraph`,
    },
  });

  // --- Exchange Online Scripts ---

  await prisma.script.upsert({
    where: { slug: "get-mailbox-sizes" },
    update: {},
    create: {
      name: "Get Mailbox Sizes",
      slug: "get-mailbox-sizes",
      description: "Generates a report of all user mailbox sizes including item count and total size. Useful for storage auditing and planning.",
      categoryId: mailbox.id,
      tags: "exchange,mailbox,storage,report",
      content: `# Get All Mailbox Sizes Report
# Requires: ExchangeOnlineManagement module
# Permissions: Exchange Administrator

Connect-ExchangeOnline

$mailboxes = Get-EXOMailbox -ResultSize Unlimited -Properties DisplayName, UserPrincipalName

$report = $mailboxes | ForEach-Object {
    $stats = Get-EXOMailboxStatistics -Identity $_.UserPrincipalName -ErrorAction SilentlyContinue
    if ($stats) {
        [PSCustomObject]@{
            DisplayName = $_.DisplayName
            UPN         = $_.UserPrincipalName
            ItemCount   = $stats.ItemCount
            TotalSize   = $stats.TotalItemSize.Value.ToString()
        }
    }
}

$report | Sort-Object { [int64]($_.TotalSize -replace '[^0-9]') } -Descending | Format-Table -AutoSize

Write-Host "\\nTotal mailboxes: $($report.Count)" -ForegroundColor Cyan

Disconnect-ExchangeOnline -Confirm:$false`,
    },
  });

  await prisma.script.upsert({
    where: { slug: "set-out-of-office" },
    update: {},
    create: {
      name: "Set Out of Office Reply",
      slug: "set-out-of-office",
      description: "Configures automatic out-of-office reply for a specified user mailbox with internal and external messages.",
      categoryId: mailbox.id,
      tags: "exchange,mailbox,ooo,auto-reply",
      content: `# Set Out of Office Auto-Reply
# Requires: ExchangeOnlineManagement module

param(
    [Parameter(Mandatory=$true)]
    [string]$UserPrincipalName,

    [Parameter(Mandatory=$true)]
    [string]$InternalMessage,

    [string]$ExternalMessage = "",

    [datetime]$StartTime,
    [datetime]$EndTime
)

Connect-ExchangeOnline

$params = @{
    Identity          = $UserPrincipalName
    AutoReplyState    = "Scheduled"
    InternalMessage   = $InternalMessage
    ExternalMessage   = if ($ExternalMessage) { $ExternalMessage } else { $InternalMessage }
    ExternalAudience  = "Known"
}

if ($StartTime) { $params.StartTime = $StartTime }
if ($EndTime)   { $params.EndTime = $EndTime }

Set-MailboxAutoReplyConfiguration @params

Write-Host "Out of office configured for $UserPrincipalName" -ForegroundColor Green
Get-MailboxAutoReplyConfiguration -Identity $UserPrincipalName | Format-List

Disconnect-ExchangeOnline -Confirm:$false`,
    },
  });

  // --- SharePoint Online Scripts ---

  await prisma.script.upsert({
    where: { slug: "get-site-storage-usage" },
    update: {},
    create: {
      name: "Get Site Storage Usage",
      slug: "get-site-storage-usage",
      description: "Reports storage usage across all SharePoint Online sites. Identifies sites consuming the most storage.",
      categoryId: sharepoint.id,
      tags: "sharepoint,storage,audit,sites",
      content: `# SharePoint Online Site Storage Report
# Requires: PnP.PowerShell module
# Permissions: SharePoint Administrator

param(
    [Parameter(Mandatory=$true)]
    [string]$AdminUrl
)

Connect-PnPOnline -Url $AdminUrl -Interactive

$sites = Get-PnPTenantSite -Detailed | Where-Object { $_.Template -ne "SRCHCEN#0" }

$report = $sites | ForEach-Object {
    [PSCustomObject]@{
        Title         = $_.Title
        Url           = $_.Url
        StorageUsedMB = [math]::Round($_.StorageUsageCurrent, 2)
        StorageQuotaMB = $_.StorageQuota
        PercentUsed   = if ($_.StorageQuota -gt 0) { [math]::Round(($_.StorageUsageCurrent / $_.StorageQuota) * 100, 1) } else { 0 }
        LastModified  = $_.LastContentModifiedDate
    }
}

$report | Sort-Object StorageUsedMB -Descending | Format-Table -AutoSize

$totalGB = [math]::Round(($report | Measure-Object -Property StorageUsedMB -Sum).Sum / 1024, 2)
Write-Host "\\nTotal storage used: $totalGB GB across $($report.Count) sites" -ForegroundColor Cyan

Disconnect-PnPOnline`,
    },
  });

  // --- Microsoft Teams Scripts ---

  await prisma.script.upsert({
    where: { slug: "get-teams-with-owners" },
    update: {},
    create: {
      name: "Get All Teams with Owners",
      slug: "get-teams-with-owners",
      description: "Lists all Microsoft Teams along with their owners. Useful for governance auditing and identifying ownerless teams.",
      categoryId: teams.id,
      tags: "teams,owners,governance,audit",
      content: `# Get All Teams with Owners
# Requires: Microsoft.Graph PowerShell module
# Permissions: Group.Read.All

Connect-MgGraph -Scopes "Group.Read.All"

$teams = Get-MgGroup -Filter "resourceProvisioningOptions/Any(x:x eq 'Team')" -All -Property DisplayName, Id, Description, CreatedDateTime

$report = foreach ($team in $teams) {
    $owners = Get-MgGroupOwner -GroupId $team.Id -All | ForEach-Object {
        (Get-MgUser -UserId $_.Id -Property DisplayName).DisplayName
    }

    [PSCustomObject]@{
        TeamName    = $team.DisplayName
        Description = $team.Description
        Created     = $team.CreatedDateTime
        Owners      = ($owners -join "; ")
        OwnerCount  = $owners.Count
    }
}

$report | Format-Table TeamName, OwnerCount, Owners, Created -AutoSize

$ownerless = ($report | Where-Object { $_.OwnerCount -eq 0 }).Count
Write-Host "\\nTotal teams: $($report.Count) | Ownerless teams: $ownerless" -ForegroundColor $(if ($ownerless -gt 0) { "Yellow" } else { "Cyan" })

Disconnect-MgGraph`,
    },
  });

  // --- Security & Compliance Scripts ---

  await prisma.script.upsert({
    where: { slug: "audit-admin-role-assignments" },
    update: {},
    create: {
      name: "Audit Admin Role Assignments",
      slug: "audit-admin-role-assignments",
      description: "Lists all users with administrative roles in the tenant. Critical for security auditing and principle of least privilege reviews.",
      categoryId: security.id,
      tags: "security,roles,admin,audit,compliance",
      requiresAdmin: true,
      content: `# Audit Admin Role Assignments
# Requires: Microsoft.Graph PowerShell module
# Permissions: RoleManagement.Read.Directory

Connect-MgGraph -Scopes "RoleManagement.Read.Directory"

$roles = Get-MgDirectoryRole -All

$report = foreach ($role in $roles) {
    $members = Get-MgDirectoryRoleMember -DirectoryRoleId $role.Id -All

    foreach ($member in $members) {
        $user = Get-MgUser -UserId $member.Id -Property DisplayName, UserPrincipalName -ErrorAction SilentlyContinue
        if ($user) {
            [PSCustomObject]@{
                Role              = $role.DisplayName
                DisplayName       = $user.DisplayName
                UserPrincipalName = $user.UserPrincipalName
            }
        }
    }
}

$report | Sort-Object Role, DisplayName | Format-Table -AutoSize

$uniqueAdmins = ($report | Select-Object -Property UserPrincipalName -Unique).Count
Write-Host "\\nTotal role assignments: $($report.Count) across $uniqueAdmins unique admin accounts" -ForegroundColor Cyan

Disconnect-MgGraph`,
    },
  });

  await prisma.script.upsert({
    where: { slug: "check-mfa-status" },
    update: {},
    create: {
      name: "Check MFA Status for All Users",
      slug: "check-mfa-status",
      description: "Reports the MFA registration and enforcement status for all users. Identifies users without MFA configured.",
      categoryId: security.id,
      tags: "security,mfa,compliance,audit",
      content: `# Check MFA Registration Status
# Requires: Microsoft.Graph PowerShell module
# Permissions: UserAuthenticationMethod.Read.All, User.Read.All

Connect-MgGraph -Scopes "UserAuthenticationMethod.Read.All", "User.Read.All"

$users = Get-MgUser -All -Property DisplayName, UserPrincipalName, AccountEnabled -Filter "accountEnabled eq true"

$report = foreach ($user in $users) {
    $methods = Get-MgUserAuthenticationMethod -UserId $user.Id

    $hasMfa = ($methods | Where-Object {
        $_.AdditionalProperties.'@odata.type' -ne '#microsoft.graph.passwordAuthenticationMethod'
    }).Count -gt 0

    [PSCustomObject]@{
        DisplayName = $user.DisplayName
        UPN         = $user.UserPrincipalName
        MFAEnabled  = $hasMfa
        MethodCount = $methods.Count
        Methods     = ($methods | ForEach-Object { $_.AdditionalProperties.'@odata.type'.Split('.')[-1] }) -join ", "
    }
}

$mfaEnabled = ($report | Where-Object { $_.MFAEnabled }).Count
$mfaDisabled = ($report | Where-Object { -not $_.MFAEnabled }).Count

$report | Format-Table DisplayName, UPN, MFAEnabled, Methods -AutoSize

Write-Host "\\nMFA Enabled: $mfaEnabled | MFA Not Configured: $mfaDisabled" -ForegroundColor $(if ($mfaDisabled -gt 0) { "Yellow" } else { "Green" })

Disconnect-MgGraph`,
    },
  });

  // --- Reporting Scripts ---

  await prisma.script.upsert({
    where: { slug: "license-utilization-report" },
    update: {},
    create: {
      name: "License Utilization Report",
      slug: "license-utilization-report",
      description: "Generates a comprehensive report of all license SKUs in the tenant showing total, assigned, and available counts. Helps identify unused licenses for cost optimization.",
      categoryId: reporting.id,
      tags: "licenses,reporting,cost,optimization",
      content: `# License Utilization Report
# Requires: Microsoft.Graph PowerShell module
# Permissions: Organization.Read.All

Connect-MgGraph -Scopes "Organization.Read.All"

$subscriptions = Get-MgSubscribedSku -All

$report = $subscriptions | ForEach-Object {
    $consumed = $_.ConsumedUnits
    $total = $_.PrepaidUnits.Enabled
    $available = $total - $consumed
    $utilization = if ($total -gt 0) { [math]::Round(($consumed / $total) * 100, 1) } else { 0 }

    [PSCustomObject]@{
        SKU           = $_.SkuPartNumber
        Total         = $total
        Assigned      = $consumed
        Available     = $available
        Utilization   = "$utilization%"
    }
}

$report | Sort-Object SKU | Format-Table -AutoSize

$totalLicenses = ($report | Measure-Object -Property Total -Sum).Sum
$totalAssigned = ($report | Measure-Object -Property Assigned -Sum).Sum
Write-Host "\\nOverall: $totalAssigned / $totalLicenses licenses assigned ($([math]::Round(($totalAssigned/$totalLicenses)*100,1))% utilization)" -ForegroundColor Cyan

Disconnect-MgGraph`,
    },
  });

  // --- User Provisioning Scripts ---

  const newUserScript = await prisma.script.upsert({
    where: { slug: "new-user-provisioning" },
    update: {
      content: NEW_USER_PROVISIONING_SCRIPT,
      description: "Automated new hire provisioning: creates M365 users from CSV input with UPN generation, department assignment, duplicate checking, manager assignment, and generates output reports (master CSV, sales CSV, operations CSV, email lists).",
    },
    create: {
      name: "New User Provisioning",
      slug: "new-user-provisioning",
      description: "Automated new hire provisioning: creates M365 users from CSV input with UPN generation, department assignment, duplicate checking, manager assignment, and generates output reports (master CSV, sales CSV, operations CSV, email lists).",
      categoryId: provisioning.id,
      tags: "onboarding,new-hire,provisioning,csv,bulk",
      requiresAdmin: true,
      content: NEW_USER_PROVISIONING_SCRIPT,
    },
  });

  // Parameters for New User Provisioning
  const newUserParams = [
    {
      id: "param-newuser-csv",
      name: "CsvPath",
      label: "Input CSV Path",
      type: "STRING" as const,
      required: true,
      defaultValue: "",
      description: "Path to CSV with columns: FirstName, LastName, Company, JobTitle, Manager (UPN or display name)",
      sortOrder: 1,
    },
    {
      id: "param-newuser-output",
      name: "OutputDir",
      label: "Output Directory",
      type: "STRING" as const,
      required: false,
      defaultValue: ".\\\\output",
      description: "Directory for generated output files (master CSV, department CSVs, email lists)",
      sortOrder: 2,
    },
    {
      id: "param-newuser-whatif",
      name: "WhatIf",
      label: "Dry Run (WhatIf)",
      type: "BOOLEAN" as const,
      required: false,
      defaultValue: "true",
      description: "When true, simulates provisioning without creating users. Set to false to execute.",
      sortOrder: 3,
    },
    {
      id: "param-newuser-temppass",
      name: "DefaultPassword",
      label: "Temporary Password",
      type: "STRING" as const,
      required: false,
      defaultValue: "",
      description: "Temporary password for new accounts. Leave blank to auto-generate per user.",
      sortOrder: 4,
    },
  ];

  for (const param of newUserParams) {
    await prisma.scriptParameter.upsert({
      where: { id: param.id },
      update: {},
      create: {
        ...param,
        scriptId: newUserScript.id,
      },
    });
  }

  console.log("Seed completed successfully!");
  console.log("  Categories: 7");
  console.log("  Scripts: 11");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
