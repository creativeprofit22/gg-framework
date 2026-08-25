param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [int]$DelaySeconds = 20,
  [ValidateRange(1, 120)][int]$GracefulShutdownSeconds = 10,
  [ValidateRange(1, 300)][int]$LockClearTimeoutSeconds = 30,
  [string]$MetadataPath,
  [string]$LogPath,
  [string]$AllowedInstallerRoot,
  [string]$ExpectedVersion,
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
$script:LockClearTimeoutMilliseconds = $LockClearTimeoutSeconds * 1000

function Write-Step([string]$Message) {
  $null = Assert-NoReparsePointTraversal -Path $script:InstallLogPath -Description 'Install log path'
  $line = '[{0}] {1}' -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $script:InstallLogPath -Value $line -Encoding UTF8
}

function Assert-NoReparsePointTraversal([string]$Path, [string]$Description = 'Path') {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  $current = $root
  $relative = $fullPath.Substring($root.Length)
  foreach ($segment in $relative.Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $segment
    try {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    } catch {
      if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { break }
      throw "Unable to inspect $Description component '$current': $($_.Exception.Message)"
    }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Description traverses a reparse point: $current"
    }
  }
  return $fullPath
}

function Assert-DirectoryTreeHasNoReparsePoints([string]$Path, [string]$Description = 'Directory') {
  $fullPath = Assert-NoReparsePointTraversal -Path $Path -Description $Description
  if (-not (Test-Path -LiteralPath $fullPath)) { return $fullPath }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
    throw "$Description is not a directory: $fullPath"
  }
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($fullPath)
  while ($pending.Count -gt 0) {
    foreach ($child in Get-ChildItem -LiteralPath $pending.Dequeue() -Force -ErrorAction Stop) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Description contains a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
    }
  }
  return $fullPath
}

