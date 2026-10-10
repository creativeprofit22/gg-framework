//! Native app settings (~/.gg/gg-app.json) and the workspace snapshot.

use crate::*;

// ── Native app settings (~/.gg/gg-app.json) ───────────────────────────────
// The project folder is a plain home-dir file with NOTHING to do with the
// agent, so Rust reads/writes it directly. This makes the home-screen Settings
// + New project flow independent of the Node sidecar's boot — a slow or crashed
// sidecar used to make "Save project folder" silently fail or time out even on
// up-to-date builds. (The sidecar keeps its own /settings endpoint for its
// internal use; this is the authoritative path for the webview.)

/// Absolute path to this product identity's gg-app.json.
pub(crate) fn app_settings_path(identifier: &str) -> PathBuf {
    agent_data_root(identifier).join("gg-app.json")
}

/// Default projects root: ~/gg-projects.
pub(crate) fn default_projects_root() -> PathBuf {
    home_dir().join("gg-projects")
}

/// Validate a project folder name: lowercase letters, digits, single dashes
/// between segments (mirrors the sidecar's isValidProjectName).
pub(crate) fn is_valid_project_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ — no leading/trailing/double dashes.
    let bytes = name.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_dash = false;
    for &b in bytes {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => prev_dash = false,
            b'-' => {
                if prev_dash {
                    return false;
                }
                prev_dash = true;
            }
            _ => return false,
        }
    }
    true
}

pub(crate) fn read_app_settings(identifier: &str) -> serde_json::Value {
    let raw = std::fs::read_to_string(app_settings_path(identifier)).ok();
    let parsed = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let configured = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let projects_root = parsed
        .as_ref()
        .and_then(|v| v.get("projectsRoot"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_projects_root().to_string_lossy().to_string());
    serde_json::json!({ "projectsRoot": projects_root, "configured": configured })
}

/// Native: read gg-app settings directly from this app identity's data root.
#[tauri::command]
pub(crate) fn app_settings_get(app: tauri::AppHandle) -> serde_json::Value {
    read_app_settings(&app.config().identifier)
}

/// Update only the user-facing projects root while preserving sidecar-owned
/// preferences in the same file (models, hidden projects, extra roots, and
/// forward-compatible fields).
pub(crate) fn write_projects_root(
    path: &Path,
    projects_root: &str,
) -> Result<serde_json::Value, String> {
    let mut settings = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|error| format!("failed to parse {}: {error}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let object = settings
        .as_object_mut()
        .ok_or_else(|| format!("app settings must be a JSON object: {}", path.display()))?;
    object.insert(
        "projectsRoot".to_string(),
        serde_json::Value::String(projects_root.to_string()),
    );

    let parent = path
        .parent()
        .ok_or_else(|| format!("app settings path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid app settings filename: {}", path.display()))?;
    let dir = cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())
        .map_err(|error| format!("failed to open {}: {error}", parent.display()))?;
    let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    atomic_write_identity_file(&dir, parent, filename, &bytes)?;
    Ok(settings)
}

/// Native: update gg-app settings directly in this app identity's data root.
/// The read-modify-write is atomic and never needs the sidecar.
#[tauri::command]
pub(crate) fn app_settings_save(
    app: tauri::AppHandle,
    projects_root: String,
) -> Result<serde_json::Value, String> {
    let trimmed = projects_root.trim();
    if trimmed.is_empty() {
        return Err("projectsRoot is required".to_string());
    }
    write_projects_root(&app_settings_path(&app.config().identifier), trimmed)?;
    Ok(serde_json::json!({ "projectsRoot": trimmed }))
}

/// Native: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, an error message on invalid name / conflict.
/// Never needs the sidecar.
#[tauri::command]
pub(crate) fn app_create_project(
    app: tauri::AppHandle,
    name: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if !is_valid_project_name(name) {
        return Err(
            "Project name must be lowercase letters, digits, and dashes (e.g. my-project)."
                .to_string(),
        );
    }
    // Resolve the projects root the same way app_settings_get does.
    let settings = read_app_settings(&app.config().identifier);
    let root = settings
        .get("projectsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_root);
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("A folder named \"{name}\" already exists."));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
}

// ── Workspace snapshot (~/.gg/gg-app-workspace.json) ──────────────────────
// Records which project/session is open in each window (plus geometry) so a
// restart — especially the updater's relaunch() — can reopen every window where
// it left off instead of dropping back to a single picker window. Owned by Rust
// (same pattern as gg-app.json), written on project-select / window-close /
// app-exit, replayed in `setup`.

/// One saved window: its mode, cwd, an optional session file to resume, and
/// optional last-known geometry (physical pixels).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WorkspaceEntry {
    #[serde(default)]
    pub(crate) mode: WorkspaceMode,
    #[serde(rename = "chatAgent", default)]
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: String,
    #[serde(
        rename = "sessionPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
}

