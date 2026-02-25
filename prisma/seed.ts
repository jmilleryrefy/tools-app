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
# Interactive phase-based provisioning with review at each step.
# Each phase displays results and lets you edit before proceeding.
#
# Input modes:
#   - Pass -CsvPath to import directly from a CSV file
#   - Run without parameters for an interactive menu:
#     [T] Export a blank CSV template to fill out
#     [C] Import from a completed CSV file
#     [M] Manual entry - type names and set details interactively
#
# Phases:
#   1. UPN / Email Generation
#   2. Department Assignments
#   3. License Assignment Review (auto-mapped from role/company rules)
#   4. Duplicate Check
#   5. Manager Lookup
#   6. Final Review (includes group assignment preview)
#   7. Create Users, Assign Licenses & Groups, Generate Output
#
# License Rules (employees only - contractors are not handled by this script):
#   Yrefy/Ignyte SLA        -> Business Premium + Intune Suite
#   Yrefy/Ignyte Other      -> M365 E5
#   Invessio Employee       -> M365 E5
#
# Requires: Microsoft.Graph PowerShell module
# Permissions: User.ReadWrite.All, Directory.ReadWrite.All, Organization.Read.All, Group.ReadWrite.All
#
# Input CSV columns: FirstName, LastName, Company, JobTitle, Manager
# =============================================================================

param(
    [string]$CsvPath = "",

    [string]$OutputDir = ".\\\\output",

    [string]$DefaultPassword = ""
)

# ── Modules & Connection ─────────────────────────────────────────────────────

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Write-Error "Microsoft.Graph module is not installed. Run: Install-Module Microsoft.Graph -Scope CurrentUser"
    exit 1
}

Connect-MgGraph -Scopes "User.ReadWrite.All", "Directory.ReadWrite.All", "Organization.Read.All", "Group.ReadWrite.All" -UseDeviceCode

# ── Configuration ────────────────────────────────────────────────────────────

$DomainMap = @{
    "Yrefy"    = "yrefy.com"
    "Ignyte"   = "yrefy.com"
    "Invessio" = "invessio.com"
}

$AvailableDomains = @("yrefy.com", "invessio.com", "investyrefy.com")

$InvestorRelationsTitlePatterns = @(
    "Investor Relations",
    "Investor"
)

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
    "Quality Assurance"
)

$EngineeringTitlePatterns = @(
    "Engineer",
    "Developer",
    "DevOps",
    "Software",
    "Architect",
    "SRE"
)

# ── License Configuration ────────────────────────────────────────────────
# SKU IDs (GUIDs) are resolved dynamically from the tenant via Get-MgSubscribedSku.
# Rules below use SkuPartNumber strings: SPE_E5 (M365 E5), SPB (Business Premium),
# INTUNE_A (Intune Suite).

# Yrefy license rules (by job-title pattern and department)
# Each rule returns: @{ Primary = "<SkuPartNumber>"; AddOns = @("<SkuPartNumber>", ...) }

$YrefyLicenseRules = @(
    @{
        Label       = "Student Loan Advocate (SLA)"
        Match       = { param($jt, $dept) $jt -match "Student Loan Advocate" }
        Primary     = "SPB"          # Business Premium
        AddOns      = @("INTUNE_A")  # Intune Suite + Advanced Security (bundled in BP add-ons)
    },
    @{
        Label       = "SL Support / Operations / Compliance / Investor Relations"
        Match       = { param($jt, $dept) $dept -in @("Operations", "Sales", "General") -and $jt -notmatch "Student Loan Advocate" }
        Primary     = "SPE_E5"       # M365 E5
        AddOns      = @()            # Teams Enterprise is included in E5
    }
)

$InvessioLicenseRules = @(
    @{
        Label       = "Invessio Employee (hired by Yrefy)"
        Match       = { param($jt, $dept) $true }    # all non-contractor Invessio users
        Primary     = "SPE_E5"       # M365 E5
        AddOns      = @()            # Teams Enterprise + VS Enterprise handled outside M365
    }
)

# ── Group Assignment Configuration ───────────────────────────────────────────
# Group rules are evaluated in order; ALL matching rules apply (groups accumulate).
# Each rule has a Match scriptblock receiving ($JobTitle, $Department, $Company).
# Groups are referenced by display name; IDs are resolved at runtime.

$GroupAssignmentRules = @(
    # ── Yrefy base groups (all Yrefy employees) ──────────────────────────────
    @{
        Label   = "Yrefy base groups"
        Match   = { param($jt, $dept, $co) $co -in @("Yrefy", "Ignyte") }
        Groups  = @("Acrobat Pro Windows", "Balto AI Users", "Team Yrefy")
    },
    # ── Yrefy Sales / Student Loan Advocate ──────────────────────────────────
    @{
        Label   = "Yrefy Sales (SLA)"
        Match   = { param($jt, $dept, $co) $co -in @("Yrefy", "Ignyte") -and $jt -match "Student Loan Advocate" }
        Groups  = @("Student Loan Advocates")
    }
    # Add additional rules here as new roles/departments are defined
)

# ── Helper Functions ─────────────────────────────────────────────────────────

function Write-Phase {
    param([int]$Number, [string]$Title)
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host " PHASE $Number: $Title" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
}

function Get-Confirmation {
    param([string]$Prompt = "Continue?")
    Write-Host ""
    $choice = Read-Host "$Prompt [Y]es / [E]dit / [Q]uit"
    return $choice.ToUpper()
}

function Edit-UserField {
    param(
        [array]$Users,
        [string]$FieldName
    )
    $rowNum = Read-Host "Enter row number to edit (1-$($Users.Count))"
    $idx = [int]$rowNum - 1
    if ($idx -lt 0 -or $idx -ge $Users.Count) {
        Write-Host "Invalid row number." -ForegroundColor Red
        return $Users
    }
    $currentVal = $Users[$idx].$FieldName
    $newVal = Read-Host "Current value: '$currentVal'. Enter new value"
    if ($newVal -ne "") {
        $Users[$idx].$FieldName = $newVal
        Write-Host "Updated row $rowNum $FieldName to '$newVal'" -ForegroundColor Green
    }
    return $Users
}

function Get-LicenseAssignment {
    param(
        [string]$Company,
        [string]$JobTitle,
        [string]$Department
    )
    $rules = switch ($Company) {
        "Yrefy"    { $YrefyLicenseRules }
        "Ignyte"   { $YrefyLicenseRules }   # Ignyte follows Yrefy licensing
        "Invessio" { $InvessioLicenseRules }
        default    { @() }
    }
    foreach ($rule in $rules) {
        if (& $rule.Match $JobTitle $Department) {
            return @{
                Primary    = $rule.Primary
                AddOns     = $rule.AddOns
                RuleLabel  = $rule.Label
            }
        }
    }
    # Fallback - no matching rule
    return @{
        Primary    = ""
        AddOns     = @()
        RuleLabel  = "No matching rule"
    }
}

