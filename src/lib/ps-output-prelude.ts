/**
 * PowerShell prelude injected ahead of every script execution.
 *
 * Shadows the console-formatting commands (Format-Table, Format-List,
 * Write-Host) with functions that emit single-line structured JSON markers
 * ("@@UI@@{...}") instead of fixed-width console text. Function definitions
 * take precedence over cmdlets in PowerShell, so existing scripts work
 * unchanged - and scripts downloaded and run locally still hit the real
 * cmdlets because this prelude only exists in the web runner.
 *
 * The web UI (ScriptExecutor) parses these markers and renders real HTML
 * tables and styled text that adapt to any screen size.
 *
 * Markers are written directly via [Console]::Out so they bypass the
 * Out-String width formatting applied to everything else in the wrapper.
 */
export const UI_MARKER = "@@UI@@";

export const PS_OUTPUT_PRELUDE = String.raw`# --- IT Tools structured output prelude (injected by the web runner) ---

$global:__UiNoNewlineBuffer = ''
$global:__UiNoNewlineColor  = $null

function global:__Ui-Coerce {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [bool] -or $Value -is [string] -or $Value -is [decimal] -or $Value.GetType().IsPrimitive) { return $Value }
    if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-dd HH:mm:ss') }
    return [string]$Value
}

function global:__Ui-Emit {
    param([hashtable]$Payload)
    [Console]::Out.WriteLine('@@UI@@' + (ConvertTo-Json -InputObject $Payload -Depth 8 -Compress))
}

function global:Write-Host {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromRemainingArguments = $true)]
        [object[]]$Object,
        [switch]$NoNewline,
        [object]$Separator = ' ',
        [System.ConsoleColor]$ForegroundColor,
        [System.ConsoleColor]$BackgroundColor
    )
    process {
        $text = if ($null -eq $Object) { '' } else { @($Object | ForEach-Object { [string]$_ }) -join [string]$Separator }
        $color = if ($PSBoundParameters.ContainsKey('ForegroundColor')) { [string]$ForegroundColor } else { $global:__UiNoNewlineColor }
        if ($NoNewline) {
            $global:__UiNoNewlineBuffer += $text
            if ($color) { $global:__UiNoNewlineColor = $color }
            return
        }
        $text = $global:__UiNoNewlineBuffer + $text
        $global:__UiNoNewlineBuffer = ''
        $global:__UiNoNewlineColor  = $null
        if ($color) { __Ui-Emit @{ t = 'line'; text = $text; color = $color } }
        else        { [Console]::Out.WriteLine($text) }
    }
}

function global:Format-Table {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][object[]]$Property,
        [Parameter(ValueFromPipeline = $true)]$InputObject,
        [switch]$AutoSize,
        [switch]$Wrap,
        [switch]$HideTableHeaders,
        [switch]$Force,
        [object]$GroupBy,
        [string]$View
    )
    begin { $items = [System.Collections.Generic.List[object]]::new() }
    process { if ($null -ne $InputObject) { [void]$items.Add($InputObject) } }
    end {
        if ($items.Count -eq 0) { return }
        $selected = if ($PSBoundParameters.ContainsKey('Property')) { @($items | Select-Object -Property $Property) }
                    else { @($items | Select-Object -Property *) }
        if ($selected.Count -eq 0) { return }
        $columns = @($selected[0].PSObject.Properties.Name)
        $rows = @(foreach ($row in $selected) {
            , @(foreach ($col in $columns) { __Ui-Coerce -Value $row.$col })
        })
        __Ui-Emit @{ t = 'table'; columns = $columns; rows = $rows }
    }
}

function global:Format-List {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][object[]]$Property,
        [Parameter(ValueFromPipeline = $true)]$InputObject,
        [switch]$Force,
        [object]$GroupBy,
        [string]$View
    )
    begin { $items = [System.Collections.Generic.List[object]]::new() }
    process { if ($null -ne $InputObject) { [void]$items.Add($InputObject) } }
    end {
        foreach ($obj in $items) {
            $source = if ($PSBoundParameters.ContainsKey('Property')) { @($obj | Select-Object -Property $Property)[0] } else { $obj }
            $entries = @(foreach ($p in $source.PSObject.Properties) {
                @{ name = $p.Name; value = (__Ui-Coerce -Value $p.Value) }
            })
            __Ui-Emit @{ t = 'list'; items = $entries }
        }
    }
}

# --- end prelude ---`;