function Test-PathWithinRoot([string]$Path, [string]$Root) {
  $fullPath = Assert-NoReparsePointTraversal -Path $Path -Description 'Contained path'
  $fullRoot = (Assert-NoReparsePointTraversal -Path $Root -Description 'Containment root').TrimEnd([char[]]@('\', '/'))
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

function Get-NativeErrorCode([Exception]$Exception) {
  $current = $Exception
  while ($current) {
    $code = $current.HResult -band 0xFFFF
    if ($code -in @(32, 33)) { return $code }
    $current = $current.InnerException
  }
  return ($Exception.HResult -band 0xFFFF)
}

function Test-SharingViolation([Exception]$Exception) {
  (Get-NativeErrorCode -Exception $Exception) -in @(32, 33)
}

function Invoke-RestartManagerQuery([string[]]$Resources) {
  return [GgCoder.RestartManagerDiagnostics]::Query($Resources)
}

function Get-RestartManagerLockState([string]$ResourcePath, [long]$QueryDeadlineTimestamp = [long]::MaxValue) {
  $fullPath = [IO.Path]::GetFullPath($ResourcePath)
  if (Test-Path -LiteralPath $fullPath -PathType Container) {
    return [pscustomobject]@{ ResourceCount = 0; Status = 'fatal'; Stage = 'validate';
      Reason = 'container-resource-not-allowed'; Owners = @() }
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    return [pscustomobject]@{ ResourceCount = 0; Status = 'none';
      Reason = 'no-existing-file-resource'; Owners = @() }
  }
  $resource = Assert-NoReparsePointTraversal -Path $fullPath -Description 'Restart Manager payload resource'

  if (-not ('GgCoder.RestartManagerDiagnostics' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace GgCoder {
  public sealed class RestartManagerOwner {
    public int ProcessId; public string AppName; public bool Restartable;
  }
  public sealed class RestartManagerQueryResult {
    public string Status, Stage, Reason;
    public int Error, Attempt, Attempts; public uint Needed;
    public RestartManagerOwner[] Owners = new RestartManagerOwner[0];
  }
  public static class RestartManagerDiagnostics {
    private const int ErrorMoreData = 234;
    private const uint MaxOwnerCount = 4096;
    private const int MaxListAttempts = 4;
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess {
      public int ProcessId;
      public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo {
      public UniqueProcess Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
      public uint ApplicationType, AppStatus, TerminalSessionId;
      [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, string[] services);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] affected, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll")] private static extern int RmEndSession(uint handle);

    public static RestartManagerQueryResult Query(string[] paths) {
      uint handle;
      int result = RmStartSession(out handle, 0, new StringBuilder(64));
      if (result != 0) return new RestartManagerQueryResult { Status = "unavailable", Stage = "start", Error = result };
      try {
        result = RmRegisterResources(handle, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null);
        if (result != 0) return new RestartManagerQueryResult { Status = "unavailable", Stage = "register", Error = result };
        uint needed = 0, count = 0, rebootReasons = 0;
        result = RmGetList(handle, out needed, ref count, null, ref rebootReasons);
        if (result == 0) return new RestartManagerQueryResult { Status = "none" };
        if (result != ErrorMoreData) return new RestartManagerQueryResult { Status = "unavailable", Stage = "list", Error = result };
        for (int attempt = 1; attempt <= MaxListAttempts; attempt++) {
          if (needed == 0 || needed > MaxOwnerCount)
            return new RestartManagerQueryResult { Status = "unavailable", Stage = "list", Reason = "owner-count-limit", Error = ErrorMoreData, Needed = needed, Attempt = attempt };
          var processInfo = new ProcessInfo[needed];
          count = needed;
          result = RmGetList(handle, out needed, ref count, processInfo, ref rebootReasons);
          if (result == 0) {
            var owners = new RestartManagerOwner[count];
            for (int index = 0; index < count; index++)
              owners[index] = new RestartManagerOwner { ProcessId = processInfo[index].Process.ProcessId, AppName = processInfo[index].AppName ?? "", Restartable = processInfo[index].Restartable };
            return new RestartManagerQueryResult { Status = "owners", Owners = owners };
          }
          if (result != ErrorMoreData) return new RestartManagerQueryResult { Status = "unavailable", Stage = "list", Error = result };
        }
        return new RestartManagerQueryResult { Status = "unavailable", Stage = "list", Reason = "error-more-data-retry-exhausted", Error = ErrorMoreData, Needed = needed, Attempts = MaxListAttempts };
      } finally { RmEndSession(handle); }
    }
  }
}
'@
  }
  if ($QueryDeadlineTimestamp -ne [long]::MaxValue -and
      [Diagnostics.Stopwatch]::GetTimestamp() -ge $QueryDeadlineTimestamp) {
    throw [TimeoutException]::new('Restart Manager polling deadline exhausted before query')
  }
  $query = Invoke-RestartManagerQuery -Resources ([string[]]@($resource))
  return [pscustomobject]@{ ResourceCount = 1; Status = [string]$query.Status;
    Stage = [string]$query.Stage; Reason = [string]$query.Reason; Error = [int]$query.Error;
    Needed = [uint32]$query.Needed; Attempt = [int]$query.Attempt; Attempts = [int]$query.Attempts;
    Owners = @($query.Owners) }
}

function Format-RestartManagerLockState([object]$State) {
  $parts = [Collections.Generic.List[string]]::new()
  $parts.Add("resourceCount=$($State.ResourceCount)"); $parts.Add("status=$($State.Status)")
  foreach ($field in @('Stage', 'Reason', 'Error', 'Needed')) {
    if ($State.$field) { $parts.Add("$($field.ToLower())=$($State.$field)") }
  }
  if ($State.Reason -eq 'owner-count-limit') { $parts.Add('limit=4096') }
  elseif ($null -ne $State.Limit) { $parts.Add("limit=$($State.Limit)") }
  foreach ($field in @('Attempt', 'Attempts')) { if ($State.$field) { $parts.Add("$($field.ToLower())=$($State.$field)") } }
  if ($State.DiagnosticExceptionType) { $parts.Add("diagnosticExceptionType=$($State.DiagnosticExceptionType)") }
  if ($State.DiagnosticMessage) {
    $message = ([string]$State.DiagnosticMessage).Replace('"', "'").Replace("`r", ' ').Replace("`n", ' ')
    $parts.Add("diagnosticMessage=`"$message`"")
  }
  $owners = @($State.Owners)
  if ($State.Status -eq 'owners') { $parts.Add("count=$($owners.Count)") }
  foreach ($owner in $owners) {
    $appName = ([string]$owner.AppName).Replace('"', "'").Replace("`r", ' ').Replace("`n", ' ')
    $parts.Add("ownerPid=$($owner.ProcessId)"); $parts.Add("ownerApp=`"$appName`"")
    $parts.Add("ownerRestartable=$($owner.Restartable)")
  }
  return $parts -join ' '
}

function Throw-LockClearTimeout([string]$InstalledExecutable, [int]$TimeoutMilliseconds, [int]$Attempts,
  [string]$LastEvidence, [string]$LastOwnerEvidence) {
  $ownerEvidence = if ($LastOwnerEvidence) { "; lastOwnerEvidence=$LastOwnerEvidence" } else { '' }
  $message = "Installed payload locks did not clear before the ${TimeoutMilliseconds}ms Restart Manager polling deadline; attempts=$Attempts; installedExecutable=`"$InstalledExecutable`"; lastEvidence=$LastEvidence$ownerEvidence"
  Write-Step "LOCK CLEAR TIMEOUT $message"
  throw $message
}

function Wait-InstalledPayloadLocksClear([string]$InstalledExecutable,
  [ValidateRange(1, 300000)][int]$TimeoutMilliseconds,
  [ValidateRange(10, 5000)][int]$PollIntervalMilliseconds = 250) {
  $frequency = [Diagnostics.Stopwatch]::Frequency
  $startedTimestamp = [Diagnostics.Stopwatch]::GetTimestamp()
  $deadlineTimestamp = $startedTimestamp + [long][Math]::Ceiling($TimeoutMilliseconds * $frequency / 1000.0)
  $attempt = 0; $lastEvidence = 'status=unavailable reason=not-queried'; $lastOwnerEvidence = $null
  while ($true) {
    $beforeQueryTimestamp = [Diagnostics.Stopwatch]::GetTimestamp()
    if ($beforeQueryTimestamp -ge $deadlineTimestamp) {
      $elapsedMilliseconds = [long](($beforeQueryTimestamp - $startedTimestamp) * 1000.0 / $frequency)
      $lastEvidence = 'status=unavailable reason=polling-deadline-exhausted-before-query'
      Write-Step "LOCK CLEAR ATTEMPT attempt=$($attempt + 1) elapsedMs=$elapsedMilliseconds installedExecutable=`"$InstalledExecutable`" $lastEvidence"
      Throw-LockClearTimeout $InstalledExecutable $TimeoutMilliseconds $attempt $lastEvidence $lastOwnerEvidence
    }
    $attempt += 1
    try {
      $state = Get-RestartManagerLockState -ResourcePath $InstalledExecutable -QueryDeadlineTimestamp $deadlineTimestamp
    } catch {
      $state = [pscustomobject]@{ ResourceCount = 0; Status = 'unavailable';
        DiagnosticExceptionType = $_.Exception.GetType().FullName; DiagnosticMessage = $_.Exception.Message; Owners = @() }
    }
    $lastEvidence = Format-RestartManagerLockState -State $state
    if ($state.Status -eq 'owners') { $lastOwnerEvidence = $lastEvidence }
    $afterQueryTimestamp = [Diagnostics.Stopwatch]::GetTimestamp()
    $elapsedMilliseconds = [long](($afterQueryTimestamp - $startedTimestamp) * 1000.0 / $frequency)
    Write-Step "LOCK CLEAR ATTEMPT attempt=$attempt elapsedMs=$elapsedMilliseconds installedExecutable=`"$InstalledExecutable`" $lastEvidence"
    if ($state.Status -eq 'fatal') {
      $message = "Restart Manager lock query cannot safely continue; installedExecutable=`"$InstalledExecutable`"; evidence=$lastEvidence"
      Write-Step "LOCK CLEAR FAILED $message"
      throw $message
    }
    if ($afterQueryTimestamp -ge $deadlineTimestamp) {
      Throw-LockClearTimeout $InstalledExecutable $TimeoutMilliseconds $attempt $lastEvidence $lastOwnerEvidence
    }
    if ($state.Status -eq 'none') {
      Write-Step "LOCK CLEAR SUCCESS attempts=$attempt elapsedMs=$elapsedMilliseconds installedExecutable=`"$InstalledExecutable`""
      return
    }
    $remainingMilliseconds = [long][Math]::Ceiling(($deadlineTimestamp - $afterQueryTimestamp) * 1000.0 / $frequency)
    Start-Sleep -Milliseconds ([Math]::Min($PollIntervalMilliseconds, $remainingMilliseconds))
  }
}

function Write-OperationFailureDiagnostic([string]$Operation, [string]$Path, [Exception]$Exception) {
  $hresult = '0x{0:X8}' -f ([uint32]($Exception.HResult -band 0xFFFFFFFFL))
  Write-Step "OPERATION FAILED name=$Operation path=`"$Path`" exceptionType=$($Exception.GetType().FullName) hresult=$hresult message=`"$($Exception.Message)`""
  if (Test-SharingViolation -Exception $Exception) {
    try {
      $lockState = Get-RestartManagerLockState -ResourcePath $Path
      $lockEvidence = Format-RestartManagerLockState -State $lockState
      Write-Step "LOCK EVIDENCE name=$Operation path=`"$Path`" nativeError=$(Get-NativeErrorCode -Exception $Exception) $lockEvidence"
    } catch {
      Write-Step "LOCK EVIDENCE name=$Operation path=`"$Path`" status=unavailable diagnosticExceptionType=$($_.Exception.GetType().FullName) diagnosticMessage=`"$($_.Exception.Message)`""
    }
  }
}

function Get-PreInstallerFileMetadata([string]$Path) {
  $operation = 'pre-installer-hash'
  Write-Step "OPERATION START name=$operation path=`"$Path`""
  try {
    $metadata = Get-FileMetadata -Path $Path
    Write-Step "OPERATION SUCCESS name=$operation path=`"$Path`" size=$($metadata.Size) sha256=$($metadata.Sha256)"
    return $metadata
  } catch {
    Write-OperationFailureDiagnostic -Operation $operation -Path $Path -Exception $_.Exception
    throw
  }
}

function Move-InstallDirectoryToBackup([string]$InstallDirectory, [string]$BackupPath) {
  $operation = 'pre-installer-directory-rename'
  Write-Step "OPERATION START name=$operation path=`"$InstallDirectory`" destinationPath=`"$BackupPath`""
  try {
    $null = Assert-DirectoryTreeHasNoReparsePoints -Path $InstallDirectory -Description 'Install directory'
    $null = Assert-NoReparsePointTraversal -Path (Split-Path -Parent $BackupPath) -Description 'Backup parent directory'
    $null = Assert-NoReparsePointTraversal -Path $BackupPath -Description 'Backup path'
    if (Test-Path -LiteralPath $BackupPath) { throw "Backup path already exists: $BackupPath" }
    Move-Item -LiteralPath $InstallDirectory -Destination $BackupPath
    Write-Step "OPERATION SUCCESS name=$operation path=`"$InstallDirectory`" destinationPath=`"$BackupPath`""
  } catch {
    Write-OperationFailureDiagnostic -Operation $operation -Path $InstallDirectory -Exception $_.Exception
    throw
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
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    throw "Unable to enumerate installed Local Fork processes: $($_.Exception.Message)"
  }
  @($processes | ForEach-Object {
    if (-not $_.ExecutablePath) { return }
    try {
      $executablePath = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
    } catch {
      throw "Unable to canonicalize process path for PID=$($_.ProcessId): $($_.Exception.Message)"
    }
    if ($executablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        ParentProcessId = [int]$_.ParentProcessId
        Name = [string]$_.Name
        ExecutablePath = $executablePath
        CreationTicks = ([DateTime]$_.CreationDate).ToUniversalTime().Ticks
      }
    }
  })
}

function Format-InstalledAppProcesses([object[]]$Processes) {
  if ($Processes.Count -eq 0) { return 'count=0' }
  $items = @($Processes | ForEach-Object {
    'pid={0} parentPid={1} name="{2}" path="{3}"' -f $_.ProcessId, $_.ParentProcessId, `
      ([string]$_.Name).Replace('"', "'"), ([string]$_.ExecutablePath).Replace('"', "'")
  })
  "count=$($Processes.Count) $($items -join '; ')"
}

function Wait-LocalForkReplacementGate(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [ValidateRange(1, 300000)][int]$TimeoutMilliseconds,
  [ValidateRange(10, 5000)][int]$PollIntervalMilliseconds = 250
) {
  $frequency = [Diagnostics.Stopwatch]::Frequency
  $startedTimestamp = [Diagnostics.Stopwatch]::GetTimestamp()
  $deadlineTimestamp = $startedTimestamp + [long][Math]::Ceiling($TimeoutMilliseconds * $frequency / 1000.0)
  $attempt = 0; $lastProcessEvidence = 'not-probed'; $lastLockEvidence = 'not-probed'
  while ([Diagnostics.Stopwatch]::GetTimestamp() -lt $deadlineTimestamp) {
    $attempt += 1
    $processes = @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
    $lastProcessEvidence = Format-InstalledAppProcesses -Processes $processes
    try {
      $lockState = Get-RestartManagerLockState -ResourcePath $InstalledExecutable -QueryDeadlineTimestamp $deadlineTimestamp
    } catch {
      if ($_.Exception.Message -eq 'Restart Manager polling deadline exhausted before query' -and
          [Diagnostics.Stopwatch]::GetTimestamp() -ge $deadlineTimestamp) {
        break
      }
      throw "Local Fork replacement gate Restart Manager query failed closed: $($_.Exception.Message); processes=$lastProcessEvidence"
    }
    $lastLockEvidence = Format-RestartManagerLockState -State $lockState
    Write-Step "REPLACEMENT GATE attempt=$attempt processes=[$lastProcessEvidence] restartManager=[$lastLockEvidence]"
    if ($lockState.Status -in @('fatal', 'unavailable')) {
      throw "Local Fork replacement gate cannot safely continue; processes=$lastProcessEvidence; restartManager=$lastLockEvidence"
    }
    if ($processes.Count -eq 0 -and $lockState.Status -eq 'none') {
      Write-Step "REPLACEMENT GATE SUCCESS attempts=$attempt"
      return
    }
    $remainingMilliseconds = [long][Math]::Ceiling(($deadlineTimestamp - [Diagnostics.Stopwatch]::GetTimestamp()) * 1000.0 / $frequency)
    if ($remainingMilliseconds -gt 0) {
      Start-Sleep -Milliseconds ([Math]::Min($PollIntervalMilliseconds, $remainingMilliseconds))
    }
  }
  throw "Local Fork replacement gate timed out after ${TimeoutMilliseconds}ms; attempts=$attempt; processes=$lastProcessEvidence; restartManager=$lastLockEvidence"
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
  $installDirectory = Split-Path -Parent $InstalledExecutable
  @(Get-InstalledAppProcesses -InstallDirectory $installDirectory | Where-Object {
    $_.Name -eq 'gg-coder-local-fork.exe' -and
      $_.ExecutablePath.Equals($InstalledExecutable, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Wait-ForInstalledAppExit([string]$InstallDirectory, [DateTime]$Deadline) {
  do {
    $remaining = @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
    if ($remaining.Count -eq 0) { return @() }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)
  return @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
}

function Stop-GgCoderForInstall(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [int]$GraceSeconds
) {
  $capturedRoots = @(Get-AppRootSnapshots -InstalledExecutable $InstalledExecutable)
  if ($capturedRoots.Count -eq 0) {
    $remainingWithoutRoot = @(Get-InstalledAppProcesses -InstallDirectory $InstallDirectory)
    if ($remainingWithoutRoot.Count -gt 0) {
      throw "Installed GG Coder Local Fork child processes exist without a verifiable app root; refusing shutdown: $(Format-InstalledAppProcesses $remainingWithoutRoot)"
    }
    Write-Step 'GG Coder Local Fork was already closed'
    return $false
  }

  Write-Step "Requesting graceful close for GG Coder Local Fork PID(s): $($capturedRoots.ProcessId -join ', ')"
  foreach ($root in $capturedRoots) {
    $current = Get-ProcessSnapshotById -ProcessId $root.ProcessId
    if (-not $current) { continue }
    if (-not $current.ExecutablePath.Equals($root.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        $current.CreationTicks -ne $root.CreationTicks) {
      throw "Refusing graceful shutdown because PID $($root.ProcessId) changed identity"
    }
    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $process.Refresh()
    if (-not $process.Path.Equals($root.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        $process.StartTime.ToUniversalTime().Ticks -ne $root.CreationTicks) {
      throw "Refusing graceful shutdown because PID $($root.ProcessId) changed identity"
    }
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
    $handle = $process.MainWindowHandle
    $accepted = $process.CloseMainWindow()
    Write-Step "CloseMainWindow PID=$($root.ProcessId) handle=$handle accepted=$accepted"
  }

  $remaining = @(Wait-ForInstalledAppExit -InstallDirectory $InstallDirectory -Deadline (Get-Date).AddSeconds($GraceSeconds))
  if ($remaining.Count -eq 0) {
    Write-Step 'GG Coder Local Fork process tree exited cleanly'
    return $true
  }
  throw "Timed out waiting for graceful shutdown after ${GraceSeconds}s; $(Format-InstalledAppProcesses $remaining)"
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

function Assert-ExpectedVersion([string]$Value) {
  if ($Value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Invalid expected version: require numeric major.minor.patch'
  }
  $Value
}

function ConvertTo-NumericCoreVersion([string]$Value, [string]$Description) {
  $trimmed = $Value.Trim()
  if ($trimmed -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.0)?$') {
    throw "$Description is missing or ambiguous: $Value"
  }
  "$($Matches[1]).$($Matches[2]).$($Matches[3])"
}

function Assert-InstalledProductVersion([string]$Path, [string]$ExpectedVersion) {
  $validatedExpected = Assert-ExpectedVersion -Value $ExpectedVersion
  $versionInfo = (Get-Item -LiteralPath $Path -ErrorAction Stop).VersionInfo
  $productVersion = ConvertTo-NumericCoreVersion -Value ([string]$versionInfo.ProductVersion) -Description 'Installed ProductVersion'
  $fileVersion = ConvertTo-NumericCoreVersion -Value ([string]$versionInfo.FileVersion) -Description 'Installed FileVersion'
  if ($productVersion -ne $validatedExpected -or $fileVersion -ne $validatedExpected) {
    throw "Installed Local Fork version mismatch: expected=$validatedExpected productVersion=$productVersion fileVersion=$fileVersion"
  }
  $validatedExpected
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
  [pscustomobject]@{
    DisplayName = [string]$registration.DisplayName
    InstallLocation = $actualDirectory
    MainBinaryName = [string]$registration.MainBinaryName
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
  $null = Assert-NoReparsePointTraversal -Path $InstallerPath -Description 'Installer executable path'
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
  $null = Assert-NoReparsePointTraversal -Path $ExecutablePath -Description 'Installed executable path'
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
  $null = Assert-NoReparsePointTraversal -Path $parent -Description 'Backup parent directory'
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
      $null = Assert-DirectoryTreeHasNoReparsePoints -Path $InstallDirectory -Description 'Failed install directory'
      Remove-Item -LiteralPath $InstallDirectory -Recurse -Force
    }
    $null = Assert-DirectoryTreeHasNoReparsePoints -Path $BackupPath -Description 'Rollback backup directory'
    $null = Assert-NoReparsePointTraversal -Path (Split-Path -Parent $InstallDirectory) -Description 'Install parent directory'
    $null = Assert-NoReparsePointTraversal -Path $InstallDirectory -Description 'Rollback destination path'
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
        $null = Assert-DirectoryTreeHasNoReparsePoints -Path $InstallDirectory -Description 'Restored install directory'
        $null = Assert-NoReparsePointTraversal -Path $BackupPath -Description 'Backup preservation path'
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
  $null = Assert-DirectoryTreeHasNoReparsePoints -Path $BackupPath -Description 'Backup cleanup directory'
  $null = Assert-NoReparsePointTraversal -Path (Split-Path -Parent $BackupPath) -Description 'Backup parent directory'
  $null = Assert-NoReparsePointTraversal -Path $recoveryArchive -Description 'Recovery archive path'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $recoveryArchive) {
      $null = Assert-NoReparsePointTraversal -Path $recoveryArchive -Description 'Existing recovery archive'
      Remove-Item -LiteralPath $recoveryArchive -Force
    }
    [IO.Compression.ZipFile]::CreateFromDirectory(
      $BackupPath,
      $recoveryArchive,
      [IO.Compression.CompressionLevel]::NoCompression,
      $false
    )
  } catch {
    $archiveFailure = $_.Exception.Message
    if (Test-Path -LiteralPath $recoveryArchive) {
      $null = Assert-NoReparsePointTraversal -Path $recoveryArchive -Description 'Partial recovery archive'
      Remove-Item -LiteralPath $recoveryArchive -Force -ErrorAction SilentlyContinue
    }
    throw "Backup cleanup was not started; intact backup remains at ${BackupPath}: $archiveFailure"
  }

  try {
    $null = Assert-DirectoryTreeHasNoReparsePoints -Path $BackupPath -Description 'Backup cleanup directory'
    Remove-Item -LiteralPath $BackupPath -Recurse -Force
  } catch {
    throw "Backup directory cleanup failed; complete recovery archive retained at ${recoveryArchive}: $($_.Exception.Message)"
  }

  try {
    $null = Assert-NoReparsePointTraversal -Path $recoveryArchive -Description 'Recovery archive path'
    Remove-Item -LiteralPath $recoveryArchive -Force
  } catch {
    throw "Backup directory was removed; complete recovery archive retained at ${recoveryArchive}: $($_.Exception.Message)"
  }
}

function Remove-FailedNewInstall([string]$InstallDirectory) {
  try {
    if (-not (Test-Path -LiteralPath $InstallDirectory)) { return }
    $null = Assert-DirectoryTreeHasNoReparsePoints -Path $InstallDirectory -Description 'Failed new install directory'
    Remove-Item -LiteralPath $InstallDirectory -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $InstallDirectory) {
      throw 'directory still exists after removal'
    }
    Write-Step "Removed failed new install directory: $InstallDirectory"
  } catch {
    throw "Failed new-install cleanup; partial install may remain at '$InstallDirectory'. Manual recovery: remove that directory after stopping Local Fork processes. $($_.Exception.Message)"
  }
}

function Invoke-VerifiedInstallTransaction(
  [string]$InstallDirectory,
  [string]$InstalledExecutable,
  [object]$InstallerManifest,
  [bool]$WasRunning,
  [string]$ExpectedVersion
) {
  $backupPath = $null
  $backupCreated = $false
  $hadExistingInstall = Test-Path -LiteralPath $InstallDirectory
  $previousMetadata = $null
  $registrationSnapshot = $null
  $launchedSnapshot = $null
  $installerStarted = $false
  try {
    $null = Assert-NoReparsePointTraversal -Path (Split-Path -Parent $InstallDirectory) -Description 'Install parent directory'
    $null = Assert-NoReparsePointTraversal -Path $InstallDirectory -Description 'Install directory path'
    Wait-LocalForkReplacementGate -InstallDirectory $InstallDirectory -InstalledExecutable $InstalledExecutable `
      -TimeoutMilliseconds $script:LockClearTimeoutMilliseconds
    $registrationSnapshot = Get-LocalForkRegistrationSnapshot
    if ($hadExistingInstall) {
      $previousMetadata = Get-PreInstallerFileMetadata -Path $InstalledExecutable
      $backupPath = New-InstallBackupPath -InstallDirectory $InstallDirectory
      Move-InstallDirectoryToBackup -InstallDirectory $InstallDirectory -BackupPath $backupPath
      $backupCreated = $true
      Write-Step "Moved previous Local Fork install atomically to backup: $backupPath"
    }

    $null = Assert-NoReparsePointTraversal -Path (Split-Path -Parent $InstallDirectory) -Description 'Install parent directory'
    $null = Assert-NoReparsePointTraversal -Path $InstallDirectory -Description 'Installer destination path'
    Write-Step 'Starting verified NSIS installer in silent mode'
    $installerStarted = $true
    $installExitCode = Invoke-NsisInstaller -InstallerPath $InstallerManifest.Path
    Write-Step "Installer exited with code $installExitCode"
    if ($installExitCode -ne 0) {
      throw "NSIS installer failed with exit code $installExitCode"
    }

    Assert-FileMatchesMetadata -Path $InstalledExecutable -ExpectedSize $InstallerManifest.PayloadSize `
      -ExpectedSha256 $InstallerManifest.PayloadSha256 -Description 'Installed Local Fork executable'
    $installedVersion = Assert-InstalledProductVersion -Path $InstalledExecutable -ExpectedVersion $ExpectedVersion
    $registrationMarker = Assert-LocalForkUninstallRegistration -InstallDirectory $InstallDirectory
    Write-Step 'Installed payload, version, and Local Fork uninstall registration verified'

    $healthySnapshot = Start-VerifiedApp -ExecutablePath $InstalledExecutable -LaunchedSnapshot ([ref]$launchedSnapshot)
    Assert-FileMatchesMetadata -Path $healthySnapshot.ExecutablePath -ExpectedSize $InstallerManifest.PayloadSize `
      -ExpectedSha256 $InstallerManifest.PayloadSha256 -Description 'Relaunched Local Fork executable'
    $liveHash = Get-Sha256 -Path $healthySnapshot.ExecutablePath

    if ($backupPath) {
      try {
        Remove-InstallBackupSafely -BackupPath $backupPath
        $backupCreated = $false
        Write-Step "Removed verified-install backup and recovery archive: $backupPath"
      } catch {
        Write-Step "WARNING: healthy install retained recoverable backup at ${backupPath}: $($_.Exception.Message)"
      }
    }
    Write-Step "SUCCESS installerExitCode=$installExitCode installedPath=`"$InstalledExecutable`" version=$installedVersion payloadSha256=$($InstallerManifest.PayloadSha256) livePid=$($healthySnapshot.ProcessId) livePath=`"$($healthySnapshot.ExecutablePath)`" liveHash=$liveHash marker=DisplayName=GG Coder Local Fork,InstallLocation=`"$($registrationMarker.InstallLocation)`",MainBinaryName=gg-coder-local-fork.exe"
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

    $freshInstallCleanupFailure = $null
    if (-not $hadExistingInstall) {
      try {
        Stop-LaunchedVerifiedRoot -Snapshot $launchedSnapshot -ExpectedExecutable $InstalledExecutable
        Remove-FailedNewInstall -InstallDirectory $InstallDirectory
      } catch {
        $freshInstallCleanupFailure = $_.Exception.Message
      }
    }
    $registrationRollbackFailure = $null
    if ($installerStarted -and $registrationSnapshot) {
      try {
        Restore-LocalForkRegistration -Snapshot $registrationSnapshot
      } catch {
        $registrationRollbackFailure = $_.Exception.Message
      }
    }
    if ($freshInstallCleanupFailure -or $registrationRollbackFailure) {
      $rollbackFailures = @($freshInstallCleanupFailure, $registrationRollbackFailure) | Where-Object { $_ }
      throw "Installation failed: $originalFailure. Rollback cleanup failed: $($rollbackFailures -join '; ')"
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
  $validatedExpectedVersion = Assert-ExpectedVersion -Value $ExpectedVersion
  $installDir = Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork'
  $installedExe = Join-Path $installDir 'gg-coder-local-fork.exe'
  $stableInstallDir = Join-Path $env:LOCALAPPDATA 'GG Coder'
  if ([IO.Path]::GetFullPath($installDir).Equals([IO.Path]::GetFullPath($stableInstallDir), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Local Fork installer resolved to the production GG Coder directory; refusing installation'
  }
  $mutexName = "Local\GG-Coder-Local-Fork-Install-$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"
  $installMutex = [Threading.Mutex]::new($false, $mutexName)
  $mutexHeld = $false
  try {
    try {
      $mutexHeld = $installMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $mutexHeld = $true
    }
    if (-not $mutexHeld) {
      throw 'Another Local Fork installation transaction is already running'
    }

    $null = Assert-NoReparsePointTraversal -Path $script:InstallLogPath -Description 'Install log path'
    Set-Content -LiteralPath $script:InstallLogPath -Value ('[{0}] Detached installer helper started as PID {1}; delay={2}s' -f (Get-Date).ToString('o'), $PID, $DelaySeconds) -Encoding UTF8
    Start-Sleep -Seconds $DelaySeconds

    Write-Step "Reading Local Fork installer manifest from: $MetadataPath"
    $installerMetadata = Read-VerifiedInstallerManifest -Path $MetadataPath -AllowedRoot $AllowedInstallerRoot
    Write-Step "Installer and payload metadata verified: installer=$($installerMetadata.Sha256) payload=$($installerMetadata.PayloadSha256)"

    $wasRunning = @(Get-AppRootSnapshots -InstalledExecutable $installedExe).Count -gt 0
    $transactionStarted = $false
    try {
      $wasRunning = Stop-GgCoderForInstall -InstallDirectory $installDir -InstalledExecutable $installedExe `
        -GraceSeconds $GracefulShutdownSeconds

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
        -InstallerManifest $reverified -WasRunning $wasRunning -ExpectedVersion $validatedExpectedVersion
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
  } finally {
    if ($mutexHeld) { $installMutex.ReleaseMutex() }
    $installMutex.Dispose()
  }
}

function Remove-CompletedLocalForkInstallerTask([string]$TaskName) {
  if ($TaskName -notmatch '^ggcoder-local-launch-\d+-[0-9a-f]{32}$') {
    throw "Refusing to delete unexpected scheduled task name: $TaskName"
  }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $cleanupOutput = & schtasks.exe /Delete /TN $TaskName /F 2>&1
    $cleanupExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($cleanupExitCode -ne 0) {
    throw "Scheduled-task cleanup failed for ${TaskName}: $($cleanupOutput -join ' ')"
  }
  Write-Step "Removed scheduled task: $TaskName"
}

function Invoke-LocalPatchedInstallHelper([string]$TaskName) {
  $helperExitCode = 0
  try {
    Invoke-LocalPatchedInstall
  } catch {
    Write-Step "FAILED: $($_.Exception.Message)"
    $helperExitCode = 1
  } finally {
    try {
      Remove-CompletedLocalForkInstallerTask -TaskName $TaskName
    } catch {
      Write-Step "FAILED: $($_.Exception.Message)"
      $helperExitCode = 1
    }
    Write-Step "HELPER_EXIT code=$helperExitCode"
  }
  $helperExitCode
}

if (-not $LibraryOnly) {
  exit (Invoke-LocalPatchedInstallHelper -TaskName $TaskName)
}
