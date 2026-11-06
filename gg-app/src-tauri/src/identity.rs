//! Local Fork identity bootstrap: once-only session history merge and rank v2 migration.

use crate::*;

pub(crate) const PRODUCTION_APP_IDENTIFIER: &str = "com.ggcoder.app";

pub(crate) const IDENTITY_BOOTSTRAP_MARKER: &str = ".identity-bootstrap-v1";

pub(crate) const IDENTITY_RANK_BOOTSTRAP_MARKER: &str = ".identity-bootstrap-v2";

pub(crate) const IDENTITY_SESSION_BOOTSTRAP_MARKER: &str = ".identity-bootstrap-v3";

pub(crate) const IDENTITY_SESSION_DIRECTORIES: &[&str] = &["sessions", "chat-sessions"];

pub(crate) const IDENTITY_SESSION_FILES: &[&str] = &["gg-app-workspace.json"];

pub(crate) const PROGRESS_FILE: &str = "progress.json";

pub(crate) const PROGRESS_BACKUP_FILE: &str = "progress.backup.json";

pub(crate) const IDENTITY_RANK_BOOTSTRAP_LOCK: &str = ".identity-bootstrap-v2.lock";

pub(crate) const PROGRESS_HMAC_KEY: &[u8] = b"gg-coder-progress-v1-9f2c4e7a1b8d3f6c";

pub(crate) const PROGRESS_LOCK_WAIT: Duration = Duration::from_secs(5);

pub(crate) const IDENTITY_BOOTSTRAP_FILES: &[&str] = &[
    "auth.json",
    "settings.json",
    "gg-app.json",
    "mcp.json",
    "mcp-auth.json",
];

/// Seed a non-production identity once from production's legacy files.
/// Sources are read-only; existing identity files are never overwritten.
pub(crate) fn bootstrap_identity_data(home: &Path, identifier: &str) -> Result<bool, String> {
    if identifier == PRODUCTION_APP_IDENTIFIER {
        return Ok(false);
    }

    let target_root = agent_data_root_for_home(home, identifier);
    let legacy_root = agent_data_root_for_home(home, PRODUCTION_APP_IDENTIFIER);
    prepare_isolated_identity_root(home, identifier, &target_root, &legacy_root)?;
    let marker = target_root.join(IDENTITY_BOOTSTRAP_MARKER);
    if marker.exists() {
        return Ok(false);
    }
    for filename in IDENTITY_BOOTSTRAP_FILES {
        let source = legacy_root.join(filename);
        let target = target_root.join(filename);
        if target.exists() || !source.is_file() {
            continue;
        }
        std::fs::copy(&source, &target).map_err(|error| {
            format!(
                "failed to bootstrap {} into identity root: {error}",
                source.display()
            )
        })?;
    }
    std::fs::write(&marker, b"v1\n").map_err(|error| {
        format!(
            "failed to complete identity bootstrap {}: {error}",
            marker.display()
        )
    })?;
    Ok(true)
}

pub(crate) fn copy_identity_directory_entries(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(target)
        .map_err(|error| format!("failed to create {}: {error}", target.display()))?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry
            .map_err(|error| format!("failed to read entry in {}: {error}", source.display()))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&source_path)
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            copy_identity_directory_entries(&source_path, &target_path)?;
        } else if metadata.is_file() && !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "failed to bootstrap session file {} into identity root: {error}",
                    source_path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Seed durable session history and the native workspace once for alternate app
/// identities. Existing identity files always win; session trees merge only
/// missing transcript files so local work is never overwritten.
pub(crate) fn bootstrap_identity_sessions(home: &Path, identifier: &str) -> Result<bool, String> {
    if identifier == PRODUCTION_APP_IDENTIFIER {
        return Ok(false);
    }
    let target_root = agent_data_root_for_home(home, identifier);
    let legacy_root = agent_data_root_for_home(home, PRODUCTION_APP_IDENTIFIER);
    prepare_isolated_identity_root(home, identifier, &target_root, &legacy_root)?;
    let marker = target_root.join(IDENTITY_SESSION_BOOTSTRAP_MARKER);
    if marker.exists() {
        return Ok(false);
    }

    for directory in IDENTITY_SESSION_DIRECTORIES {
        copy_identity_directory_entries(
            &legacy_root.join(directory),
            &target_root.join(directory),
        )?;
    }
    for filename in IDENTITY_SESSION_FILES {
        let source = legacy_root.join(filename);
        let target = target_root.join(filename);
        if source.is_file() && !target.exists() {
            std::fs::copy(&source, &target).map_err(|error| {
                format!(
                    "failed to bootstrap {} into identity root: {error}",
                    source.display()
                )
            })?;
        }
    }
    std::fs::write(&marker, b"v3\n").map_err(|error| {
        format!(
            "failed to complete identity session bootstrap {}: {error}",
            marker.display()
        )
    })?;
    Ok(true)
}

