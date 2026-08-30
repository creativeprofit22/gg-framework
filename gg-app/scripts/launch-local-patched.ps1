param(
  [switch]$LibraryOnly,
  [string]$MetadataPath,
  [string]$InstallerScriptPath,
  [string]$LogPath,
  [string]$ExpectedVersion,
  [string]$ExpectedSourceRevision
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:LauncherScriptPath = $PSCommandPath
$script:RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:DefaultMetadataPath = Join-Path $script:RepositoryRoot '.gg\local-fixes\latest-installer.json'
$script:DefaultInstallerScriptPath = Join-Path $PSScriptRoot 'install-local-patched.ps1'
$script:DefaultInstallerRoot = Join-Path $script:RepositoryRoot 'gg-app\src-tauri\target\release\bundle\nsis'
$script:DefaultLogPath = Join-Path $script:RepositoryRoot '.gg\local-fixes\launch-local-patched.log'
$script:ExpectedProductName = 'GG Coder Local Fork'
$script:ExpectedIdentifier = 'com.ggcoder.local-fork'
$script:ExpectedBinaryName = 'gg-coder-local-fork'
$script:ExpectedExecutableName = 'gg-coder-local-fork.exe'

function Write-LaunchLog([string]$Message, [string]$Path = $script:DefaultLogPath) {
  $parent = Split-Path -Parent $Path
  if ($parent) { $null = New-Item -ItemType Directory -Path $parent -Force }
  Add-Content -LiteralPath $Path -Value ('[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), $Message) -Encoding UTF8
}

function Get-FullPath([string]$Path, [string]$Description) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Description must be an absolute path"
  }
  [IO.Path]::GetFullPath($Path)
}

function Assert-PathUnderRoot([string]$Path, [string]$Root, [string]$Description) {
  $fullPath = Get-FullPath -Path $Path -Description $Description
  $fullRoot = (Get-FullPath -Path $Root -Description "$Description root").TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description escapes its allowed root: $fullPath"
  }
  $fullPath
}

function Get-RequiredJsonProperty([object]$Object, [string]$Name, [string]$Description) {
  $property = $Object.PSObject.Properties[$Name]
  if (-not $property -or $null -eq $property.Value) {
    throw "Malformed Local Fork manifest: missing $Description"
  }
  $property.Value
}

function Assert-Sha256([object]$Value, [string]$Description) {
  $text = [string]$Value
  if ($text -notmatch '^[0-9a-fA-F]{64}$') { throw "Malformed Local Fork manifest: invalid $Description" }
  $text.ToLowerInvariant()
}

function Assert-FullSourceRevision([string]$Value, [string]$Description) {
  if ($Value -notmatch '^[0-9a-fA-F]{40}$') {
    throw "Invalid ${Description}: require a full 40-character Git SHA"
  }
  $Value.ToLowerInvariant()
}

function Assert-ExpectedVersion([string]$Value) {
  if ($Value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Invalid expected version: require numeric major.minor.patch'
  }
  $Value
}

function Assert-ExactJsonProperties(
  [object]$Object,
  [string[]]$Names,
  [string]$Description
) {
  if (-not $Object -or $Object -is [System.Array]) { throw "Malformed ${Description}: expected object" }
  $actualNames = @($Object.PSObject.Properties.Name)
  if ($actualNames.Count -ne $Names.Count) { throw "Malformed ${Description}: unexpected fields" }
  foreach ($name in $Names) {
    if (-not $Object.PSObject.Properties[$name]) { throw "Malformed ${Description}: missing $name" }
  }
}

function Assert-BoundedNoteText(
  [object]$Value,
  [string]$Description,
  [int]$MaximumLength
) {
  if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value.Length -gt $MaximumLength -or
      $Value.Trim() -cne $Value -or $Value -match '[\x00-\x1f\x7f]') {
    throw "Malformed Local Fork release notes: invalid $Description"
  }
  $Value
}

