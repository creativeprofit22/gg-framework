//! Node/sidecar/cwd resolution, home dir, and macOS permissions.

use crate::*;

/// Resolve the Node runtime used to run the sidecar.
///
/// Dev (debug build, or `GG_NODE_BIN` set): use `GG_NODE_BIN`, else bare
/// `"node"` from PATH — matches the workspace developer flow.
///
/// Bundled (release): use the per-platform Node staged as a Tauri `externalBin`,
/// which Tauri places next to the app executable named `ggnode` (`.exe` on
/// Windows). This removes any dependency on a Node install on the user's PATH
/// (a Finder/Dock-launched `.app` gets a minimal PATH without nvm/homebrew).
pub(crate) fn resolve_node(_app: &tauri::AppHandle) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()));
    pick_node(
        std::env::var("GG_NODE_BIN").ok(),
        cfg!(debug_assertions),
        exe_dir.as_deref(),
    )
}

/// Pure node-path decision (testable without an AppHandle).
/// - `env_override` (GG_NODE_BIN) always wins.
/// - dev build → bare `"node"` from PATH.
/// - bundled → `ggnode(.exe)` next to the executable if present, else `"node"`.
pub(crate) fn pick_node(
    env_override: Option<String>,
    is_dev: bool,
    exe_dir: Option<&Path>,
) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return PathBuf::from("node");
    }
    let name = if cfg!(target_os = "windows") {
        "ggnode.exe"
    } else {
        "ggnode"
    };
    match exe_dir.map(|d| d.join(name)) {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("node"),
    }
}

/// Resolve the built sidecar JS.
///
/// Dev (debug build, or `GG_SIDECAR_PATH` set): use `GG_SIDECAR_PATH`, else the
/// workspace `dist/app-sidecar.js` relative to this crate.
///
/// Bundled (release): resolve the single-file ESM sidecar shipped under
/// `bundle.resources` via the Tauri resource directory.
pub(crate) fn resolve_sidecar(app: &tauri::AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resolve(
            "sidecar/app-sidecar.mjs",
            tauri::path::BaseDirectory::Resource,
        )
        .ok();
    pick_sidecar(
        std::env::var("GG_SIDECAR_PATH").ok(),
        cfg!(debug_assertions),
        resource.as_deref(),
    )
}

/// Path to the workspace dev sidecar, preferring the Local Fork Error Mom wrapper.
pub(crate) fn workspace_sidecar() -> PathBuf {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let direct = workspace_root.join("packages/ggcoder/dist/app-sidecar.js");
    let wrapper = workspace_root.join("gg-app/scripts/error-mom-sidecar.mjs");
    if wrapper.exists() {
        strip_extended_prefix(wrapper)
    } else {
        direct
    }
}

/// Pure sidecar-path decision (testable without an AppHandle).
/// - `env_override` (GG_SIDECAR_PATH) always wins.
/// - dev build → workspace `dist/app-sidecar.js`.
/// - bundled → the resolved bundle resource, falling back to the workspace path.
pub(crate) fn pick_sidecar(
    env_override: Option<String>,
    is_dev: bool,
    resource: Option<&Path>,
) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return workspace_sidecar();
    }
    match resource {
        Some(p) => strip_extended_prefix(p.to_path_buf()),
        None => workspace_sidecar(),
    }
}

/// Default working directory for the main window. Override with GG_APP_CWD;
/// otherwise the workspace root in dev, or the user's home dir in release.
/// Canonicalized so traversal segments (`../..`) don't leak into the session
/// store path and surface as a stray ".." project in the picker.
pub(crate) fn default_cwd() -> PathBuf {
    let raw = pick_cwd(
        std::env::var("GG_APP_CWD").ok(),
        cfg!(debug_assertions),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        home_dir(),
    );
    strip_extended_prefix(std::fs::canonicalize(&raw).unwrap_or(raw))
}