function Get-GroupAssignments {
    param(
        [string]$JobTitle,
        [string]$Department,
        [string]$Company
    )
    $groups = @()
    foreach ($rule in $GroupAssignmentRules) {
        if (& $rule.Match $JobTitle $Department $Company) {
            $groups += $rule.Groups
        }
    }
    # De-duplicate while preserving order
    $seen = @{}
    $unique = @()
    foreach ($g in $groups) {
        if (-not $seen.ContainsKey($g)) {
            $seen[$g] = $true
            $unique += $g
        }
    }
    return $unique
}

function Get-CleanLastName {
    param([string]$LastName)
    return ($LastName -replace "[^a-zA-Z]", "").ToLower()
}

function Get-FirstInitial {
    param([string]$FirstName)
    $clean = ($FirstName -replace "[^a-zA-Z]", "")
    return $clean.Substring(0, 1).ToLower()
}

function Get-UserPrincipalName {
    param([string]$FirstName, [string]$LastName, [string]$Company, [string]$JobTitle = "")
    $initial = Get-FirstInitial -FirstName $FirstName
    $last    = Get-CleanLastName -LastName $LastName
    $domain  = $DomainMap[$Company]
    if (-not $domain) {
        Write-Warning "Unknown company '$Company' - defaulting to yrefy.com"
        $domain = "yrefy.com"
    }
    # Engineers (any company) get the invessio.com domain
    foreach ($pattern in $EngineeringTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) {
            $domain = "invessio.com"
            break
        }
    }
    # Investor Relations get the investyrefy.com domain
    foreach ($pattern in $InvestorRelationsTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) {
            $domain = "investyrefy.com"
            break
        }
    }
    return "\${initial}\${last}@\${domain}"
}