function Get-BytesSha256([byte[]]$Bytes) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Read-VerifiedReleaseNotes(
  [object]$Manifest,
  [string]$ExpectedSourceRevision
) {
  $expectedRevision = Assert-FullSourceRevision $ExpectedSourceRevision 'expected source revision'
  $manifestRevision = Assert-FullSourceRevision `
    ([string](Get-RequiredJsonProperty $Manifest 'sourceRevision' 'sourceRevision')) `
    'manifest source revision'
  if ($manifestRevision -cne $expectedRevision) {
    throw 'Local Fork release-note source revision does not match the expected source revision'
  }
  $metadata = Get-RequiredJsonProperty $Manifest 'releaseNotes' 'releaseNotes'
  Assert-ExactJsonProperties $metadata @('size', 'sha256', 'base64') 'Local Fork release-note metadata'
  $sizeValue = Get-RequiredJsonProperty $metadata 'size' 'releaseNotes.size'
  if ($sizeValue -isnot [int] -and $sizeValue -isnot [long]) {
    throw 'Malformed Local Fork manifest: releaseNotes.size must be an integer'
  }
  $size = Assert-PositiveSize $sizeValue 'releaseNotes.size'
  if ($size -gt 32768) { throw 'Malformed Local Fork manifest: releaseNotes.size is oversized' }
  $digest = Assert-Sha256 (Get-RequiredJsonProperty $metadata 'sha256' 'releaseNotes.sha256') 'releaseNotes.sha256'
  $base64 = Get-RequiredJsonProperty $metadata 'base64' 'releaseNotes.base64'
  if ($base64 -isnot [string] -or [string]::IsNullOrWhiteSpace($base64)) {
    throw 'Malformed Local Fork manifest: invalid releaseNotes.base64'
  }
  try { $bytes = [Convert]::FromBase64String($base64) } catch {
    throw 'Malformed Local Fork manifest: invalid releaseNotes.base64'
  }
  if ([Convert]::ToBase64String($bytes) -cne $base64) {
    throw 'Malformed Local Fork manifest: noncanonical releaseNotes.base64'
  }
  if ($bytes.Length -ne $size) { throw 'Local Fork release-note size mismatch' }
  if ((Get-BytesSha256 $bytes) -cne $digest) { throw 'Local Fork release-note SHA-256 mismatch' }
  try {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $envelope = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Malformed Local Fork release-note envelope: $($_.Exception.Message)"
  }
  Assert-ExactJsonProperties $envelope @('schemaVersion', 'sourceRevision', 'note') 'Local Fork release-note envelope'
  $envelopeSchema = Get-RequiredJsonProperty $envelope 'schemaVersion' 'release-note schemaVersion'
  if ($envelopeSchema -isnot [int] -or $envelopeSchema -ne 1) {
    throw 'Unsupported Local Fork release-note envelope schema'
  }
  $envelopeRevision = Assert-FullSourceRevision `
    ([string](Get-RequiredJsonProperty $envelope 'sourceRevision' 'release-note sourceRevision')) `
    'release-note source revision'
  if ($envelopeRevision -cne $manifestRevision) {
    throw 'Local Fork release-note envelope revision does not match the manifest revision'
  }
  $note = Get-RequiredJsonProperty $envelope 'note' 'release-note note'
  Assert-ExactJsonProperties $note @('schemaVersion', 'date', 'label', 'sections') 'Local Fork release-note object'
  $noteSchema = Get-RequiredJsonProperty $note 'schemaVersion' 'release-note note.schemaVersion'
  if ($noteSchema -isnot [int] -or $noteSchema -ne 1) {
    throw 'Unsupported Local Fork release-note schema'
  }
  $date = Assert-BoundedNoteText $note.date 'date' 10
  $parsedDate = [DateTime]::MinValue
  if (-not [DateTime]::TryParseExact($date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None, [ref]$parsedDate)) {
    throw 'Malformed Local Fork release notes: invalid date'
  }
  $null = Assert-BoundedNoteText $note.label 'label' 120
  $sections = @($note.sections)
  if ($sections.Count -lt 1 -or $sections.Count -gt 8) {
    throw 'Malformed Local Fork release notes: invalid sections'
  }
  foreach ($section in $sections) {
    Assert-ExactJsonProperties $section @('title', 'items') 'Local Fork release-note section'
    $null = Assert-BoundedNoteText $section.title 'section title' 120
    $items = @($section.items)
    if ($items.Count -lt 1 -or $items.Count -gt 10) {
      throw 'Malformed Local Fork release notes: invalid section items'
    }
    foreach ($item in $items) { $null = Assert-BoundedNoteText $item 'section item' 500 }
  }
  [pscustomobject]@{ SourceRevision = $manifestRevision; Sha256 = $digest; Note = $note }
}

