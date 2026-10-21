# ---------------------------------------------------------------------------
# maintain-annotations.ps1 - Clone/update multi-flavor WoW annotation repos
#
# Manages two annotation sources under the platform data root
# (%LOCALAPPDATA% on Windows, ~/.local/share elsewhere):
#   1. Ketho's vscode-wow-api   -> <data root>/wow-annotations/
#   2. NumyAddon FrameXML       -> <data root>/wow-framexml/ (bare + worktrees)
#
# Usage:
#   .\maintain-annotations.ps1                        # Update all flavors
#   .\maintain-annotations.ps1 -Flavor live            # Update one flavor
#   .\maintain-annotations.ps1 -Flavor live,classic_era # Update specific flavors
#   .\maintain-annotations.ps1 -Check                 # Validate paths and repositories
#   .\maintain-annotations.ps1 -Help                   # Show help
#
# PowerShell 5.1+ compatible.
# ---------------------------------------------------------------------------

#Requires -Version 5.1

[CmdletBinding()]
param(
    [string[]]$Flavor,
    [switch]$Check,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -- Constants --------------------------------------------------------------

$KethoRepo = "https://github.com/Ketho/vscode-wow-api"
$FrameXMLRepo = "https://github.com/NumyAddon/FramexmlAnnotations.git"

# Platform-native annotation storage. Windows uses the non-roaming user data
# convention (%LOCALAPPDATA%); macOS/Linux (pwsh) keep the ~/.local/share
# convention shared with maintain-annotations.sh and the TS tools' defaults.
# PowerShell 5.1 only runs on Windows; $IsWindows exists from 6+ (the -lt 6
# check must come first so 5.1 never evaluates the undefined variable).
$IsWindowsHost = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$DataHome = if ($IsWindowsHost) {
    if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
} else {
    Join-Path $HOME ".local/share"
}
$AnnotationsDir = if ($env:WOW_ANNOTATIONS_ROOT) { $env:WOW_ANNOTATIONS_ROOT } else { Join-Path $DataHome "wow-annotations" }
$FrameXMLDir = if ($env:WOW_FRAMEXML_ROOT) { $env:WOW_FRAMEXML_ROOT } else { Join-Path $DataHome "wow-framexml" }
$BareDir = Join-Path $FrameXMLDir ".bare"

$FlavorBranches = @{
    "live"                  = "live-mix-into-source"
    "classic"               = "classic-mix-into-source"
    "classic_era"           = "classic_era-mix-into-source"
    "classic_anniversary"   = "classic_anniversary-mix-into-source"
}
$AllFlavors = @("live", "classic", "classic_era", "classic_anniversary")

# -- Help -------------------------------------------------------------------

if ($Help) {
    Write-Host ""
    Write-Host "maintain-annotations.ps1" -ForegroundColor Cyan
    Write-Host "  Clone or update WoW API annotation repositories."
    Write-Host ""
    Write-Host "Parameters:" -ForegroundColor Yellow
    Write-Host "  -Flavor <name[]>  Specific flavors to update (default: all)"
    Write-Host "                    Valid: live, classic, classic_era, classic_anniversary"
    Write-Host "  -Check            Validate paths and repositories without changing them"
    Write-Host "  -Help             Show this help message"
    Write-Host ""
    Write-Host "Directories:" -ForegroundColor Yellow
    Write-Host "  Ketho annotations: $AnnotationsDir"
    Write-Host "  FrameXML flavors:  $FrameXMLDir"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Yellow
    Write-Host "  .\maintain-annotations.ps1"
    Write-Host "  .\maintain-annotations.ps1 -Flavor live"
    Write-Host "  .\maintain-annotations.ps1 -Flavor live,classic_era"
    Write-Host ""
    exit 0
}

# -- Guard: git must be available -------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "X" -ForegroundColor Red -NoNewline
    Write-Host " git is not installed or not in PATH. Install git first."
    exit 1
}

# -- Parse -Flavor into validated list --------------------------------------

$RequestedFlavors = if ($Flavor -and $Flavor.Count -gt 0) {
    foreach ($f in $Flavor) {
        if (-not $FlavorBranches.ContainsKey($f)) {
            Write-Host "X" -ForegroundColor Red -NoNewline
            Write-Host " Unknown flavor: '$f'"
            Write-Host "  Valid flavors: $($AllFlavors -join ', ')"
            exit 1
        }
    }
    $Flavor
} else {
    $AllFlavors
}