pub(crate) fn stable_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null => Ok("null".to_string()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) => {
            let value = value
                .as_f64()
                .ok_or_else(|| "progress number is outside the JavaScript range".to_string())?;
            Ok(ryu_js::Buffer::new().format(value).to_string())
        }
        serde_json::Value::String(value) => serde_json::to_string(value)
            .map_err(|error| format!("failed to canonicalize progress string: {error}")),
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(stable_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            let entries = keys
                .into_iter()
                .map(|key| {
                    let serialized_key = serde_json::to_string(key)
                        .map_err(|_| "failed to canonicalize progress key".to_string())?;
                    let serialized_value = stable_json(&values[key])?;
                    Ok(format!("{serialized_key}:{serialized_value}"))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

pub(crate) fn validate_progress_source(bytes: &[u8]) -> Result<(), String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut progress = serde_json::from_slice::<serde_json::Value>(bytes)
        .map_err(|_| "production progress is not valid JSON".to_string())?;
    let object = progress
        .as_object_mut()
        .ok_or_else(|| "production progress must be a JSON object".to_string())?;
    let valid_shape = object.get("v").and_then(serde_json::Value::as_u64) == Some(1)
        && object.get("xp").is_some_and(serde_json::Value::is_number)
        && object
            .get("createdAt")
            .is_some_and(serde_json::Value::is_string)
        && object
            .get("totals")
            .is_some_and(serde_json::Value::is_object)
        && object
            .get("streak")
            .is_some_and(serde_json::Value::is_object)
        && object
            .get("rolling")
            .is_some_and(serde_json::Value::is_object);
    if !valid_shape {
        return Err("production progress has an invalid shape".to_string());
    }
    let signature = object
        .remove("sig")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "production progress is missing its signature".to_string())?;
    let signature = decode_progress_signature(&signature)?;
    let canonical = stable_json(&progress)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(PROGRESS_HMAC_KEY)
        .map_err(|_| "failed to initialize progress signature validation".to_string())?;
    mac.update(canonical.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| "production progress signature is invalid".to_string())
}

pub(crate) fn decode_progress_signature(signature: &str) -> Result<Vec<u8>, String> {
    if signature.len() != 64 {
        return Err("production progress signature is invalid".to_string());
    }
    (0..signature.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&signature[index..index + 2], 16)
                .map_err(|_| "production progress signature is invalid".to_string())
        })
        .collect()
}

pub(crate) fn atomic_write_identity_file(
    dir: &cap_std::fs::Dir,
    root: &Path,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let path = root.join(name);
    let mut file = cap_tempfile::TempFile::new(dir)
        .map_err(|error| format!("failed to stage identity file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write identity file {}: {error}", path.display()))?;
    file.as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync identity file {}: {error}", path.display()))?;
    file.replace(name)
        .map_err(|error| format!("failed to commit identity file {}: {error}", path.display()))
}

#[derive(Debug)]
pub(crate) struct IdentityFileSnapshot {
    pub(crate) name: &'static str,
    pub(crate) contents: Option<Vec<u8>>,
}

pub(crate) fn identity_file_snapshot(
    dir: &cap_std::fs::Dir,
    root: &Path,
    name: &'static str,
) -> Result<IdentityFileSnapshot, String> {
    let path = root.join(name);
    let contents = match dir.symlink_metadata(name) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "identity progress path is not a regular file: {}",
                path.display()
            ));
        }
        Ok(_) => Some(dir.read(name).map_err(|error| {
            format!(
                "failed to read identity progress before v2 migration {}: {error}",
                path.display()
            )
        })?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "failed to inspect identity progress before v2 migration {}: {error}",
                path.display()
            ));
        }
    };
    Ok(IdentityFileSnapshot { name, contents })
}

pub(crate) fn preserve_identity_file_once(
    dir: &cap_std::fs::Dir,
    root: &Path,
    snapshot: &IdentityFileSnapshot,
    source_bytes: &[u8],
) -> Result<(), String> {
    let Some(bytes) = snapshot.contents.as_deref() else {
        return Ok(());
    };
    let backup_name = format!("{}.pre-v2", snapshot.name);
    let backup = root.join(&backup_name);
    match dir.symlink_metadata(&backup_name) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "pre-v2 backup path is not a regular file: {}",
                backup.display()
            ));
        }
        Ok(_) => {
            let preserved = dir.read(&backup_name).map_err(|error| {
                format!("failed to read pre-v2 backup {}: {error}", backup.display())
            })?;
            if preserved == bytes || bytes == source_bytes {
                return Ok(());
            }
            return Err(format!(
                "pre-v2 backup does not match current identity state: {}",
                backup.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect pre-v2 backup {}: {error}",
                backup.display()
            ));
        }
    }
    atomic_write_identity_file(dir, root, &backup_name, bytes)
}

pub(crate) fn restore_identity_file(
    dir: &cap_std::fs::Dir,
    root: &Path,
    snapshot: &IdentityFileSnapshot,
) -> Result<(), String> {
    match snapshot.contents.as_deref() {
        Some(contents) => atomic_write_identity_file(dir, root, snapshot.name, contents),
        None => match dir.remove_file(snapshot.name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "failed to remove partially seeded identity file {}: {error}",
                root.join(snapshot.name).display()
            )),
        },
    }
}

pub(crate) fn rollback_identity_rank_migration(
    dir: &cap_std::fs::Dir,
    root: &Path,
    error: String,
    snapshots: &[&IdentityFileSnapshot],
    marker_attempted: bool,
) -> String {
    let mut failures = Vec::new();
    if marker_attempted
        && matches!(dir.read(IDENTITY_RANK_BOOTSTRAP_MARKER), Ok(contents) if contents == b"v2\n")
    {
        if let Err(rollback_error) = dir.remove_file(IDENTITY_RANK_BOOTSTRAP_MARKER) {
            failures.push(format!(
                "failed to remove partial migration marker {}: {rollback_error}",
                root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).display()
            ));
        }
    }
    for snapshot in snapshots.iter().rev() {
        if let Err(rollback_error) = restore_identity_file(dir, root, snapshot) {
            failures.push(rollback_error);
        }
    }
    if failures.is_empty() {
        error
    } else {
        format!("{error}; rollback failed: {}", failures.join("; "))
    }
}