function Get-Department {
    param([string]$JobTitle, [string]$Company)
    foreach ($pattern in $SalesTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) { return "Sales" }
    }
    foreach ($pattern in $OperationsTitlePatterns) {
        if ($JobTitle -match [regex]::Escape($pattern)) { return "Operations" }
    }
    if ($Company -eq "Invessio") {
        foreach ($pattern in $EngineeringTitlePatterns) {
            if ($JobTitle -match [regex]::Escape($pattern)) { return "Engineering" }
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
    catch { return $false }
}

function Get-ManagerUser {
    param([string]$ManagerInput)
    if ($ManagerInput -match "@") {
        try {
            return Get-MgUser -Filter "userPrincipalName eq '$ManagerInput'" -ErrorAction Stop
        }
        catch { return $null }
    }
    try {
        $result = Get-MgUser -Filter "displayName eq '$ManagerInput'" -ErrorAction Stop
        if ($result -and $result.Count -eq 1) { return $result }
    }
    catch { }
    return $null
}

function New-TempPassword {
    if ($DefaultPassword) { return $DefaultPassword }
    return -join ((65..90) + (97..122) + (48..57) + (33,35,36,37,42) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
}

# ── Validate Output Directory ────────────────────────────────────────────────

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# ── Input: CSV, Manual Entry, or Export Template ─────────────────────────────

$csvUsers = @()

if ($CsvPath -and $CsvPath -ne "") {
    # CSV path provided as parameter - go straight to import
    if (-not (Test-Path $CsvPath)) {
        Write-Error "CSV file not found: $CsvPath"
        Disconnect-MgGraph
        exit 1
    }
    $csvUsers = Import-Csv -Path $CsvPath
    $requiredColumns = @("FirstName", "LastName", "Company", "JobTitle", "Manager")
    $csvColumns = ($csvUsers | Get-Member -MemberType NoteProperty).Name
    foreach ($col in $requiredColumns) {
        if ($col -notin $csvColumns) {
            Write-Error "CSV is missing required column: $col"
            Disconnect-MgGraph
            exit 1
        }
    }

    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host " New User Provisioning (Interactive)" -ForegroundColor Cyan
    Write-Host " Source: CSV ($($csvUsers.Count) users)" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
}
else {
    # No CSV provided - show input mode menu
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host " New User Provisioning" -ForegroundColor Cyan
    Write-Host "=============================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  How would you like to add users?" -ForegroundColor White
    Write-Host ""
    Write-Host "  [T] Export CSV template   - Save a blank CSV template to fill out" -ForegroundColor Gray
    Write-Host "  [C] Import from CSV       - Load users from a completed CSV file" -ForegroundColor Gray
    Write-Host "  [M] Manual entry          - Type in names and details interactively" -ForegroundColor Gray
    Write-Host "  [Q] Quit" -ForegroundColor Gray
    Write-Host ""
    $inputMode = (Read-Host "Select an option").ToUpper()

    switch ($inputMode) {
        "T" {
            # Export CSV template
            $templatePath = Join-Path $OutputDir "new_user_template.csv"
            @("FirstName,LastName,Company,JobTitle,Manager") | Out-File -FilePath $templatePath -Encoding UTF8
            Write-Host ""
            Write-Host "CSV template exported to: $templatePath" -ForegroundColor Green
            Write-Host ""
            Write-Host "Columns:" -ForegroundColor Cyan
            Write-Host "  FirstName  - Employee first name" -ForegroundColor Gray
            Write-Host "  LastName   - Employee last name" -ForegroundColor Gray
            Write-Host "  Company    - Yrefy, Ignyte, or Invessio" -ForegroundColor Gray
            Write-Host "  JobTitle   - Full job title (used for domain, department, and license rules)" -ForegroundColor Gray
            Write-Host "  Manager    - Manager display name or UPN (e.g. jdoe@yrefy.com)" -ForegroundColor Gray
            Write-Host ""
            Write-Host "Fill out the template, then re-run with:" -ForegroundColor White
            Write-Host "  .\\New-UserProvisioning.ps1 -CsvPath \`"$templatePath\`"" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Or re-run without parameters and choose [C] to import." -ForegroundColor White
            Disconnect-MgGraph
            exit 0
        }
        "C" {
            # Import from CSV (prompt for path)
            $CsvPath = Read-Host "Enter path to CSV file"
            if (-not $CsvPath -or $CsvPath.Trim() -eq "") {
                Write-Host "No path provided. Exiting." -ForegroundColor Yellow
                Disconnect-MgGraph
                exit 0
            }
            $CsvPath = $CsvPath.Trim().Trim('"').Trim("'")
            if (-not (Test-Path $CsvPath)) {
                Write-Error "CSV file not found: $CsvPath"
                Disconnect-MgGraph
                exit 1
            }
            $csvUsers = Import-Csv -Path $CsvPath
            $requiredColumns = @("FirstName", "LastName", "Company", "JobTitle", "Manager")
            $csvColumns = ($csvUsers | Get-Member -MemberType NoteProperty).Name
            foreach ($col in $requiredColumns) {
                if ($col -notin $csvColumns) {
                    Write-Error "CSV is missing required column: $col"
                    Disconnect-MgGraph
                    exit 1
                }
            }

            Write-Host ""
            Write-Host "=============================================" -ForegroundColor Cyan
            Write-Host " New User Provisioning (Interactive)" -ForegroundColor Cyan
            Write-Host " Source: CSV ($($csvUsers.Count) users)" -ForegroundColor Cyan
            Write-Host "=============================================" -ForegroundColor Cyan
        }
        "M" {
            # Manual entry mode
            Write-Host ""
            Write-Host "Enter names, one per line (FirstName LastName)." -ForegroundColor White
            Write-Host "Press Enter on a blank line when done." -ForegroundColor Gray
            Write-Host ""

            $nameList = [System.Collections.ArrayList]@()
            $nameIndex = 1
            while ($true) {
                $nameInput = Read-Host "  [$nameIndex] Name (or blank to finish)"
                if (-not $nameInput -or $nameInput.Trim() -eq "") { break }
                $parts = $nameInput.Trim() -split "\\s+", 2
                if ($parts.Count -lt 2) {
                    Write-Host "    Please enter both first and last name." -ForegroundColor Red
                    continue
                }
                [void]$nameList.Add(@{ FirstName = $parts[0]; LastName = $parts[1] })
                $nameIndex++
            }

            if ($nameList.Count -eq 0) {
                Write-Host "No names entered. Exiting." -ForegroundColor Yellow
                Disconnect-MgGraph
                exit 0
            }

            Write-Host ""
            Write-Host "$($nameList.Count) user(s) entered. Now set details for each." -ForegroundColor Cyan
            Write-Host ""

            # Ask for defaults to speed up entry
            Write-Host "── Set Defaults (press Enter to skip) ─────────────────" -ForegroundColor Cyan
            Write-Host "  These will pre-fill for every user. You can override per user." -ForegroundColor Gray
            Write-Host ""
            Write-Host "  Companies: Yrefy, Ignyte, Invessio"
            $defaultCompany  = Read-Host "  Default Company"
            $defaultJobTitle = Read-Host "  Default Job Title"
            $defaultManager  = Read-Host "  Default Manager (display name or UPN)"
            Write-Host ""

            $manualUsers = [System.Collections.ArrayList]@()
            foreach ($entry in $nameList) {
                Write-Host "── $($entry.FirstName) $($entry.LastName) ──────────────────────────" -ForegroundColor White

                # Company
                if ($defaultCompany) {
                    $coInput = Read-Host "  Company [$defaultCompany]"
                    $co = if ($coInput -and $coInput.Trim() -ne "") { $coInput.Trim() } else { $defaultCompany.Trim() }
                }
                else {
                    $co = (Read-Host "  Company (Yrefy/Ignyte/Invessio)").Trim()
                    while ($co -eq "") {
                        Write-Host "    Company is required." -ForegroundColor Red
                        $co = (Read-Host "  Company (Yrefy/Ignyte/Invessio)").Trim()
                    }
                }

                # Job Title
                if ($defaultJobTitle) {
                    $jtInput = Read-Host "  Job Title [$defaultJobTitle]"
                    $jt = if ($jtInput -and $jtInput.Trim() -ne "") { $jtInput.Trim() } else { $defaultJobTitle.Trim() }
                }
                else {
                    $jt = (Read-Host "  Job Title").Trim()
                }

                # Manager
                if ($defaultManager) {
                    $mgInput = Read-Host "  Manager [$defaultManager]"
                    $mg = if ($mgInput -and $mgInput.Trim() -ne "") { $mgInput.Trim() } else { $defaultManager.Trim() }
                }
                else {
                    $mg = (Read-Host "  Manager (display name or UPN)").Trim()
                }

                [void]$manualUsers.Add([PSCustomObject]@{
                    FirstName = $entry.FirstName
                    LastName  = $entry.LastName
                    Company   = $co
                    JobTitle  = $jt
                    Manager   = $mg
                })
                Write-Host ""
            }

            $csvUsers = $manualUsers

            Write-Host "=============================================" -ForegroundColor Cyan
            Write-Host " $($csvUsers.Count) user(s) ready for provisioning" -ForegroundColor Cyan
            Write-Host "=============================================" -ForegroundColor Cyan
        }
        default {
            Write-Host "Exiting." -ForegroundColor Yellow
            Disconnect-MgGraph
            exit 0
        }
    }
}

# ── Build Working Roster ─────────────────────────────────────────────────────

$roster = [System.Collections.ArrayList]@()
foreach ($row in $csvUsers) {
    $fn = $row.FirstName.Trim()
    $ln = $row.LastName.Trim()
    $co = $row.Company.Trim()
    $jt = $row.JobTitle.Trim()
    $mg = $row.Manager.Trim()
    $dept   = Get-Department -JobTitle $jt -Company $co
    $lic    = Get-LicenseAssignment -Company $co -JobTitle $jt -Department $dept
    $groups = Get-GroupAssignments -JobTitle $jt -Department $dept -Company $co
    [void]$roster.Add([PSCustomObject]@{
        Row            = $roster.Count + 1
        FirstName      = $fn
        LastName       = $ln
        Company        = $co
        JobTitle       = $jt
        Manager        = $mg
        UPN            = Get-UserPrincipalName -FirstName $fn -LastName $ln -Company $co -JobTitle $jt
        DisplayName    = "$fn $ln"
        Department     = $dept
        LicensePrimary = $lic.Primary
        LicenseAddOns  = $lic.AddOns
        LicenseLabel   = $lic.RuleLabel
        Groups         = $groups
        Duplicate      = $false
        ManagerUPN     = ""
        ManagerName    = ""
        Status         = "Pending"
    })
}

# ==========================================================================
# PHASE 1: Review UPN Generation
# ==========================================================================

$phase1Done = $false
while (-not $phase1Done) {
    Write-Phase -Number 1 -Title "EMAIL / UPN GENERATION"
    Write-Host ""
    Write-Host ("{0,-4} {1,-20} {2,-20} {3,-10} {4,-35}" -f "#", "Name", "Company", "Domain", "Generated UPN")
    Write-Host ("{0,-4} {1,-20} {2,-20} {3,-10} {4,-35}" -f "--", "----", "-------", "------", "--------------")
    foreach ($u in $roster) {
        $domain = $u.UPN.Split("@")[1]
        Write-Host ("{0,-4} {1,-20} {2,-20} {3,-10} {4,-35}" -f $u.Row, $u.DisplayName, $u.Company, $domain, $u.UPN)
    }

    $choice = Get-Confirmation -Prompt "Phase 1: UPNs look correct?"
    switch ($choice) {
        "Y" { $phase1Done = $true }
        "E" {
            $field = Read-Host "Edit which field? [U]PN / [D]omain / [F]irstName / [L]astName / [C]ompany"
            switch ($field.ToUpper()) {
                "U" { $roster = Edit-UserField -Users $roster -FieldName "UPN" }
                "D" {
                    $rowNum = Read-Host "Enter row number to change domain (1-$($roster.Count))"
                    $idx = [int]$rowNum - 1
                    if ($idx -ge 0 -and $idx -lt $roster.Count) {
                        $r = $roster[$idx]
                        $currentDomain = $r.UPN.Split("@")[1]
                        Write-Host "Current: $($r.DisplayName) -> $($r.UPN)" -ForegroundColor White
                        Write-Host "Available domains:"
                        for ($i = 0; $i -lt $AvailableDomains.Count; $i++) {
                            $marker = if ($AvailableDomains[$i] -eq $currentDomain) { " (current)" } else { "" }
                            Write-Host "  [$($i + 1)] $($AvailableDomains[$i])$marker"
                        }
                        $domainChoice = Read-Host "Select domain number, or type a custom domain"
                        $newDomain = ""
                        if ($domainChoice -match "^\\d+$" -and [int]$domainChoice -ge 1 -and [int]$domainChoice -le $AvailableDomains.Count) {
                            $newDomain = $AvailableDomains[[int]$domainChoice - 1]
                        }
                        elseif ($domainChoice -match "\\.") {
                            $newDomain = $domainChoice
                        }
                        if ($newDomain -and $newDomain -ne $currentDomain) {
                            $localPart = $r.UPN.Split("@")[0]
                            $r.UPN = "\${localPart}@\${newDomain}"
                            Write-Host "Updated: $($r.DisplayName) -> $($r.UPN)" -ForegroundColor Green
                        }
                        elseif ($newDomain -eq $currentDomain) {
                            Write-Host "Domain unchanged." -ForegroundColor Gray
                        }
                        else {
                            Write-Host "Invalid selection." -ForegroundColor Red
                        }
                    }
                    else {
                        Write-Host "Invalid row number." -ForegroundColor Red
                    }
                }
                "F" {
                    $roster = Edit-UserField -Users $roster -FieldName "FirstName"
                    # Regenerate UPN and DisplayName for edited row
                    $rowNum = Read-Host "Regenerate UPN for this row? [Y/N]"
                    if ($rowNum -eq "Y") {
                        $idx = [int](Read-Host "Row number") - 1
                        $r = $roster[$idx]
                        $r.UPN = Get-UserPrincipalName -FirstName $r.FirstName -LastName $r.LastName -Company $r.Company -JobTitle $r.JobTitle
                        $r.DisplayName = "$($r.FirstName) $($r.LastName)"
                        Write-Host "Regenerated: $($r.UPN)" -ForegroundColor Green
                    }
                }
                "L" {
                    $roster = Edit-UserField -Users $roster -FieldName "LastName"
                    $rowNum = Read-Host "Regenerate UPN for this row? [Y/N]"
                    if ($rowNum -eq "Y") {
                        $idx = [int](Read-Host "Row number") - 1
                        $r = $roster[$idx]
                        $r.UPN = Get-UserPrincipalName -FirstName $r.FirstName -LastName $r.LastName -Company $r.Company -JobTitle $r.JobTitle
                        $r.DisplayName = "$($r.FirstName) $($r.LastName)"
                        Write-Host "Regenerated: $($r.UPN)" -ForegroundColor Green
                    }
                }
                "C" {
                    $roster = Edit-UserField -Users $roster -FieldName "Company"
                    $idx = [int](Read-Host "Row number to regenerate UPN for") - 1
                    $r = $roster[$idx]
                    $r.UPN = Get-UserPrincipalName -FirstName $r.FirstName -LastName $r.LastName -Company $r.Company -JobTitle $r.JobTitle
                    Write-Host "Regenerated: $($r.UPN)" -ForegroundColor Green
                }
                default { Write-Host "Invalid choice." -ForegroundColor Red }
            }
        }
        "Q" {
            Write-Host "Aborted by user." -ForegroundColor Yellow
            Disconnect-MgGraph
            exit 0
        }
    }
}

# ==========================================================================
# PHASE 2: Review Department Assignments
# ==========================================================================

$phase2Done = $false
while (-not $phase2Done) {
    Write-Phase -Number 2 -Title "DEPARTMENT ASSIGNMENTS"
    Write-Host ""
    Write-Host ("{0,-4} {1,-20} {2,-30} {3,-15} {4,-10}" -f "#", "Name", "Job Title", "Department", "Company")
    Write-Host ("{0,-4} {1,-20} {2,-30} {3,-15} {4,-10}" -f "--", "----", "---------", "----------", "-------")
    foreach ($u in $roster) {
        $deptColor = switch ($u.Department) {
            "Sales"       { "Green" }
            "Operations"  { "Yellow" }
            "Engineering" { "Magenta" }
            default       { "Gray" }
        }
        Write-Host ("{0,-4} {1,-20} {2,-30} " -f $u.Row, $u.DisplayName, $u.JobTitle) -NoNewline
        Write-Host ("{0,-15} " -f $u.Department) -ForegroundColor $deptColor -NoNewline
        Write-Host ("{0,-10}" -f $u.Company)
    }

    Write-Host ""
    $salesCount = ($roster | Where-Object { $_.Department -eq "Sales" }).Count
    $opsCount   = ($roster | Where-Object { $_.Department -eq "Operations" }).Count
    $engCount   = ($roster | Where-Object { $_.Department -eq "Engineering" }).Count
    $genCount   = ($roster | Where-Object { $_.Department -eq "General" }).Count
    Write-Host "  Sales: $salesCount | Operations: $opsCount | Engineering: $engCount | General: $genCount" -ForegroundColor Cyan

    $choice = Get-Confirmation -Prompt "Phase 2: Departments look correct?"
    switch ($choice) {
        "Y" { $phase2Done = $true }
        "E" {
            $rowNum = Read-Host "Enter row number to change department (1-$($roster.Count))"
            $idx = [int]$rowNum - 1
            if ($idx -ge 0 -and $idx -lt $roster.Count) {
                Write-Host "Current: $($roster[$idx].Department)"
                Write-Host "Options: [S]ales / [O]perations / [E]ngineering / [G]eneral"
                $dept = Read-Host "New department"
                $roster[$idx].Department = switch ($dept.ToUpper()) {
                    "S" { "Sales" }
                    "O" { "Operations" }
                    "E" { "Engineering" }
                    "G" { "General" }
                    default { $roster[$idx].Department }
                }
                # Recompute license and group assignments when department changes
                $lic = Get-LicenseAssignment -Company $roster[$idx].Company -JobTitle $roster[$idx].JobTitle -Department $roster[$idx].Department
                $roster[$idx].LicensePrimary = $lic.Primary
                $roster[$idx].LicenseAddOns  = $lic.AddOns
                $roster[$idx].LicenseLabel   = $lic.RuleLabel
                $roster[$idx].Groups = Get-GroupAssignments -JobTitle $roster[$idx].JobTitle -Department $roster[$idx].Department -Company $roster[$idx].Company
                Write-Host "Updated row $rowNum to $($roster[$idx].Department)" -ForegroundColor Green
            }
        }
        "Q" {
            Write-Host "Aborted by user." -ForegroundColor Yellow
            Disconnect-MgGraph
            exit 0
        }
    }
}

# ==========================================================================
# PHASE 3: License Assignment Review
# ==========================================================================

# Resolve tenant SKUs so we can map SkuPartNumber -> SkuId
Write-Phase -Number 3 -Title "LICENSE ASSIGNMENT REVIEW"
Write-Host ""
Write-Host "Resolving available license SKUs from tenant..." -ForegroundColor White

$tenantSkus = Get-MgSubscribedSku -All
$skuLookup = @{}
foreach ($sku in $tenantSkus) {
    $skuLookup[$sku.SkuPartNumber] = @{
        SkuId     = $sku.SkuId
        Name      = $sku.SkuPartNumber
        Total     = $sku.PrepaidUnits.Enabled
        Consumed  = $sku.ConsumedUnits
        Available = $sku.PrepaidUnits.Enabled - $sku.ConsumedUnits
    }
}

# Show available SKUs that match our config
$relevantSkus = @("SPE_E5", "SPB", "INTUNE_A")
foreach ($skuName in $relevantSkus) {
    if ($skuLookup.ContainsKey($skuName)) {
        $s = $skuLookup[$skuName]
        $color = if ($s.Available -le 0) { "Red" } elseif ($s.Available -le 5) { "Yellow" } else { "Green" }
        Write-Host "  $($skuName): $($s.Available) available / $($s.Total) total" -ForegroundColor $color
    }
    else {
        Write-Host "  $($skuName): NOT FOUND in tenant" -ForegroundColor Red
    }
}

$phase3Done = $false
while (-not $phase3Done) {
    Write-Host ""
    Write-Host ("{0,-4} {1,-20} {2,-12} {3,-20} {4,-20} {5,-30}" -f "#", "Name", "Company", "Primary License", "Add-Ons", "Rule Matched")
    Write-Host ("{0,-4} {1,-20} {2,-12} {3,-20} {4,-20} {5,-30}" -f "--", "----", "-------", "---------------", "-------", "------------")
    foreach ($u in $roster) {
        $addOnDisplay = if ($u.LicenseAddOns -and $u.LicenseAddOns.Count -gt 0) { ($u.LicenseAddOns -join ", ") } else { "(none)" }
        $primaryDisplay = if ($u.LicensePrimary) { $u.LicensePrimary } else { "NONE" }
        $licColor = if (-not $u.LicensePrimary) { "Red" } else { "White" }
        Write-Host ("{0,-4} {1,-20} {2,-12} " -f $u.Row, $u.DisplayName, $u.Company) -NoNewline
        Write-Host ("{0,-20} " -f $primaryDisplay) -ForegroundColor $licColor -NoNewline
        Write-Host ("{0,-20} {1,-30}" -f $addOnDisplay, $u.LicenseLabel)
    }

    # Summarize license demand
    Write-Host ""
    $e5Need  = ($roster | Where-Object { $_.LicensePrimary -eq "SPE_E5" }).Count
    $bpNeed  = ($roster | Where-Object { $_.LicensePrimary -eq "SPB" }).Count
    $intNeed = ($roster | Where-Object { $_.LicenseAddOns -contains "INTUNE_A" }).Count
    Write-Host "  Licenses needed:  M365 E5: $e5Need | Business Premium: $bpNeed | Intune Suite: $intNeed" -ForegroundColor Cyan

    # Warn if demand exceeds available licenses
    $shortages = @()
    if ($skuLookup.ContainsKey("SPE_E5") -and $e5Need -gt $skuLookup["SPE_E5"].Available) {
        $shortages += "M365 E5: need $e5Need but only $($skuLookup["SPE_E5"].Available) available"
    }
    if ($skuLookup.ContainsKey("SPB") -and $bpNeed -gt $skuLookup["SPB"].Available) {
        $shortages += "Business Premium: need $bpNeed but only $($skuLookup["SPB"].Available) available"
    }
    if ($skuLookup.ContainsKey("INTUNE_A") -and $intNeed -gt $skuLookup["INTUNE_A"].Available) {
        $shortages += "Intune Suite: need $intNeed but only $($skuLookup["INTUNE_A"].Available) available"
    }
    if ($shortages.Count -gt 0) {
        Write-Host ""
        Write-Host "  WARNING: License demand exceeds available supply!" -ForegroundColor Red
        foreach ($s in $shortages) {
            Write-Host "    - $s" -ForegroundColor Red
        }
        Write-Host "  Users will be created but some may not receive licenses." -ForegroundColor Yellow
    }

    $choice = Get-Confirmation -Prompt "Phase 3: License assignments look correct?"
    switch ($choice) {
        "Y" { $phase3Done = $true }
        "E" {
            $rowNum = Read-Host "Enter row number to change license (1-$($roster.Count))"
            $idx = [int]$rowNum - 1
            if ($idx -ge 0 -and $idx -lt $roster.Count) {
                Write-Host "Current primary: $($roster[$idx].LicensePrimary)"
                Write-Host "Options: [E] M365 E5 (SPE_E5) / [B] Business Premium (SPB) / [N] None"
                $licChoice = Read-Host "New primary license"
                $roster[$idx].LicensePrimary = switch ($licChoice.ToUpper()) {
                    "E" { "SPE_E5" }
                    "B" { "SPB" }
                    "N" { "" }
                    default { $roster[$idx].LicensePrimary }
                }
                $roster[$idx].LicenseLabel = "Manual override"

                $addOnChoice = Read-Host "Add-ons (comma-separated SKU names, e.g. INTUNE_A) or press Enter to keep current"
                if ($addOnChoice -ne "") {
                    $roster[$idx].LicenseAddOns = ($addOnChoice -split ",") | ForEach-Object { $_.Trim() }
                }
                Write-Host "Updated row $rowNum: Primary=$($roster[$idx].LicensePrimary), AddOns=$($roster[$idx].LicenseAddOns -join ', ')" -ForegroundColor Green
            }
        }
        "Q" {
            Write-Host "Aborted by user." -ForegroundColor Yellow
            Disconnect-MgGraph
            exit 0
        }
    }
}

# ==========================================================================
# PHASE 4: Duplicate Check
# ==========================================================================

Write-Phase -Number 4 -Title "DUPLICATE CHECK"
Write-Host ""
Write-Host "Checking each UPN against existing tenant users..." -ForegroundColor White

$dupCount = 0
foreach ($u in $roster) {
    $exists = Test-UserExists -UPN $u.UPN
    $u.Duplicate = $exists
    if ($exists) {
        $dupCount++
        Write-Host "  [DUPLICATE] $($u.UPN) already exists" -ForegroundColor Red
    }
    else {
        Write-Host "  [OK]        $($u.UPN) is available" -ForegroundColor Green
    }
}

if ($dupCount -gt 0) {
    Write-Host ""
    Write-Host "$dupCount duplicate(s) found. These will be skipped unless you edit their UPN." -ForegroundColor Yellow

    $phase4Done = $false
    while (-not $phase4Done) {
        $choice = Get-Confirmation -Prompt "Phase 4: Handle duplicates?"
        switch ($choice) {
            "Y" { $phase4Done = $true }
            "E" {
                $rowNum = Read-Host "Row number to edit UPN"
                $idx = [int]$rowNum - 1
                if ($idx -ge 0 -and $idx -lt $roster.Count -and $roster[$idx].Duplicate) {
                    $newUpn = Read-Host "Enter new UPN for $($roster[$idx].DisplayName) (current: $($roster[$idx].UPN))"
                    if ($newUpn -ne "") {
                        $roster[$idx].UPN = $newUpn
                        # Re-check the new UPN
                        $recheck = Test-UserExists -UPN $newUpn
                        $roster[$idx].Duplicate = $recheck
                        if ($recheck) {
                            Write-Host "  '$newUpn' also exists. Still marked as duplicate." -ForegroundColor Red
                        }
                        else {
                            Write-Host "  '$newUpn' is available!" -ForegroundColor Green
                        }
                    }
                }
                else {
                    Write-Host "Invalid row or row is not a duplicate." -ForegroundColor Red
                }
            }
            "Q" {
                Write-Host "Aborted by user." -ForegroundColor Yellow
                Disconnect-MgGraph
                exit 0
            }
        }
    }
}
else {
    Write-Host ""
    Write-Host "No duplicates found. All UPNs are available." -ForegroundColor Green
    Start-Sleep -Seconds 1
}

# ==========================================================================
# PHASE 5: Manager Lookup
# ==========================================================================

Write-Phase -Number 5 -Title "MANAGER LOOKUP"
Write-Host ""
Write-Host "Looking up managers in the tenant..." -ForegroundColor White

foreach ($u in $roster) {
    if ($u.Duplicate) { continue }
    if (-not $u.Manager -or $u.Manager -eq "") {
        $u.ManagerUPN  = "(none)"
        $u.ManagerName = "(none)"
        Write-Host "  $($u.DisplayName) -> No manager specified" -ForegroundColor Gray
        continue
    }

    $mgr = Get-ManagerUser -ManagerInput $u.Manager
    if ($mgr) {
        $u.ManagerUPN  = $mgr.UserPrincipalName
        $u.ManagerName = $mgr.DisplayName
        Write-Host "  $($u.DisplayName) -> $($mgr.DisplayName) ($($mgr.UserPrincipalName))" -ForegroundColor Green
    }
    else {
        $u.ManagerUPN  = "NOT FOUND"
        $u.ManagerName = "NOT FOUND"
        Write-Host "  $($u.DisplayName) -> '$($u.Manager)' NOT FOUND" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("{0,-4} {1,-20} {2,-20} {3,-30} {4,-30}" -f "#", "New User", "Manager Input", "Resolved Name", "Resolved UPN")
Write-Host ("{0,-4} {1,-20} {2,-20} {3,-30} {4,-30}" -f "--", "--------", "-------------", "-------------", "------------")
foreach ($u in $roster) {
    if ($u.Duplicate) { continue }
    $color = if ($u.ManagerUPN -eq "NOT FOUND") { "Red" } elseif ($u.ManagerUPN -eq "(none)") { "Gray" } else { "White" }
    Write-Host ("{0,-4} {1,-20} {2,-20} {3,-30} {4,-30}" -f $u.Row, $u.DisplayName, $u.Manager, $u.ManagerName, $u.ManagerUPN) -ForegroundColor $color
}

$notFound = ($roster | Where-Object { $_.ManagerUPN -eq "NOT FOUND" -and -not $_.Duplicate }).Count
if ($notFound -gt 0) {
    Write-Host ""
    Write-Host "$notFound manager(s) not found. You can edit the manager value or continue without." -ForegroundColor Yellow
}

$phase5Done = $false
while (-not $phase5Done) {
    $choice = Get-Confirmation -Prompt "Phase 5: Manager assignments look correct?"
    switch ($choice) {
        "Y" { $phase5Done = $true }
        "E" {
            $rowNum = Read-Host "Row number to edit manager"
            $idx = [int]$rowNum - 1
            if ($idx -ge 0 -and $idx -lt $roster.Count) {
                $newMgr = Read-Host "Enter manager UPN (e.g. jdoe@yrefy.com) for $($roster[$idx].DisplayName)"
                if ($newMgr -ne "") {
                    $roster[$idx].Manager = $newMgr
                    # Re-lookup
                    $mgr = Get-ManagerUser -ManagerInput $newMgr
                    if ($mgr) {
                        $roster[$idx].ManagerUPN  = $mgr.UserPrincipalName
                        $roster[$idx].ManagerName = $mgr.DisplayName
                        Write-Host "  Resolved: $($mgr.DisplayName) ($($mgr.UserPrincipalName))" -ForegroundColor Green
                    }
                    else {
                        $roster[$idx].ManagerUPN  = "NOT FOUND"
                        $roster[$idx].ManagerName = "NOT FOUND"
                        Write-Host "  Still not found." -ForegroundColor Red
                    }
                }
            }
        }
        "Q" {
            Write-Host "Aborted by user." -ForegroundColor Yellow
            Disconnect-MgGraph
            exit 0
        }
    }
}

# ==========================================================================
# PHASE 6: Final Review
# ==========================================================================

Write-Phase -Number 6 -Title "FINAL REVIEW"
Write-Host ""

$toCreate = $roster | Where-Object { -not $_.Duplicate }
$toSkip   = $roster | Where-Object { $_.Duplicate }

Write-Host "The following $($toCreate.Count) user(s) WILL BE CREATED:" -ForegroundColor Green
Write-Host ""
Write-Host ("{0,-4} {1,-20} {2,-30} {3,-15} {4,-20} {5,-20}" -f "#", "Display Name", "UPN", "Department", "License", "Manager")
Write-Host ("{0,-4} {1,-20} {2,-30} {3,-15} {4,-20} {5,-20}" -f "--", "------------", "---", "----------", "-------", "-------")
foreach ($u in $toCreate) {
    $mgrDisplay = $u.ManagerName
    $licDisplay = if ($u.LicensePrimary) { $u.LicensePrimary } else { "NONE" }
    Write-Host ("{0,-4} {1,-20} {2,-30} {3,-15} {4,-20} {5,-20}" -f $u.Row, $u.DisplayName, $u.UPN, $u.Department, $licDisplay, $mgrDisplay)
}

# Group assignment summary
Write-Host ""
Write-Host "Group Assignments:" -ForegroundColor White
foreach ($u in $toCreate) {
    $grpDisplay = if ($u.Groups -and $u.Groups.Count -gt 0) { $u.Groups -join ", " } else { "(none)" }
    Write-Host ("  {0,-20} -> {1}" -f $u.DisplayName, $grpDisplay) -ForegroundColor White
}

if ($toSkip.Count -gt 0) {
    Write-Host ""
    Write-Host "The following $($toSkip.Count) user(s) will be SKIPPED (duplicate):" -ForegroundColor Yellow
    foreach ($u in $toSkip) {
        Write-Host "  $($u.DisplayName) ($($u.UPN))" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Total to create:  $($toCreate.Count)" -ForegroundColor Green
Write-Host "  Total to skip:    $($toSkip.Count)" -ForegroundColor Yellow
Write-Host ""

$finalChoice = Read-Host "CREATE these $($toCreate.Count) users now? [Y]es / [Q]uit"
if ($finalChoice.ToUpper() -ne "Y") {
    Write-Host "Aborted. No users were created." -ForegroundColor Yellow
    Disconnect-MgGraph
    exit 0
}

# ==========================================================================
# PHASE 7: Create Users, Assign Licenses & Generate Output
# ==========================================================================

Write-Phase -Number 7 -Title "CREATING USERS, ASSIGNING LICENSES & GROUPS"
Write-Host ""

# Resolve group display names to object IDs
$allGroupNames = @()
foreach ($u in $toCreate) {
    if ($u.Groups) { $allGroupNames += $u.Groups }
}
$allGroupNames = $allGroupNames | Sort-Object -Unique

$groupLookup = @{}
if ($allGroupNames.Count -gt 0) {
    Write-Host "Resolving Entra ID groups..." -ForegroundColor White
    foreach ($gName in $allGroupNames) {
        try {
            $grp = Get-MgGroup -Filter "displayName eq '$gName'" -ErrorAction Stop
            if ($grp -and $grp.Count -eq 1) {
                $groupLookup[$gName] = $grp.Id
                Write-Host "  [OK] $gName ($($grp.Id))" -ForegroundColor Green
            }
            elseif ($grp -and $grp.Count -gt 1) {
                Write-Host "  [WARN] Multiple groups named '$gName' - skipping (resolve manually)" -ForegroundColor Yellow
            }
            else {
                Write-Host "  [WARN] Group '$gName' not found in tenant" -ForegroundColor Yellow
            }
        }
        catch {
            Write-Host "  [WARN] Could not resolve group '$gName': $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    Write-Host "  Resolved $($groupLookup.Count) / $($allGroupNames.Count) groups" -ForegroundColor White
    Write-Host ""
}

$results = @()
$errors  = @()

foreach ($u in $toCreate) {
    $tempPass = New-TempPassword
    Write-Host "Creating $($u.UPN)..." -NoNewline

    try {
        $newUser = New-MgUser -AccountEnabled:$true \`
            -DisplayName $u.DisplayName \`
            -GivenName $u.FirstName \`
            -Surname $u.LastName \`
            -UserPrincipalName $u.UPN \`
            -MailNickname ($u.UPN.Split("@")[0]) \`
            -JobTitle $u.JobTitle \`
            -Department $u.Department \`
            -CompanyName $u.Company \`
            -UsageLocation "US" \`
            -PasswordProfile @{
                Password                             = $tempPass
                ForceChangePasswordNextSignIn         = $true
                ForceChangePasswordNextSignInWithMfa  = $false
            }

        Write-Host " CREATED" -ForegroundColor Green

        # Assign manager
        if ($u.ManagerUPN -and $u.ManagerUPN -notin @("NOT FOUND", "(none)", "")) {
            try {
                $mgr = Get-MgUser -Filter "userPrincipalName eq '$($u.ManagerUPN)'" -ErrorAction Stop
                Set-MgUserManagerByRef -UserId $newUser.Id -BodyParameter @{
                    "@odata.id" = "https://graph.microsoft.com/v1.0/users/$($mgr.Id)"
                }
                Write-Host "  Manager -> $($u.ManagerName)" -ForegroundColor Green
            }
            catch {
                Write-Host "  Manager assignment failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        # Assign licenses
        $licensesAssigned = @()
        if ($u.LicensePrimary -and $skuLookup.ContainsKey($u.LicensePrimary)) {
            $allSkus = @($u.LicensePrimary) + @($u.LicenseAddOns | Where-Object { $_ -and $skuLookup.ContainsKey($_) })
            $addLicenses = @()
            foreach ($skuName in $allSkus) {
                $addLicenses += @{ SkuId = $skuLookup[$skuName].SkuId }
            }
            try {
                Set-MgUserLicense -UserId $newUser.Id -AddLicenses $addLicenses -RemoveLicenses @()
                $licensesAssigned = $allSkus
                Write-Host "  Licenses -> $($allSkus -join ', ')" -ForegroundColor Green
            }
            catch {
                Write-Host "  License assignment failed: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        elseif ($u.LicensePrimary) {
            Write-Host "  License SKU '$($u.LicensePrimary)' not found in tenant - skipped" -ForegroundColor Yellow
        }

        # Assign groups
        $groupsAssigned = @()
        if ($u.Groups -and $u.Groups.Count -gt 0) {
            foreach ($gName in $u.Groups) {
                if ($groupLookup.ContainsKey($gName)) {
                    try {
                        New-MgGroupMember -GroupId $groupLookup[$gName] -DirectoryObjectId $newUser.Id
                        $groupsAssigned += $gName
                        Write-Host "  Group  -> $gName" -ForegroundColor Green
                    }
                    catch {
                        Write-Host "  Group '$gName' assignment failed: $($_.Exception.Message)" -ForegroundColor Yellow
                    }
                }
                else {
                    Write-Host "  Group '$gName' was not resolved - skipped" -ForegroundColor Yellow
                }
            }
        }

        $u.Status = "Created"
        $u | Add-Member -NotePropertyName "Password" -NotePropertyValue $tempPass -Force
        $u | Add-Member -NotePropertyName "AssignedLicenses" -NotePropertyValue ($licensesAssigned -join ", ") -Force
        $u | Add-Member -NotePropertyName "AssignedGroups" -NotePropertyValue ($groupsAssigned -join ", ") -Force
        $results += $u
    }
    catch {
        Write-Host " FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $u.Status = "Failed"
        $errors += $u
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
$results | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle, Department, Company, Password, AssignedLicenses, AssignedGroups, Status |
    Export-Csv -Path $masterPath -NoTypeInformation
Write-Host "  Master CSV:      $masterPath" -ForegroundColor Green

# B) Sales CSV
$salesUsers = $results | Where-Object { $_.Department -eq "Sales" }
if ($salesUsers.Count -gt 0) {
    $salesPath = Join-Path $OutputDir "sales_users_\${timestamp}.csv"
    $salesUsers | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle |
        Export-Csv -Path $salesPath -NoTypeInformation
    Write-Host "  Sales CSV:       $salesPath ($($salesUsers.Count) users)" -ForegroundColor Green
}

# C) Operations CSV
$opsUsers = $results | Where-Object { $_.Department -eq "Operations" }
if ($opsUsers.Count -gt 0) {
    $opsPath = Join-Path $OutputDir "operations_users_\${timestamp}.csv"
    $opsUsers | Select-Object UPN, FirstName, LastName, DisplayName, JobTitle |
        Export-Csv -Path $opsPath -NoTypeInformation
    Write-Host "  Operations CSV:  $opsPath ($($opsUsers.Count) users)" -ForegroundColor Green
}

# D) Email Lists
$allEmails = ($results | Where-Object { $_.Status -eq "Created" }).UPN
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
if ($toSkip.Count -gt 0) {
    $dupPath = Join-Path $OutputDir "duplicates_\${timestamp}.csv"
    $toSkip | Select-Object DisplayName, UPN | Export-Csv -Path $dupPath -NoTypeInformation
    Write-Host "  Duplicates:      $dupPath ($($toSkip.Count) skipped)" -ForegroundColor Yellow
}

# Errors report
if ($errors.Count -gt 0) {
    $errPath = Join-Path $OutputDir "errors_\${timestamp}.csv"
    $errors | Select-Object DisplayName, UPN, Status | Export-Csv -Path $errPath -NoTypeInformation
    Write-Host "  Errors:          $errPath ($($errors.Count) failed)" -ForegroundColor Red
}

# ── Final Summary ────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " COMPLETE" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Created:    $($results.Count)" -ForegroundColor Green
Write-Host "  Skipped:    $($toSkip.Count)" -ForegroundColor Yellow
Write-Host "  Failed:     $($errors.Count)" -ForegroundColor $(if ($errors.Count -gt 0) { "Red" } else { "White" })
Write-Host ""
Write-Host "  Sales:      $($salesUsers.Count)" -ForegroundColor White
Write-Host "  Operations: $($opsUsers.Count)" -ForegroundColor White
Write-Host "  Other:      $(($results | Where-Object { $_.Department -notin @('Sales','Operations') }).Count)" -ForegroundColor White
Write-Host ""
$licensedCount = ($results | Where-Object { $_.AssignedLicenses -and $_.AssignedLicenses -ne "" }).Count
$e5Assigned    = ($results | Where-Object { $_.AssignedLicenses -match "SPE_E5" }).Count
$bpAssigned    = ($results | Where-Object { $_.AssignedLicenses -match "SPB" }).Count
Write-Host "  Licensed:   $licensedCount / $($results.Count)" -ForegroundColor White
Write-Host "  M365 E5:    $e5Assigned | Business Premium: $bpAssigned" -ForegroundColor White
Write-Host ""
$groupedCount = ($results | Where-Object { $_.AssignedGroups -and $_.AssignedGroups -ne "" }).Count
Write-Host "  Group memberships assigned: $groupedCount / $($results.Count) users" -ForegroundColor White
Write-Host ""
Write-Host "Output files saved to: $OutputDir" -ForegroundColor Cyan
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

Connect-MgGraph -Scopes "User.Read.All" -UseDeviceCode

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

Connect-MgGraph -Scopes "UserAuthenticationMethod.ReadWrite.All" -UseDeviceCode

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

Connect-MgGraph -Scopes "User.ReadWrite.All", "AuditLog.Read.All" -UseDeviceCode

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

Connect-ExchangeOnline -Device

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

Connect-ExchangeOnline -Device

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

Connect-PnPOnline -Url $AdminUrl -DeviceLogin

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

Connect-MgGraph -Scopes "Group.Read.All" -UseDeviceCode

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

Connect-MgGraph -Scopes "RoleManagement.Read.Directory" -UseDeviceCode

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

Connect-MgGraph -Scopes "UserAuthenticationMethod.Read.All", "User.Read.All" -UseDeviceCode

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

Connect-MgGraph -Scopes "Organization.Read.All" -UseDeviceCode

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
      description: "Automated new hire provisioning with three input modes: CSV import, manual name entry, or export a blank CSV template. Includes UPN generation, department assignment, license assignment (M365 E5, Business Premium, Intune Suite based on role/company rules), Entra ID group membership assignment, duplicate checking, manager assignment, and output reports. Does not handle contractor licensing.",
    },
    create: {
      name: "New User Provisioning",
      slug: "new-user-provisioning",
      description: "Automated new hire provisioning with three input modes: CSV import, manual name entry, or export a blank CSV template. Includes UPN generation, department assignment, license assignment (M365 E5, Business Premium, Intune Suite based on role/company rules), Entra ID group membership assignment, duplicate checking, manager assignment, and output reports. Does not handle contractor licensing.",
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
      required: false,
      defaultValue: "",
      description: "Path to CSV with columns: FirstName, LastName, Company, JobTitle, Manager. Leave blank for interactive mode (export template, import CSV, or manual entry).",
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
      id: "param-newuser-temppass",
      name: "DefaultPassword",
      label: "Temporary Password",
      type: "STRING" as const,
      required: false,
      defaultValue: "",
      description: "Temporary password for new accounts. Leave blank to auto-generate per user.",
      sortOrder: 3,
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