function Assert-PhysicalDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $Current = $Path
    while ($Current) {
        $Item = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
        if ($null -ne $Item) {
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Annotation paths cannot contain symbolic links or junctions: $Current. Choose the physical directory."
            }
            if (-not $Item.PSIsContainer) {
                throw "Annotation paths must be directories: $Current. Choose a dedicated directory."
            }
        }
        $Parent = [IO.Path]::GetDirectoryName($Current)
        if ($Parent -eq $Current) { break }
        $Current = $Parent
    }
}

function Get-AnnotationDirectory {
    param([Parameter(Mandatory)][string]$Path)
    if ($Path -match '[\r\n\x00]') {
        throw 'Annotation directory paths cannot contain line breaks or null characters.'
    }
    if (-not [IO.Path]::IsPathRooted($Path) -or
        ($IsWindowsHost -and $Path -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)')) {
        throw "Annotation directories must be absolute paths: $Path. Use an absolute WOW_ANNOTATIONS_ROOT or WOW_FRAMEXML_ROOT."
    }
    $FullPath = [IO.Path]::GetFullPath($Path)
    $Separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $Directory = $FullPath.TrimEnd($Separators)
    $Root = [IO.Path]::GetPathRoot($FullPath).TrimEnd($Separators)
    $HomeDirectory = [IO.Path]::GetFullPath($HOME).TrimEnd($Separators)
    if ($Directory -eq $Root -or $Directory -eq $HomeDirectory) {
        throw "Choose a dedicated annotation directory instead of a filesystem root or home directory: $FullPath."
    }
    Assert-PhysicalDirectory -Path $Directory
    return $Directory
}

function Test-DirectoryOverlap {
    param(
        [Parameter(Mandatory)][string]$First,
        [Parameter(Mandatory)][string]$Second
    )
    $Comparison = if ($IsWindowsHost) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $FirstPrefix = $First.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $SecondPrefix = $Second.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    return $FirstPrefix.StartsWith($SecondPrefix, $Comparison) -or $SecondPrefix.StartsWith($FirstPrefix, $Comparison)
}

function Read-GitValue {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $PreviousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Value = & git @Arguments 2>$null
        $ReadExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($ReadExitCode -ne 0) {
        throw "Cannot validate the annotation repository with git $($Arguments -join ' '). Choose the expected annotation repository or an empty directory."
    }
    return ($Value -join "`n").Trim()
}

function Assert-ExpectedOrigin {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Repository,
        [switch]$Bare
    )
    $Arguments = if ($Bare) { @('--git-dir', $Path) } else { @('-C', $Path) }
    $Origin = Read-GitValue -Arguments ($Arguments + @('remote', 'get-url', 'origin'))
    $Expected = '^(?:https://github\.com/|ssh://git@github\.com(?::22)?/|git@github\.com:)' + [Regex]::Escape($Repository) + '(?:\.git)?/?$'
    if ($Origin -notmatch $Expected) {
        throw "Annotation repository $Path has origin '$Origin'. Expected github.com/$Repository. Choose an empty directory or the expected repository."
    }
}

function Assert-WorkingRepository {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Repository,
        [string]$Branch
    )
    Assert-PhysicalDirectory -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) { return }
    $GitMarker = Join-Path $Path '.git'
    if (-not (Test-Path -LiteralPath $GitMarker)) {
        throw "Annotation directory contains unrelated data: $Path. Choose an empty directory or the expected repository."
    }
    $MarkerItem = Get-Item -LiteralPath $GitMarker -Force
    if ($MarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "The annotation Git directory is a symbolic link or junction: $GitMarker. Choose the physical repository."
    }
    $TopLevel = Read-GitValue -Arguments @('-C', $Path, 'rev-parse', '--show-toplevel')
    $ExpectedTopLevel = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $ActualTopLevel = [IO.Path]::GetFullPath($TopLevel).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $Comparison = if ($IsWindowsHost) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $ActualTopLevel.Equals($ExpectedTopLevel, $Comparison)) {
        throw "The annotation directory is inside another repository: $Path. Choose a dedicated annotation repository."
    }
    Assert-ExpectedOrigin -Path $Path -Repository $Repository
    if ($Branch) {
        $ActualBranch = Read-GitValue -Arguments @('-C', $Path, 'branch', '--show-current')
        if ($ActualBranch -cne $Branch) {
            throw "Annotation worktree $Path is on branch '$ActualBranch'. Expected '$Branch'. Switch to the expected branch before updating."
        }
    }
}

