#Requires -Version 5.1
<#
.SYNOPSIS
Install the portable skill and prepare a local MCP server interactively.
.PARAMETER SkillsDir
Absolute path to the parent skills directory. Defaults to ~/.agents/skills.
.PARAMETER Force
Replace the existing wow-addon directory.
.PARAMETER Annotations
Clone or update optional local annotation repositories.
.PARAMETER Mcp
Prepare the local MCP server and print complete settings JSON. Skip the skill
unless interactive mode is selected.
.PARAMETER Interactive
Ask which components to install, including when input is redirected.
.PARAMETER NonInteractive
Disable prompts. Without -Mcp, install the portable skill only.
.PARAMETER Help
Show usage. PowerShell also supports -?.
#>
[CmdletBinding()]
param(
    [string]$SkillsDir,
    [switch]$Force,
    [switch]$Annotations,
    [switch]$Mcp,
    [switch]$Interactive,
    [switch]$NonInteractive,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Output 'Usage: .\install.ps1 [-Interactive | -NonInteractive] [-Mcp] [-SkillsDir DIR] [-Force] [-Annotations]'
    Write-Output 'With no arguments in a terminal, choose the skill, MCP server, paths, and annotations.'
    Write-Output 'With flags or redirected input, install the skill to ~/.agents/skills/wow-addon.'
    Write-Output '-Mcp prepares the MCP server only and prints settings JSON with absolute paths.'
    Write-Output '-Interactive prompts with redirected input too. -NonInteractive disables prompts.'
    Write-Output 'MCP setup installs missing locked Bun dependencies and builds the server.'
    Write-Output 'Client settings are never changed. Redirect stdout to save the JSON.'
    Write-Output 'Examples: .\install.ps1'
    Write-Output '          .\install.ps1 -Mcp > mcp-settings.json'
    exit 0
}

if ($Interactive -and $NonInteractive) {
    throw 'Choose either -Interactive or -NonInteractive.'
}

function Write-Status {
    param([Parameter(Mandatory)][string]$Message)
    [Console]::Error.WriteLine($Message)
}

function Read-InstallerLine {
    param([Parameter(Mandatory)][string]$Prompt)
    [Console]::Error.Write($Prompt)
    $Answer = [Console]::ReadLine()
    if ($null -eq $Answer) {
        throw 'Input ended. Installer cancelled before making changes.'
    }
    return $Answer
}

function Read-YesNo {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][bool]$Default
    )
    $Choices = if ($Default) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $Answer = (Read-InstallerLine -Prompt "$Prompt $Choices ").Trim().ToLowerInvariant()
        if ($Answer -eq '') { return $Default }
        if ($Answer -eq 'y' -or $Answer -eq 'yes') { return $true }
        if ($Answer -eq 'n' -or $Answer -eq 'no') { return $false }
        Write-Status 'Enter yes or no.'
    }
}

function Read-InstallerPath {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Default
    )
    $Answer = Read-InstallerLine -Prompt "$Prompt [$Default]: "
    if ($Answer -eq '') { return $Default }
    return $Answer
}

function Invoke-LoggedNative {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    # Windows PowerShell turns redirected native stderr into ErrorRecord
    # objects. Do not treat a successful tool's progress output as a failure.
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments 2>&1 | ForEach-Object {
            [Console]::Error.WriteLine($_.ToString())
        }
        $NativeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($NativeExitCode -ne 0) {
        throw "$Executable failed with exit code $NativeExitCode."
    }
}

function Invoke-ConfigHelper {
    param(
        [Parameter(Mandatory)][string]$BunExecutable,
        [string[]]$Arguments = @()
    )
    $Output = & $BunExecutable (Join-Path $PSScriptRoot 'scripts/mcp-config.mjs') @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "MCP configuration failed with exit code $LASTEXITCODE."
    }
    return ($Output -join [Environment]::NewLine)
}

function Assert-PlainPath {
    param([Parameter(Mandatory)][string]$Path)
    $Current = $Path
    while ($Current) {
        $Item = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
        if ($null -ne $Item) {
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Symbolic links and junctions are not supported in the skills path: $Current. Use the physical directory path."
            }
        }
        $Parent = [IO.Path]::GetDirectoryName($Current)
        if ($Parent -eq $Current) { break }
        $Current = $Parent
    }
}

# PowerShell 5.1 can follow junctions while removing directories. Refuse them
# before replacing or recursively removing any tree.
function Assert-PlainTree {
    param([Parameter(Mandatory)][string]$Path)
    Assert-PlainPath -Path $Path
    $Pending = New-Object 'System.Collections.Generic.Stack[string]'
    $Pending.Push($Path)
    while ($Pending.Count -gt 0) {
        $Current = $Pending.Pop()
        foreach ($Item in Get-ChildItem -LiteralPath $Current -Force) {
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Symbolic links and junctions are not supported inside the skill: $($Item.FullName). Remove the link yourself first."
            }
            if ($Item.PSIsContainer) { $Pending.Push($Item.FullName) }
        }
    }
}