pub(crate) struct IdentityProgressLock {
    pub(crate) _file: std::fs::File,
}

pub(crate) fn identity_progress_lock_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || cfg!(windows) && error.raw_os_error() == Some(33)
}

pub(crate) fn acquire_identity_progress_lock(
    dir: &cap_std::fs::Dir,
    root: &Path,
) -> Result<IdentityProgressLock, String> {
    use fs2::FileExt;

    let path = root.join(IDENTITY_RANK_BOOTSTRAP_LOCK);
    if matches!(dir.symlink_metadata(IDENTITY_RANK_BOOTSTRAP_LOCK), Ok(metadata) if !metadata.file_type().is_file())
    {
        return Err(format!(
            "identity progress lock is not a regular file: {}",
            path.display()
        ));
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    let file = dir
        .open_with(IDENTITY_RANK_BOOTSTRAP_LOCK, &options)
        .map(cap_std::fs::File::into_std)
        .map_err(|error| {
            format!(
                "failed to open identity progress lock {}: {error}",
                path.display()
            )
        })?;
    let deadline = std::time::Instant::now() + PROGRESS_LOCK_WAIT;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(IdentityProgressLock { _file: file }),
            Err(error) if identity_progress_lock_contended(&error) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for identity progress lock {}",
                        path.display()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(format!(
                    "failed to acquire identity progress lock {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

pub(crate) fn prepare_isolated_identity_root(
    home: &Path,
    identifier: &str,
    target_root: &Path,
    production_root: &Path,
) -> Result<(), String> {
    let mut components = Path::new(identifier).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!("invalid non-production identity: {identifier}"));
    }

    let identities_root = home.join(".gg").join("identities");
    std::fs::create_dir_all(&identities_root).map_err(|error| {
        format!(
            "failed to create identities root {}: {error}",
            identities_root.display()
        )
    })?;
    std::fs::create_dir_all(target_root).map_err(|error| {
        format!(
            "failed to create identity data root {}: {error}",
            target_root.display()
        )
    })?;
    let canonical_identities = std::fs::canonicalize(&identities_root).map_err(|error| {
        format!(
            "failed to resolve identities root {}: {error}",
            identities_root.display()
        )
    })?;
    let canonical_target = std::fs::canonicalize(target_root).map_err(|error| {
        format!(
            "failed to resolve identity data root {}: {error}",
            target_root.display()
        )
    })?;
    let canonical_production = std::fs::canonicalize(production_root).map_err(|error| {
        format!(
            "failed to resolve production data root {}: {error}",
            production_root.display()
        )
    })?;
    let canonical_target_name = canonical_target.file_name();
    if canonical_identities.parent() != Some(canonical_production.as_path())
        || canonical_identities.file_name() != Some(std::ffi::OsStr::new("identities"))
        || canonical_target == canonical_production
        || canonical_target.parent() != Some(canonical_identities.as_path())
        || canonical_target_name != Some(std::ffi::OsStr::new(identifier))
    {
        return Err(format!(
            "refusing non-isolated identity data root {}",
            target_root.display()
        ));
    }
    Ok(())
}

pub(crate) struct IdentityRankBootstrapDirs {
    pub(crate) production: cap_std::fs::Dir,
    pub(crate) _identities: cap_std::fs::Dir,
    pub(crate) identity: cap_std::fs::Dir,
}

pub(crate) fn open_identity_rank_bootstrap_dirs(
    production_root: &Path,
    identifier: &str,
) -> Result<IdentityRankBootstrapDirs, String> {
    let mut components = Path::new(identifier).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!("invalid non-production identity: {identifier}"));
    }

    let production =
        cap_std::fs::Dir::open_ambient_dir(production_root, cap_std::ambient_authority()).map_err(
            |error| {
                format!(
                    "failed to open production data root {}: {error}",
                    production_root.display()
                )
            },
        )?;
    production.create_dir_all("identities").map_err(|error| {
        format!(
            "failed to create identities root {}: {error}",
            production_root.join("identities").display()
        )
    })?;
    let identities_metadata = production.symlink_metadata("identities").map_err(|error| {
        format!(
            "failed to inspect identities root {}: {error}",
            production_root.join("identities").display()
        )
    })?;
    if !identities_metadata.file_type().is_dir() {
        return Err(format!(
            "refusing aliased identities root {}",
            production_root.join("identities").display()
        ));
    }
    let identities = production.open_dir("identities").map_err(|error| {
        format!(
            "failed to open identities root {}: {error}",
            production_root.join("identities").display()
        )
    })?;

    match identities.symlink_metadata(identifier) {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err(format!(
                "refusing non-isolated identity data root {}",
                production_root
                    .join("identities")
                    .join(identifier)
                    .display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            identities.create_dir(identifier).map_err(|error| {
                format!(
                    "failed to create identity data root {}: {error}",
                    production_root
                        .join("identities")
                        .join(identifier)
                        .display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect identity data root {}: {error}",
                production_root
                    .join("identities")
                    .join(identifier)
                    .display()
            ));
        }
    }

    let expected = Path::new(identifier);
    let resolved = identities.canonicalize(identifier).map_err(|error| {
        format!(
            "failed to resolve identity data root {}: {error}",
            production_root
                .join("identities")
                .join(identifier)
                .display()
        )
    })?;
    if resolved != expected {
        return Err(format!(
            "refusing non-isolated identity data root {}",
            production_root
                .join("identities")
                .join(identifier)
                .display()
        ));
    }
    let identity = identities.open_dir(identifier).map_err(|error| {
        format!(
            "failed to open identity data root {}: {error}",
            production_root
                .join("identities")
                .join(identifier)
                .display()
        )
    })?;
    match identities.canonicalize(identifier) {
        Ok(resolved) if resolved == expected => {}
        _ => {
            return Err(format!(
                "identity data root changed while opening {}",
                production_root
                    .join("identities")
                    .join(identifier)
                    .display()
            ));
        }
    }

    Ok(IdentityRankBootstrapDirs {
        production,
        _identities: identities,
        identity,
    })
}

pub(crate) fn identity_rank_marker_complete(
    dir: &cap_std::fs::Dir,
    root: &Path,
) -> Result<bool, String> {
    let marker = root.join(IDENTITY_RANK_BOOTSTRAP_MARKER);
    let metadata = match dir.symlink_metadata(IDENTITY_RANK_BOOTSTRAP_MARKER) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "failed to inspect identity v2 marker {}: {error}",
                marker.display()
            ));
        }
    };
    if !metadata.file_type().is_file() {
        return Err(format!(
            "identity v2 marker is not a regular file: {}",
            marker.display()
        ));
    }
    let contents = dir.read(IDENTITY_RANK_BOOTSTRAP_MARKER).map_err(|error| {
        format!(
            "failed to read identity v2 marker {}: {error}",
            marker.display()
        )
    })?;
    if contents != b"v2\n" {
        return Err(format!(
            "identity v2 marker has invalid contents: {}",
            marker.display()
        ));
    }
    Ok(true)
}