function Assert-PositiveSize([object]$Value, [string]$Description) {
  $size = 0L
  if (-not [long]::TryParse([string]$Value, [ref]$size) -or $size -lt 1) {
    throw "Malformed Local Fork manifest: invalid $Description"
  }
  $size
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-FileMetadata(
  [string]$Path,
  [long]$ExpectedSize,
  [string]$ExpectedSha256,
  [string]$Description
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Description is missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ([long]$item.Length -ne $ExpectedSize) {
    throw "$Description size mismatch: expected $ExpectedSize, found $($item.Length)"
  }
  $actualHash = Get-Sha256 -Path $Path
  if ($actualHash -ne $ExpectedSha256) {
    throw "$Description SHA-256 mismatch: expected $ExpectedSha256, found $actualHash"
  }
  $actualHash
}

function Read-CanonicalLocalForkManifest(
  [string]$Path,
  [string]$ExpectedSourceRevision,
  [string]$AllowedRoot = $script:RepositoryRoot
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Local Fork installer manifest is missing: $Path"
  }
  try {
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Malformed Local Fork manifest '$Path': $($_.Exception.Message)"
  }
  if (-not $manifest -or $manifest -is [System.Array]) {
    throw "Malformed Local Fork manifest '$Path': expected one JSON object"
  }
  $schemaVersion = Get-RequiredJsonProperty $manifest 'schemaVersion' 'schemaVersion'
  if ($schemaVersion -isnot [int] -or $schemaVersion -ne 2) {
    throw 'Unsupported Local Fork installer manifest schema'
  }
  $releaseNotes = Read-VerifiedReleaseNotes $manifest $ExpectedSourceRevision

  $identity = Get-RequiredJsonProperty -Object $manifest -Name 'identity' -Description 'identity'
  $payload = Get-RequiredJsonProperty -Object $manifest -Name 'payload' -Description 'payload'
  $expectedIdentity = @{
    productName = $script:ExpectedProductName
    identifier = $script:ExpectedIdentifier
    mainBinaryName = $script:ExpectedBinaryName
    executableName = $script:ExpectedExecutableName
    installMode = 'currentUser'
  }
  foreach ($entry in $expectedIdentity.GetEnumerator()) {
    $actual = [string](Get-RequiredJsonProperty -Object $identity -Name $entry.Key -Description "identity.$($entry.Key)")
    if ($actual -cne $entry.Value) {
      throw "Malformed Local Fork manifest: identity.$($entry.Key) must equal '$($entry.Value)'"
    }
  }

  $installerPath = Assert-PathUnderRoot -Path ([string](Get-RequiredJsonProperty $manifest 'path' 'path')) `
    -Root $AllowedRoot -Description 'Manifest installer path'
  $payloadName = [string](Get-RequiredJsonProperty $payload 'name' 'payload.name')
  if ($payloadName -cne $script:ExpectedExecutableName) {
    throw "Malformed Local Fork manifest: payload must name $($script:ExpectedExecutableName)"
  }

  $installerSize = Assert-PositiveSize (Get-RequiredJsonProperty $manifest 'size' 'size') 'size'
  $installerHash = Assert-Sha256 (Get-RequiredJsonProperty $manifest 'sha256' 'sha256') 'sha256'
  $payloadSize = Assert-PositiveSize (Get-RequiredJsonProperty $payload 'size' 'payload.size') 'payload.size'
  $payloadHash = Assert-Sha256 (Get-RequiredJsonProperty $payload 'sha256' 'payload.sha256') 'payload.sha256'
  $null = Assert-FileMetadata $installerPath $installerSize $installerHash 'Manifest installer'

  [pscustomobject]@{
    ManifestPath = [IO.Path]::GetFullPath($Path)
    InstallerPath = $installerPath
    InstallerSha256 = $installerHash
    PayloadSize = $payloadSize
    PayloadSha256 = $payloadHash
    SourceRevision = $releaseNotes.SourceRevision
    ReleaseNotesSha256 = $releaseNotes.Sha256
  }
}

function Test-InstalledPayloadCurrent([string]$Path, [object]$Manifest) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if ([long]$item.Length -ne [long]$Manifest.PayloadSize) { return $false }
  (Get-Sha256 -Path $Path) -eq $Manifest.PayloadSha256
}

function Get-LocalForkRootProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = '$($script:ExpectedExecutableName)'" -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      ProcessId = [int]$_.ProcessId
      ParentProcessId = [int]$_.ParentProcessId
      ExecutablePath = [string]$_.ExecutablePath
      CreationTicks = ([DateTime]$_.CreationDate).ToUniversalTime().Ticks
    }
  })
}

function Assert-UnambiguousLocalForkProcess([object[]]$Processes, [string]$ExpectedExecutable) {
  if ($Processes.Count -gt 1) {
    throw "Ambiguous Local Fork roots: expected at most one, found $($Processes.Count) (PIDs $($Processes.ProcessId -join ', '))"
  }
  if ($Processes.Count -eq 1) {
    $actualPath = [string]$Processes[0].ExecutablePath
    if (-not $actualPath.Equals($ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Wrong-path Local Fork root PID $($Processes[0].ProcessId): expected '$ExpectedExecutable', found '$actualPath'"
    }
  }
  if ($Processes.Count -eq 1) { return $Processes[0] }
  $null
}

function ConvertTo-SingleQuotedPowerShellLiteral([string]$Value) {
  "'" + $Value.Replace("'", "''") + "'"
}

function New-LocalForkInstallerEncodedCommand(
  [string]$ScriptPath,
  [string]$TaskName,
  [string]$ManifestPath,
  [string]$InstallerLogPath,
  [string]$AllowedRoot,
  [string]$ExpectedVersion,
  [string]$ExpectedSourceRevision
) {
  $command = @(
    '&', (ConvertTo-SingleQuotedPowerShellLiteral $ScriptPath),
    '-TaskName', (ConvertTo-SingleQuotedPowerShellLiteral $TaskName),
    '-DelaySeconds', '1',
    '-MetadataPath', (ConvertTo-SingleQuotedPowerShellLiteral $ManifestPath),
    '-LogPath', (ConvertTo-SingleQuotedPowerShellLiteral $InstallerLogPath),
    '-AllowedInstallerRoot', (ConvertTo-SingleQuotedPowerShellLiteral $AllowedRoot),
    '-ExpectedVersion', (ConvertTo-SingleQuotedPowerShellLiteral $ExpectedVersion),
    '-ExpectedSourceRevision', (ConvertTo-SingleQuotedPowerShellLiteral $ExpectedSourceRevision)
  ) -join ' '
  [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
}

function Register-LocalForkInstallerTask(
  [string]$TaskName,
  [string]$PowerShellPath,
  [string]$EncodedCommand
) {
  $action = New-ScheduledTaskAction -Execute $PowerShellPath `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $EncodedCommand"
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive -RunLevel Limited
  $null = Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Description 'Guarded GG Coder Local Fork installer handoff' -Force
}