/// Drop Windows' extended-length (`\\?\`) prefix from a canonicalized path.
///
/// `std::fs::canonicalize` ALWAYS returns `\\?\C:\…` on Windows. That string is
/// not interchangeable with the plain `C:\…` form everyone else produces:
/// project paths from discovery, the workspace snapshot, and the picker's
/// selected-project comparison all use the plain form, so the prefixed value
/// silently matched nothing and leaked into the UI as `\\?\C:\Users\…`. Shell
/// APIs (`ShellExecute`, hence the opener) also reject the prefixed form, so
/// clicking a file path in a tool result did nothing.
///
/// UNC canonicalizes to `\\?\UNC\server\share`, which maps back to
/// `\\server\share`. No-op on other platforms and for unprefixed paths.
pub(crate) fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// The current user's home directory.
///
/// This must agree with Node's `os.homedir()` because production preserves the
/// legacy `~/.gg` root and identity roots are derived from that same home.
pub(crate) fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            if !profile.is_empty() {
                return PathBuf::from(profile);
            }
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            if !drive.is_empty() && !path.is_empty() {
                let mut home = std::ffi::OsString::from(drive);
                home.push(path);
                return PathBuf::from(home);
            }
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Production remains byte-for-byte compatible with the legacy root. Every
/// other signed Tauri identity owns a child root under `~/.gg/identities`.
pub(crate) fn agent_data_root_for_home(home: &Path, identifier: &str) -> PathBuf {
    let legacy = home.join(".gg");
    if identifier == PRODUCTION_APP_IDENTIFIER {
        legacy
    } else {
        legacy.join("identities").join(identifier)
    }
}

pub(crate) fn agent_data_root(identifier: &str) -> PathBuf {
    agent_data_root_for_home(&home_dir(), identifier)
}

/// Whether this process can read inside a macOS TCC-protected folder (probed
/// via the user's Documents directory, present on every account). Full Disk
/// Access grants blanket read access to all of them at once; a narrower grant
/// (e.g. only Desktop) would still fail this Documents probe, which is the
/// intentionally strict behavior — the Settings badge should read "not
/// granted" until Full Disk Access covers everything the subagent process
/// might need. Returns `true` immediately on non-macOS (no probe needed).
#[cfg(target_os = "macos")]
pub(crate) fn full_disk_access_granted() -> bool {
    let probe = home_dir().join("Documents");
    std::fs::read_dir(&probe).is_ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn full_disk_access_granted() -> bool {
    true
}

/// Report whether there's an OS permission to grant on this platform, and
/// whether it's currently granted. Windows/Linux have nothing to grant (the
/// subagent-respawn TCC issue is macOS-only), so `applicable` is false and the
/// Settings modal hides the row entirely.
#[tauri::command]
pub(crate) fn permissions_status() -> PermissionsStatus {
    PermissionsStatus {
        applicable: cfg!(target_os = "macos"),
        granted: full_disk_access_granted(),
    }
}

/// Open System Settings' Full Disk Access pane directly (macOS only — the
/// frontend only shows the button when `permissions_status().applicable` is
/// true). `x-apple.systempreferences` deep-links straight past the generic
/// Privacy & Security landing page.
#[tauri::command]
pub(crate) fn open_permissions_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
        spawn_reaped(cmd).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("not applicable on this platform".into())
    }
}

/// Pure cwd decision (testable without touching env/filesystem).
/// - `env_override` (GG_APP_CWD) always wins.
/// - dev build → the workspace root (`CARGO_MANIFEST_DIR/../..`).
/// - bundled (release) → `home`. `CARGO_MANIFEST_DIR` is baked in at COMPILE
///   time, so in a shipped binary it's the CI build machine's path (e.g.
///   `/Users/runner/work/...`) which doesn't exist on the user's machine — the
///   sidecar would crash with EACCES trying to use it. Home always exists and
///   is writable; the project picker re-points the window immediately anyway.
pub(crate) fn pick_cwd(
    env_override: Option<String>,
    is_dev: bool,
    dev_root: PathBuf,
    home: PathBuf,
) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return dev_root;
    }
    home
}

/// A debug override replaces, rather than extends, the plugin's shared file targets.
/// Release builds ignore the variable entirely, including invalid values.
pub(crate) fn native_log_override_targets(
    debug_enabled: bool,
    value: Option<&std::ffi::OsStr>,
) -> Result<Option<[tauri_plugin_log::TargetKind; 2]>, String> {
    if !debug_enabled {
        return Ok(None);
    }
    let Some(value) = value else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.as_encoded_bytes().contains(&0) {
        return Err(
            "GG_APP_DEV_LOG_DIR must be an absolute directory path without NUL bytes".into(),
        );
    }
    Ok(Some([
        tauri_plugin_log::TargetKind::Stdout,
        tauri_plugin_log::TargetKind::Folder {
            path,
            file_name: Some("gg-app".into()),
        },
    ]))
}