/// The whole snapshot: an ordered list of open windows (main first).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Workspace {
    #[serde(default)]
    pub(crate) windows: Vec<WorkspaceEntry>,
}

/// Absolute path to ~/.gg/gg-app-workspace.json.
pub(crate) fn app_workspace_path(identifier: &str) -> PathBuf {
    agent_data_root(identifier).join("gg-app-workspace.json")
}

/// Read the workspace snapshot; missing/invalid file → an empty workspace.
pub(crate) fn read_workspace(identifier: &str) -> Workspace {
    std::fs::read_to_string(app_workspace_path(identifier))
        .ok()
        .and_then(|s| serde_json::from_str::<Workspace>(&s).ok())
        .unwrap_or_default()
}

/// Write the workspace snapshot (creating ~/.gg if needed). Best-effort.
pub(crate) fn write_workspace(identifier: &str, ws: &Workspace) {
    let path = app_workspace_path(identifier);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(ws) {
        let _ = std::fs::write(&path, pretty);
    }
}

/// Pure: picker-only windows have a daemon session at the default boot cwd but
/// no active workspace target. A selected project remains snapshot-worthy even
/// when its path happens to equal that default cwd.
pub(crate) fn keep_for_snapshot(workspace_selected: bool, cwd: Option<&Path>) -> bool {
    workspace_selected && cwd.is_some()
}

/// Pure: drop restore entries that can't be opened (empty cwd, or a cwd that no
/// longer exists). `exists` is injected so this is testable without the fs.
pub(crate) fn filter_restorable<F: Fn(&str) -> bool>(
    windows: Vec<WorkspaceEntry>,
    exists: F,
) -> Vec<WorkspaceEntry> {
    windows
        .into_iter()
        .filter(|w| !w.cwd.trim().is_empty() && exists(&w.cwd))
        .collect()
}

/// Walk every live window + its `Windows` session entry and write a fresh
/// snapshot. Picker-only windows (without an active target) are excluded.
/// Geometry is captured from each window's current outer position + inner size.
pub(crate) fn snapshot_workspace(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    let selected_labels: HashSet<String> = app
        .state::<RestoreTargets>()
        .map
        .lock_or_recover()
        .keys()
        .cloned()
        .collect();
    let state: State<Windows> = app.state();
    let map = state.map.lock_or_recover();

    // Deterministic order: main first, then project-N ascending, so the first
    // restored window reclaims the `main` label.
    let mut labels: Vec<String> = windows.keys().cloned().collect();
    labels.sort_by_key(|a| label_rank(a));

    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    for label in &labels {
        let Some(inst) = map.get(label).and_then(|panes| panes.get(PRIMARY_PANE_ID)) else {
            continue;
        };
        let cwd = inst.cwd.as_deref();
        if !keep_for_snapshot(selected_labels.contains(label), cwd) {
            continue;
        }
        let cwd = cwd.unwrap().to_string_lossy().to_string();
        let (mut x, mut y, mut width, mut height) = (None, None, None, None);
        if let Some(win) = windows.get(label) {
            if let Ok(pos) = win.outer_position() {
                x = Some(pos.x);
                y = Some(pos.y);
            }
            if let Ok(size) = win.inner_size() {
                width = Some(size.width);
                height = Some(size.height);
            }
        }
        entries.push(WorkspaceEntry {
            mode: inst.mode,
            chat_agent: inst.chat_agent,
            cwd,
            session_path: inst.session_path.clone(),
            x,
            y,
            width,
            height,
        });
    }
    drop(map);
    write_workspace(&app.config().identifier, &Workspace { windows: entries });
}

/// Remove one window's entry from the snapshot (deliberate user close). Keyed by
/// the window's recorded mode + cwd, since the snapshot has no labels.
pub(crate) fn remove_window_from_workspace(app: &tauri::AppHandle, label: &str) {
    let target = {
        let state: State<Windows> = app.state();
        let map = state.map.lock_or_recover();
        map.get(label)
            .and_then(|panes| panes.get(PRIMARY_PANE_ID))
            .and_then(|i| {
                i.cwd
                    .as_ref()
                    .map(|cwd| (i.mode, i.chat_agent, cwd.to_string_lossy().to_string()))
            })
    };
    let Some((mode, chat_agent, cwd)) = target else {
        return;
    };
    let identifier = &app.config().identifier;
    let mut ws = read_workspace(identifier);
    // Remove a SINGLE matching entry: duplicate windows must restore independently.
    if let Some(idx) = ws
        .windows
        .iter()
        .position(|w| w.mode == mode && w.chat_agent == chat_agent && w.cwd == cwd)
    {
        ws.windows.remove(idx);
        write_workspace(identifier, &ws);
    }
}

