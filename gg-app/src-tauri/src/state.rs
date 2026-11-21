//! Tauri-managed shared state: the daemon handle, window↔session map, restore targets.

use crate::*;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DaemonProcessIdentity {
    pub(crate) daemon_instance_id: String,
    pub(crate) process_id: u32,
    pub(crate) process_start_token: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DaemonPredecessorProof {
    pub(crate) daemon_instance_id: String,
    pub(crate) process_id: u32,
    pub(crate) process_start_token: String,
    pub(crate) terminated_at: String,
}

impl DaemonPredecessorProof {
    pub(crate) fn from_terminated(identity: DaemonProcessIdentity) -> Self {
        Self {
            daemon_instance_id: identity.daemon_instance_id,
            process_id: identity.process_id,
            process_start_token: identity.process_start_token,
            terminated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// The single shared Node daemon process. Every window's `AgentSession` lives
/// inside this one process as an in-process object, addressed by a session id
/// (see `Windows`). Replaces the old one-sidecar-process-per-window model: one
/// Node runtime + one module graph for all windows, instead of N.
#[derive(Default)]
pub(crate) struct Daemon {
    /// The daemon child process (process-group leader). `None` until spawned.
    pub(crate) child: Mutex<Option<Child>>,
    /// High-entropy bootstrap credential used only to mint logical sessions.
    /// It never crosses the native IPC boundary into the webview.
    pub(crate) auth_token: Mutex<Option<String>>,
    /// The daemon's HTTP port, learned from its `GG_APP_LISTENING` handshake.
    /// `None` until ready; reset to `None` across a crash-respawn.
    pub(crate) port: Mutex<Option<u16>>,
    /// Consecutive short-lived crashes. A daemon that stays up for the stable
    /// window resets this budget; repeated crashes hit a circuit breaker.
    pub(crate) respawn_attempts: Mutex<u32>,
    /// Monotonic successful-spawn counter used to await a completed refresh.
    pub(crate) generation: AtomicU64,
    /// Distinguishes a requested configuration refresh from a process crash.
    pub(crate) planned_reload: AtomicBool,
    /// Window labels awaiting a complete pane recovery before model refresh.
    pub(crate) model_refresh_windows: Mutex<HashSet<String>>,
    /// Exact native-supervised process identity currently holding Roadmap leases.
    pub(crate) process_identity: Mutex<Option<DaemonProcessIdentity>>,
    /// Proof that the immediately preceding daemon was reaped before respawn.
    pub(crate) predecessor_proof: Mutex<Option<DaemonPredecessorProof>>,
    /// Why the daemon is down for good (spawn failure or crash circuit breaker).
    /// Session starts fail fast with this instead of waiting for a port that
    /// will never arrive; `retry_window_session` clears it and respawns.
    pub(crate) failure: Mutex<Option<String>>,
    /// The latest `GG_APP_FATAL` reason. A single crash is retried silently;
    /// this only surfaces if the crash loop exhausts its respawn budget.
    pub(crate) last_fatal: Mutex<Option<String>>,
    /// Per-launch bearer token required as `x-gg-token` on every daemon request.
    pub(crate) token: String,
    /// Kill-on-close job holding the current daemon and every descendant.
    /// Replacing or dropping it terminates leftovers of that daemon generation.
    #[cfg(windows)]
    pub(crate) job: Mutex<Option<daemon_job::DaemonJob>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceMode {
    Chat,
    Motion,
    #[default]
    #[serde(other)]
    Code,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatAgent {
    Therapist,
    Research,
    #[default]
    #[serde(other)]
    General,
}

pub(crate) const PRIMARY_PANE_ID: &str = "primary";

pub(crate) const MAX_PANE_ID_LEN: usize = 64;

pub(crate) const MAX_AGENT_PANES_PER_WINDOW: usize = 12;

/// One logical pane's session inside the shared daemon.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaneSession {
    pub(crate) session_id: Option<String>,
    pub(crate) mode: WorkspaceMode,
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) session_path: Option<String>,
    pub(crate) generation: u64,
    /// Why the current generation's session start failed. `sidecar_port`
    /// reports it so the webview shows the real cause instead of timing out.
    pub(crate) startup_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct PaneRegistry {
    pub(crate) windows: HashMap<String, HashMap<String, PaneSession>>,
    pub(crate) next_generation: u64,
}

impl std::ops::Deref for PaneRegistry {
    type Target = HashMap<String, HashMap<String, PaneSession>>;

    fn deref(&self) -> &Self::Target {
        &self.windows
    }
}

impl std::ops::DerefMut for PaneRegistry {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.windows
    }
}

/// Pane registry keyed by native owner window then validated logical pane ID.
#[derive(Default)]
pub(crate) struct Windows {
    pub(crate) map: Mutex<PaneRegistry>,
}

pub(crate) fn validate_pane_id(pane_id: &str) -> Result<(), String> {
    if pane_id.is_empty() || pane_id.len() > MAX_PANE_ID_LEN {
        return Err("pane id must contain 1-64 characters".into());
    }
    if !pane_id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("pane id contains unsupported characters".into());
    }
    Ok(())
}

pub(crate) fn resolve_owned_pane<'a>(
    registry: &'a PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Option<&'a PaneSession> {
    registry.get(owner_label)?.get(pane_id)
}

pub(crate) fn record_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> u64 {
    registry.next_generation = registry.next_generation.saturating_add(1);
    let generation = registry.next_generation;
    registry.entry(owner_label.to_string()).or_default().insert(
        pane_id.to_string(),
        PaneSession {
            session_id: None,
            mode,
            chat_agent,
            cwd: Some(cwd),
            session_path,
            generation,
            startup_error: None,
        },
    );
    generation
}

pub(crate) fn create_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> Result<u64, String> {
    validate_pane_id(pane_id)?;
    let panes = registry.get(owner_label);
    if panes.is_some_and(|panes| panes.contains_key(pane_id)) {
        return Err(format!("pane '{pane_id}' already exists"));
    }
    if panes.is_some_and(|panes| panes.len() >= MAX_AGENT_PANES_PER_WINDOW) {
        return Err(format!(
            "window cannot contain more than {MAX_AGENT_PANES_PER_WINDOW} agent panes"
        ));
    }
    Ok(record_pane_target(
        registry,
        owner_label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
    ))
}

pub(crate) fn restore_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> Result<(u64, bool, Option<String>), String> {
    validate_pane_id(pane_id)?;
    if let Some(existing) = registry
        .get(owner_label)
        .and_then(|panes| panes.get(pane_id))
    {
        let target_changed = existing.mode != mode
            || existing.chat_agent != chat_agent
            || existing.cwd.as_ref() != Some(&cwd)
            || existing.session_path != session_path;
        let should_relaunch =
            target_changed || existing.session_id.is_none() || existing.startup_error.is_some();
        if !should_relaunch {
            return Ok((existing.generation, false, None));
        }

        registry.next_generation = registry.next_generation.saturating_add(1);
        let generation = registry.next_generation;
        let existing = registry
            .get_mut(owner_label)
            .and_then(|panes| panes.get_mut(pane_id))
            .expect("pane existence checked");
        let replaced_session_id = existing.session_id.take();
        existing.mode = mode;
        existing.chat_agent = chat_agent;
        existing.cwd = Some(cwd);
        existing.session_path = session_path;
        existing.generation = generation;
        existing.startup_error = None;
        return Ok((generation, true, replaced_session_id));
    }
    create_pane_target(
        registry,
        owner_label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
    )
    .map(|generation| (generation, true, None))
}

pub(crate) fn take_pane_session(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Option<PaneSession> {
    let panes = registry.get_mut(owner_label)?;
    let pane = panes.remove(pane_id);
    if panes.is_empty() {
        registry.remove(owner_label);
    }
    pane
}

pub(crate) fn pane_disposal_target(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    allow_primary: bool,
    expected_generation: Option<u64>,
) -> Result<PaneSession, String> {
    validate_pane_id(pane_id)?;
    if pane_id == PRIMARY_PANE_ID && !allow_primary {
        return Err("primary pane cannot be disposed".into());
    }
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))?;
    if expected_generation.is_some_and(|generation| pane.generation != generation) {
        return Err(format!("pane '{pane_id}' generation is stale"));
    }
    Ok(pane.clone())
}

pub(crate) fn dispose_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    allow_primary: bool,
    expected_generation: Option<u64>,
) -> Result<PaneSession, String> {
    pane_disposal_target(
        registry,
        owner_label,
        pane_id,
        allow_primary,
        expected_generation,
    )?;
    take_pane_session(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))
}