pub(crate) fn valid_production_progress(
    production: &cap_std::fs::Dir,
    production_root: &Path,
) -> Result<Option<(PathBuf, Vec<u8>)>, String> {
    let mut failures = Vec::new();
    for filename in [PROGRESS_FILE, PROGRESS_BACKUP_FILE] {
        let source = production_root.join(filename);
        match production.symlink_metadata(filename) {
            Ok(metadata) if !metadata.file_type().is_file() => failures.push(format!(
                "{}: source is not a regular file",
                source.display()
            )),
            Ok(_) => match production.read(filename) {
                Ok(bytes) => match validate_progress_source(&bytes) {
                    Ok(()) => return Ok(Some((source, bytes))),
                    Err(error) => failures.push(format!("{}: {error}", source.display())),
                },
                Err(error) => failures.push(format!("{}: {error}", source.display())),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("{}: {error}", source.display())),
        }
    }
    if failures.is_empty() {
        Ok(None)
    } else {
        Err(format!(
            "refusing identity v2 migration without valid production progress: {}",
            failures.join("; ")
        ))
    }
}

/// Seed rank progress for a non-production identity exactly once. Production is
/// read-only; identity-local progress is preserved before both isolated live files
/// are atomically replaced with the same validated production snapshot.
pub(crate) fn bootstrap_identity_rank_progress_v2(
    home: &Path,
    identifier: &str,
) -> Result<bool, String> {
    bootstrap_identity_rank_progress_v2_with_fault(home, identifier, |_| Ok(()))
}