/// Hand the calling webview its active workspace target so it can skip Home and
/// hydrate the existing daemon session. Unlike the old consume-once target, this
/// remains available across React remounts and WebKit content-process reloads.
#[tauri::command]
pub(crate) fn window_restore_target(webview: WebviewWindow) -> Option<RestoreEntry> {
    let state: State<RestoreTargets> = webview.state();
    let map = state.map.lock_or_recover();
    restore_target(&map, webview.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_for_snapshot_excludes_only_unselected_picker_windows() {
        let default = Path::new("/home/user");
        // Picker session exists at the boot cwd, but no workspace was chosen.
        assert!(!keep_for_snapshot(false, Some(default)));
        assert!(!keep_for_snapshot(false, None));
        // Explicitly choosing that exact directory must still survive restart.
        assert!(keep_for_snapshot(true, Some(default)));
        assert!(keep_for_snapshot(true, Some(Path::new("/home/user/proj"))));
    }

    #[test]
    fn filter_restorable_drops_missing_and_empty() {
        let windows = vec![
            WorkspaceEntry {
                cwd: "/exists/a".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "   ".into(),
                ..Default::default()
            },
            WorkspaceEntry {
                cwd: "/gone/b".into(),
                ..Default::default()
            },
        ];
        let kept = filter_restorable(windows, |c| c == "/exists/a");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].cwd, "/exists/a");
    }

    #[test]
    fn workspace_roundtrips_through_json() {
        let ws = Workspace {
            windows: vec![
                WorkspaceEntry {
                    mode: WorkspaceMode::Chat,
                    chat_agent: ChatAgent::Research,
                    cwd: "/p/a".into(),
                    session_path: Some("/s/a.jsonl".into()),
                    x: Some(0),
                    y: Some(25),
                    width: Some(1280),
                    height: Some(800),
                },
                WorkspaceEntry {
                    cwd: "/p/b".into(),
                    ..Default::default()
                },
            ],
        };
        let json = serde_json::to_string(&ws).unwrap();
        let back: Workspace = serde_json::from_str(&json).unwrap();
        assert_eq!(ws, back);
        assert_eq!(back.windows[0].mode, WorkspaceMode::Chat);
        assert_eq!(back.windows[0].chat_agent, ChatAgent::Research);
        assert!(json.contains(r#""mode":"chat""#));
        assert!(json.contains(r#""chatAgent":"research""#));
        // The second entry omits optional fields entirely (skip_serializing_if).
        assert!(!json.contains("\"sessionPath\":null"));
    }

    #[test]
    fn workspace_defaults_legacy_and_invalid_modes_to_code() {
        let legacy: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "cwd": "/p/a" }] }"#).unwrap();
        assert_eq!(legacy.windows[0].mode, WorkspaceMode::Code);
        assert_eq!(legacy.windows[0].chat_agent, ChatAgent::General);

        let invalid: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "future", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(invalid.windows[0].mode, WorkspaceMode::Code);
    }

    #[test]
    fn workspace_restores_motion_mode() {
        let motion: Workspace =
            serde_json::from_str(r#"{ "windows": [{ "mode": "motion", "cwd": "/p/a" }] }"#)
                .unwrap();
        assert_eq!(motion.windows[0].mode, WorkspaceMode::Motion);
        assert!(serde_json::to_string(&motion)
            .unwrap()
            .contains(r#""mode":"motion""#));
    }

    #[test]
    fn restore_target_serializes_mode_and_session_path() {
        let target = RestoreEntry {
            mode: WorkspaceMode::Chat,
            chat_agent: ChatAgent::Therapist,
            cwd: "/p/a".into(),
            session_path: Some("/s/a.jsonl".into()),
        };
        let json = serde_json::to_value(target).unwrap();
        assert_eq!(json["mode"], "chat");
        assert_eq!(json["chatAgent"], "therapist");
        assert_eq!(json["cwd"], "/p/a");
        assert_eq!(json["sessionPath"], "/s/a.jsonl");
    }

    #[test]
    fn empty_or_missing_workspace_is_default() {
        let ws: Workspace = serde_json::from_str("{}").unwrap();
        assert!(ws.windows.is_empty());
    }

    #[test]
    fn project_root_write_preserves_unrelated_app_settings() {
        let home = identity_bootstrap_test_home("app-settings-merge");
        std::fs::create_dir_all(&home).unwrap();
        let path = home.join("gg-app.json");
        std::fs::write(
            &path,
            r#"{"projectsRoot":"old","projectRoots":["extra"],"hiddenProjects":["hidden"],"autopilot":true,"future":{"keep":1}}"#,
        )
        .unwrap();

        write_projects_root(&path, r"C:\ggcoder-projects").unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["projectsRoot"], r"C:\ggcoder-projects");
        assert_eq!(saved["projectRoots"], serde_json::json!(["extra"]));
        assert_eq!(saved["hiddenProjects"], serde_json::json!(["hidden"]));
        assert_eq!(saved["autopilot"], true);
        assert_eq!(saved["future"], serde_json::json!({ "keep": 1 }));
        std::fs::remove_dir_all(home).unwrap();
    }
}