pub(crate) fn complete_pane_disposal(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    deletion_result: Result<(), String>,
) -> Result<(), String> {
    deletion_result?;
    dispose_pane_target(registry, owner_label, pane_id, false, Some(generation)).map(|_| ())
}

#[cfg(test)]
pub(crate) fn bind_pane_session(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: String,
) -> bool {
    bind_pane_session_with_path(registry, owner_label, pane_id, generation, session_id, None)
}

/// Bind a pane's session and record the conversation file the daemon opened, so
/// a daemon respawn reopens it instead of starting fresh (a new session has no
/// path until the daemon reports one).
pub(crate) fn bind_pane_session_with_path(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: String,
    opened_path: Option<String>,
) -> bool {
    let Some(pane) = registry
        .get_mut(owner_label)
        .and_then(|panes| panes.get_mut(pane_id))
    else {
        return false;
    };
    if pane.generation != generation || pane.session_id.is_some() {
        return false;
    }
    pane.session_id = Some(session_id);
    pane.startup_error = None;
    if opened_path.is_some() {
        pane.session_path = opened_path;
    }
    true
}

pub(crate) fn record_pane_startup_error(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    message: String,
) -> bool {
    let Some(pane) = registry
        .get_mut(owner_label)
        .and_then(|panes| panes.get_mut(pane_id))
    else {
        return false;
    };
    if pane.generation != generation || pane.session_id.is_some() {
        return false;
    }
    pane.startup_error = Some(message);
    true
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneStartupStatus {
    pub(crate) ready: bool,
    pub(crate) error: Option<String>,
    pub(crate) generation: u64,
    pub(crate) session_id: Option<String>,
}

pub(crate) type PaneStartupCompletion = tokio::sync::oneshot::Receiver<Result<(), String>>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PaneStartupOutcome {
    Ready { port: u16, session_id: String },
    Failed(String),
    Superseded,
}

pub(crate) fn pane_startup_status(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Result<PaneStartupStatus, String> {
    validate_pane_id(pane_id)?;
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))?;
    Ok(PaneStartupStatus {
        ready: pane.startup_error.is_none() && pane.session_id.is_some(),
        error: pane.startup_error.clone(),
        generation: pane.generation,
        session_id: pane.session_id.clone(),
    })
}