pub(crate) fn bootstrap_identity_rank_progress_v2_with_fault<F>(
    home: &Path,
    identifier: &str,
    mut fault: F,
) -> Result<bool, String>
where
    F: FnMut(&'static str) -> Result<(), String>,
{
    if identifier == PRODUCTION_APP_IDENTIFIER {
        return Ok(false);
    }

    let target_root = agent_data_root_for_home(home, identifier);
    let production_root = agent_data_root_for_home(home, PRODUCTION_APP_IDENTIFIER);
    let dirs = open_identity_rank_bootstrap_dirs(&production_root, identifier)?;
    if identity_rank_marker_complete(&dirs.identity, &target_root)? {
        return Ok(false);
    }
    let _lock = acquire_identity_progress_lock(&dirs.identity, &target_root)?;
    if identity_rank_marker_complete(&dirs.identity, &target_root)? {
        return Ok(false);
    }

    let Some((source, source_bytes)) =
        valid_production_progress(&dirs.production, &production_root)?
    else {
        return Ok(false);
    };
    log::info!(
        "identity v2 migration source: identity={identifier} source={}",
        source.display()
    );

    let target = identity_file_snapshot(&dirs.identity, &target_root, PROGRESS_FILE)?;
    let target_backup = identity_file_snapshot(&dirs.identity, &target_root, PROGRESS_BACKUP_FILE)?;
    fault("after-source-validation")?;
    preserve_identity_file_once(&dirs.identity, &target_root, &target, &source_bytes)?;
    fault("after-primary-backup")?;
    preserve_identity_file_once(&dirs.identity, &target_root, &target_backup, &source_bytes)?;
    fault("after-backups")?;

    let mut touched = Vec::new();
    touched.push(&target);
    if let Err(error) =
        atomic_write_identity_file(&dirs.identity, &target_root, target.name, &source_bytes)
    {
        return Err(rollback_identity_rank_migration(
            &dirs.identity,
            &target_root,
            error,
            &touched,
            false,
        ));
    }
    if let Err(error) = fault("after-primary-seed") {
        return Err(rollback_identity_rank_migration(
            &dirs.identity,
            &target_root,
            error,
            &touched,
            false,
        ));
    }

    touched.push(&target_backup);
    if let Err(error) = atomic_write_identity_file(
        &dirs.identity,
        &target_root,
        target_backup.name,
        &source_bytes,
    ) {
        return Err(rollback_identity_rank_migration(
            &dirs.identity,
            &target_root,
            error,
            &touched,
            false,
        ));
    }
    if let Err(error) = fault("before-marker") {
        return Err(rollback_identity_rank_migration(
            &dirs.identity,
            &target_root,
            error,
            &touched,
            false,
        ));
    }

    if let Err(error) = atomic_write_identity_file(
        &dirs.identity,
        &target_root,
        IDENTITY_RANK_BOOTSTRAP_MARKER,
        b"v2\n",
    ) {
        return Err(rollback_identity_rank_migration(
            &dirs.identity,
            &target_root,
            error,
            &touched,
            true,
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_storage_diagnostics_use_authenticated_identity_scoped_proxy() {
        let home = Path::new("/tmp/gg-identity-diagnostics");
        let production = agent_data_root_for_home(home, PRODUCTION_APP_IDENTIFIER);
        let local_fork = agent_data_root_for_home(home, "com.ggcoder.local-fork");

        assert_eq!(NOTES_DIAGNOSTICS_PATH, "/notes/diagnostics");
        assert_eq!(
            sidecar_identity_arg("com.ggcoder.local-fork"),
            "--gg-app-identity=com.ggcoder.local-fork"
        );
        assert_ne!(production, local_fork);
    }

    #[test]
    fn identity_bootstrap_is_once_only_and_preserves_sources_and_targets() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!(
            "gg-app-identity-bootstrap-{}-{unique}",
            std::process::id()
        ));
        let legacy_root = home.join(".gg");
        std::fs::create_dir_all(&legacy_root).unwrap();
        for filename in IDENTITY_BOOTSTRAP_FILES {
            std::fs::write(legacy_root.join(filename), format!("production-{filename}")).unwrap();
        }

        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&local_root).unwrap();
        std::fs::write(local_root.join("settings.json"), "identity-settings").unwrap();

        assert!(bootstrap_identity_data(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read_to_string(local_root.join("settings.json")).unwrap(),
            "identity-settings"
        );
        assert_eq!(
            std::fs::read_to_string(local_root.join("auth.json")).unwrap(),
            "production-auth.json"
        );
        assert_eq!(
            std::fs::read_to_string(legacy_root.join("auth.json")).unwrap(),
            "production-auth.json"
        );

        std::fs::write(legacy_root.join("auth.json"), "production-changed").unwrap();
        std::fs::remove_file(local_root.join("auth.json")).unwrap();
        assert!(!bootstrap_identity_data(&home, "com.ggcoder.local-fork").unwrap());
        assert!(!local_root.join("auth.json").exists());
        assert_eq!(
            std::fs::read_to_string(legacy_root.join("auth.json")).unwrap(),
            "production-changed"
        );

        assert!(!bootstrap_identity_data(&home, PRODUCTION_APP_IDENTIFIER).unwrap());
        assert!(!legacy_root.join(IDENTITY_BOOTSTRAP_MARKER).exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    const SIGNED_PROGRESS_FIXTURE: &str = r#"{"v":1,"xp":56437,"createdAt":"2026-01-02T03:04:05.000Z","totals":{"prompts":7,"commits":2,"linesShipped":3,"projects":["abc"]},"xpBySource":{"prompts":70,"commits":20,"streakBonus":0},"streak":{"current":2,"best":4,"lastActiveDay":"2026-08-09"},"rolling":{"promptTimes":[1,2],"commitTimes":[],"dayXp":10,"dayKey":"2026-08-09"},"repos":{"abc":{"lastHead":"deadbeef"}},"patchIds":["p1"],"lastEvent":null,"sig":"6ec96988064d1d89c4366ee50257f1a05417f18658f14a5e6f1042f9b4c30f80"}"#;

    #[test]
    fn identity_session_bootstrap_merges_history_without_overwriting_local_files() {
        let home = identity_bootstrap_test_home("identity-session-bootstrap-v3");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        let production_sessions = production_root.join("sessions/project");
        let local_sessions = local_root.join("sessions/project");
        std::fs::create_dir_all(&production_sessions).unwrap();
        std::fs::create_dir_all(&local_sessions).unwrap();
        std::fs::write(production_sessions.join("shared.jsonl"), b"production").unwrap();
        std::fs::write(production_sessions.join("missing.jsonl"), b"imported").unwrap();
        std::fs::write(local_sessions.join("shared.jsonl"), b"local").unwrap();
        std::fs::create_dir_all(production_root.join("chat-sessions/general/project")).unwrap();
        std::fs::write(
            production_root.join("chat-sessions/general/project/chat.jsonl"),
            b"chat",
        )
        .unwrap();
        std::fs::write(production_root.join("gg-app-workspace.json"), b"workspace").unwrap();

        assert!(bootstrap_identity_sessions(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read(local_sessions.join("shared.jsonl")).unwrap(),
            b"local"
        );
        assert_eq!(
            std::fs::read(local_sessions.join("missing.jsonl")).unwrap(),
            b"imported"
        );
        assert_eq!(
            std::fs::read(local_root.join("chat-sessions/general/project/chat.jsonl")).unwrap(),
            b"chat"
        );
        assert_eq!(
            std::fs::read(local_root.join("gg-app-workspace.json")).unwrap(),
            b"workspace"
        );
        assert!(!bootstrap_identity_sessions(&home, "com.ggcoder.local-fork").unwrap());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn progress_signature_validation_matches_typescript_store() {
        validate_progress_source(SIGNED_PROGRESS_FIXTURE.as_bytes()).unwrap();
        let tampered = SIGNED_PROGRESS_FIXTURE.replace("\"xp\":56437", "\"xp\":56438");
        assert!(validate_progress_source(tampered.as_bytes()).is_err());
        assert_eq!(
            stable_json(&serde_json::json!(1e20)).unwrap(),
            "100000000000000000000"
        );
        assert_eq!(stable_json(&serde_json::json!(1e-6)).unwrap(), "0.000001");
        assert_eq!(stable_json(&serde_json::json!(-0.0)).unwrap(), "0");
        assert_eq!(
            stable_json(&serde_json::json!({ "\u{e000}": 1, "\u{10000}": 2 })).unwrap(),
            "{\"𐀀\":2,\"\":1}"
        );
    }

    #[test]
    fn identity_rank_bootstrap_v2_preserves_then_seeds_once_without_touching_production() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        let production_path = production_root.join(PROGRESS_FILE);
        let local_path = local_root.join(PROGRESS_FILE);
        let local_backup_path = local_root.join(PROGRESS_BACKUP_FILE);
        std::fs::write(&production_path, SIGNED_PROGRESS_FIXTURE).unwrap();
        std::fs::write(&local_path, b"local-progress-before-v2").unwrap();
        std::fs::write(&local_backup_path, b"local-backup-before-v2").unwrap();
        let production_before = std::fs::read(&production_path).unwrap();

        assert!(bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read(local_root.join("progress.json.pre-v2")).unwrap(),
            b"local-progress-before-v2"
        );
        assert_eq!(
            std::fs::read(local_root.join("progress.backup.json.pre-v2")).unwrap(),
            b"local-backup-before-v2"
        );
        assert_eq!(std::fs::read(&local_path).unwrap(), production_before);
        assert_eq!(
            std::fs::read(&local_backup_path).unwrap(),
            production_before
        );
        assert_eq!(
            std::fs::read(local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER)).unwrap(),
            b"v2\n"
        );
        assert_eq!(std::fs::read(&production_path).unwrap(), production_before);

        std::fs::write(&local_path, b"identity-progress-after-v2").unwrap();
        assert!(!bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read(&local_path).unwrap(),
            b"identity-progress-after-v2"
        );
        assert_eq!(
            std::fs::read(local_root.join("progress.json.pre-v2")).unwrap(),
            b"local-progress-before-v2"
        );
        assert_eq!(std::fs::read(&production_path).unwrap(), production_before);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_fails_closed_on_invalid_production_progress() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-invalid");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        let production_path = production_root.join(PROGRESS_FILE);
        let local_path = local_root.join(PROGRESS_FILE);
        let local_backup_path = local_root.join(PROGRESS_BACKUP_FILE);
        let invalid_source = SIGNED_PROGRESS_FIXTURE.replace("\"xp\":56437", "\"xp\":999999");
        std::fs::write(&production_path, invalid_source.as_bytes()).unwrap();
        std::fs::write(&local_path, b"local-progress-unchanged").unwrap();
        std::fs::write(&local_backup_path, b"local-backup-unchanged").unwrap();

        let error =
            bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap_err();
        assert!(error.contains("signature is invalid"));
        assert_eq!(
            std::fs::read(&local_path).unwrap(),
            b"local-progress-unchanged"
        );
        assert_eq!(
            std::fs::read(&local_backup_path).unwrap(),
            b"local-backup-unchanged"
        );
        assert!(!local_root.join("progress.json.pre-v2").exists());
        assert!(!local_root.join("progress.backup.json.pre-v2").exists());
        assert!(!local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).exists());
        assert_eq!(
            std::fs::read(&production_path).unwrap(),
            invalid_source.as_bytes()
        );

        assert!(!bootstrap_identity_rank_progress_v2(&home, PRODUCTION_APP_IDENTIFIER).unwrap());
        assert!(!production_root
            .join(IDENTITY_RANK_BOOTSTRAP_MARKER)
            .exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_uses_only_a_valid_production_backup() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-fallback");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        let invalid_main = SIGNED_PROGRESS_FIXTURE.replace("\"xp\":56437", "\"xp\":7");
        let production_path = production_root.join(PROGRESS_FILE);
        let production_backup_path = production_root.join(PROGRESS_BACKUP_FILE);
        std::fs::write(&production_path, invalid_main.as_bytes()).unwrap();
        std::fs::write(&production_backup_path, SIGNED_PROGRESS_FIXTURE).unwrap();
        std::fs::write(local_root.join(PROGRESS_FILE), b"local-progress-before-v2").unwrap();

        assert!(bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
            SIGNED_PROGRESS_FIXTURE.as_bytes()
        );
        assert_eq!(
            std::fs::read(&production_path).unwrap(),
            invalid_main.as_bytes()
        );
        assert_eq!(
            std::fs::read(&production_backup_path).unwrap(),
            SIGNED_PROGRESS_FIXTURE.as_bytes()
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_prefers_a_valid_primary_over_backup() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-primary");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        let primary = format!("\n{SIGNED_PROGRESS_FIXTURE}\n");
        std::fs::write(production_root.join(PROGRESS_FILE), primary.as_bytes()).unwrap();
        std::fs::write(
            production_root.join(PROGRESS_BACKUP_FILE),
            SIGNED_PROGRESS_FIXTURE,
        )
        .unwrap();

        assert!(bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap());
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
            primary.as_bytes()
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_rejects_malformed_and_unsigned_sources() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-malformed");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        std::fs::write(production_root.join(PROGRESS_FILE), b"{not-json").unwrap();
        std::fs::write(
            production_root.join(PROGRESS_BACKUP_FILE),
            br#"{"v":1,"xp":1}"#,
        )
        .unwrap();
        std::fs::write(local_root.join(PROGRESS_FILE), b"local-primary").unwrap();
        std::fs::write(local_root.join(PROGRESS_BACKUP_FILE), b"local-backup").unwrap();

        let error =
            bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap_err();
        assert!(error.contains("not valid JSON"));
        assert!(error.contains("invalid shape"));
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
            b"local-primary"
        );
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_BACKUP_FILE)).unwrap(),
            b"local-backup"
        );
        assert!(!local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).exists());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_rolls_back_injected_partial_failures() {
        for phase in [
            "after-primary-backup",
            "after-primary-seed",
            "before-marker",
        ] {
            let home = identity_bootstrap_test_home(&format!(
                "identity-rank-bootstrap-v2-fault-{}",
                phase.replace('-', "_")
            ));
            let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
            let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
            std::fs::create_dir_all(&production_root).unwrap();
            std::fs::create_dir_all(&local_root).unwrap();
            std::fs::write(production_root.join(PROGRESS_FILE), SIGNED_PROGRESS_FIXTURE).unwrap();
            std::fs::write(local_root.join(PROGRESS_FILE), b"local-primary").unwrap();
            std::fs::write(local_root.join(PROGRESS_BACKUP_FILE), b"local-backup").unwrap();

            let error = bootstrap_identity_rank_progress_v2_with_fault(
                &home,
                "com.ggcoder.local-fork",
                |boundary| {
                    if boundary == phase {
                        Err(format!("injected failure at {phase}"))
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap_err();
            assert!(error.contains("injected failure"));
            assert_eq!(
                std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
                b"local-primary",
                "primary changed after fault at {phase}"
            );
            assert_eq!(
                std::fs::read(local_root.join(PROGRESS_BACKUP_FILE)).unwrap(),
                b"local-backup",
                "backup changed after fault at {phase}"
            );
            assert_eq!(
                std::fs::read(local_root.join("progress.json.pre-v2")).unwrap(),
                b"local-primary"
            );
            if phase == "after-primary-backup" {
                assert!(!local_root.join("progress.backup.json.pre-v2").exists());
            } else {
                assert_eq!(
                    std::fs::read(local_root.join("progress.backup.json.pre-v2")).unwrap(),
                    b"local-backup"
                );
            }
            assert!(!local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).exists());

            assert!(
                bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap(),
                "retry did not complete after fault at {phase}"
            );
            assert_eq!(
                std::fs::read(local_root.join("progress.json.pre-v2")).unwrap(),
                b"local-primary"
            );
            assert_eq!(
                std::fs::read(local_root.join("progress.backup.json.pre-v2")).unwrap(),
                b"local-backup"
            );
            std::fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn identity_rank_bootstrap_v2_directory_swap_cannot_touch_alias_target() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-directory-swap");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        let detached_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork-detached");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        std::fs::write(production_root.join(PROGRESS_FILE), SIGNED_PROGRESS_FIXTURE).unwrap();
        std::fs::write(local_root.join(PROGRESS_FILE), b"local-primary").unwrap();
        std::fs::write(local_root.join(PROGRESS_BACKUP_FILE), b"local-backup").unwrap();
        let mut swap_completed = false;
        let mut swap_blocked = false;

        assert!(bootstrap_identity_rank_progress_v2_with_fault(
            &home,
            "com.ggcoder.local-fork",
            |boundary| {
                if boundary != "after-source-validation" {
                    return Ok(());
                }
                match std::fs::rename(&local_root, &detached_root) {
                    Ok(()) => {
                        #[cfg(unix)]
                        std::os::unix::fs::symlink(&production_root, &local_root).unwrap();
                        #[cfg(windows)]
                        assert!(Command::new("cmd")
                            .arg("/C")
                            .arg("mklink")
                            .arg("/J")
                            .arg(&local_root)
                            .arg(&production_root)
                            .status()
                            .is_ok_and(|status| status.success()));
                        swap_completed = true;
                    }
                    Err(_) => swap_blocked = true,
                }
                Ok(())
            },
        )
        .unwrap());

        #[cfg(unix)]
        assert!(
            swap_completed,
            "directory swap should exercise the bound handle"
        );
        #[cfg(windows)]
        assert!(
            swap_blocked,
            "open directory handles must block junction swaps"
        );
        assert_eq!(
            std::fs::read(production_root.join(PROGRESS_FILE)).unwrap(),
            SIGNED_PROGRESS_FIXTURE.as_bytes()
        );
        assert!(!production_root
            .join(IDENTITY_RANK_BOOTSTRAP_MARKER)
            .exists());
        if swap_completed {
            assert!(detached_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).is_file());
            assert_eq!(
                std::fs::read(detached_root.join("progress.json.pre-v2")).unwrap(),
                b"local-primary"
            );
            #[cfg(unix)]
            std::fs::remove_file(&local_root).unwrap();
            #[cfg(windows)]
            std::fs::remove_dir(&local_root).unwrap();
        } else {
            assert!(local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER).is_file());
        }
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_rejects_stale_backups_and_markers() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-stale");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        std::fs::write(production_root.join(PROGRESS_FILE), SIGNED_PROGRESS_FIXTURE).unwrap();
        std::fs::write(local_root.join(PROGRESS_FILE), b"current-local").unwrap();
        std::fs::write(local_root.join("progress.json.pre-v2"), b"stale-local").unwrap();

        let error =
            bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap_err();
        assert!(error.contains("does not match current identity state"));
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
            b"current-local"
        );

        std::fs::remove_file(local_root.join("progress.json.pre-v2")).unwrap();
        std::fs::write(
            local_root.join(IDENTITY_RANK_BOOTSTRAP_MARKER),
            b"incomplete",
        )
        .unwrap();
        let error =
            bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap_err();
        assert!(error.contains("marker has invalid contents"));
        assert_eq!(
            std::fs::read(local_root.join(PROGRESS_FILE)).unwrap(),
            b"current-local"
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_serializes_concurrent_attempts() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-concurrent");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::create_dir_all(&local_root).unwrap();
        std::fs::write(production_root.join(PROGRESS_FILE), SIGNED_PROGRESS_FIXTURE).unwrap();
        std::fs::write(local_root.join(PROGRESS_FILE), b"local-progress-before-v2").unwrap();
        std::fs::write(
            local_root.join(PROGRESS_BACKUP_FILE),
            b"local-backup-before-v2",
        )
        .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let home = home.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    bootstrap_identity_rank_progress_v2(&home, "com.ggcoder.local-fork").unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let mut outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        outcomes.sort_unstable();

        assert_eq!(outcomes, vec![false, true]);
        assert_eq!(
            std::fs::read(local_root.join("progress.json.pre-v2")).unwrap(),
            b"local-progress-before-v2"
        );
        assert_eq!(
            std::fs::read(local_root.join("progress.backup.json.pre-v2")).unwrap(),
            b"local-backup-before-v2"
        );
        assert!(local_root.join(IDENTITY_RANK_BOOTSTRAP_LOCK).is_file());
        let dirs =
            open_identity_rank_bootstrap_dirs(&production_root, "com.ggcoder.local-fork").unwrap();
        let recovered_lock = acquire_identity_progress_lock(&dirs.identity, &local_root).unwrap();
        drop(recovered_lock);
        drop(dirs);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn identity_rank_bootstrap_v2_rejects_non_isolated_identifier_paths() {
        let home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-path");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        std::fs::create_dir_all(&production_root).unwrap();
        std::fs::write(production_root.join(PROGRESS_FILE), SIGNED_PROGRESS_FIXTURE).unwrap();

        let error = bootstrap_identity_rank_progress_v2(&home, "../escape").unwrap_err();
        assert!(error.contains("invalid non-production identity"));
        assert!(!home.join(".gg").join("escape").exists());

        let first_identity = agent_data_root_for_home(&home, "first-identity");
        std::fs::create_dir_all(&first_identity).unwrap();
        let error = prepare_isolated_identity_root(
            &home,
            "second-identity",
            &first_identity,
            &production_root,
        )
        .unwrap_err();
        assert!(error.contains("refusing non-isolated identity data root"));
        std::fs::remove_dir_all(home).unwrap();

        let alias_home = identity_bootstrap_test_home("identity-rank-bootstrap-v2-alias");
        let alias_production = agent_data_root_for_home(&alias_home, PRODUCTION_APP_IDENTIFIER);
        let alias_target = agent_data_root_for_home(&alias_home, "com.ggcoder.local-fork");
        std::fs::create_dir_all(alias_target.parent().unwrap()).unwrap();
        std::fs::write(
            alias_production.join(PROGRESS_FILE),
            SIGNED_PROGRESS_FIXTURE,
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&alias_production, &alias_target).unwrap();
        #[cfg(windows)]
        assert!(Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&alias_target)
            .arg(&alias_production)
            .status()
            .is_ok_and(|status| status.success()));
        let error =
            bootstrap_identity_rank_progress_v2(&alias_home, "com.ggcoder.local-fork").unwrap_err();
        assert!(error.contains("refusing non-isolated identity data root"));
        assert!(!alias_production
            .join(IDENTITY_RANK_BOOTSTRAP_MARKER)
            .exists());
        assert_eq!(
            std::fs::read(alias_production.join(PROGRESS_FILE)).unwrap(),
            SIGNED_PROGRESS_FIXTURE.as_bytes()
        );
        #[cfg(unix)]
        std::fs::remove_file(&alias_target).unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(&alias_target).unwrap();
        std::fs::remove_dir_all(alias_home).unwrap();
    }
}