function Assert-AnnotationRepositories {
    $RepositoryDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
    if ((Test-DirectoryOverlap -First $AnnotationsDir -Second $RepositoryDirectory) -or
        (Test-DirectoryOverlap -First $FrameXMLDir -Second $RepositoryDirectory)) {
        throw 'Annotation directories must be separate from this checkout and its parent directories. Choose dedicated data directories.'
    }
    if (Test-DirectoryOverlap -First $AnnotationsDir -Second $FrameXMLDir) {
        throw 'WoW API and FrameXML annotation directories must be separate and cannot contain each other.'
    }
    Assert-WorkingRepository -Path $AnnotationsDir -Repository 'Ketho/vscode-wow-api'
    if (Test-Path -LiteralPath $FrameXMLDir -PathType Container) {
        $ExpectedNames = @('.bare') + $AllFlavors
        $MetadataNames = @('.DS_Store', 'Thumbs.db', 'desktop.ini')
        foreach ($Item in Get-ChildItem -LiteralPath $FrameXMLDir -Force) {
            if (-not $Item.PSIsContainer -and $MetadataNames -contains $Item.Name) { continue }
            $KnownName = if ($IsWindowsHost) { $ExpectedNames -contains $Item.Name } else { $ExpectedNames -ccontains $Item.Name }
            if (-not $KnownName) {
                throw "FrameXML directory contains unrelated data: $($Item.FullName). Choose an empty directory or the expected FrameXML layout."
            }
            Assert-PhysicalDirectory -Path $Item.FullName
        }
    }
    if ((Test-Path -LiteralPath $BareDir -PathType Container) -and @(Get-ChildItem -LiteralPath $BareDir -Force).Count -gt 0) {
        $IsBare = Read-GitValue -Arguments @('--git-dir', $BareDir, 'rev-parse', '--is-bare-repository')
        if ($IsBare -ne 'true') {
            throw "The FrameXML .bare directory is not a bare Git repository: $BareDir. Choose the expected repository or an empty directory."
        }
        Assert-ExpectedOrigin -Path $BareDir -Repository 'NumyAddon/FramexmlAnnotations' -Bare
    }
    foreach ($FlavorName in $RequestedFlavors) {
        $Worktree = Join-Path $FrameXMLDir $FlavorName
        Assert-WorkingRepository -Path $Worktree -Repository 'NumyAddon/FramexmlAnnotations' -Branch $FlavorBranches[$FlavorName]
    }
}

$AnnotationsDir = Get-AnnotationDirectory -Path $AnnotationsDir
$FrameXMLDir = Get-AnnotationDirectory -Path $FrameXMLDir
$BareDir = Join-Path $FrameXMLDir '.bare'
Assert-AnnotationRepositories
if ($Check) {
    [Console]::Error.WriteLine('Annotation paths and repositories passed validation.')
    exit 0
}

# -- Git wrapper ------------------------------------------------------------

function Invoke-GitCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDir,
        [Parameter(Mandatory)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $WorkingDir -PathType Container)) {
        throw "Working directory not found: $WorkingDir"
    }

    Write-Host "  git $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location -LiteralPath $WorkingDir
    $PreviousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git @Arguments 2>&1
        $GitExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousPreference
        Pop-Location
    }
    if ($GitExitCode -ne 0) {
        throw "Git failed during '$Description' (exit code $GitExitCode)"
    }
}

# -- Ketho repo (shared Core annotations) -----------------------------------

function Update-KethoRepo {
    [CmdletBinding()]
    param()

    Write-Host ""
    Write-Host "Ketho annotations" -ForegroundColor Cyan
    Write-Host "  Directory: $AnnotationsDir"

    $isFirstRun = -not (Test-Path -LiteralPath (Join-Path $AnnotationsDir ".git"))

    if ($isFirstRun) {
        Write-Host "  Cloning..." -ForegroundColor Yellow
        $parentDir = Split-Path $AnnotationsDir -Parent
        if (-not (Test-Path -LiteralPath $parentDir -PathType Container)) {
            [IO.Directory]::CreateDirectory($parentDir) | Out-Null
        }
        Invoke-GitCommand -Arguments @("clone", $KethoRepo, $AnnotationsDir) `
            -WorkingDir $parentDir `
            -Description "clone Ketho repo"
    } else {
        Write-Host "  Updating..." -ForegroundColor Yellow
        Invoke-GitCommand -Arguments @("pull", "--ff-only", "origin") `
            -WorkingDir $AnnotationsDir `
            -Description "pull Ketho repo"
    }

    # Init and update submodules (FrameXML submodule lives here)
    Write-Host "  Updating submodules..." -ForegroundColor Yellow
    Invoke-GitCommand -Arguments @("submodule", "update", "--init", "--recursive") `
        -WorkingDir $AnnotationsDir `
        -Description "update Ketho submodules"

    Write-Host "+" -ForegroundColor Green -NoNewline
    Write-Host " Ketho annotations up to date"
}