function Get-SkillInstallPlan {
    param([Parameter(Mandatory)][string]$ParentDirectory)
    if ($ParentDirectory -match '[\r\n]') {
        throw '-SkillsDir cannot contain a newline.'
    }
    if (-not [IO.Path]::IsPathRooted($ParentDirectory) -or $ParentDirectory -match '^[A-Za-z]:[^\\/]') {
        throw '-SkillsDir must be an absolute directory path.'
    }
    $ParentDirectory = [IO.Path]::GetFullPath($ParentDirectory)
    $Separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $ParentDirectory = $ParentDirectory.TrimEnd($Separators)
    $Root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($ParentDirectory + [IO.Path]::DirectorySeparatorChar)).TrimEnd($Separators)
    $HomeDir = [IO.Path]::GetFullPath($HOME).TrimEnd($Separators)
    if ($ParentDirectory -eq $Root -or $ParentDirectory -eq $HomeDir) {
        throw 'Choose a dedicated skills directory, not a filesystem root or home directory.'
    }
    Assert-PlainPath -Path $ParentDirectory

    $Source = Join-Path $PSScriptRoot 'skills/wow-addon'
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'SKILL.md') -PathType Leaf)) {
        throw "Missing source skill: $Source/SKILL.md. Use a complete repository checkout."
    }
    Assert-PlainTree -Path $Source
    $Target = Join-Path $ParentDirectory 'wow-addon'
    $RepositoryPrefix = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd($Separators) + [IO.Path]::DirectorySeparatorChar
    $TargetPrefix = [IO.Path]::GetFullPath($Target).TrimEnd($Separators) + [IO.Path]::DirectorySeparatorChar
    if ($TargetPrefix.StartsWith($RepositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $RepositoryPrefix.StartsWith($TargetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The install destination overlaps the source skill or repository. Choose a different skills directory.'
    }
    Assert-PlainPath -Path $Target
    $Exists = Test-Path -LiteralPath $Target
    if ($Exists -and -not (Test-Path -LiteralPath $Target -PathType Container)) {
        throw "The skill destination is not a directory: $Target. Move it yourself first."
    }
    return [PSCustomObject]@{
        SkillsDir = $ParentDirectory
        Source = $Source
        Target = $Target
        Exists = $Exists
    }
}

function Install-PortableSkill {
    param(
        [Parameter(Mandatory)]$Plan,
        [Parameter(Mandatory)][bool]$ReplaceExisting
    )
    $CurrentPlan = Get-SkillInstallPlan -ParentDirectory $Plan.SkillsDir
    if ($CurrentPlan.Exists -ne $Plan.Exists) {
        throw 'The skill destination changed while choosing settings. Rerun the installer.'
    }
    $Plan = $CurrentPlan
    if ($Plan.Exists -and -not $ReplaceExisting) {
        Write-Status "Skipped $($Plan.Target) (already exists; use -Force to replace)."
        return
    }
    if ($Plan.Exists) { Assert-PlainTree -Path $Plan.Target }
    [IO.Directory]::CreateDirectory($Plan.SkillsDir) | Out-Null
    $Staging = Join-Path $Plan.SkillsDir ('.wow-addon-install.' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($Staging) | Out-Null
    $NewSkill = Join-Path $Staging 'new'
    $Previous = Join-Path $Staging 'previous'
    try {
        Copy-Item -LiteralPath $Plan.Source -Destination $NewSkill -Recurse
        if ($Plan.Exists) { Move-Item -LiteralPath $Plan.Target -Destination $Previous }
        Move-Item -LiteralPath $NewSkill -Destination $Plan.Target
        Write-Status "Installed $($Plan.Target)"
    } finally {
        if ((Test-Path -LiteralPath $Previous) -and -not (Test-Path -LiteralPath $Plan.Target)) {
            Move-Item -LiteralPath $Previous -Destination $Plan.Target
        }
        Remove-Item -LiteralPath $Staging -Recurse -Force
    }
}

$TerminalInput = $false
try { $TerminalInput = $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected } catch {}
$AskQuestions = $Interactive -or (-not $NonInteractive -and $PSBoundParameters.Count -eq 0 -and $TerminalInput)
$InstallSkill = -not $Mcp
$PrepareMcp = [bool]$Mcp
$UpdateAnnotations = [bool]$Annotations
$ReplaceSkill = [bool]$Force
if (-not $SkillsDir) { $SkillsDir = Join-Path $HOME '.agents/skills' }

if ($AskQuestions) {
    $InstallSkill = Read-YesNo -Prompt 'Install the portable wow-addon skill?' -Default $true
    if ($InstallSkill) {
        $SkillsDir = Read-InstallerPath -Prompt 'Parent skills directory (absolute path)' -Default $SkillsDir
    }
}
$SkillPlan = $null
if ($InstallSkill) {
    $SkillPlan = Get-SkillInstallPlan -ParentDirectory $SkillsDir
    if ($AskQuestions -and $SkillPlan.Exists) {
        $ReplaceSkill = Read-YesNo -Prompt "Replace the existing skill at $($SkillPlan.Target)?" -Default $false
    }
}

# PowerShell 5.1 runs on Windows. The short circuit avoids reading an
# undefined $IsWindows variable on that version under strict mode.
$IsWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$DataHome = if ($IsWindowsHost) {
    if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData/Local' }
} else {
    Join-Path $HOME '.local/share'
}
$AnnotationRoot = if ($env:WOW_ANNOTATIONS_ROOT) { $env:WOW_ANNOTATIONS_ROOT } else { Join-Path $DataHome 'wow-annotations' }
$FrameXmlRoot = if ($env:WOW_FRAMEXML_ROOT) { $env:WOW_FRAMEXML_ROOT } else { Join-Path $DataHome 'wow-framexml' }

if ($AskQuestions) {
    $PrepareMcp = Read-YesNo -Prompt 'Prepare the local MCP server (install missing locked Bun dependencies, build, and print settings JSON)?' -Default $true
    if ($PrepareMcp) {
        $AnnotationRoot = Read-InstallerPath -Prompt 'WoW API annotations directory' -Default $AnnotationRoot
        $FrameXmlRoot = Read-InstallerPath -Prompt 'FrameXML annotations directory' -Default $FrameXmlRoot
    }
    $UpdateAnnotations = Read-YesNo -Prompt 'Clone or update local annotation repositories using git?' -Default ([bool]$Annotations)
}

$PreviousAnnotationRoot = $env:WOW_ANNOTATIONS_ROOT
$PreviousFrameXmlRoot = $env:WOW_FRAMEXML_ROOT
try {
    $BunExecutable = $null
    if ($PrepareMcp) {
        $BunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $BunCommand) {
            throw 'Bun is missing. Install Bun 1.3.12 or newer, then rerun the installer.'
        }
        $BunExecutable = $BunCommand.Source
        Invoke-LoggedNative -Executable $BunExecutable -Arguments @((Join-Path $PSScriptRoot 'scripts/mcp-config.mjs'), '--check-runtime')
        $env:WOW_ANNOTATIONS_ROOT = $AnnotationRoot
        $env:WOW_FRAMEXML_ROOT = $FrameXmlRoot
        $env:WOW_ANNOTATIONS_ROOT = Invoke-ConfigHelper -BunExecutable $BunExecutable -Arguments @('--annotations-root')
        $env:WOW_FRAMEXML_ROOT = Invoke-ConfigHelper -BunExecutable $BunExecutable -Arguments @('--framexml-root')
        Invoke-LoggedNative -Executable $BunExecutable -Arguments @((Join-Path $PSScriptRoot 'scripts/mcp-config.mjs'), '--check-prerequisites')
    }

    if ($UpdateAnnotations) {
        $LASTEXITCODE = 0
        & (Join-Path $PSScriptRoot 'maintain-annotations.ps1') -Check *>&1 | ForEach-Object {
            [Console]::Error.WriteLine($_.ToString())
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Annotation preflight failed with exit code $LASTEXITCODE."
        }
    }

    if ($InstallSkill) { Install-PortableSkill -Plan $SkillPlan -ReplaceExisting $ReplaceSkill }

    if ($PrepareMcp) {
        Push-Location -LiteralPath $PSScriptRoot
        try {
            $CompilerName = if ($IsWindowsHost) { 'tsc.cmd' } else { 'tsc' }
            $ServerDependency = Join-Path $PSScriptRoot 'node_modules/@modelcontextprotocol/server/package.json'
            $Compiler = Join-Path $PSScriptRoot ('node_modules/.bin/' + $CompilerName)
            if (-not (Test-Path -LiteralPath $ServerDependency -PathType Leaf) -or
                -not (Test-Path -LiteralPath $Compiler -PathType Leaf)) {
                Write-Status 'Installing locked Bun dependencies in the repository.'
                Invoke-LoggedNative -Executable $BunExecutable -Arguments @('ci')
            }
            Write-Status 'Building the local MCP server.'
            Invoke-LoggedNative -Executable $BunExecutable -Arguments @('run', 'build')
        } finally {
            Pop-Location
        }
    }

    if ($UpdateAnnotations) {
        $LASTEXITCODE = 0
        & (Join-Path $PSScriptRoot 'maintain-annotations.ps1') *>&1 | ForEach-Object {
            [Console]::Error.WriteLine($_.ToString())
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Annotation maintenance failed with exit code $LASTEXITCODE."
        }
    }

    if ($PrepareMcp) {
        $SettingsJson = Invoke-ConfigHelper -BunExecutable $BunExecutable
        Write-Status 'Copy this JSON into your MCP client settings.'
        Write-Output $SettingsJson
    }
} finally {
    $env:WOW_ANNOTATIONS_ROOT = $PreviousAnnotationRoot
    $env:WOW_FRAMEXML_ROOT = $PreviousFrameXmlRoot
}
