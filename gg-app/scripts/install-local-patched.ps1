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

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Read-VerifiedInstallerManifest([string]$Path, [string]$AllowedRoot) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Installer manifest not found: $Path"
  }

  try {
    $manifest = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    throw "Installer manifest is not valid JSON: $Path ($($_.Exception.Message))"
  }

  if ($manifest.schemaVersion -ne 1) {
    throw "Installer manifest schemaVersion must be 1: $($manifest.schemaVersion)"
  }
  $expectedIdentity = @{
    productName = 'GG Coder Local Fork'
    identifier = 'com.ggcoder.local-fork'
    mainBinaryName = 'gg-coder-local-fork'
    executableName = 'gg-coder-local-fork.exe'
    installMode = 'currentUser'
  }
  foreach ($property in $expectedIdentity.Keys) {
    if ([string]$manifest.identity.$property -cne $expectedIdentity[$property]) {
      throw "Installer manifest Local Fork identity mismatch for ${property}: expected=$($expectedIdentity[$property]) actual=$($manifest.identity.$property)"
    }
  }

  $installerValue = [string]$manifest.path
  $expectedSha256 = ([string]$manifest.sha256).Trim()
  if ([string]::IsNullOrWhiteSpace($installerValue) -or
      [string]::IsNullOrWhiteSpace($expectedSha256)) {
    throw 'Installer manifest must contain non-empty path and sha256 values'
  }
  if (-not [IO.Path]::IsPathRooted($installerValue)) {
    throw "Installer manifest path must be absolute: $installerValue"
  }
  if ($expectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Installer manifest sha256 must be exactly 64 hexadecimal characters: $expectedSha256"
  }

  $installer = [IO.Path]::GetFullPath($installerValue)
  if (-not (Test-PathWithinRoot -Path $installer -Root $AllowedRoot)) {
    throw "Installer manifest path is outside the allowed NSIS output directory: $installer"
  }
  if ([IO.Path]::GetFileName($installer) -notmatch '^GG Coder Local Fork_[^_]+_[^_]+-setup\.exe$') {
    throw "Installer manifest path is not a GG Coder Local Fork NSIS executable: $installer"
  }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer not found: $installer"
  }

  $item = Get-Item -LiteralPath $installer
  try { $expectedInstallerSize = [int64]$manifest.size } catch { throw 'Installer manifest size must be an integer' }
  if ($expectedInstallerSize -le 0) {
    throw "Installer manifest size must be positive: $expectedInstallerSize"
  }
  if ($expectedInstallerSize -ne $item.Length) {
    throw "Installer size mismatch: expected=$expectedInstallerSize actual=$($item.Length)"
  }

  $actualSha256 = Get-Sha256 -Path $installer
  $normalizedExpected = $expectedSha256.ToUpperInvariant()
  if ($actualSha256 -ne $normalizedExpected) {
    throw "Installer SHA-256 mismatch: expected=$normalizedExpected actual=$actualSha256"
  }

  if ([string]$manifest.payload.name -cne 'gg-coder-local-fork.exe') {
    throw "Installer manifest payload name must be gg-coder-local-fork.exe: $($manifest.payload.name)"
  }
  try { $payloadSize = [int64]$manifest.payload.size } catch { throw 'Installer manifest payload size must be an integer' }
  if ($payloadSize -le 0) {
    throw "Installer manifest payload size must be positive: $payloadSize"
  }
  $payloadSha256 = ([string]$manifest.payload.sha256).Trim()
  if ($payloadSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Installer manifest payload sha256 must be exactly 64 hexadecimal characters: $payloadSha256"
  }

  [pscustomobject]@{
    Path = $installer
    Sha256 = $normalizedExpected
    Size = $item.Length
    ProductName = [string]$manifest.identity.productName
    Identifier = [string]$manifest.identity.identifier
    MainBinaryName = [string]$manifest.identity.mainBinaryName
    ExecutableName = [string]$manifest.identity.executableName
    InstallMode = [string]$manifest.identity.installMode
    PayloadSize = $payloadSize
    PayloadSha256 = $payloadSha256.ToUpperInvariant()
  }
}