function Start-LocalForkInstallerTask([string]$TaskName) {
  Start-ScheduledTask -TaskName $TaskName
}

function Remove-FailedLocalForkInstallerTask([string]$TaskName) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

function Invoke-GuardedLocalForkInstaller(
  [string]$ScriptPath,
  [string]$ManifestPath,
  [string]$AllowedRoot,
  [string]$InstallerLogPath,
  [string]$ExpectedVersion,
  [string]$ExpectedSourceRevision
) {
  $validatedVersion = Assert-ExpectedVersion -Value $ExpectedVersion
  $validatedRevision = Assert-FullSourceRevision $ExpectedSourceRevision 'expected source revision'
  $expectedScript = [IO.Path]::GetFullPath($script:DefaultInstallerScriptPath)
  $actualScript = Get-FullPath -Path $ScriptPath -Description 'Guarded installer script path'
  if (-not $actualScript.Equals($expectedScript, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing non-canonical guarded installer script: $actualScript"
  }
  if (-not (Test-Path -LiteralPath $actualScript -PathType Leaf)) {
    throw "Guarded installer script is missing: $actualScript"
  }
  $actualManifest = Get-FullPath -Path $ManifestPath -Description 'Installer manifest path'
  $actualLog = Get-FullPath -Path $InstallerLogPath -Description 'Installer log path'
  $actualAllowedRoot = Get-FullPath -Path $AllowedRoot -Description 'Allowed installer root'
  $null = Read-CanonicalLocalForkManifest -Path $actualManifest -AllowedRoot $actualAllowedRoot `
    -ExpectedSourceRevision $validatedRevision
  $taskName = 'ggcoder-local-launch-{0}-{1}' -f $PID, [Guid]::NewGuid().ToString('N')
  $encodedCommand = New-LocalForkInstallerEncodedCommand -ScriptPath $actualScript -TaskName $taskName `
    -ManifestPath $actualManifest -InstallerLogPath $actualLog -AllowedRoot $actualAllowedRoot `
    -ExpectedVersion $validatedVersion -ExpectedSourceRevision $validatedRevision
  $powerShellPath = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "System PowerShell executable is missing: $powerShellPath"
  }
  Register-LocalForkInstallerTask -TaskName $taskName -PowerShellPath $powerShellPath `
    -EncodedCommand $encodedCommand
  try {
    Start-LocalForkInstallerTask -TaskName $taskName
  } catch {
    $startFailure = $_.Exception.Message
    try {
      Remove-FailedLocalForkInstallerTask -TaskName $taskName
    } catch {
      throw "Failed to start guarded installer task '$taskName': $startFailure. Failed to remove the unstarted task: $($_.Exception.Message)"
    }
    throw "Failed to start guarded installer task '$taskName': $startFailure"
  }
  [pscustomobject]@{ TaskName = $taskName; Status = 'started' }
}

function Start-CanonicalLocalFork([string]$ExecutablePath) {
  Start-Process -FilePath $ExecutablePath -PassThru
}

function Confirm-LiveCanonicalRoot(
  [string]$ExpectedExecutable,
  [object]$Manifest,
  [int]$ExpectedPid = 0,
  [int]$TimeoutSeconds = 15,
  [ValidateRange(1, 30000)][int]$StabilityMilliseconds = 3000
) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 200
    $processes = @(Get-LocalForkRootProcesses)
    $root = Assert-UnambiguousLocalForkProcess -Processes $processes -ExpectedExecutable $ExpectedExecutable
    if ($root -and ($ExpectedPid -eq 0 -or $root.ProcessId -eq $ExpectedPid)) { break }
    if ($root -and $ExpectedPid -gt 0 -and $root.ProcessId -ne $ExpectedPid) {
      throw "Launched Local Fork PID $ExpectedPid was replaced by unexpected PID $($root.ProcessId)"
    }
  } while ((Get-Date) -lt $deadline)
  if (-not $root) { throw 'Verified Local Fork root did not remain live during startup' }
  $initialRoot = $root
  Start-Sleep -Milliseconds $StabilityMilliseconds
  $stableProcesses = @(Get-LocalForkRootProcesses)
  $stableRoot = Assert-UnambiguousLocalForkProcess -Processes $stableProcesses -ExpectedExecutable $ExpectedExecutable
  if (-not $stableRoot -or $stableRoot.ProcessId -ne $initialRoot.ProcessId -or
      $stableRoot.CreationTicks -ne $initialRoot.CreationTicks -or
      -not $stableRoot.ExecutablePath.Equals($initialRoot.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Local Fork root PID $($initialRoot.ProcessId) did not retain a stable identity during startup"
  }
  $actualHash = Assert-FileMetadata $ExpectedExecutable $Manifest.PayloadSize $Manifest.PayloadSha256 `
    'Live Local Fork root executable'
  [pscustomobject]@{
    ProcessId = [int]$stableRoot.ProcessId
    ParentProcessId = [int]$stableRoot.ParentProcessId
    CreationTicks = [long]$stableRoot.CreationTicks
    ExecutablePath = [string]$stableRoot.ExecutablePath
    Sha256 = $actualHash
  }
}

function Invoke-CanonicalLocalForkLaunch(
  [string]$ManifestPath = $script:DefaultMetadataPath,
  [string]$GuardedInstallerPath = $script:DefaultInstallerScriptPath,
  [string]$AllowedManifestRoot = $script:RepositoryRoot,
  [string]$AllowedInstallerRoot = $script:DefaultInstallerRoot,
  [string]$ExpectedExecutable = (Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork\gg-coder-local-fork.exe'),
  [string]$LauncherLogPath = $script:DefaultLogPath,
  [string]$ExpectedVersion,
  [string]$ExpectedSourceRevision
) {
  $validatedVersion = Assert-ExpectedVersion -Value $ExpectedVersion
  $validatedRevision = Assert-FullSourceRevision $ExpectedSourceRevision 'expected source revision'
  $canonicalExecutable = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'GG Coder Local Fork\gg-coder-local-fork.exe'))
  $expectedFullPath = Get-FullPath -Path $ExpectedExecutable -Description 'Installed Local Fork executable path'
  if (-not $expectedFullPath.Equals($canonicalExecutable, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing non-canonical installed Local Fork path: $expectedFullPath"
  }

  Write-LaunchLog "START manifest=$ManifestPath executable=$expectedFullPath sourceRevision=$validatedRevision" $LauncherLogPath
  $manifest = Read-CanonicalLocalForkManifest -Path $ManifestPath -AllowedRoot $AllowedManifestRoot `
    -ExpectedSourceRevision $validatedRevision
  $initialProcesses = @(Get-LocalForkRootProcesses)
  $initialRoot = Assert-UnambiguousLocalForkProcess -Processes $initialProcesses -ExpectedExecutable $expectedFullPath
  $installedCurrent = Test-InstalledPayloadCurrent -Path $expectedFullPath -Manifest $manifest

  if (-not $installedCurrent) {
    Write-LaunchLog "INSTALL required; installed payload missing or stale; expectedSha256=$($manifest.PayloadSha256)" $LauncherLogPath
    $handoff = Invoke-GuardedLocalForkInstaller -ScriptPath $GuardedInstallerPath -ManifestPath $manifest.ManifestPath `
      -AllowedRoot $AllowedInstallerRoot -InstallerLogPath (Join-Path (Split-Path -Parent $LauncherLogPath) 'install-local-patched.log') `
      -ExpectedVersion $validatedVersion -ExpectedSourceRevision $validatedRevision
    Write-LaunchLog "SUCCESS disposition=install-scheduled taskName=$($handoff.TaskName)" $LauncherLogPath
    return [pscustomobject]@{
      disposition = 'install-scheduled'
      manifestPath = $manifest.ManifestPath
      installerPath = $manifest.InstallerPath
      installerSha256 = $manifest.InstallerSha256
      sourceRevision = $manifest.SourceRevision
      executablePath = $expectedFullPath
      taskName = $handoff.TaskName
      expectedVersion = $validatedVersion
    }
  }

  $processes = @(Get-LocalForkRootProcesses)
  $root = Assert-UnambiguousLocalForkProcess -Processes $processes -ExpectedExecutable $expectedFullPath
  $expectedPid = 0
  $disposition = if ($root) { 'existing-and-verified' } else { 'launched-and-verified' }
  if (-not $root) {
    $started = Start-CanonicalLocalFork -ExecutablePath $expectedFullPath
    $expectedPid = [int]$started.Id
  }
  $liveRoot = Confirm-LiveCanonicalRoot -ExpectedExecutable $expectedFullPath -Manifest $manifest -ExpectedPid $expectedPid
  Write-LaunchLog "SUCCESS disposition=$disposition pid=$($liveRoot.ProcessId) path=$($liveRoot.ExecutablePath) sha256=$($liveRoot.Sha256)" $LauncherLogPath
  [pscustomobject]@{
    disposition = $disposition
    expectedVersion = $validatedVersion
    manifestPath = $manifest.ManifestPath
    installerPath = $manifest.InstallerPath
    installerSha256 = $manifest.InstallerSha256
    sourceRevision = $manifest.SourceRevision
    executablePath = $liveRoot.ExecutablePath
    executableSha256 = $liveRoot.Sha256
    pid = $liveRoot.ProcessId
    parentPid = $liveRoot.ParentProcessId
    creationTicks = $liveRoot.CreationTicks
  }
}

if (-not $LibraryOnly) {
  try {
    $effectiveMetadataPath = if ($MetadataPath) { $MetadataPath } else { $script:DefaultMetadataPath }
    $effectiveInstallerScript = if ($InstallerScriptPath) { $InstallerScriptPath } else { $script:DefaultInstallerScriptPath }
    $effectiveLogPath = if ($LogPath) { $LogPath } else { $script:DefaultLogPath }
    Invoke-CanonicalLocalForkLaunch -ManifestPath $effectiveMetadataPath `
      -GuardedInstallerPath $effectiveInstallerScript -LauncherLogPath $effectiveLogPath `
      -ExpectedVersion $ExpectedVersion -ExpectedSourceRevision $ExpectedSourceRevision | ConvertTo-Json -Depth 4 -Compress
  } catch {
    $effectiveLogPath = if ($LogPath) { $LogPath } else { $script:DefaultLogPath }
    try { Write-LaunchLog "FAILED $($_.Exception.Message)" $effectiveLogPath } catch { }
    Write-Error $_
    exit 1
  }
}
