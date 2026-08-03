param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [int]$DelaySeconds = 20,
  [ValidateRange(1, 120)][int]$GracefulShutdownSeconds = 10,
  [ValidateRange(1, 120)][int]$ForcedShutdownSeconds = 15,
  [string]$MetadataPath,
  [string]$LogPath,
  [string]$AllowedInstallerRoot,
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($MetadataPath)) {
  $MetadataPath = Join-Path $repositoryRoot '.gg\local-fixes\latest-installer.json'
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $repositoryRoot '.gg\local-fixes\install-local-patched.log'
}
if ([string]::IsNullOrWhiteSpace($AllowedInstallerRoot)) {
  $AllowedInstallerRoot = Join-Path $repositoryRoot 'gg-app\src-tauri\target\release\bundle\nsis'
}

$script:InstallLogPath = $LogPath

function Write-Step([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $script:InstallLogPath -Value $line -Encoding UTF8
}

function Test-PathWithinRoot([string]$Path, [string]$Root) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
  return $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Read-VerifiedInstallerMetadata([string]$Path, [string]$AllowedRoot) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Installer metadata not found: $Path"
  }

  try {
    $metadata = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    throw "Installer metadata is not valid JSON: $Path ($($_.Exception.Message))"
  }

  $installerValue = [string]$metadata.path
  $expectedSha256 = ([string]$metadata.sha256).Trim()
  if ([string]::IsNullOrWhiteSpace($installerValue) -or
      [string]::IsNullOrWhiteSpace($expectedSha256)) {
    throw 'Installer metadata must contain non-empty path and sha256 values'
  }
  if (-not [IO.Path]::IsPathRooted($installerValue)) {
    throw "Installer metadata path must be absolute: $installerValue"
  }
  if ($expectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Installer metadata sha256 must be exactly 64 hexadecimal characters: $expectedSha256"
  }

  $installer = [IO.Path]::GetFullPath($installerValue)
  if (-not (Test-PathWithinRoot -Path $installer -Root $AllowedRoot)) {
    throw "Installer metadata path is outside the allowed NSIS output directory: $installer"
  }
  if ([IO.Path]::GetExtension($installer) -ne '.exe') {
    throw "Installer metadata path is not an executable: $installer"
  }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer not found: $installer"
  }

  $item = Get-Item -LiteralPath $installer
  if ($null -ne $metadata.size -and [int64]$metadata.size -ne $item.Length) {
    throw "Installer size mismatch: expected=$($metadata.size) actual=$($item.Length)"
  }

  $actualSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToUpperInvariant()
  $normalizedExpected = $expectedSha256.ToUpperInvariant()
  if ($actualSha256 -ne $normalizedExpected) {
    throw "Installer SHA-256 mismatch: expected=$normalizedExpected actual=$actualSha256"
  }

  [pscustomobject]@{
    Path = $installer
    Sha256 = $normalizedExpected
    Size = $item.Length
  }
}

function Get-InstalledAppProcesses([string]$InstallDirectory) {
  $prefix = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-AppRootSnapshots([string]$InstalledExecutable) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'gg-app.exe' -and $_.ExecutablePath -and
      $_.ExecutablePath.Equals($InstalledExecutable, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object {
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      ExecutablePath = [string]$_.ExecutablePath
      CreationTicks = ([DateTime]$_.CreationDate).ToUniversalTime().Ticks
    }
  })
}

function Get-CurrentRootSnapshots([object[]]$CapturedRoots) {
  @($CapturedRoots | ForEach-Object {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ProcessId)" -ErrorAction SilentlyContinue
    if ($current) {
      [pscustomobject]@{
        ProcessId = [int]$current.ProcessId
        ExecutablePath = [string]$current.ExecutablePath
        CreationTicks = ([DateTime]$current.CreationDate).ToUniversalTime().Ticks
      }
    }
  })
}