function Get-InstalledAppProcesses([string]$InstallDirectory) {
  $prefix = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-CurrentUserGgAppProcesses {
  $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  try {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'gg-coder-local-fork.exe'" -ErrorAction Stop)
  } catch {
    throw "Unable to enumerate gg-coder-local-fork.exe processes safely: $($_.Exception.Message)"
  }
  @($candidates | Where-Object {
    $candidate = $_
    try {
      $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop
    } catch {
      throw "Unable to verify owner of gg-coder-local-fork.exe PID=$($candidate.ProcessId): $($_.Exception.Message)"
    }
    if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace([string]$owner.Sid)) {
      throw "Unable to verify owner of gg-coder-local-fork.exe PID=$($candidate.ProcessId): GetOwnerSid returned $($owner.ReturnValue)"
    }
    $owner.Sid -eq $currentUserSid
  })
}

function Assert-NoUnrelatedGgAppProcesses(
  [string]$InstalledExecutable,
  [object[]]$Processes = @(Get-CurrentUserGgAppProcesses)
) {
  $unrelated = @($Processes | Where-Object {
    -not $_.ExecutablePath -or
      -not ([string]$_.ExecutablePath).Equals($InstalledExecutable, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($unrelated.Count -gt 0) {
    $details = @($unrelated | ForEach-Object {
      'PID={0} path={1}' -f $_.ProcessId, $(if ($_.ExecutablePath) { $_.ExecutablePath } else { '<unavailable>' })
    }) -join '; '
    throw "Refusing installation while unrelated current-user gg-coder-local-fork.exe process(es) remain: $details"
  }
}

function Get-AppRootSnapshots([string]$InstalledExecutable) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'gg-coder-local-fork.exe' -and $_.ExecutablePath -and
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
      throw "Refusing forced shutdown for uncaptured GG Coder Local Fork PID $($current.ProcessId)"
    }
    if (-not $current.ExecutablePath.Equals($captured[0].ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        $current.CreationTicks -ne $captured[0].CreationTicks) {
      throw "Refusing forced shutdown because GG Coder Local Fork PID $($current.ProcessId) changed identity"
    }
    if ($AcceptedCloseRootIds -notcontains $current.ProcessId) {
      throw "Refusing forced shutdown because GG Coder Local Fork PID $($current.ProcessId) did not accept a graceful window close"
    }
    if ($VisibleWindowRootIds -contains $current.ProcessId) {
      throw "Refusing forced shutdown because GG Coder Local Fork PID $($current.ProcessId) still has a visible main window"
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
      throw "Installed GG Coder Local Fork child processes exist without a verifiable app root; refusing to terminate PID(s): $($remainingWithoutRoot.ProcessId -join ', ')"
    }
    Write-Step 'GG Coder Local Fork was already closed'
    return $false
  }

  Write-Step "Requesting graceful close for GG Coder Local Fork PID(s): $($capturedRoots.ProcessId -join ', ')"
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
    Write-Step 'GG Coder Local Fork process tree exited cleanly'
    return $true
  }

  $currentRoots = @(Get-CurrentRootSnapshots -CapturedRoots $capturedRoots)
  if ($currentRoots.Count -eq 0) {
    throw "GG Coder Local Fork root exited but installed child processes remain; refusing unscoped termination of PID(s): $($remaining.ProcessId -join ', ')"
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

  Write-Step "Grace period expired after ${GraceSeconds}s with no app windows; terminating only captured GG Coder Local Fork tree root PID(s): $($currentRoots.ProcessId -join ', ')"
  foreach ($root in $currentRoots) {
    $null = & taskkill.exe /PID $root.ProcessId /T /F 2>&1
    Write-Step "Bounded fallback requested for captured PID=$($root.ProcessId); taskkillExit=$LASTEXITCODE"
  }

  $remaining = @(Wait-ForInstalledAppExit -InstallDirectory $InstallDirectory -Deadline (Get-Date).AddSeconds($ForceSeconds))
  if ($remaining.Count -gt 0) {
    throw "Timed out after bounded shutdown fallback; remaining installed PID(s): $($remaining.ProcessId -join ', ')"
  }
  Write-Step 'GG Coder Local Fork process tree exited after bounded captured-tree fallback'
  return $true
}

function Get-FileMetadata([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Expected executable not found: $Path"
  }
  $item = Get-Item -LiteralPath $Path
  [pscustomobject]@{
    Size = [int64]$item.Length
    Sha256 = Get-Sha256 -Path $Path
  }
}

function Assert-FileMatchesMetadata(
  [string]$Path,
  [int64]$ExpectedSize,
  [string]$ExpectedSha256,
  [string]$Description
) {
  $actual = Get-FileMetadata -Path $Path
  $normalizedExpected = $ExpectedSha256.ToUpperInvariant()
  if ($actual.Size -ne $ExpectedSize) {
    throw "${Description} size mismatch: expected=$ExpectedSize actual=$($actual.Size) path=$Path"
  }
  if ($actual.Sha256 -ne $normalizedExpected) {
    throw "${Description} SHA-256 mismatch: expected=$normalizedExpected actual=$($actual.Sha256) path=$Path"
  }
}

function Get-LocalForkUninstallRegistration {
  $registrationPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GG Coder Local Fork'
  if (-not (Test-Path -LiteralPath $registrationPath)) {
    throw "GG Coder Local Fork uninstall registration not found: $registrationPath"
  }
  Get-ItemProperty -LiteralPath $registrationPath
}

function Assert-LocalForkUninstallRegistration([string]$InstallDirectory) {
  $registration = Get-LocalForkUninstallRegistration
  $registeredDirectory = ([string]$registration.InstallLocation).Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($registeredDirectory)) {
    throw 'GG Coder Local Fork uninstall registration has no InstallLocation'
  }
  $expectedDirectory = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
  $actualDirectory = [IO.Path]::GetFullPath($registeredDirectory).TrimEnd('\')
  if (-not $actualDirectory.Equals($expectedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
    throw "GG Coder Local Fork uninstall registration points to the wrong directory: expected=$expectedDirectory actual=$actualDirectory"
  }
  if ([string]$registration.DisplayName -cne 'GG Coder Local Fork') {
    throw "GG Coder Local Fork uninstall registration has the wrong display name: $($registration.DisplayName)"
  }
  if ([string]$registration.MainBinaryName -cne 'gg-coder-local-fork.exe') {
    throw "GG Coder Local Fork uninstall registration has the wrong main binary: $($registration.MainBinaryName)"
  }
}

function Get-LocalForkRegistrationSnapshot(
  [string]$RegistrationPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GG Coder Local Fork'
) {
  if (-not (Test-Path -LiteralPath $registrationPath)) {
    return [pscustomobject]@{ Exists = $false; Values = @() }
  }
  $key = Get-Item -LiteralPath $registrationPath -ErrorAction Stop
  $values = @($key.GetValueNames() | ForEach-Object {
    [pscustomobject]@{
      Name = [string]$_
      Value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      Kind = [string]$key.GetValueKind($_)
    }
  })
  [pscustomobject]@{ Exists = $true; Values = $values }
}

function Restore-LocalForkRegistration(
  [object]$Snapshot,
  [string]$RegistrationPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GG Coder Local Fork'
) {
  if (Test-Path -LiteralPath $registrationPath) {
    Remove-Item -LiteralPath $registrationPath -Recurse -Force
  }
  if (-not $Snapshot.Exists) { return }
  $null = New-Item -Path $registrationPath -Force
  foreach ($value in $Snapshot.Values) {
    $null = New-ItemProperty -LiteralPath $registrationPath -Name $value.Name -Value $value.Value `
      -PropertyType $value.Kind -Force
  }
  Write-Step 'Restored previous Local Fork uninstall registration'
}

function Invoke-NsisInstaller([string]$InstallerPath) {
  $installProcess = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
  return [int]$installProcess.ExitCode
}

function Get-ProcessSnapshotById([int]$ProcessId) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $current) { return $null }
  [pscustomobject]@{
    ProcessId = [int]$current.ProcessId
    ExecutablePath = [string]$current.ExecutablePath
    CreationTicks = ([DateTime]$current.CreationDate).ToUniversalTime().Ticks
  }
}

function Start-VerifiedApp([string]$ExecutablePath, [ref]$LaunchedSnapshot) {
  Write-Step "Launching verified Local Fork app: $ExecutablePath"
  $launched = Start-Process -FilePath $ExecutablePath -PassThru
  $identityDeadline = (Get-Date).AddSeconds(1)
  do {
    $initialSnapshot = Get-ProcessSnapshotById -ProcessId $launched.Id
    if (-not $initialSnapshot) { Start-Sleep -Milliseconds 100 }
  } while (-not $initialSnapshot -and (Get-Date) -lt $identityDeadline)
  if (-not $initialSnapshot) {
    throw "Relaunched GG Coder Local Fork PID $($launched.Id) exited before its identity could be captured"
  }
  if (-not $initialSnapshot.ExecutablePath.Equals($ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Relaunched GG Coder Local Fork PID $($launched.Id) has an unexpected executable path: $($initialSnapshot.ExecutablePath)"
  }
  if ($LaunchedSnapshot) { $LaunchedSnapshot.Value = $initialSnapshot }

  Start-Sleep -Seconds 3
  $healthySnapshot = Get-ProcessSnapshotById -ProcessId $launched.Id
  if (-not $healthySnapshot -or $healthySnapshot.CreationTicks -ne $initialSnapshot.CreationTicks) {
    throw "Relaunched GG Coder Local Fork PID $($launched.Id) exited during startup"
  }
  if (-not $healthySnapshot.ExecutablePath.Equals($ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Relaunched GG Coder Local Fork PID $($launched.Id) changed executable path during startup: $($healthySnapshot.ExecutablePath)"
  }
  Write-Step "Verified GG Coder Local Fork startup health for PID=$($healthySnapshot.ProcessId)"
  return $healthySnapshot
}

function Stop-LaunchedVerifiedRoot([object]$Snapshot, [string]$ExpectedExecutable) {
  if (-not $Snapshot) { return }
  $current = Get-ProcessSnapshotById -ProcessId $Snapshot.ProcessId
  if (-not $current) { return }
  if (-not $current.ExecutablePath.Equals($ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
      $current.CreationTicks -ne $Snapshot.CreationTicks) {
    throw "Refusing rollback shutdown because launched PID $($Snapshot.ProcessId) changed identity"
  }
  $null = & taskkill.exe /PID $current.ProcessId /T /F 2>&1
  if ($LASTEXITCODE -ne 0 -and (Get-ProcessSnapshotById -ProcessId $current.ProcessId)) {
    throw "Failed to stop newly launched GG Coder Local Fork PID $($current.ProcessId) for rollback"
  }
  Write-Step "Stopped newly launched verified GG Coder Local Fork tree PID=$($current.ProcessId) for rollback"
}

function New-InstallBackupPath([string]$InstallDirectory) {
  $parent = Split-Path -Parent $InstallDirectory
  $leaf = Split-Path -Leaf $InstallDirectory
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
  Join-Path $parent ("{0}.backup-{1}-{2}" -f $leaf, $stamp, [Guid]::NewGuid().ToString('N'))
}

function Restore-InstallBackup(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [string]$BackupPath,
  [object]$PreviousMetadata,
  [object]$RegistrationSnapshot,
  [bool]$WasRunning,
  [object]$LaunchedSnapshot
) {
  try {
    Stop-LaunchedVerifiedRoot -Snapshot $LaunchedSnapshot -ExpectedExecutable $InstalledExecutable
    if (Test-Path -LiteralPath $InstallDirectory) {
      Remove-Item -LiteralPath $InstallDirectory -Recurse -Force
    }
    Move-Item -LiteralPath $BackupPath -Destination $InstallDirectory
    Assert-FileMatchesMetadata -Path $InstalledExecutable -ExpectedSize $PreviousMetadata.Size `
      -ExpectedSha256 $PreviousMetadata.Sha256 -Description 'Restored Local Fork executable'
    Restore-LocalForkRegistration -Snapshot $RegistrationSnapshot
    if ($WasRunning) {
      $null = Start-VerifiedApp -ExecutablePath $InstalledExecutable
    }
    Write-Step "ROLLBACK SUCCESS: restored verified previous install from $BackupPath"
  } catch {
    $rollbackError = $_.Exception.Message
    if (-not (Test-Path -LiteralPath $BackupPath) -and (Test-Path -LiteralPath $InstallDirectory)) {
      try {
        Move-Item -LiteralPath $InstallDirectory -Destination $BackupPath
      } catch {
        $rollbackError += "; failed to preserve restored directory at backup path: $($_.Exception.Message)"
      }
    }
    throw "ROLLBACK FAILED: $rollbackError. Manual recovery: restore '$BackupPath' to '$InstallDirectory'."
  }
}

function Remove-InstallBackupSafely([string]$BackupPath) {
  $recoveryArchive = "$BackupPath.recovery.zip"
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $recoveryArchive) {
      Remove-Item -LiteralPath $recoveryArchive -Force
    }
    [IO.Compression.ZipFile]::CreateFromDirectory(
      $BackupPath,
      $recoveryArchive,
      [IO.Compression.CompressionLevel]::NoCompression,
      $false
    )
  } catch {
    Remove-Item -LiteralPath $recoveryArchive -Force -ErrorAction SilentlyContinue
    throw "Backup cleanup was not started; intact backup remains at ${BackupPath}: $($_.Exception.Message)"
  }

  try {
    Remove-Item -LiteralPath $BackupPath -Recurse -Force
  } catch {
    throw "Backup directory cleanup failed; complete recovery archive retained at ${recoveryArchive}: $($_.Exception.Message)"
  }

  try {
    Remove-Item -LiteralPath $recoveryArchive -Force
  } catch {
    throw "Backup directory was removed; complete recovery archive retained at ${recoveryArchive}: $($_.Exception.Message)"
  }
}