pub(crate) fn take_window_panes(
    registry: &mut PaneRegistry,
    owner_label: &str,
) -> Vec<PaneSession> {
    registry
        .remove(owner_label)
        .map(|panes| panes.into_values().collect())
        .unwrap_or_default()
}

pub(crate) type RecoveryTarget = (
    String,
    String,
    WorkspaceMode,
    ChatAgent,
    PathBuf,
    Option<String>,
    u64,
);

pub(crate) fn recovery_targets(registry: &PaneRegistry) -> Vec<RecoveryTarget> {
    registry
        .iter()
        .flat_map(|(label, panes)| {
            panes.iter().filter_map(move |(pane_id, pane)| {
                pane.cwd.clone().map(|cwd| {
                    (
                        label.clone(),
                        pane_id.clone(),
                        pane.mode,
                        pane.chat_agent,
                        cwd,
                        pane.session_path.clone(),
                        pane.generation,
                    )
                })
            })
        })
        .collect()
}

pub(crate) fn pane_identity_is_current(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: &str,
) -> bool {
    resolve_owned_pane(registry, owner_label, pane_id).is_some_and(|pane| {
        pane.generation == generation && pane.session_id.as_deref() == Some(session_id)
    })
}

/// True once the app has begun quitting. Set on `ExitRequested` so the cascade
/// of per-window `Destroyed` events during shutdown does NOT prune the workspace
/// snapshot — the last full snapshot is what we restore next launch.
#[derive(Default)]
pub(crate) struct AppExiting(pub(crate) AtomicBool);