function Assert-SafeForceFallback(
  [object[]]$CapturedRoots,
  [object[]]$CurrentRoots,
  [int[]]$AcceptedCloseRootIds,
  [int[]]$VisibleWindowRootIds
) {
  foreach ($current in $CurrentRoots) {
    $captured = @($CapturedRoots | Where-Object { $_.ProcessId -eq $current.ProcessId })
    if ($captured.Count -ne 1) {
      throw "Refusing forced shutdown for uncaptured GG Coder PID $($current.ProcessId)"
    }
    if (-not $current.ExecutablePath.Equals($captured[0].ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        $current.CreationTicks -ne $captured[0].CreationTicks) {
      throw "Refusing forced shutdown because GG Coder PID $($current.ProcessId) changed identity"
    }
    if ($AcceptedCloseRootIds -notcontains $current.ProcessId) {
      throw "Refusing forced shutdown because GG Coder PID $($current.ProcessId) did not accept a graceful window close"
    }
    if ($VisibleWindowRootIds -contains $current.ProcessId) {
      throw "Refusing forced shutdown because GG Coder PID $($current.ProcessId) still has a visible main window"
    }
  }
}

function Wait-ForInstalledAppExit([string]$InstallDirectory, [DateTime]$Deadline) {
  do {
    $remaining = @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
    if ($remaining.Count -eq 0) {
      return @()
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)
  return @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
}

function Stop-GgCoderForInstall(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [int]$GraceSeconds,
  [int]$ForceSeconds
) {
  $capturedRoots = @(Get-AppRootSnapshots -InstalledExecutable $InstalledExecutable)
  if ($capturedRoots.Count -eq 0) {
    $remainingWithoutRoot = @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
    if ($remainingWithoutRoot.Count -gt 0) {
      throw "Installed GG Coder child processes exist without a verifiable app root; refusing to terminate PID(s): $($remainingWithoutRoot.ProcessId -join ', ')"
    }
    Write-Step 'GG Coder was already closed'
    return
  }

  Write-Step "Requesting graceful close for GG Coder PID(s): $($capturedRoots.ProcessId -join ', ')"
  $acceptedCloseRootIds = @()
  foreach ($root in $capturedRoots) {
    $acceptedAny = $false
    for ($windowIndex = 0; $windowIndex -lt 32; $windowIndex += 1) {
      $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
      if (-not $process) { break }
      $process.Refresh()
      if ($process.MainWindowHandle -eq [IntPtr]::Zero) { break }
      $handle = $process.MainWindowHandle
      $accepted = $process.CloseMainWindow()
      Write-Step "CloseMainWindow PID=$($root.ProcessId) handle=$handle accepted=$accepted"
      if (-not $accepted) { break }
      $acceptedAny = $true
      Start-Sleep -Milliseconds 300
    }
    if ($acceptedAny) {
      $acceptedCloseRootIds += $root.ProcessId
    }
  }

  $remaining = @(Wait-ForInstalledAppExit -InstallDirectory $InstallDirectory -Deadline (Get-Date).AddSeconds($GraceSeconds))
  if ($remaining.Count -eq 0) {
    Write-Step 'GG Coder process tree exited cleanly'
    return
  }

  $currentRoots = @(Get-CurrentRootSnapshots -CapturedRoots $capturedRoots)
  if ($currentRoots.Count -eq 0) {
    throw "GG Coder root exited but installed child processes remain; refusing unscoped termination of PID(s): $($remaining.ProcessId -join ', ')"
  }
  $visibleWindowRootIds = @()
  foreach ($root in $currentRoots) {
    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    if ($process) {
      $process.Refresh()
      if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        $visibleWindowRootIds += $root.ProcessId
      }
    }
  }
  Assert-SafeForceFallback -CapturedRoots $capturedRoots -CurrentRoots $currentRoots `
    -AcceptedCloseRootIds $acceptedCloseRootIds -VisibleWindowRootIds $visibleWindowRootIds

  Write-Step "Grace period expired after ${GraceSeconds}s with no app windows; terminating only captured GG Coder tree root PID(s): $($currentRoots.ProcessId -join ', ')"
  foreach ($root in $currentRoots) {
    $null = & taskkill.exe /PID $root.ProcessId /T /F 2>&1
    Write-Step "Bounded fallback requested for captured PID=$($root.ProcessId); taskkillExit=$LASTEXITCODE"
  }

  $remaining = @(Wait-ForInstalledAppExit -InstallDirectory $InstallDirectory -Deadline (Get-Date).AddSeconds($ForceSeconds))
  if ($remaining.Count -gt 0) {
    throw "Timed out after bounded shutdown fallback; remaining installed PID(s): $($remaining.ProcessId -join ', ')"
  }
  Write-Step 'GG Coder process tree exited after bounded captured-tree fallback'
}

function Invoke-LocalPatchedInstall {
  $installDir = Join-Path $env:LOCALAPPDATA 'GG Coder'
  $installedExe = Join-Path $installDir 'gg-app.exe'

  Set-Content -LiteralPath $script:InstallLogPath -Value ('[{0}] Detached installer helper started as PID {1}; delay={2}s' -f (Get-Date).ToString('o'), $PID, $DelaySeconds) -Encoding UTF8
  Start-Sleep -Seconds $DelaySeconds

  Write-Step "Reading installer path and SHA-256 from: $MetadataPath"
  $installerMetadata = Read-VerifiedInstallerMetadata -Path $MetadataPath -AllowedRoot $AllowedInstallerRoot
  Write-Step "Installer SHA-256 verified: $($installerMetadata.Sha256) ($($installerMetadata.Path))"

  Stop-GgCoderForInstall -InstallDirectory $installDir -InstalledExecutable $installedExe `
    -GraceSeconds $GracefulShutdownSeconds -ForceSeconds $ForcedShutdownSeconds

  $reverified = Read-VerifiedInstallerMetadata -Path $MetadataPath -AllowedRoot $AllowedInstallerRoot
  if ($reverified.Path -ne $installerMetadata.Path -or $reverified.Sha256 -ne $installerMetadata.Sha256) {
    throw 'Installer metadata changed during shutdown; installation aborted'
  }
  Write-Step 'Installer path and SHA-256 reverified after shutdown'

  Write-Step 'Starting verified NSIS installer in silent mode'
  $installProcess = Start-Process -FilePath $reverified.Path -ArgumentList '/S' -PassThru -Wait
  Write-Step "Installer exited with code $($installProcess.ExitCode)"
  if ($installProcess.ExitCode -ne 0) {
    throw "NSIS installer failed with exit code $($installProcess.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) {
    throw "Installed production executable not found: $installedExe"
  }

  Write-Step "Relaunching installed production app: $installedExe"
  $launched = Start-Process -FilePath $installedExe -PassThru
  Start-Sleep -Seconds 3
  if (-not (Get-Process -Id $launched.Id -ErrorAction SilentlyContinue)) {
    throw "Relaunched GG Coder PID $($launched.Id) exited during startup"
  }
  Write-Step "SUCCESS: installed and relaunched GG Coder PID=$($launched.Id)"
}

if (-not $LibraryOnly) {
  $helperExitCode = 0
  try {
    Invoke-LocalPatchedInstall
  } catch {
    Write-Step "FAILED: $($_.Exception.Message)"
    $helperExitCode = 1
  } finally {
    $cleanupOutput = & schtasks.exe /Delete /TN $TaskName /F 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Step "Removed scheduled task: $TaskName"
    } else {
      Write-Step "Scheduled-task cleanup warning for ${TaskName}: $($cleanupOutput -join ' ')"
    }
  }
  exit $helperExitCode
}