function Invoke-VerifiedInstallTransaction(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [object]$InstallerManifest,
  [bool]$WasRunning
) {
  $backupPath = $null
  $backupCreated = $false
  $hadExistingInstall = Test-Path -LiteralPath $InstallDirectory
  $previousMetadata = $null
  $registrationSnapshot = $null
  $launchedSnapshot = $null
  $installerStarted = $false
  try {
    $registrationSnapshot = Get-LocalForkRegistrationSnapshot
    if ($hadExistingInstall) {
      $previousMetadata = Get-FileMetadata -Path $InstalledExecutable
      $backupPath = New-InstallBackupPath -InstallDirectory $InstallDirectory
      Move-Item -LiteralPath $InstallDirectory -Destination $backupPath
      $backupCreated = $true
      Write-Step "Moved previous Local Fork install atomically to backup: $backupPath"
    }

    Write-Step 'Starting verified NSIS installer in silent mode'
    $installerStarted = $true
    $installExitCode = Invoke-NsisInstaller -InstallerPath $InstallerManifest.Path
    Write-Step "Installer exited with code $installExitCode"
    if ($installExitCode -ne 0) {
      throw "NSIS installer failed with exit code $installExitCode"
    }

    Assert-FileMatchesMetadata -Path $InstalledExecutable -ExpectedSize $InstallerManifest.PayloadSize `
      -ExpectedSha256 $InstallerManifest.PayloadSha256 -Description 'Installed Local Fork executable'
    Assert-LocalForkUninstallRegistration -InstallDirectory $InstallDirectory
    Write-Step 'Installed payload and Local Fork uninstall registration verified'

    $null = Start-VerifiedApp -ExecutablePath $InstalledExecutable -LaunchedSnapshot ([ref]$launchedSnapshot)

    if ($backupPath) {
      try {
        Remove-InstallBackupSafely -BackupPath $backupPath
        $backupCreated = $false
        Write-Step "Removed verified-install backup and recovery archive: $backupPath"
      } catch {
        Write-Step "WARNING: healthy install retained recoverable backup at ${backupPath}: $($_.Exception.Message)"
      }
    }
    Write-Step "SUCCESS: installed and relaunched verified GG Coder Local Fork PID=$($launchedSnapshot.ProcessId)"
  } catch {
    $originalFailure = $_.Exception.Message
    Write-Step "TRANSACTION FAILED: $originalFailure"
    if ($backupCreated -and $backupPath -and $previousMetadata) {
      try {
        Restore-InstallBackup -InstallDirectory $InstallDirectory -InstalledExecutable $InstalledExecutable `
          -BackupPath $backupPath -PreviousMetadata $previousMetadata -RegistrationSnapshot $registrationSnapshot `
          -WasRunning $WasRunning -LaunchedSnapshot $launchedSnapshot
        throw "Installation failed and the previous install was restored: $originalFailure"
      } catch {
        if ($_.Exception.Message.StartsWith('Installation failed and the previous install was restored:')) {
          throw
        }
        throw "Installation failed: $originalFailure. $($_.Exception.Message)"
      }
    }

    if (-not $hadExistingInstall -and (Test-Path -LiteralPath $InstallDirectory)) {
      Remove-Item -LiteralPath $InstallDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($installerStarted -and $registrationSnapshot) {
      try {
        Restore-LocalForkRegistration -Snapshot $registrationSnapshot
      } catch {
        throw "Installation failed: $originalFailure. Registration rollback failed: $($_.Exception.Message)"
      }
    }
    if ($WasRunning -and $hadExistingInstall -and
        (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) {
      try { $null = Start-VerifiedApp -ExecutablePath $InstalledExecutable } catch {
        throw "Installation failed before backup: $originalFailure. Failed to restart unchanged GG Coder Local Fork: $($_.Exception.Message)"
      }
    }
    throw
  }
}

function Invoke-LocalPatchedInstall {
  $installDir = Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork'
  $installedExe = Join-Path $installDir 'gg-coder-local-fork.exe'
  $stableInstallDir = Join-Path $env:LOCALAPPDATA 'GG Coder'
  if ([IO.Path]::GetFullPath($installDir).Equals([IO.Path]::GetFullPath($stableInstallDir), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Local Fork installer resolved to the production GG Coder directory; refusing installation'
  }
  Set-Content -LiteralPath $script:InstallLogPath -Value ('[{0}] Detached installer helper started as PID {1}; delay={2}s' -f (Get-Date).ToString('o'), $PID, $DelaySeconds) -Encoding UTF8
  Start-Sleep -Seconds $DelaySeconds

  Write-Step "Reading Local Fork installer manifest from: $MetadataPath"
  $installerMetadata = Read-VerifiedInstallerManifest -Path $MetadataPath -AllowedRoot $AllowedInstallerRoot
  Write-Step "Installer and payload metadata verified: installer=$($installerMetadata.Sha256) payload=$($installerMetadata.PayloadSha256)"

  $wasRunning = @(Get-AppRootSnapshots -InstalledExecutable $installedExe).Count -gt 0
  $transactionStarted = $false
  try {
    $wasRunning = Stop-GgCoderForInstall -InstallDirectory $installDir -InstalledExecutable $installedExe `
      -GraceSeconds $GracefulShutdownSeconds -ForceSeconds $ForcedShutdownSeconds

    $reverified = Read-VerifiedInstallerManifest -Path $MetadataPath -AllowedRoot $AllowedInstallerRoot
    if ($reverified.Path -ne $installerMetadata.Path -or
        $reverified.Sha256 -ne $installerMetadata.Sha256 -or
        $reverified.PayloadSha256 -ne $installerMetadata.PayloadSha256 -or
        $reverified.PayloadSize -ne $installerMetadata.PayloadSize) {
      throw 'Installer manifest changed during shutdown; installation aborted'
    }
    Write-Step 'Installer and expected payload reverified after shutdown'
    Assert-NoUnrelatedGgAppProcesses -InstalledExecutable $installedExe
    Write-Step 'No unrelated current-user gg-coder-local-fork.exe processes remain'

    $transactionStarted = $true
    Invoke-VerifiedInstallTransaction -InstallDirectory $installDir -InstalledExecutable $installedExe `
      -InstallerManifest $reverified -WasRunning $wasRunning
  } catch {
    $preTransactionFailure = $_.Exception.Message
    if (-not $transactionStarted -and $wasRunning -and
        (Test-Path -LiteralPath $installedExe -PathType Leaf) -and
        @(Get-AppRootSnapshots -InstalledExecutable $installedExe).Count -eq 0) {
      try {
        $null = Start-VerifiedApp -ExecutablePath $installedExe
        Write-Step 'Restarted unchanged GG Coder Local Fork after pre-install failure'
      } catch {
        throw "Pre-install failure: $preTransactionFailure. Failed to restart unchanged GG Coder Local Fork: $($_.Exception.Message)"
      }
    }
    throw
  }
}

if (-not $LibraryOnly) {
  $helperExitCode = 0
  try {
    Invoke-LocalPatchedInstall
  } catch {
    Write-Step "FAILED: $($_.Exception.Message)"
    $helperExitCode = 1
  } finally {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $cleanupOutput = & schtasks.exe /Delete /TN $TaskName /F 2>&1
      $cleanupExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($cleanupExitCode -eq 0) {
      Write-Step "Removed scheduled task: $TaskName"
    } else {
      Write-Step "Scheduled-task cleanup warning for ${TaskName}: $($cleanupOutput -join ' ')"
    }
  }
  exit $helperExitCode
}