/// One window's active target (mode, cwd, and optional session), returned by
/// `window_restore_target` so the webview can recover without showing Home.
#[derive(Clone, serde::Serialize)]
pub(crate) struct RestoreEntry {
    pub(crate) mode: WorkspaceMode,
    #[serde(rename = "chatAgent")]
    pub(crate) chat_agent: ChatAgent,
    pub(crate) cwd: String,
    #[serde(rename = "sessionPath")]
    pub(crate) session_path: Option<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct DroppedPathInfo {
    pub(crate) path: String,
    #[serde(rename = "isDir")]
    pub(crate) is_dir: bool,
}

/// OS-level permission status shown in the Settings modal's "Grant
/// Permissions" row. Only macOS has anything to grant today (Full Disk
/// Access — needed because the subagent tool spawns a fresh `ggnode` process
/// per call, which re-triggers macOS's per-folder privacy prompts under
/// Desktop/Documents/Downloads/iCloud). Windows/Linux report
/// `applicable: false` so the webview hides the row entirely instead of
/// showing a badge for a permission that doesn't exist there.
#[derive(serde::Serialize)]
pub(crate) struct PermissionsStatus {
    pub(crate) applicable: bool,
    pub(crate) granted: bool,
}

/// Per-window active workspace targets. An entry exists only after the user has
/// chosen a workspace (or when one was restored at boot). Targets stay available
/// for the lifetime of the window so a WebKit content-process reload can recover
/// the same workspace instead of falling back to Home.
#[derive(Default)]
pub(crate) struct RestoreTargets {
    pub(crate) map: Mutex<HashMap<String, RestoreEntry>>,
}

#[derive(Clone)]
pub(crate) struct PaneCopyOperation {
    pub(crate) source_owner: String,
    pub(crate) target_label: String,
    pub(crate) restore: RestoreEntry,
    pub(crate) cloned_session_path: Option<PathBuf>,
    pub(crate) started: bool,
}

#[derive(Default)]
pub(crate) struct PaneCopyRegistry {
    pub(crate) operations: HashMap<(String, String), PaneCopyOperation>,
    pub(crate) target_owners: HashMap<String, (String, String)>,
    pub(crate) rolling_back: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct PaneCopies {
    pub(crate) map: Mutex<PaneCopyRegistry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedPaneCopy {
    pub(crate) copy_id: String,
    pub(crate) window_label: String,
    pub(crate) reused_window: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneCopyResult {
    pub(crate) window_label: String,
    pub(crate) reused_window: bool,
}

pub(crate) fn remove_copy_operation(
    registry: &mut PaneCopyRegistry,
    source_owner: &str,
    copy_id: &str,
) -> Option<PaneCopyOperation> {
    let key = (source_owner.to_string(), copy_id.to_string());
    let operation = registry.operations.remove(&key)?;
    registry.target_owners.remove(&operation.target_label);
    Some(operation)
}

pub(crate) fn consume_copy_restore_target(
    copies: &PaneCopyRegistry,
    targets: &mut HashMap<String, RestoreEntry>,
    target_label: &str,
) -> Option<RestoreEntry> {
    copies.target_owners.get(target_label)?;
    remove_restore_target(targets, target_label)
}

pub(crate) fn register_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: String,
    entry: RestoreEntry,
) {
    targets.insert(label, entry);
}

pub(crate) fn register_selected_primary_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: &str,
    pane_id: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: &str,
    session_path: Option<&str>,
) -> bool {
    if pane_id != PRIMARY_PANE_ID {
        return false;
    }
    register_restore_target(
        targets,
        label.to_string(),
        RestoreEntry {
            mode,
            chat_agent,
            cwd: cwd.to_string(),
            session_path: session_path.map(str::to_string),
        },
    );
    true
}

pub(crate) fn restore_target(
    targets: &HashMap<String, RestoreEntry>,
    label: &str,
) -> Option<RestoreEntry> {
    targets.get(label).cloned()
}

pub(crate) fn remove_restore_target(
    targets: &mut HashMap<String, RestoreEntry>,
    label: &str,
) -> Option<RestoreEntry> {
    targets.remove(label)
}

/// The label of the currently-focused window, updated on `Focused` window
/// events. `broadcast_window_order` reads this so every window knows which one
/// is active (and `focus_window_by_offset` cycles from here).
#[derive(Default)]
pub(crate) struct FocusedWindow(pub(crate) Mutex<Option<String>>);

/// Debounce token for `Moved` window events: the `Instant` of the last move.
/// Only the deferred task whose captured `Instant` still matches the stored one
/// fires the broadcast — earlier moves are superseded.
#[derive(Default)]
pub(crate) struct MoveDebounce(pub(crate) Mutex<Option<std::time::Instant>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_restart_proof_preserves_exact_terminated_identity() {
        let identity = DaemonProcessIdentity {
            daemon_instance_id: "daemon-a".into(),
            process_id: 42,
            process_start_token: "start-a".into(),
        };
        let proof = DaemonPredecessorProof::from_terminated(identity);
        let value = serde_json::to_value(proof).unwrap();
        assert_eq!(value["daemonInstanceId"], "daemon-a");
        assert_eq!(value["processId"], 42);
        assert_eq!(value["processStartToken"], "start-a");
        assert!(
            chrono::DateTime::parse_from_rfc3339(value["terminatedAt"].as_str().unwrap()).is_ok()
        );
    }

    #[test]
    fn selected_primary_restore_target_makes_window_snapshot_eligible() {
        let mut targets = HashMap::new();
        assert!(register_selected_primary_restore_target(
            &mut targets,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Chat,
            ChatAgent::Research,
            "/project",
            Some("/sessions/one.jsonl"),
        ));

        let target = restore_target(&targets, "main").expect("primary target registered");
        assert_eq!(target.mode, WorkspaceMode::Chat);
        assert_eq!(target.chat_agent, ChatAgent::Research);
        assert_eq!(target.cwd, "/project");
        assert_eq!(target.session_path.as_deref(), Some("/sessions/one.jsonl"));
        assert!(keep_for_snapshot(
            targets.contains_key("main"),
            Some(Path::new(&target.cwd)),
        ));
    }

    #[test]
    fn selected_non_primary_restore_target_does_not_change_window_persistence() {
        let existing = RestoreEntry {
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: "/existing".into(),
            session_path: None,
        };
        let mut targets = HashMap::from([("main".to_string(), existing)]);

        assert!(!register_selected_primary_restore_target(
            &mut targets,
            "main",
            "secondary",
            WorkspaceMode::Chat,
            ChatAgent::Research,
            "/secondary",
            Some("/sessions/secondary.jsonl"),
        ));

        let target = restore_target(&targets, "main").expect("existing target preserved");
        assert_eq!(target.cwd, "/existing");
        assert_eq!(target.mode, WorkspaceMode::Code);
        assert_eq!(target.chat_agent, ChatAgent::General);
        assert!(target.session_path.is_none());
    }

    #[test]
    fn restoring_a_concrete_session_replaces_a_fresh_runtime() {
        let mut registry = PaneRegistry::default();
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("project"),
            None,
        );
        let pane = registry
            .get_mut("main")
            .and_then(|panes| panes.get_mut(PRIMARY_PANE_ID))
            .unwrap();
        pane.session_id = Some("fresh-runtime".to_string());

        let (generation, should_launch, replaced) = restore_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("project"),
            Some("saved-session.jsonl".to_string()),
        )
        .unwrap();
        assert!(should_launch);
        assert_eq!(replaced.as_deref(), Some("fresh-runtime"));
        let restored = &registry["main"][PRIMARY_PANE_ID];
        assert_eq!(restored.generation, generation);
        assert_eq!(
            restored.session_path.as_deref(),
            Some("saved-session.jsonl")
        );
        assert!(restored.session_id.is_none());
    }

