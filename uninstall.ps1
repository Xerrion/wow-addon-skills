#Requires -Version 5.1
<#
.SYNOPSIS
Remove only the installed wow-addon skill. Preserve annotations and client configuration.
.PARAMETER SkillsDir
Absolute path to the parent skills directory. Defaults to ~/.agents/skills.
.PARAMETER Yes
Skip the confirmation prompt.
.PARAMETER Help
Show usage. PowerShell also supports -?.
#>
[CmdletBinding()]
param(
    [string]$SkillsDir,
    [switch]$Yes,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host 'Usage: .\uninstall.ps1 [-SkillsDir DIR] [-Yes]'
    Write-Host 'Remove only ~/.agents/skills/wow-addon. Preserve annotations and client configuration.'
    Write-Host 'SkillsDir must be an absolute path to a dedicated skills directory.'
    exit 0
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

# Check children without traversing links, including junctions on PowerShell 5.1.
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

if (-not $SkillsDir) { $SkillsDir = Join-Path $HOME '.agents/skills' }
if (-not [IO.Path]::IsPathRooted($SkillsDir) -or $SkillsDir -match '^[A-Za-z]:[^\\/]') {
    throw '-SkillsDir must be an absolute directory path.'
}
$SkillsDir = [IO.Path]::GetFullPath($SkillsDir)
$Separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$SkillsDir = $SkillsDir.TrimEnd($Separators)
$Root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($SkillsDir + [IO.Path]::DirectorySeparatorChar)).TrimEnd($Separators)
$HomeDir = [IO.Path]::GetFullPath($HOME).TrimEnd($Separators)
if ($SkillsDir -eq $Root -or $SkillsDir -eq $HomeDir) {
    throw 'Choose a dedicated skills directory, not a filesystem root or home directory.'
}
Assert-PlainPath -Path $SkillsDir
$Target = Join-Path $SkillsDir 'wow-addon'
$RepositoryPrefix = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd($Separators) + [IO.Path]::DirectorySeparatorChar
$TargetPrefix = [IO.Path]::GetFullPath($Target).TrimEnd($Separators) + [IO.Path]::DirectorySeparatorChar
if ($TargetPrefix.StartsWith($RepositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $RepositoryPrefix.StartsWith($TargetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The uninstall destination overlaps the source skill or repository. Choose the installed skills directory.'
}
Assert-PlainPath -Path $Target
if (-not (Test-Path -LiteralPath $Target)) {
    Write-Host "Already absent: $Target"
    exit 0
}
if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    throw "The skill destination is not a directory: $Target. Move it yourself first."
}
Assert-PlainTree -Path $Target

if (-not $Yes) {
    $Answer = Read-Host "Remove ${Target}? [y/N]"
    if ($Answer -notmatch '^(?i:y|yes)$') {
        Write-Host 'Aborted.'
        exit 0
    }
}
Remove-Item -LiteralPath $Target -Recurse -Force
Write-Host "Removed $Target"