# -- FrameXML bare repo -----------------------------------------------------

function Update-BareRepo {
    [CmdletBinding()]
    param()

    $isFirstRun = -not (Test-Path -LiteralPath (Join-Path $BareDir 'HEAD') -PathType Leaf)

    if ($isFirstRun) {
        Write-Host "  Cloning bare repo..." -ForegroundColor Yellow
        if (-not (Test-Path -LiteralPath $FrameXMLDir -PathType Container)) {
            [IO.Directory]::CreateDirectory($FrameXMLDir) | Out-Null
        }
        Invoke-GitCommand -Arguments @("clone", "--bare", $FrameXMLRepo, $BareDir) `
            -WorkingDir $FrameXMLDir `
            -Description "clone bare FrameXML repo"
    } else {
        Write-Host "  Fetching bare repo..." -ForegroundColor Yellow
        Invoke-GitCommand -Arguments @("fetch", "origin", "--prune") `
            -WorkingDir $BareDir `
            -Description "fetch bare FrameXML repo"
    }
}

# -- Single flavor worktree -------------------------------------------------

function Update-Worktree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FlavorName,
        [Parameter(Mandatory)][string]$BranchName
    )

    $worktreeDir = Join-Path $FrameXMLDir $FlavorName
    $isFirstRun = -not (Test-Path -LiteralPath (Join-Path $worktreeDir '.git'))

    if ($isFirstRun) {
        Write-Host "  Creating worktree for '$FlavorName'..." -ForegroundColor Yellow
        Invoke-GitCommand -Arguments @("worktree", "add", $worktreeDir, $BranchName) `
            -WorkingDir $BareDir `
            -Description "create worktree $FlavorName"
    } else {
        Write-Host "  Updating worktree for '$FlavorName'..." -ForegroundColor Yellow
        $currentBranch = & git -C $worktreeDir branch --show-current
        if ($currentBranch -ne $BranchName) {
            throw "Worktree $FlavorName is on '$currentBranch', expected '$BranchName'"
        }
        Invoke-GitCommand -Arguments @("pull", "--ff-only", "origin", $BranchName) `
            -WorkingDir $worktreeDir `
            -Description "pull $FlavorName"
    }

    Write-Host "+" -ForegroundColor Green -NoNewline
    Write-Host " $FlavorName up to date"
}

# -- Main -------------------------------------------------------------------

Write-Host ""
Write-Host "=== WoW Annotation Maintenance ===" -ForegroundColor Magenta
Write-Host "Flavors: $($RequestedFlavors -join ', ')"

# Always update Ketho repo first (provides shared Core/ annotations)
Update-KethoRepo

# Update bare repo once, then each flavor worktree
Write-Host ""
Write-Host "FrameXML annotations" -ForegroundColor Cyan
Write-Host "  Bare repo: $BareDir"
Update-BareRepo

foreach ($flavorName in $RequestedFlavors) {
    $branchName = $FlavorBranches[$flavorName]
    if (-not $branchName) {
        throw "No branch mapping for flavor: $flavorName"
    }

    Write-Host ""
    Write-Host "FrameXML: $flavorName" -ForegroundColor Cyan
    Write-Host "  Branch: $branchName"
    Write-Host "  Directory: $(Join-Path $FrameXMLDir $flavorName)"

    Update-Worktree -FlavorName $flavorName -BranchName $branchName
}

# -- Summary ----------------------------------------------------------------

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "  Ketho annotations: $AnnotationsDir"
foreach ($flavorName in $RequestedFlavors) {
    Write-Host "  FrameXML ${flavorName}: $(Join-Path $FrameXMLDir $flavorName)"
}
Write-Host ""