    #[test]
    fn local_file_pane_cwds_distinguish_identical_relative_paths() {
        let home = identity_bootstrap_test_home("pane-local-files");
        let mut registry = PaneRegistry::default();
        for (pane_id, directory) in [("primary", "one"), ("secondary", "two")] {
            let cwd = home.join(directory);
            std::fs::create_dir_all(&cwd).unwrap();
            std::fs::write(cwd.join("same.md"), directory).unwrap();
            add_pane(&mut registry, "main", pane_id, cwd.to_str().unwrap());
        }
        for (pane_id, expected) in [("primary", "one"), ("secondary", "two")] {
            let cwd = resolve_owned_pane(&registry, "main", pane_id)
                .unwrap()
                .cwd
                .as_ref()
                .unwrap();
            assert_eq!(
                std::fs::read_to_string(cwd.join("same.md")).unwrap(),
                expected
            );
            assert!(resolve_owned_pane(&registry, "other-window", pane_id).is_none());
        }
        assert!(resolve_owned_pane(&registry, "main", "missing").is_none());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn arbitrary_panes_in_one_window_are_independent() {
        let mut registry = PaneRegistry::default();
        let left = add_pane(&mut registry, "main", "left", "/left");
        let right = add_pane(&mut registry, "main", "right", "/right");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "left",
            left,
            "sid-left".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "right",
            right,
            "sid-right".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "left")
                .unwrap()
                .session_id
                .as_deref(),
            Some("sid-left")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "main", "right")
                .unwrap()
                .session_id
                .as_deref(),
            Some("sid-right")
        );
    }

    #[test]
    fn same_pane_ids_in_different_windows_do_not_collide() {
        let mut registry = PaneRegistry::default();
        let first = add_pane(&mut registry, "main", "chat", "/one");
        let second = add_pane(&mut registry, "project-1", "chat", "/two");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            first,
            "one".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "project-1",
            "chat",
            second,
            "two".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "project-1", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("two")
        );
    }

    #[test]
    fn stale_create_or_select_bind_cannot_overwrite_newer_generation() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");
        assert!(!bind_pane_session(
            &mut registry,
            "main",
            "chat",
            stale,
            "stale".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            current,
            "current".into()
        ));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .session_id
                .as_deref(),
            Some("current")
        );
    }

    #[test]
    fn pane_selection_waits_for_delayed_daemon_success_and_exact_generation_bind() {
        tauri::async_runtime::block_on(async {
            let mut initial_registry = PaneRegistry::default();
            let generation = add_pane(&mut initial_registry, "main", "chat", "/project");
            let registry = std::sync::Arc::new(Mutex::new(initial_registry));
            let bind_registry = registry.clone();
            let error_registry = registry.clone();
            let deleted = std::sync::Arc::new(Mutex::new(Vec::new()));
            let deleted_for_startup = deleted.clone();
            let (daemon_tx, daemon_rx) = tokio::sync::oneshot::channel();
            let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
            let startup = tauri::async_runtime::spawn(orchestrate_pane_session_startup(
                "chat",
                generation,
                async move { daemon_rx.await.unwrap() },
                move |session_id| {
                    bind_pane_session(
                        &mut bind_registry.lock_or_recover(),
                        "main",
                        "chat",
                        generation,
                        session_id.to_string(),
                    )
                },
                move |message| {
                    record_pane_startup_error(
                        &mut error_registry.lock_or_recover(),
                        "main",
                        "chat",
                        generation,
                        message.to_string(),
                    )
                },
                move |port, session_id| async move {
                    deleted_for_startup
                        .lock_or_recover()
                        .push((port, session_id));
                },
                completion_tx,
            ));
            let mut selection = Box::pin(settle_pane_selection("chat", generation, completion_rx));

            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut selection)
                    .await
                    .is_err()
            );
            assert!(
                resolve_owned_pane(&registry.lock_or_recover(), "main", "chat")
                    .unwrap()
                    .session_id
                    .is_none()
            );

            daemon_tx
                .send(Ok((321, "exact-session".to_string())))
                .unwrap();
            assert_eq!(selection.await.unwrap(), generation);
            assert_eq!(
                startup.await.unwrap(),
                PaneStartupOutcome::Ready {
                    port: 321,
                    session_id: "exact-session".to_string(),
                }
            );
            assert_eq!(
                resolve_owned_pane(&registry.lock_or_recover(), "main", "chat")
                    .unwrap()
                    .session_id
                    .as_deref(),
                Some("exact-session")
            );
            assert!(deleted.lock_or_recover().is_empty());
        });
    }

    #[test]
    fn pane_selection_reports_daemon_failure_after_recording_startup_error() {
        tauri::async_runtime::block_on(async {
            let mut initial_registry = PaneRegistry::default();
            let generation = add_pane(&mut initial_registry, "main", "chat", "/project");
            let registry = std::sync::Arc::new(Mutex::new(initial_registry));
            let bind_registry = registry.clone();
            let error_registry = registry.clone();
            let deleted = std::sync::Arc::new(Mutex::new(Vec::new()));
            let deleted_for_startup = deleted.clone();
            let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();

            let outcome = orchestrate_pane_session_startup(
                "chat",
                generation,
                std::future::ready(Err("resume failed".to_string())),
                move |session_id| {
                    bind_pane_session(
                        &mut bind_registry.lock_or_recover(),
                        "main",
                        "chat",
                        generation,
                        session_id.to_string(),
                    )
                },
                move |message| {
                    record_pane_startup_error(
                        &mut error_registry.lock_or_recover(),
                        "main",
                        "chat",
                        generation,
                        message.to_string(),
                    )
                },
                move |port, session_id| async move {
                    deleted_for_startup
                        .lock_or_recover()
                        .push((port, session_id));
                },
                completion_tx,
            )
            .await;

            assert_eq!(
                outcome,
                PaneStartupOutcome::Failed("resume failed".to_string())
            );
            assert_eq!(
                settle_pane_selection("chat", generation, completion_rx)
                    .await
                    .unwrap_err(),
                "resume failed"
            );
            assert_eq!(
                resolve_owned_pane(&registry.lock_or_recover(), "main", "chat")
                    .unwrap()
                    .startup_error
                    .as_deref(),
                Some("resume failed")
            );
            assert!(deleted.lock_or_recover().is_empty());
        });
    }

    #[test]
    fn pane_selection_supersedes_stale_generation_and_deletes_created_session() {
        tauri::async_runtime::block_on(async {
            let mut initial_registry = PaneRegistry::default();
            let stale_generation = add_pane(&mut initial_registry, "main", "chat", "/old");
            dispose_pane_target(
                &mut initial_registry,
                "main",
                "chat",
                true,
                Some(stale_generation),
            )
            .unwrap();
            let current_generation = add_pane(&mut initial_registry, "main", "chat", "/new");
            let registry = std::sync::Arc::new(Mutex::new(initial_registry));
            let bind_registry = registry.clone();
            let error_registry = registry.clone();
            let deleted = std::sync::Arc::new(Mutex::new(Vec::new()));
            let deleted_for_startup = deleted.clone();
            let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();

            let outcome = orchestrate_pane_session_startup(
                "chat",
                stale_generation,
                std::future::ready(Ok((654, "stale-session".to_string()))),
                move |session_id| {
                    bind_pane_session(
                        &mut bind_registry.lock_or_recover(),
                        "main",
                        "chat",
                        stale_generation,
                        session_id.to_string(),
                    )
                },
                move |message| {
                    record_pane_startup_error(
                        &mut error_registry.lock_or_recover(),
                        "main",
                        "chat",
                        stale_generation,
                        message.to_string(),
                    )
                },
                move |port, session_id| async move {
                    deleted_for_startup
                        .lock_or_recover()
                        .push((port, session_id));
                },
                completion_tx,
            )
            .await;

            assert_eq!(outcome, PaneStartupOutcome::Superseded);
            assert_eq!(
                settle_pane_selection("chat", stale_generation, completion_rx)
                    .await
                    .unwrap_err(),
                format!("pane 'chat' generation {stale_generation} was superseded during startup")
            );
            assert_eq!(
                deleted.lock_or_recover().as_slice(),
                &[(654, "stale-session".to_string())]
            );
            let registry = registry.lock_or_recover();
            let current = resolve_owned_pane(&registry, "main", "chat").unwrap();
            assert_eq!(current.generation, current_generation);
            assert!(current.session_id.is_none());
            assert!(current.startup_error.is_none());
        });
    }

    #[test]
    fn pane_disposal_success_removes_acknowledged_generation() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/project");
        let target =
            pane_disposal_target(&registry, "main", "chat", false, Some(generation)).unwrap();

        complete_pane_disposal(&mut registry, "main", "chat", target.generation, Ok(())).unwrap();

        assert!(resolve_owned_pane(&registry, "main", "chat").is_none());
    }

    #[test]
    fn pane_disposal_failure_preserves_registry_for_retry() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/project");

        let error = complete_pane_disposal(
            &mut registry,
            "main",
            "chat",
            generation,
            Err("daemon rejected disposal".into()),
        )
        .unwrap_err();

        assert_eq!(error, "daemon rejected disposal");
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            generation
        );
    }

    #[test]
    fn pane_disposal_stale_generation_preserves_replacement() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");

        let error =
            complete_pane_disposal(&mut registry, "main", "chat", stale, Ok(())).unwrap_err();

        assert!(error.contains("generation is stale"));
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            current
        );
    }

    #[test]
    fn generation_mismatched_disposal_cannot_remove_replacement() {
        let mut registry = PaneRegistry::default();
        let stale = add_pane(&mut registry, "main", "chat", "/old");
        dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).unwrap();
        let current = add_pane(&mut registry, "main", "chat", "/new");
        assert!(dispose_pane_target(&mut registry, "main", "chat", true, Some(stale)).is_err());
        assert_eq!(
            resolve_owned_pane(&registry, "main", "chat")
                .unwrap()
                .generation,
            current
        );
    }

    #[test]
    fn window_close_drains_only_its_panes() {
        let mut registry = PaneRegistry::default();
        add_pane(&mut registry, "main", "one", "/one");
        add_pane(&mut registry, "main", "two", "/two");
        add_pane(&mut registry, "peer", "one", "/peer");
        assert_eq!(take_window_panes(&mut registry, "main").len(), 2);
        assert!(registry.get("main").is_none());
        assert!(resolve_owned_pane(&registry, "peer", "one").is_some());
    }

    #[test]
    fn recovery_enumerates_every_pane_target() {
        let mut registry = PaneRegistry::default();
        add_pane(&mut registry, "main", "one", "/one");
        add_pane(&mut registry, "main", "two", "/two");
        add_pane(&mut registry, "peer", "one", "/peer");
        let targets = recovery_targets(&registry);
        let identities: HashSet<_> = targets
            .iter()
            .map(|target| (target.0.as_str(), target.1.as_str()))
            .collect();
        assert_eq!(
            identities,
            HashSet::from([("main", "one"), ("main", "two"), ("peer", "one")])
        );
    }

    #[test]
    fn replacing_secondary_preserves_primary_identity_and_recovery_target() {
        let mut registry = PaneRegistry::default();
        let primary_generation = add_pane(&mut registry, "main", "primary", "/a");
        let secondary_generation = add_pane(&mut registry, "main", "secondary", "/b");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "primary",
            primary_generation,
            "sid-a".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "secondary",
            secondary_generation,
            "sid-b".into()
        ));
        let primary_before = resolve_owned_pane(&registry, "main", "primary")
            .unwrap()
            .clone();

        let (replacement_generation, relaunched, replaced_session_id) = restore_pane_target(
            &mut registry,
            "main",
            "secondary",
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("/c"),
            None,
        )
        .unwrap();
        assert!(relaunched);
        assert_eq!(replaced_session_id.as_deref(), Some("sid-b"));
        assert!(replacement_generation > secondary_generation);
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "secondary",
            replacement_generation,
            "sid-c".into()
        ));

        assert_eq!(
            resolve_owned_pane(&registry, "main", "primary").unwrap(),
            &primary_before
        );
        assert!(pane_identity_is_current(
            &registry,
            "main",
            "primary",
            primary_generation,
            "sid-a"
        ));
        let targets = recovery_targets(&registry);
        let primary_target = targets.iter().find(|target| target.1 == "primary").unwrap();
        let secondary_target = targets
            .iter()
            .find(|target| target.1 == "secondary")
            .unwrap();
        assert_eq!(primary_target.4, PathBuf::from("/a"));
        assert_eq!(primary_target.6, primary_generation);
        assert_eq!(secondary_target.4, PathBuf::from("/c"));
        assert_eq!(secondary_target.6, replacement_generation);
    }

    #[test]
    fn copy_restore_is_destination_scoped_and_consume_once() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies.target_owners.insert("copy-copy-id".into(), key);
        let mut targets = HashMap::from([(
            "copy-copy-id".into(),
            copy_operation("main", "copy-copy-id").restore,
        )]);

        assert!(consume_copy_restore_target(&copies, &mut targets, "main").is_none());
        assert!(consume_copy_restore_target(&copies, &mut targets, "copy-copy-id").is_some());
        assert!(consume_copy_restore_target(&copies, &mut targets, "copy-copy-id").is_none());
    }

    #[test]
    fn copy_rollback_is_source_owner_scoped() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies.target_owners.insert("copy-copy-id".into(), key);

        assert!(remove_copy_operation(&mut copies, "peer", "copy-id").is_none());
        assert!(copies.target_owners.contains_key("copy-copy-id"));
        assert!(remove_copy_operation(&mut copies, "main", "copy-id").is_some());
        assert!(copies.operations.is_empty());
        assert!(copies.target_owners.is_empty());
    }
}