pub(crate) fn native_log_builder(
    debug_enabled: bool,
    value: Option<&std::ffi::OsStr>,
) -> Result<tauri_plugin_log::Builder, String> {
    let builder = tauri_plugin_log::Builder::new().level(log::LevelFilter::Info);
    match native_log_override_targets(debug_enabled, value)? {
        Some(targets) => Ok(builder
            .clear_targets()
            .targets(targets.map(tauri_plugin_log::Target::new))),
        None => Ok(builder
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ))
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("gg-app".into()),
                },
            ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_log_override_selects_only_stdout_and_requested_folder() {
        let path = std::env::current_dir()
            .unwrap()
            .join("isolated-native-logs");
        let targets = native_log_override_targets(true, Some(path.as_os_str()))
            .unwrap()
            .unwrap();
        assert_eq!(targets.len(), 2);
        assert!(matches!(&targets[0], tauri_plugin_log::TargetKind::Stdout));
        assert!(matches!(&targets[1], tauri_plugin_log::TargetKind::Folder {
            path: selected, file_name: Some(name),
        } if selected == &path && name == "gg-app"));
        assert!(!targets
            .iter()
            .any(|target| matches!(target, tauri_plugin_log::TargetKind::LogDir { .. })));
        assert!(native_log_builder(true, Some(path.as_os_str())).is_ok());
    }

    #[test]
    fn native_log_override_unset_preserves_normal_logging() {
        assert!(native_log_override_targets(true, None).unwrap().is_none());
        assert!(native_log_builder(true, None).is_ok());
    }

    #[test]
    fn native_log_override_rejects_empty_relative_and_nul_paths() {
        let absolute = std::env::current_dir().unwrap().join("invalid\0logs");
        for value in [
            std::ffi::OsStr::new(""),
            std::ffi::OsStr::new("relative/logs"),
            std::ffi::OsStr::new("../logs"),
            absolute.as_os_str(),
        ] {
            assert!(native_log_override_targets(true, Some(value)).is_err());
            // Invalid overrides must propagate errors instead of returning the normal builder.
            assert!(native_log_builder(true, Some(value)).is_err());
        }
    }

    #[test]
    fn native_log_override_release_ignores_even_invalid_values() {
        let absolute = std::env::current_dir()
            .unwrap()
            .join("isolated-native-logs");
        for value in [
            None,
            Some(std::ffi::OsStr::new("")),
            Some(std::ffi::OsStr::new("relative")),
            Some(absolute.as_os_str()),
        ] {
            assert!(native_log_override_targets(false, value).unwrap().is_none());
            assert!(native_log_builder(false, value).is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_log_override_rejects_drive_relative_and_root_relative_paths() {
        for value in [r"C:logs", r"\logs"] {
            assert!(native_log_builder(true, Some(std::ffi::OsStr::new(value))).is_err());
        }
    }

    #[test]
    fn pick_node_env_override_wins() {
        let got = pick_node(Some("/opt/node".into()), true, None);
        assert_eq!(got, PathBuf::from("/opt/node"));
        // ...even in bundled mode with a present exe dir.
        let got = pick_node(Some("/opt/node".into()), false, Some(Path::new("/app")));
        assert_eq!(got, PathBuf::from("/opt/node"));
    }

    #[test]
    fn strip_extended_prefix_normalizes_windows_canonical_paths() {
        // canonicalize() always returns the \\?\ form on Windows; nothing else
        // in the app (discovery, workspace json, the picker) produces it, and
        // ShellExecute rejects it outright.
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"\\?\C:\Users\dev\proj")),
            PathBuf::from(r"C:\Users\dev\proj")
        );
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"\\?\UNC\server\share\proj")),
            PathBuf::from(r"\\server\share\proj")
        );
        // Unprefixed and POSIX paths pass through untouched.
        assert_eq!(
            strip_extended_prefix(PathBuf::from(r"C:\Users\dev")),
            PathBuf::from(r"C:\Users\dev")
        );
        assert_eq!(
            strip_extended_prefix(PathBuf::from("/Users/dev")),
            PathBuf::from("/Users/dev")
        );
    }

    #[test]
    fn pick_node_dev_uses_path() {
        let got = pick_node(None, true, Some(Path::new("/app")));
        assert_eq!(got, PathBuf::from("node"));
    }

    #[test]
    fn pick_node_bundled_uses_exe_dir_when_present() {
        let tmp = std::env::temp_dir().join(format!("ggnode-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let name = if cfg!(target_os = "windows") {
            "ggnode.exe"
        } else {
            "ggnode"
        };
        let staged = tmp.join(name);
        std::fs::write(&staged, b"").unwrap();
        let got = pick_node(None, false, Some(&tmp));
        assert_eq!(got, staged);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn pick_node_bundled_falls_back_when_missing() {
        let got = pick_node(None, false, Some(Path::new("/nonexistent-dir-xyz")));
        assert_eq!(got, PathBuf::from("node"));
    }

    #[test]
    fn pick_sidecar_env_override_wins() {
        let got = pick_sidecar(Some("/x/side.mjs".into()), true, None);
        assert_eq!(got, PathBuf::from("/x/side.mjs"));
        let got = pick_sidecar(
            Some("/x/side.mjs".into()),
            false,
            Some(Path::new("/res/sidecar/app-sidecar.mjs")),
        );
        assert_eq!(got, PathBuf::from("/x/side.mjs"));
    }

    #[test]
    fn pick_sidecar_dev_uses_workspace() {
        let got = pick_sidecar(None, true, Some(Path::new("/res/app-sidecar.mjs")));
        assert_eq!(got, workspace_sidecar());
    }

    #[test]
    fn pick_sidecar_bundled_uses_resource() {
        let res = Path::new("/res/sidecar/app-sidecar.mjs");
        let got = pick_sidecar(None, false, Some(res));
        assert_eq!(got, res.to_path_buf());
    }

    #[test]
    fn pick_sidecar_bundled_normalizes_windows_resource_paths() {
        let cases = [
            (
                r"\\?\C:\Program Files\GG Coder\sidecar\app-sidecar.mjs",
                r"C:\Program Files\GG Coder\sidecar\app-sidecar.mjs",
            ),
            (
                r"C:\Program Files\GG Coder\sidecar\app-sidecar.mjs",
                r"C:\Program Files\GG Coder\sidecar\app-sidecar.mjs",
            ),
            (
                r"\\?\UNC\server\share\sidecar\app-sidecar.mjs",
                r"\\server\share\sidecar\app-sidecar.mjs",
            ),
        ];

        for (resource, expected) in cases {
            assert_eq!(
                pick_sidecar(None, false, Some(Path::new(resource))),
                PathBuf::from(expected)
            );
        }
    }

    #[test]
    fn pick_sidecar_bundled_falls_back_without_resource() {
        let got = pick_sidecar(None, false, None);
        assert_eq!(got, workspace_sidecar());
    }

    #[test]
    fn pick_cwd_env_override_wins() {
        let got = pick_cwd(
            Some("/work/proj".into()),
            true,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/work/proj"));
        // ...even in release mode.
        let got = pick_cwd(
            Some("/work/proj".into()),
            false,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/work/proj"));
    }

    #[test]
    fn pick_cwd_dev_uses_workspace_root() {
        let got = pick_cwd(
            None,
            true,
            PathBuf::from("/repo"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/repo"));
    }

    #[test]
    fn pick_cwd_release_uses_home_not_build_path() {
        // The crux of the release bug: in a shipped binary the dev_root is the CI
        // build machine's path; release must ignore it and use the home dir.
        let got = pick_cwd(
            None,
            false,
            PathBuf::from("/Users/runner/work/gg-framework/gg-framework"),
            PathBuf::from("/home/user"),
        );
        assert_eq!(got, PathBuf::from("/home/user"));
    }

    #[test]
    fn identity_data_paths_preserve_production_and_separate_local_fork() {
        let home = PathBuf::from("/test-home");
        let production_root = agent_data_root_for_home(&home, PRODUCTION_APP_IDENTIFIER);
        let local_root = agent_data_root_for_home(&home, "com.ggcoder.local-fork");

        assert_eq!(production_root, home.join(".gg"));
        assert_eq!(
            local_root,
            home.join(".gg")
                .join("identities")
                .join("com.ggcoder.local-fork")
        );
        assert_ne!(production_root, local_root);
        assert_eq!(
            app_settings_path(PRODUCTION_APP_IDENTIFIER),
            agent_data_root(PRODUCTION_APP_IDENTIFIER).join("gg-app.json")
        );
        assert_eq!(
            auth_file_path("com.ggcoder.local-fork"),
            agent_data_root("com.ggcoder.local-fork").join("auth.json")
        );
        assert_eq!(
            app_workspace_path("com.ggcoder.local-fork"),
            agent_data_root("com.ggcoder.local-fork").join("gg-app-workspace.json")
        );
    }
}
