use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use base64::Engine as _;
use futures_util::StreamExt;
use tauri::{
    Emitter, EventTarget, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

mod terminal;

/// The single shared Node daemon process. Every window's `AgentSession` lives
/// inside this one process as an in-process object, addressed by a session id
/// (see `Windows`). Replaces the old one-sidecar-process-per-window model: one
/// Node runtime + one module graph for all windows, instead of N.
#[derive(Default)]
struct Daemon {
    /// The daemon child process (process-group leader). `None` until spawned.
    child: Mutex<Option<Child>>,
    /// The daemon's HTTP port, learned from its `GG_APP_LISTENING` handshake.
    /// `None` until ready; reset to `None` across a crash-respawn.
    port: Mutex<Option<u16>>,
    /// Persistent daemon-global startup failure, visible to every owned pane.
    startup_error: Mutex<Option<String>>,
}

const PRIMARY_PANE_ID: &str = "primary";
const MAX_PANE_ID_LEN: usize = 64;
const MAX_PANES_PER_WINDOW: usize = 4;

/// One pane's session inside the shared daemon. Pane IDs are scoped by their
/// owning native window; daemon session IDs remain opaque runtime identities.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
struct PaneSession {
    session_id: Option<String>,
    cwd: Option<PathBuf>,
    session_path: Option<String>,
    generation: u64,
    startup_error: Option<String>,
}

#[derive(Default)]
struct PaneRegistry {
    windows: HashMap<String, HashMap<String, PaneSession>>,
    next_generation: u64,
}

impl PaneRegistry {
    #[cfg(test)]
    fn new() -> Self {
        Self::default()
    }
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

/// Per-window pane registry, keyed first by owner window label, then pane ID.
#[derive(Default)]
pub(crate) struct Windows {
    map: Mutex<PaneRegistry>,
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

fn pane_id_or_primary(pane_id: Option<&str>) -> Result<&str, String> {
    let pane_id = pane_id.unwrap_or(PRIMARY_PANE_ID);
    validate_pane_id(pane_id)?;
    Ok(pane_id)
}

fn resolve_owned_pane<'a>(
    registry: &'a PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Option<&'a PaneSession> {
    registry.get(owner_label)?.get(pane_id)
}

pub(crate) fn owned_pane_cwd(
    windows: &Windows,
    owner_label: &str,
    pane_id: &str,
) -> Result<PathBuf, String> {
    let registry = windows
        .map
        .lock()
        .map_err(|_| "pane registry lock poisoned")?;
    resolve_owned_pane(&registry, owner_label, pane_id)
        .and_then(|pane| pane.cwd.clone())
        .ok_or_else(|| "terminal pane is not ready or belongs to another window".into())
}

fn record_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    cwd: PathBuf,
    session_path: Option<String>,
) -> u64 {
    // Keep generation history outside pane entries so disposal + recreation of
    // the same ID cannot let an old async POST /session bind to the new target.
    registry.next_generation = registry.next_generation.saturating_add(1);
    let generation = registry.next_generation;
    let panes = registry.entry(owner_label.to_string()).or_default();
    panes.insert(
        pane_id.to_string(),
        PaneSession {
            session_id: None,
            cwd: Some(cwd),
            session_path,
            generation,
            startup_error: None,
        },
    );
    generation
}

fn create_pane_target(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    cwd: PathBuf,
    session_path: Option<String>,
) -> Result<u64, String> {
    validate_pane_id(pane_id)?;
    let panes = registry.get(owner_label);
    if panes.is_some_and(|panes| panes.contains_key(pane_id)) {
        return Err(format!("pane '{pane_id}' already exists"));
    }
    if panes.is_some_and(|panes| panes.len() >= MAX_PANES_PER_WINDOW) {
        return Err(format!(
            "window cannot contain more than {MAX_PANES_PER_WINDOW} panes"
        ));
    }
    Ok(record_pane_target(
        registry,
        owner_label,
        pane_id,
        cwd,
        session_path,
    ))
}

fn dispose_pane_target(
    registry: &mut PaneRegistry,
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
    take_pane_session(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))
}

fn bind_pane_session(
    registry: &mut PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    generation: u64,
    session_id: String,
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
    true
}

fn record_pane_startup_error(
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
struct PaneStartupStatus {
    ready: bool,
    error: Option<String>,
}

fn pane_startup_status(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    daemon_error: Option<&str>,
) -> Result<PaneStartupStatus, String> {
    validate_pane_id(pane_id)?;
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist"))?;
    let error = daemon_error
        .map(str::to_string)
        .or_else(|| pane.startup_error.clone());
    Ok(PaneStartupStatus {
        ready: error.is_none() && pane.session_id.is_some(),
        error,
    })
}

fn take_pane_session(
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

fn take_window_panes(registry: &mut PaneRegistry, owner_label: &str) -> Vec<PaneSession> {
    registry
        .remove(owner_label)
        .map(|panes| panes.into_values().collect())
        .unwrap_or_default()
}

/// Clear daemon-owned runtime identity after a crash without changing any
/// durable pane target or its generation. Holding the registry lock around this
/// helper makes every old bridge become stale before recovery starts.
fn clear_runtime_session_ids(registry: &mut PaneRegistry) -> usize {
    let mut cleared = 0;
    for pane in registry.values_mut().flat_map(HashMap::values_mut) {
        if pane.session_id.take().is_some() {
            cleared += 1;
        }
    }
    cleared
}

fn enumerate_pane_targets(
    registry: &PaneRegistry,
) -> Vec<(String, String, PathBuf, Option<String>)> {
    registry
        .iter()
        .flat_map(|(label, panes)| {
            panes.iter().filter_map(move |(pane_id, pane)| {
                pane.cwd.clone().map(|cwd| {
                    (
                        label.clone(),
                        pane_id.clone(),
                        cwd,
                        pane.session_path.clone(),
                    )
                })
            })
        })
        .collect()
}

fn pane_bridge_is_active(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
    session_id: &str,
) -> bool {
    resolve_owned_pane(registry, owner_label, pane_id).and_then(|pane| pane.session_id.as_deref())
        == Some(session_id)
}

/// True once the app has begun quitting. Set on `ExitRequested` so the cascade
/// of per-window `Destroyed` events during shutdown does NOT prune the workspace
/// snapshot — the last full snapshot is what we restore next launch.
#[derive(Default)]
struct AppExiting(AtomicBool);

/// One restored window's target (cwd + optional session), handed to the webview
/// once via `window_restore_target` so it skips the project picker on boot.
#[derive(Clone, serde::Serialize)]
struct RestoreEntry {
    cwd: String,
    #[serde(rename = "sessionPath")]
    session_path: Option<String>,
}

#[derive(serde::Serialize)]
struct DroppedPathInfo {
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

/// OS-level permission status shown in the Settings modal's "Grant
/// Permissions" row. Only macOS has anything to grant today (Full Disk
/// Access — needed because the subagent tool spawns a fresh `ggnode` process
/// per call, which re-triggers macOS's per-folder privacy prompts under
/// Desktop/Documents/Downloads/iCloud). Windows/Linux report
/// `applicable: false` so the webview hides the row entirely instead of
/// showing a badge for a permission that doesn't exist there.
#[derive(serde::Serialize)]
struct PermissionsStatus {
    applicable: bool,
    granted: bool,
}

/// Pending per-window restore targets, consumed once by the webview on mount.
#[derive(Default)]
struct RestoreTargets {
    map: Mutex<HashMap<String, RestoreEntry>>,
}

/// The label of the currently-focused window, updated on `Focused` window
/// events. `broadcast_window_order` reads this so every window knows which one
/// is active (and `focus_window_by_offset` cycles from here).
#[derive(Default)]
struct FocusedWindow(Mutex<Option<String>>);

/// Debounce token for `Moved` window events: the `Instant` of the last move.
/// Only the deferred task whose captured `Instant` still matches the stored one
/// fires the broadcast — earlier moves are superseded.
#[derive(Default)]
struct MoveDebounce(Mutex<Option<std::time::Instant>>);

/// Windows-only: per-window last-known minimized state. Used to detect the
/// minimized→restored edge in `Resized` events (on Windows, minimize fires
/// `Resized(0,0)` / `is_minimized()==true`, restore fires `Resized(real)` /
/// `is_minimized()==false`) so that restoring ONE window brings all its
/// siblings back too — matching the macOS dock-reopen behavior. On macOS the
/// OS already restores every window from a single dock click, so the whole
/// `Resized` arm is compiled out there and this state is never populated.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct MinimizeState(Mutex<HashMap<String, bool>>);

/// Windows-only: on the minimized→restored edge of one window, un-minimize
/// every sibling so a single taskbar click brings the whole workspace back
/// (like macOS). Ordinary resizes/drags are ignored — only a true
/// minimized→restored transition triggers the cascade. We pre-mark every
/// window as restored before calling `unminimize()`, so the `Resized` events
/// those calls generate don't re-cascade. No `set_focus()` — un-minimizing
/// siblings must not steal focus from the window the user actually clicked.
#[cfg(target_os = "windows")]
fn restore_sibling_windows(window: &tauri::Window) {
    let app = window.app_handle();
    let label = window.label().to_string();
    let cur = window.is_minimized().unwrap_or(false);
    let state: State<MinimizeState> = app.state();
    // Act only on an actual minimized (prev) → restored (cur == false) edge.
    let cascade = {
        let mut map = state.0.lock().unwrap();
        let prev = map.get(&label).copied().unwrap_or(false);
        map.insert(label.clone(), cur);
        prev && !cur
    };
    if !cascade {
        return;
    }
    // Collect siblings AND pre-mark every window restored, holding the lock only
    // briefly — never across a window call. `unminimize()` on Windows can
    // synchronously re-enter this handler (ShowWindow dispatches WM_SIZE), so a
    // lock held across it would deadlock the (non-reentrant) mutex. Pre-marking
    // makes any such re-entrant call read prev == false and skip the cascade.
    let siblings: Vec<WebviewWindow> = {
        let mut map = state.0.lock().unwrap();
        let mut out = Vec::new();
        for (sib_label, win) in app.webview_windows() {
            map.insert(sib_label.clone(), false);
            if sib_label != label {
                out.push(win);
            }
        }
        out
    };
    for win in siblings {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
    }
}

/// App-wide guard for the local-patched source update workflow. It rebuilds the
/// app installer from the source checkout, so only one run should mutate/build at
/// a time even when multiple project windows are open.
#[derive(Default)]
struct LocalPatchedUpdate {
    running: Mutex<bool>,
}

fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Gracefully terminate a sidecar child AND its entire process tree so MCP/LSP
/// children (spawned without `detached`, so they share the sidecar's process
/// group) die with it — no orphans on window-close/project-switch/quit.
///
/// On Unix the daemon is spawned as a process-group leader (see
/// `spawn_daemon`), so sending signals to `-pid` (negative pid =
/// the whole group) reaps every descendant in one shot. We SIGTERM the group so
/// the sidecar's SIGTERM handler can run `session.dispose()`, poll `try_wait()`
/// for up to ~3s, then SIGKILL the group and `wait()` to reap the direct child
/// (std `Child` never auto-reaps).
///
/// On Windows there is no process-group kill, so we tree-kill via
/// `taskkill /T /F` (kills the descendant tree), then `wait()` to reap.
fn terminate_child(mut child: Child) {
    let pid = child.id() as i32;
    #[cfg(unix)]
    unsafe {
        // Negative pid = signal the entire process group. The sidecar is its
        // own group leader (pgid == sidecar pid), so this reaches every
        // non-detached descendant (MCP stdio children, LSP servers).
        libc::kill(-pid, libc::SIGTERM);
    }
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Grace period expired — force-kill the whole group.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            // Tree-kill on Windows: /T kills the descendant tree, /F forces it.
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            // Fall back to direct kill if taskkill is unavailable.
            let _ = child.kill();
        }
        let _ = child.wait(); // reap the direct child (avoid zombie)
    });
}

// ── Startup orphan sweeper ─────────────────────────────────────────────────
// When the app is force-quit, crashes, or is killed during a dev run, the
// sidecar process tree (Node sidecar + MCP stdio children + LSP servers) is
// orphaned — reparented to init (pid 1) or an orphan-reaper. Rust only kills
// the direct sidecar PID, so children survive. Without a startup sweep these
// accumulate forever. We run once at the top of `.setup`, before new sidecars
// are spawned.
//
// Cross-platform: the pure classifier (`orphan_killset`) is OS-agnostic; only
// the process-table snapshot and the force-kill primitive differ between
// Unix (`ps` + `libc::kill`) and Windows (PowerShell CIM + `taskkill`).

/// One process row from the OS process table (pid, parent pid, process-group
/// id, full command). `pgid` is 0 on platforms without process groups
/// (Windows) — it's only consulted on Unix, where the sidecar is spawned as a
/// group leader (`process_group(0)`) so every non-detached descendant inherits
/// `pgid == sidecar_pid`. That inherited pgid survives the sidecar's death (the
/// children reparent to init but keep their group id), which is what lets the
/// sweep recognise a crashed sidecar's MCP/LSP children by lineage instead of
/// by a hardcoded name whitelist.
struct ProcInfo {
    pid: i32,
    ppid: i32,
    pgid: i32,
    command: String,
}

/// Command substrings that identify a GG Coder *sidecar* process itself.
/// `app-sidecar` matches both bundled `app-sidecar.mjs` and dev
/// `app-sidecar.js`. This is our OWN binary name (fully under our control, not
/// a third-party MCP name), so it's a safe, stable anchor. MCP children are NOT
/// matched by name — there are thousands of possible MCP servers and users can
/// add any of them — they're recognised structurally instead (descendant walk +
/// process-group lineage; see `orphan_killset`).
const SIDECAR_COMMAND_PATTERNS: &[&str] = &["app-sidecar"];

/// Pure (no I/O): given a process-table snapshot, the current app's pid, and the
/// set of process-group ids belonging to sidecars we have ever spawned (the
/// ledger — see `read_sidecar_ledger`), return the orphaned sidecar-tree PIDs to
/// SIGKILL.
///
/// A sidecar-tree member is killed when ANY of these hold and it isn't self:
///
/// 1. **Orphaned sidecar** — command matches `SIDECAR_COMMAND_PATTERNS` and its
///    parent is dead (`ppid == 1` or `ppid` absent from the snapshot).
/// 2. **Descendant of an orphaned sidecar** — transitively reachable via the
///    ppid tree from a (1) root. Catches MCP/LSP children still linked to a
///    freshly-dead sidecar that's still in this snapshot.
/// 3. **Process-group lineage (name-agnostic)** — the process's `pgid` is a
///    ledgered sidecar group whose *leader is dead* (no live process has
///    `pid == pgid`). This is the key case: after a crash/force-quit the sidecar
///    is long gone and its MCP children have reparented to init, but they keep
///    the sidecar's pgid. Any MCP server, of any name the user added, is caught
///    here — no whitelist. PID-recycle-safe: a group whose leader is alive is
///    skipped entirely (either a still-live sidecar, whose children we must NOT
///    kill, or an unrelated process that recycled the pid).
///
/// The current app pid and its live sidecars are never matched — a live
/// sidecar's parent is the still-running `gg-app`, so its `ppid` is alive, and
/// its group leader is alive so lineage skips it.
fn orphan_killset(snapshot: &[ProcInfo], self_pid: i32, ledger_pgids: &HashSet<i32>) -> Vec<i32> {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let mut parent_children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in snapshot {
        parent_children.entry(p.ppid).or_default().push(p.pid);
    }

    let matches_sidecar = |cmd: &str| SIDECAR_COMMAND_PATTERNS.iter().any(|pat| cmd.contains(pat));
    let parent_dead = |ppid: i32| ppid == 1 || !live_pids.contains(&ppid);

    // The subset of ledgered sidecar groups whose LEADER is dead. A group whose
    // leader (pid == pgid) is still alive is skipped: it's either a live sidecar
    // (its children are in use) or an unrelated process that recycled the pid.
    let dead_leader_groups: HashSet<i32> = ledger_pgids
        .iter()
        .copied()
        .filter(|&g| g > 1 && !live_pids.contains(&g))
        .collect();

    let mut killset: HashSet<i32> = HashSet::new();

    // (1) Orphaned sidecars + (3) process-group lineage. Both are single-pass
    // over the snapshot.
    for p in snapshot {
        if p.pid == self_pid {
            continue;
        }
        let orphaned_sidecar = matches_sidecar(&p.command) && parent_dead(p.ppid);
        let orphaned_group_member = p.pgid > 1 && dead_leader_groups.contains(&p.pgid);
        if orphaned_sidecar || orphaned_group_member {
            killset.insert(p.pid);
        }
    }

    // (2) Descendants: transitively collect children of each root via the map.
    // Catches freshly-orphaned MCP/LSP trees still linked to a dead sidecar
    // that remains in this snapshot (its pgid leader still "alive").
    let mut stack: Vec<i32> = killset.iter().copied().collect();
    while let Some(parent) = stack.pop() {
        if let Some(children) = parent_children.get(&parent) {
            for &child in children {
                if child != self_pid && killset.insert(child) {
                    stack.push(child);
                }
            }
        }
    }

    let mut result: Vec<i32> = killset.into_iter().collect();
    result.sort_unstable();
    result
}

/// Pure parser for `ps -eo pid=,ppid=,pgid=,command=` output (one row per
/// line). Column padding (multiple spaces) is collapsed by `split_whitespace`.
/// Available on all platforms so the parsing can be unit-tested.
fn parse_ps_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: i32 = parts.next()?.parse().ok()?;
            let ppid: i32 = parts.next()?.parse().ok()?;
            let pgid: i32 = parts.next()?.parse().ok()?;
            // The rest of the line is the full command (may contain spaces).
            // Pattern matching uses .contains(), so rejoining with single
            // spaces is fine.
            let command = parts.collect::<Vec<_>>().join(" ");
            Some(ProcInfo {
                pid,
                ppid,
                pgid,
                command,
            })
        })
        .collect()
}

/// Pure parser for PowerShell CIM output: one line per process as
/// `pid|ppid|command` (see `process_snapshot` on Windows). The command field
/// may contain `|` and spaces — `splitn(3, '|')` captures it verbatim.
/// Available on all platforms so the parsing can be unit-tested.
/// `allow(dead_code)`: on Unix its only caller is `#[cfg(not(unix))]`, so the
/// compiler flags it as dead; on Windows it IS used by `process_snapshot`.
#[allow(dead_code)]
fn parse_cim_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // splitn(3, '|') — the command field may itself contain '|',
            // but only the first two fields matter and the third captures
            // everything else verbatim.
            let mut parts = line.splitn(3, '|');
            let pid: i32 = parts.next()?.trim().parse().ok()?;
            let ppid: i32 = parts.next()?.trim().parse().ok()?;
            let command = parts.next()?.trim().to_string();
            // Windows has no POSIX process groups; pgid is unused there (set to
            // 0 so the lineage rule in `orphan_killset`, which requires pgid > 1,
            // never fires — Windows relies on name + descendant matching).
            Some(ProcInfo {
                pid,
                ppid,
                pgid: 0,
                command,
            })
        })
        .collect()
}

/// Snapshot the OS process table into `ProcInfo` rows (pid, ppid, command).
/// Returns `None` if the process-listing command is unavailable — the sweep
/// then silently does nothing.
#[cfg(unix)]
fn process_snapshot() -> Option<Vec<ProcInfo>> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,pgid=,command="])
        .output()
        .ok()?;
    Some(parse_ps_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Windows snapshot via PowerShell CIM — the modern replacement for the
/// deprecated `wmic`. Emits one line per process: `pid|ppid|command`, using
/// `|` as a field delimiter. CommandLine may be empty for kernel processes;
/// those won't match any pattern so they're harmless.
#[cfg(not(unix))]
fn process_snapshot() -> Option<Vec<ProcInfo>> {
    // Single-quoted '|' inside the script is a literal separator, not a pipe.
    // The script string uses Rust line continuations (\) so it reads as one
    // logical line of PowerShell.
    let script = "Get-CimInstance Win32_Process | ForEach-Object { \
        [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + [string]$_.CommandLine \
    }";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(parse_cim_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Force-kill a single PID (best-effort, errors ignored).
#[cfg(unix)]
fn force_kill_pid(pid: i32) {
    unsafe {
        let _ = libc::kill(pid, libc::SIGKILL);
    }
}

/// Force-kill a single PID via `taskkill /F` (no descendant tree walk needed —
/// the sweeper kills every orphan-tree member individually from the snapshot).
#[cfg(not(unix))]
fn force_kill_pid(pid: i32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Absolute path to the sidecar PID ledger (`~/.gg/gg-app-sidecars`).
///
/// Newline-delimited list of PIDs of every Node sidecar this app has spawned.
/// Because each sidecar is spawned as a process-group leader (`process_group(0)`
/// on Unix), its PID equals the pgid shared by all of its MCP/LSP children. So a
/// ledgered PID doubles as "a GG process-group id", which is how the sweep
/// recognises a crashed sidecar's children by lineage — no MCP-name whitelist.
fn sidecar_ledger_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app-sidecars")
}

/// Read the ledgered sidecar PIDs (== process-group ids). Missing/garbage file
/// → empty set (the sweep then degrades to name + descendant matching, exactly
/// the pre-ledger behaviour). Best-effort, never panics.
fn read_sidecar_ledger() -> HashSet<i32> {
    let Ok(contents) = std::fs::read_to_string(sidecar_ledger_path()) else {
        return HashSet::new();
    };
    contents
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .filter(|&p| p > 1)
        .collect()
}

/// Append a freshly-spawned sidecar's PID to the ledger. Called right after
/// `spawn_daemon` gets a live child. Creates `~/.gg` if needed. Best-effort:
/// a write failure only means that sidecar's orphans fall back to name matching.
fn record_sidecar_pid(pid: i32) {
    let path = sidecar_ledger_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{pid}");
    }
}

/// Rewrite the ledger to keep only PIDs whose process group is still live —
/// i.e. a process with `pid == pgid` exists in the snapshot (a still-running
/// sidecar, ours or a concurrent instance's). Drops dead groups (their members
/// were just swept) and pids recycled away, so the file can't grow without
/// bound. Best-effort.
fn prune_sidecar_ledger(ledger: &HashSet<i32>, snapshot: &[ProcInfo]) {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let keep: Vec<i32> = ledger
        .iter()
        .copied()
        .filter(|g| live_pids.contains(g))
        .collect();
    let path = sidecar_ledger_path();
    if keep.is_empty() {
        // Nothing worth keeping — remove the file so a stale set can't linger.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let body = keep
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&path, format!("{body}\n"));
}

/// Snapshot the process table, classify orphaned sidecar trees, and force-kill
/// each. Best-effort + logged; never panics. Runs once at startup before any
/// sidecar is spawned.
fn sweep_orphan_sidecars() {
    let Some(snapshot) = process_snapshot() else {
        log::warn!("orphan sweep: process listing unavailable, skipping");
        return;
    };
    let self_pid = std::process::id() as i32;
    let ledger = read_sidecar_ledger();

    let killset = orphan_killset(&snapshot, self_pid, &ledger);
    if killset.is_empty() {
        log::info!("orphan sweep: no stale sidecars found");
        prune_sidecar_ledger(&ledger, &snapshot);
        return;
    }

    log::info!("orphan sweep: killing {} stale process(es)", killset.len());
    for pid in &killset {
        let cmd = snapshot
            .iter()
            .find(|p| &p.pid == pid)
            .map(|p| p.command.as_str())
            .unwrap_or("?");
        log::info!("orphan sweep: killing pid {pid}: {cmd}");
        force_kill_pid(*pid);
    }
    prune_sidecar_ledger(&ledger, &snapshot);
}

/// The shared daemon port (same for every window). Named `port_for` so the ~35
/// proxy commands keep their call shape; the per-window routing is the session
/// id (`session_for`), attached as the `x-gg-session` header.
fn port_for(webview: &WebviewWindow) -> Option<u16> {
    let daemon: State<Daemon> = webview.state();
    let port = *daemon.port.lock().unwrap();
    port
}

fn pane_session_for(webview: &WebviewWindow, pane_id: Option<&str>) -> Option<String> {
    let pane_id = pane_id_or_primary(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let map = windows.map.lock().unwrap();
    resolve_owned_pane(&map, webview.label(), pane_id)?
        .session_id
        .clone()
}

fn pane_cwd_for(webview: &WebviewWindow, pane_id: Option<&str>) -> Option<PathBuf> {
    let pane_id = pane_id_or_primary(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let map = windows.map.lock().unwrap();
    resolve_owned_pane(&map, webview.label(), pane_id)?
        .cwd
        .clone()
}

/// Await the daemon's HTTP port (set by its `GG_APP_LISTENING` handshake),
/// polling up to ~30s. Returns `None` if the daemon never came up. Mirrors the
/// webview's `waitForReady` poll cadence.
async fn await_daemon_port(app: &tauri::AppHandle) -> Option<u16> {
    for _ in 0..600 {
        if let Some(p) = *app.state::<Daemon>().port.lock().unwrap() {
            return Some(p);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

/// Frontend polls this until it returns a port. An omitted pane id preserves the
/// legacy primary-pane readiness seam.
#[tauri::command]
fn sidecar_port(webview: WebviewWindow, pane_id: Option<String>) -> Option<u16> {
    pane_session_for(&webview, pane_id.as_deref())?;
    port_for(&webview)
}

/// Stable, ownership-checked readiness state. Unlike startup events, this cannot
/// be missed when the webview subscribes after a fast daemon/session failure.
#[tauri::command]
fn agent_pane_status(
    webview: WebviewWindow,
    pane_id: Option<String>,
) -> Result<PaneStartupStatus, String> {
    let pane_id = pane_id_or_primary(pane_id.as_deref())?;
    let daemon_error = webview
        .state::<Daemon>()
        .startup_error
        .lock()
        .unwrap()
        .clone();
    let mut status = {
        let windows: State<Windows> = webview.state();
        let registry = windows.map.lock().unwrap();
        pane_startup_status(&registry, webview.label(), pane_id, daemon_error.as_deref())?
    };
    // A bound session ID is stale during the brief crash window before registry
    // invalidation; readiness also requires the daemon's live listening port.
    status.ready &= port_for(&webview).is_some();
    Ok(status)
}

/// Filesystem-only validation for a persisted webview layout target. This stays
/// independent of daemon readiness so a stale session cannot block recovery.
#[tauri::command]
fn workspace_target_status(cwd: String, session_path: Option<String>) -> serde_json::Value {
    let project_exists = Path::new(&cwd).is_dir();
    let session_exists = session_path
        .as_deref()
        .map(|path| Path::new(path).is_file())
        .unwrap_or(true);
    serde_json::json!({
        "projectExists": project_exists,
        "sessionExists": session_exists,
    })
}

#[tauri::command]
fn dropped_path_info(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .map(|path| {
            let is_dir = std::fs::metadata(&path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            DroppedPathInfo { path, is_dir }
        })
        .collect()
}

/// Cap on a single dropped file's size for base64 attachment — large drops
/// (e.g. multi-GB video) would blow up the base64 payload and the IPC/agent
/// prompt pipeline; point the user at the file path instead via the error.
const MAX_DROPPED_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Guess a media type from the file extension. Covers the kinds the chat
/// input already accepts (image/video via the attach button, everything else
/// falls back to a generic binary type like a browser's File.type would for
/// an unrecognized extension).
fn guess_media_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A native drag-drop only gives us absolute paths (no browser File object),
/// so a regular file dropped on the window (as opposed to a folder, handled
/// separately by inserting its path into the draft) is read here and handed
/// back as base64 — the same shape `fileToPending` builds for a pasted/picked
/// file — so it attaches identically regardless of how it entered the input.
#[tauri::command]
fn read_dropped_file_attachment(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "{} is too large to attach ({} MB, limit {} MB)",
            path,
            metadata.len() / (1024 * 1024),
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let media_type = guess_media_type(p);
    Ok(serde_json::json!({ "name": name, "mediaType": media_type, "data": data }))
}

fn strip_file_location_suffix(path: &str) -> &str {
    let mut end = path.len();
    for _ in 0..2 {
        let Some(colon) = path[..end].rfind(':') else {
            break;
        };
        let suffix = &path[colon + 1..end];
        if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        let last_sep = path[..colon].rfind(|c| c == '/' || c == '\\').unwrap_or(0);
        if colon <= last_sep {
            break;
        }
        end = colon;
    }
    &path[..end]
}

/// Open a project file linked from the chat. Relative paths resolve against this
/// window's sidecar cwd; `:line[:col]` and `#Lline` decorations are tolerated.
#[tauri::command]
fn open_project_path(
    webview: WebviewWindow,
    path: String,
    pane_id: Option<String>,
) -> Result<(), String> {
    let cwd = pane_cwd_for(&webview, pane_id.as_deref()).ok_or("sidecar not ready")?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    if trimmed.contains("://") && !trimmed.starts_with("file://") {
        return Err("not a file path".into());
    }

    let without_file_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let without_anchor = without_file_scheme
        .split_once("#L")
        .map(|(p, _)| p)
        .unwrap_or(without_file_scheme);
    let without_query = without_anchor
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or(without_anchor);
    let cleaned = strip_file_location_suffix(without_query);
    let candidate = PathBuf::from(cleaned);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    let canonical = resolved
        .canonicalize()
        .map_err(|_| format!("file not found: {}", cleaned))?;

    webview
        .opener()
        .open_path(canonical.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| e.to_string())
}

/// Proxy: current agent/session state.
#[tauri::command]
async fn agent_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/state", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: current XP/rank progress snapshot (Ranks system).
#[tauri::command]
async fn agent_progress(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/progress", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: the active provider's subscription quota snapshot. Account-wide, so
/// no per-window session header is needed.
#[tauri::command]
async fn agent_usage(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    if provider != "anthropic" && provider != "openai" {
        return Err("unsupported usage provider".into());
    }
    let res = client
        .get(format!(
            "{}/usage?provider={}",
            sidecar_base(port),
            provider
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("usage request failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: submit a prompt (optionally with attachments). The reply streams back
/// via the `agent-event` event. `attachments` is passed through opaquely.
#[tauri::command]
async fn agent_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/prompt", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "text": text,
            "attachments": attachments.unwrap_or(serde_json::Value::Array(vec![])),
            "meta": meta.unwrap_or(serde_json::Value::Null),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: resumed conversation history (user + assistant text) for hydration.
#[tauri::command]
async fn agent_history(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/history", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: start a fresh session (clears history) for this window's project.
#[tauri::command]
async fn agent_new_session(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/new-session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: store an API key for a provider.
#[tauri::command]
async fn agent_auth_apikey(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
    key: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/apikey", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider, "key": key }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: begin an OAuth login. Progress streams back via `agent-event`
/// (`auth_url`, `auth_status`, `auth_need_code`, `auth_done`, `auth_error`).
#[tauri::command]
async fn agent_auth_oauth_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/start", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: submit a pasted OAuth code to an in-flight login.
#[tauri::command]
async fn agent_auth_oauth_code(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    code: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/code", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: disconnect a provider (clear its stored credentials).
#[tauri::command]
async fn agent_auth_logout(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    provider: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/logout", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: stop a background task by id. Returns `{ message }`.
#[tauri::command]
async fn agent_kill_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/kill", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: radio state for THIS window's sidecar — `{ stations, current }`.
/// Playback lives in the per-window sidecar process, so each window's radio is
/// independent (opening more windows never duplicates audio).
#[tauri::command]
async fn agent_radio_state(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: play a station by id, or stop with `station = "off"`. Returns
/// `{ current }` on success, an error message (e.g. no player installed) on 4xx.
#[tauri::command]
async fn agent_radio_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    station: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "station": station }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("radio request failed")
            .to_string();
        return Err(msg);
    }
    Ok(body)
}

/// Proxy: list this project's task list (the ~/.gg-tasks store for its cwd).
#[tauri::command]
async fn agent_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/tasks", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: run one task (`id`) or run-all (`all = true`, starting from the next
/// pending task). Progress streams back via `agent-event` (session_reset,
/// task_start, run_start/run_end, tasks_list, tasks_run_done).
#[tauri::command]
async fn agent_run_tasks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    all: bool,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/tasks/run", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id, "all": all }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: delete a task by id. Returns the remaining `{ tasks }`.
#[tauri::command]
async fn agent_delete_task(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/tasks/delete", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: accept the pending plan — bakes its `## Steps` into the system prompt
/// so the agent emits `[DONE:n]` progress markers while implementing. Call
/// before sending the "implement it now" prompt.
#[tauri::command]
async fn agent_accept_plan(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    plan_path: Option<String>,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/plan/accept", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "planPath": plan_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cancel the in-flight run.
#[tauri::command]
async fn agent_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: ask Ken Kai (the read-only mentor agent). Reply streams back via the
/// `agent-event` event with `ken_`-prefixed types. Lazily boots Ken's session.
#[tauri::command]
async fn agent_ken_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/ken/prompt", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cancel Ken's in-flight run (leaves GG Coder's run untouched).
#[tauri::command]
async fn agent_ken_cancel(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    client
        .post(format!("{}/ken/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: toggle autopilot (auto-review) for THIS window's project. Persisted
/// server-side in ~/.gg/gg-app.json keyed by cwd; returns `{ autopilot }`.
#[tauri::command]
async fn agent_autopilot_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: bool,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/autopilot", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: list workflow (prompt-template) slash commands.
#[tauri::command]
async fn agent_commands(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/commands", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: list models available to the logged-in providers.
#[tauri::command]
async fn agent_models(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/models", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: switch the active model. Returns the new provider/model + thinking state.
#[tauri::command]
async fn agent_switch_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: pin Ken (mentor + autopilot) to a model, or clear the pin so he
/// follows GG Coder's model again. `model: None` clears. Returns
/// `{ kenProvider, kenModel, kenModelOverride }`.
#[tauri::command]
async fn agent_switch_ken_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: Option<String>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/ken/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: rewrite a draft prompt into a tighter, terminology-correct version
/// using the active model. Returns `{ enhanced, segments }`.
#[tauri::command]
async fn agent_enhance_prompt(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    text: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/enhance", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: cycle the reasoning/thinking level to the next supported value.
/// Returns the new `{ thinkingLevel, supportedThinkingLevels }`.
#[tauri::command]
async fn agent_cycle_thinking(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: read gg-app settings (e.g. the projects root folder).
#[tauri::command]
async fn agent_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/settings", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: save gg-app settings.
#[tauri::command]
async fn agent_save_settings(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    projects_root: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/settings", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "projectsRoot": projects_root }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

// ── Native app settings (~/.gg/gg-app.json) ───────────────────────────────
// The project folder is a plain home-dir file with NOTHING to do with the
// agent, so Rust reads/writes it directly. This makes the home-screen Settings
// + New project flow independent of the Node sidecar's boot — a slow or crashed
// sidecar used to make "Save project folder" silently fail or time out even on
// up-to-date builds. (The sidecar keeps its own /settings endpoint for its
// internal use; this is the authoritative path for the webview.)

/// Absolute path to ~/.gg/gg-app.json.
fn app_settings_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app.json")
}

/// Default projects root: ~/gg-projects.
fn default_projects_root() -> PathBuf {
    home_dir().join("gg-projects")
}

fn relative_time(ms: u128) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(ms);
    let diff = now_ms.saturating_sub(ms);
    let minute = 60_000;
    let hour = 60 * minute;
    let day = 24 * hour;
    if diff < minute {
        "just now".to_string()
    } else if diff < hour {
        format!("{}m ago", diff / minute)
    } else if diff < day {
        format!("{}h ago", diff / hour)
    } else {
        format!("{}d ago", diff / day)
    }
}

fn native_projects_root_folders() -> Vec<serde_json::Value> {
    let settings = app_settings_get();
    let root = settings
        .get("projectsRoot")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(default_projects_root);
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut projects = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let last_active_ms = modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project")
            .to_string();
        projects.push(serde_json::json!({
            "name": name,
            "path": path.to_string_lossy().to_string(),
            "lastActiveMs": last_active_ms as f64,
            "lastActiveDisplay": relative_time(last_active_ms),
            "sources": ["ggcoder"],
        }));
    }
    projects.sort_by(|a, b| {
        let ams = a
            .get("lastActiveMs")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let bms = b
            .get("lastActiveMs")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        bms.partial_cmp(&ams).unwrap_or(std::cmp::Ordering::Equal)
    });
    projects
}

fn merge_project_lists(mut sidecar_projects: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    for native in native_projects_root_folders() {
        let Some(native_path) = native.get("path").and_then(|v| v.as_str()) else {
            continue;
        };
        if sidecar_projects.iter().any(|p| {
            p.get("path")
                .and_then(|v| v.as_str())
                .is_some_and(|p| p.eq_ignore_ascii_case(native_path))
        }) {
            continue;
        }
        sidecar_projects.push(native);
    }
    sidecar_projects.sort_by(|a, b| {
        let ams = a
            .get("lastActiveMs")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let bms = b
            .get("lastActiveMs")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        bms.partial_cmp(&ams).unwrap_or(std::cmp::Ordering::Equal)
    });
    sidecar_projects
}

/// Validate a project folder name: lowercase letters, digits, single dashes
/// between segments (mirrors the sidecar's isValidProjectName).
fn is_valid_project_name(name: &str) -> bool {
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

/// Native: read gg-app settings directly from ~/.gg/gg-app.json. `configured`
/// is true only when the file exists with a non-empty projectsRoot (so the home
/// screen's "Your Projects" gate matches the sidecar's semantics). Never needs
/// the sidecar.
#[tauri::command]
fn app_settings_get() -> serde_json::Value {
    let raw = std::fs::read_to_string(app_settings_path()).ok();
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

/// Native: write gg-app settings directly to ~/.gg/gg-app.json. Creates the
/// ~/.gg directory if needed. Never needs the sidecar.
#[tauri::command]
fn app_settings_save(projects_root: String) -> Result<serde_json::Value, String> {
    let trimmed = projects_root.trim();
    if trimmed.is_empty() {
        return Err("projectsRoot is required".to_string());
    }
    let path = app_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut body = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    body["projectsRoot"] = serde_json::json!(trimmed);
    let pretty = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "projectsRoot": trimmed }))
}

/// Native: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, an error message on invalid name / conflict.
/// Never needs the sidecar.
#[tauri::command]
fn app_create_project(name: String) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if !is_valid_project_name(name) {
        return Err(
            "Project name must be lowercase letters, digits, and dashes (e.g. my-project)."
                .to_string(),
        );
    }
    // Resolve the projects root the same way app_settings_get does.
    let settings = app_settings_get();
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

/// One saved window: the project cwd, an optional session file to resume, and
/// optional last-known geometry (physical pixels).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct WorkspaceEntry {
    cwd: String,
    #[serde(
        rename = "sessionPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}

/// The whole snapshot: an ordered list of open windows (main first).
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct Workspace {
    #[serde(default)]
    windows: Vec<WorkspaceEntry>,
}

/// Absolute path to ~/.gg/gg-app-workspace.json.
fn app_workspace_path() -> PathBuf {
    home_dir().join(".gg").join("gg-app-workspace.json")
}

/// Read the workspace snapshot; missing/invalid file → an empty workspace.
fn read_workspace() -> Workspace {
    std::fs::read_to_string(app_workspace_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Workspace>(&s).ok())
        .unwrap_or_default()
}

/// Write the workspace snapshot (creating ~/.gg if needed). Best-effort.
fn write_workspace(ws: &Workspace) {
    let path = app_workspace_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(ws) {
        let _ = std::fs::write(&path, pretty);
    }
}

/// Pure: is this window worth snapshotting? A window still sitting on the picker
/// has no project chosen (its cwd is None or equals the default boot cwd) and
/// must be excluded so it doesn't restore as an empty home window.
fn keep_for_snapshot(cwd: Option<&Path>, default_cwd: &Path) -> bool {
    match cwd {
        Some(c) => c != default_cwd,
        None => false,
    }
}

/// Pure: drop restore entries that can't be opened (empty cwd, or a cwd that no
/// longer exists). `exists` is injected so this is testable without the fs.
fn filter_restorable<F: Fn(&str) -> bool>(
    windows: Vec<WorkspaceEntry>,
    exists: F,
) -> Vec<WorkspaceEntry> {
    windows
        .into_iter()
        .filter(|w| !w.cwd.trim().is_empty() && exists(&w.cwd))
        .collect()
}

/// Walk every live window + its `Windows` session entry and write a fresh
/// snapshot. Picker-only windows (still at the default boot cwd) are excluded.
/// Geometry is captured from each window's current outer position + inner size.
fn live_snapshot_labels<'a>(
    live_labels: impl IntoIterator<Item = &'a String>,
    excluded_label: Option<&str>,
) -> Vec<String> {
    let mut labels: Vec<String> = live_labels
        .into_iter()
        .filter(|label| excluded_label != Some(label.as_str()))
        .cloned()
        .collect();
    labels.sort_by_key(|label| label_rank(label));
    labels
}

fn snapshot_workspace_excluding(app: &tauri::AppHandle, excluded_label: Option<&str>) {
    let default = default_cwd();
    let windows = app.webview_windows();
    // Only native windows are eligible. Registry-only labels are startup
    // reservations and must never become persisted phantom windows.
    let labels = live_snapshot_labels(windows.keys(), excluded_label);
    let state: State<Windows> = app.state();
    let map = state.map.lock().unwrap();

    let mut entries: Vec<WorkspaceEntry> = Vec::new();
    for label in &labels {
        let Some(inst) = map.get(label).and_then(|panes| panes.get(PRIMARY_PANE_ID)) else {
            continue;
        };
        let cwd = inst.cwd.as_deref();
        if !keep_for_snapshot(cwd, &default) {
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
            cwd,
            session_path: inst.session_path.clone(),
            x,
            y,
            width,
            height,
        });
    }
    drop(map);
    write_workspace(&Workspace { windows: entries });
}

fn snapshot_workspace(app: &tauri::AppHandle) {
    snapshot_workspace_excluding(app, None);
}

/// Consume-once: hand the calling window its restore target (cwd + session) so
/// the webview skips the picker on boot. Returns null for a normal (non-restored)
/// window. The entry is removed after the first read.
#[tauri::command]
fn window_restore_target(webview: WebviewWindow) -> Option<RestoreEntry> {
    let state: State<RestoreTargets> = webview.state();
    let mut map = state.map.lock().unwrap();
    map.remove(webview.label())
}

// ── Native provider auth status (~/.gg/auth.json) ─────────────────────────
// The AI-providers list is STATIC metadata and the "connected" badge only needs
// to read which provider keys exist in ~/.gg/auth.json — neither needs the Node
// agent. Reading it natively means the login hub always renders even when the
// sidecar is slow/crashed (it used to show a blank list, identical in spirit to
// the project-folder bug). The login ACTIONS (OAuth flow, key storage, logout)
// still go through the sidecar — those genuinely need the agent.
//
// This list mirrors packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS).
// Keep the two in sync when adding a provider.

/// Absolute path to ~/.gg/auth.json.
fn auth_file_path() -> PathBuf {
    home_dir().join(".gg").join("auth.json")
}

/// One API-key option for a provider that splits auth across multiple
/// distinct endpoints/credentials (currently only Xiaomi: Token Plan vs.
/// API Credits). Mirrors `ApiKeyVariant` in
/// packages/ggcoder/src/core/auth-providers.ts.
#[derive(PartialEq, Debug)]
struct ApiKeyVariant {
    /// Storage key in auth.json (distinct from the provider `value`).
    key: &'static str,
    /// Display label, e.g. "Token Plan" or "API Credits".
    label: &'static str,
    /// Base URL stored alongside this variant's credential.
    base_url: Option<&'static str>,
}

/// Static metadata for one AI provider in the login hub. Mirrors
/// packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS) — keep in sync.
struct ProviderMeta {
    /// Storage key in auth.json + the value the webview passes back.
    value: &'static str,
    label: &'static str,
    description: &'static str,
    /// Supported auth methods, e.g. `["oauth"]`, `["apikey"]`, or both.
    methods: &'static [&'static str],
    api_key_label: Option<&'static str>,
    /// Custom API base URL stored alongside an API-key credential. Used as the
    /// default when `api_key_variants` is empty.
    api_key_base_url: Option<&'static str>,
    /// When a provider's API-key auth splits across multiple endpoints, the
    /// choices to present (first = default). Empty for every single-credential
    /// provider.
    api_key_variants: &'static [ApiKeyVariant],
}

/// The provider catalog (single source of truth for app_auth_status +
/// app_auth_apikey). Order is the display order in the login hub.
const AUTH_PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude Opus 4.8, Fable 5, Sonnet 4.6, Haiku 4.5",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openai",
        label: "OpenAI",
        description: "GPT-5.5, GPT-5.5 Pro, GPT-5.4, GPT-5.3 Codex",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "gemini",
        label: "Gemini",
        description: "Gemini 3.1 Flash Lite Preview",
        methods: &["oauth"],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "moonshot",
        label: "Moonshot",
        description: "Kimi K2.7 · OAuth or API key",
        methods: &["oauth", "apikey"],
        api_key_label: Some("Moonshot"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "glm",
        label: "Z.AI (GLM)",
        description: "GLM-5.1, GLM-4.7, GLM-4.7 Flash",
        methods: &["apikey"],
        api_key_label: Some("Z.AI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "minimax",
        label: "MiniMax",
        description: "MiniMax M3",
        methods: &["apikey"],
        api_key_label: Some("MiniMax"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "xiaomi",
        label: "Xiaomi (MiMo)",
        description:
            "MiMo-V2.5-Pro, MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5 · Token Plan or API Credits",
        methods: &["apikey"],
        api_key_label: Some("Xiaomi MiMo"),
        api_key_base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
        api_key_variants: &[
            ApiKeyVariant {
                key: "xiaomi",
                label: "Token Plan",
                base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
            },
            ApiKeyVariant {
                key: "xiaomi-credits",
                label: "API Credits (required for UltraSpeed)",
                base_url: Some("https://api.xiaomimimo.com/v1"),
            },
        ],
    },
    ProviderMeta {
        value: "deepseek",
        label: "DeepSeek",
        description: "DeepSeek V4 Pro, V4 Flash",
        methods: &["apikey"],
        api_key_label: Some("DeepSeek"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openrouter",
        label: "OpenRouter",
        description: "Qwen3.6-Plus, multi-provider gateway",
        methods: &["apikey"],
        api_key_label: Some("OpenRouter"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "sakana",
        label: "Sakana (Fugu)",
        description: "Fugu, Fugu Ultra",
        methods: &["apikey"],
        api_key_label: Some("Sakana"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
];

/// Pure: resolve `(storage_key, base_url)` for an API-key submission to
/// `provider`, given an optional variant key. Providers with multiple
/// `api_key_variants` (currently only Xiaomi: Token Plan vs. API Credits)
/// select the matching variant, defaulting to the first/primary one when
/// `variant` is absent or unknown. Single-variant providers ignore `variant`
/// and use the flat `api_key_base_url`. Returns `None` if `provider` is
/// unknown or doesn't support API-key auth.
fn resolve_apikey_target(
    provider: &str,
    variant: Option<&str>,
) -> Option<(String, Option<&'static str>)> {
    let meta = AUTH_PROVIDERS
        .iter()
        .find(|p| p.value == provider && p.methods.contains(&"apikey"))?;
    if meta.api_key_variants.is_empty() {
        return Some((meta.value.to_string(), meta.api_key_base_url));
    }
    let chosen = variant
        .and_then(|v| meta.api_key_variants.iter().find(|x| x.key == v))
        .unwrap_or(&meta.api_key_variants[0]);
    Some((chosen.key.to_string(), chosen.base_url))
}

/// Native: provider list + live connection status, read directly from
/// ~/.gg/auth.json. `connected` is true when a credential key is present
/// (moonshot is satisfied by either its OAuth key `moonshot-oauth` or the
/// `moonshot` API key; a multi-variant provider like Xiaomi is satisfied by
/// ANY of its variant keys — mirrors AuthStorage.hasProviderAuth). Never needs
/// the sidecar.
#[tauri::command]
fn app_auth_status() -> serde_json::Value {
    // Parse the auth file into a JSON object; missing/invalid → empty (no creds).
    let creds = std::fs::read_to_string(auth_file_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let has_key = |key: &str| -> bool {
        creds
            .as_ref()
            .and_then(|v| v.get(key))
            .map(|v| !v.is_null())
            .unwrap_or(false)
    };
    let connected = |p: &ProviderMeta| -> bool {
        if p.value == "moonshot" {
            return has_key("moonshot-oauth") || has_key("moonshot");
        }
        if !p.api_key_variants.is_empty() {
            return has_key(p.value) || p.api_key_variants.iter().any(|v| has_key(v.key));
        }
        has_key(p.value)
    };

    let list: Vec<serde_json::Value> = AUTH_PROVIDERS
        .iter()
        .map(|p| {
            let mut obj = serde_json::json!({
                "value": p.value,
                "label": p.label,
                "description": p.description,
                "methods": p.methods,
                "connected": connected(p),
            });
            if let Some(l) = p.api_key_label {
                obj["apiKeyLabel"] = serde_json::json!(l);
            }
            if let Some(u) = p.api_key_base_url {
                obj["apiKeyBaseUrl"] = serde_json::json!(u);
            }
            if !p.api_key_variants.is_empty() {
                let variants: Vec<serde_json::Value> = p
                    .api_key_variants
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "label": v.label,
                            "baseUrl": v.base_url,
                        })
                    })
                    .collect();
                obj["apiKeyVariants"] = serde_json::json!(variants);
            }
            obj
        })
        .collect();

    serde_json::json!({ "providers": list })
}

// ── Native API-key auth writes (~/.gg/auth.json) ──────────────────────────
// Storing/removing an API key is a pure mutation of auth.json — the SAME file
// app_auth_status reads. Doing it natively (not via the sidecar) means a fresh
// user can log in even though their not-yet-configured sidecar may not be up:
// the sidecar used to crash on boot when no provider was configured, so a
// sidecar-routed key write would hang forever. Mirrors AuthStorage on the Node
// side (the credential shape + moonshot's dual-key logout).

/// API-key credentials never expire in practice; mirror the sidecar's ~100-year
/// horizon (365d * 100) so refresh logic never treats them as stale.
const API_KEY_TTL_MS: i64 = 365 * 24 * 60 * 60 * 1000 * 100;

/// Pure: build the OAuthCredentials JSON object for an API key (matches
/// AuthStorage's shape: accessToken + empty refreshToken + far-future expiry +
/// optional baseUrl). `now_ms` is injected for testability.
fn apikey_credential_json(key: &str, base_url: Option<&str>, now_ms: i64) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "accessToken": key,
        "refreshToken": "",
        "expiresAt": now_ms + API_KEY_TTL_MS,
    });
    if let Some(url) = base_url {
        obj["baseUrl"] = serde_json::json!(url);
    }
    obj
}

/// Pure: upsert an API-key credential into the existing auth.json text
/// (read-modify-write), preserving every other provider's entry. Returns the
/// new pretty-printed JSON. `existing` is the current file contents (None when
/// the file is missing). Errors only on a malformed (non-object) existing file.
fn apply_apikey(
    existing: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
    now_ms: i64,
    key: &str,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    if let Some(map) = root.as_object_mut() {
        map.insert(
            provider.to_string(),
            apikey_credential_json(key, base_url, now_ms),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Pure: remove a provider's credential from the existing auth.json text.
/// Moonshot also drops its distinct OAuth key (`moonshot-oauth`) so a single
/// "disconnect" fully removes Kimi OAuth + the Moonshot API key. Returns the new
/// pretty-printed JSON (an empty object `{}` when nothing remains / no file).
fn apply_logout(existing: Option<&str>, provider: &str) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    if let Some(map) = root.as_object_mut() {
        map.remove(provider);
        if provider == "moonshot" {
            map.remove("moonshot-oauth");
        }
        if let Some(meta) = AUTH_PROVIDERS.iter().find(|p| p.value == provider) {
            for v in meta.api_key_variants {
                map.remove(v.key);
            }
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Parse auth.json text into a JSON object value. Missing file → empty object.
/// A present-but-malformed/non-object file is an error (refuse to clobber it).
fn parse_auth_object(existing: Option<&str>) -> Result<serde_json::Value, String> {
    match existing {
        None => Ok(serde_json::json!({})),
        Some(s) if s.trim().is_empty() => Ok(serde_json::json!({})),
        Some(s) => {
            let v: serde_json::Value =
                serde_json::from_str(s).map_err(|e| format!("auth.json is not valid JSON: {e}"))?;
            if v.is_object() {
                Ok(v)
            } else {
                Err("auth.json is not a JSON object".to_string())
            }
        }
    }
}

/// Atomically write auth.json (temp file + rename), creating ~/.gg if needed.
/// On unix the file is mode 0600 (credentials). Mirrors gg-core's atomicWriteFile.
fn write_auth_file(contents: &str) -> Result<(), String> {
    let path = auth_file_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// Native: store an API key for a provider directly in ~/.gg/auth.json. Never
/// touches the sidecar, so it can't hang on a not-yet-booted agent. Validates
/// that the provider exists and supports API-key auth, and that the key is
/// non-empty. `variant` selects which storage key/base URL to use for
/// providers with multiple API-key options (currently only Xiaomi); omitted or
/// unknown defaults to the first/primary variant. Returns `{ ok: true }`.
#[tauri::command]
fn app_auth_apikey(
    provider: String,
    key: String,
    variant: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is required".to_string());
    }
    let (storage_key, base_url) = resolve_apikey_target(&provider, variant.as_deref())
        .ok_or_else(|| "provider does not support API key auth".to_string())?;
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let now_ms = current_unix_millis();
    let next = apply_apikey(existing.as_deref(), &storage_key, base_url, now_ms, key)?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Native: disconnect a provider (remove its credential from ~/.gg/auth.json).
/// Moonshot also clears its OAuth key; any provider with multiple
/// `api_key_variants` (currently only Xiaomi) clears every variant key, so a
/// single "disconnect" fully removes all of a provider's credentials. Never
/// touches the sidecar. Returns `{ ok: true }`.
#[tauri::command]
fn app_auth_logout(provider: String) -> Result<serde_json::Value, String> {
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    // Nothing to remove and no file → succeed silently (idempotent).
    if existing.is_none() {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let next = apply_logout(existing.as_deref(), &provider)?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Current unix time in milliseconds (wall clock; fine for an expiry stamp).
fn current_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Proxy: read Telegram config status (configured + masked preview).
#[tauri::command]
async fn agent_telegram_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/telegram", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: save Telegram config (bot token + user id). Verifies the token via
/// getMe sidecar-side; returns an error message on rejection.
#[tauri::command]
async fn agent_telegram_save(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    bot_token: String,
    user_id: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/telegram", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "botToken": bot_token, "userId": user_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to save Telegram config");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: Telegram serve status (`{ running, configured }`).
#[tauri::command]
async fn agent_serve_status(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/serve", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: start the Telegram serve loop. Returns `{ running }` or an error.
#[tauri::command]
async fn agent_serve_start(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/serve/start", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to start serve");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: stop the Telegram serve loop. Returns `{ running: false }`.
#[tauri::command]
async fn agent_serve_stop(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/serve/stop", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: list MCP servers with live connection status (`{ servers: […] }`).
/// `cwd` (project scope) scopes the project servers to a specific project path.
#[tauri::command]
async fn agent_mcp_list(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: Option<String>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let mut req = client
        .get(format!("{}/mcp", sidecar_base(port)))
        .header("x-gg-session", &gg_sid);
    if let Some(c) = cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        req = req.query(&[("cwd", c)]);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: add an MCP server from a pasted `claude mcp add …` line. Returns
/// `{ ok, name, connected, toolCount, error? }`, or an error message on parse/save
/// failure (the sidecar probes before saving but never blocks the save).
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
async fn agent_mcp_add(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    line: String,
    scope: String,
    cwd: Option<String>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/add", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "line": line, "scope": scope, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to add MCP server");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: remove an MCP server by name. Returns `{ removed: boolean }`.
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
async fn agent_mcp_remove(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/remove", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "scope": scope, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: begin an interactive OAuth login for a remote (HTTP) MCP server.
/// Returns 202 immediately; progress + outcome stream back via `agent-event`
/// (`mcp_auth_url`, `mcp_auth_status`, `mcp_auth_done`, `mcp_auth_error`). The
/// webview opens the browser when it receives `mcp_auth_url`.
/// `cwd` is required for project scope (the target project path).
#[tauri::command]
async fn agent_mcp_login(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    scope: String,
    cwd: Option<String>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/login", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "scope": scope, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to start MCP login");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: create a new project folder under the configured projects root.
/// Returns `{ path }` on success, or an error message on validation/conflict.
#[tauri::command]
async fn agent_create_project(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/create-project", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to create project");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Discover known projects across ggcoder/Claude Code/Codex stores, plus direct
/// children of the configured project folder natively. The native merge keeps
/// existing repos visible even if the sidecar is still booting or is reading an
/// older settings view.
#[tauri::command]
async fn agent_projects(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let sidecar_projects = match (
        port_for(&webview),
        pane_session_for(&webview, pane_id.as_deref()),
    ) {
        (Some(port), Some(gg_sid)) => match client
            .get(format!("{}/projects", sidecar_base(port)))
            .header("x-gg-session", &gg_sid)
            .send()
            .await
            .and_then(|res| res.error_for_status())
        {
            Ok(res) => res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|body| body.get("projects").and_then(|v| v.as_array()).cloned())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    };
    Ok(serde_json::json!({ "projects": merge_project_lists(sidecar_projects) }))
}

/// Proxy: list recent sessions for a project cwd.
#[tauri::command]
async fn agent_sessions(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    cwd: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let encoded = urlencoding(&cwd);
    let res = client
        .get(format!("{}/sessions?cwd={}", sidecar_base(port), encoded))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: search project files for the chat input's `@` picker. Empty `query`
/// returns the most-recently-modified files; a query returns fuzzy matches.
#[tauri::command]
async fn agent_files(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    query: String,
    pane_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id.as_deref()).ok_or("session not ready")?;
    let encoded = urlencoding(&query);
    let res = client
        .get(format!("{}/files?q={}", sidecar_base(port), encoded))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Minimal percent-encoding for a filesystem path in a query string.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const LOCAL_PATCHED_UPDATE_EVENT: &str = "local-patched-update";

/// Start the safe local-patched update workflow from the source checkout. This
/// intentionally does NOT call Tauri's updater `downloadAndInstall()`; it runs
/// the repo script that rebases local customizations on upstream, reapplies work,
/// checks, and builds a new local-patched installer.
#[tauri::command]
fn app_local_patched_update_start(
    app: tauri::AppHandle,
    update_state: State<'_, LocalPatchedUpdate>,
    repo_root: String,
) -> Result<serde_json::Value, String> {
    let repo = resolve_local_update_repo_root(repo_root)?;
    {
        let mut running = update_state.running.lock().unwrap();
        if *running {
            return Err("A local-patched update is already running.".into());
        }
        *running = true;
    }

    std::thread::spawn(move || run_local_patched_update(app, repo));
    Ok(serde_json::json!({ "started": true }))
}

fn resolve_local_update_repo_root(repo_root: String) -> Result<PathBuf, String> {
    let raw = if repo_root.trim().is_empty() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    } else {
        PathBuf::from(repo_root)
    };
    let repo = std::fs::canonicalize(&raw).map_err(|e| {
        format!(
            "Could not find the local source checkout at {}: {e}",
            raw.display()
        )
    })?;
    if !repo.join("package.json").is_file() || !repo.join("gg-app/package.json").is_file() {
        return Err(format!(
            "{} does not look like the gg-framework checkout. Rebuild the local-patched app from the repo, then try again.",
            repo.display()
        ));
    }
    Ok(repo)
}

fn emit_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    let _ = app.emit(LOCAL_PATCHED_UPDATE_EVENT, payload);
}

fn run_local_patched_update(app: tauri::AppHandle, repo: PathBuf) {
    emit_local_patched_update(
        &app,
        serde_json::json!({
            "type": "started",
            "repoRoot": repo.to_string_lossy(),
            "message": "Starting safe local-patched update: rebasing local customizations on upstream, reapplying work, checking, then building a patched installer.",
        }),
    );

    let mut cmd = local_patched_update_command();
    cmd.current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            finish_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start pnpm --filter gg-app update:local-fixes -- --check: {e}"),
                }),
            );
            return;
        }
    };

    let mut readers: Vec<JoinHandle<()>> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(stream_local_update_output(app.clone(), "stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(stream_local_update_output(app.clone(), "stderr", stderr));
    }

    let status = child.wait();
    for reader in readers {
        let _ = reader.join();
    }

    match status {
        Ok(status) if status.success() => {
            let installer = newest_rebuilt_installer(&repo);
            let windows_opened =
                open_rebuilt_installer_on_windows(&app, installer.as_deref(), &repo);
            emit_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "completed",
                    "exitCode": status.code().unwrap_or(0),
                    "installerPath": installer.map(|p| p.to_string_lossy().to_string()),
                    "opened": windows_opened,
                    "message": completed_local_update_message(windows_opened),
                }),
            );
            clear_local_patched_update_running(&app);
        }
        Ok(status) => {
            finish_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "error",
                    "exitCode": status.code(),
                    "message": format!(
                        "Local-patched update failed with exit code {}. Review the streamed output for rebase conflicts, manual-resolution instructions, or check/build errors.",
                        status.code().map_or_else(|| "unknown".into(), |c| c.to_string())
                    ),
                }),
            );
        }
        Err(e) => {
            finish_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "error",
                    "message": format!("Local-patched update process failed: {e}"),
                }),
            );
        }
    }
}

fn local_patched_update_command() -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args([
            "/C",
            "pnpm",
            "--filter",
            "gg-app",
            "update:local-fixes",
            "--",
            "--check",
        ]);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("pnpm");
        cmd.args(["--filter", "gg-app", "update:local-fixes", "--", "--check"]);
        cmd
    }
}

fn stream_local_update_output<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    stream: &'static str,
    reader: R,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            emit_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "line",
                    "stream": stream,
                    "line": line,
                }),
            );
        }
    })
}

fn newest_rebuilt_installer(repo: &Path) -> Option<PathBuf> {
    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    let candidates = [bundle.join("nsis"), bundle.join("msi")];
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for dir in candidates {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_installer = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("msi")
                });
            if !is_installer {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

#[cfg(target_os = "windows")]
fn open_rebuilt_installer_on_windows(
    app: &tauri::AppHandle,
    installer: Option<&Path>,
    repo: &Path,
) -> &'static str {
    if let Some(installer) = installer {
        if app
            .opener()
            .open_path(installer.to_string_lossy().to_string(), None::<String>)
            .is_ok()
        {
            return "installer";
        }
        if let Some(parent) = installer.parent() {
            if app
                .opener()
                .open_path(parent.to_string_lossy().to_string(), None::<String>)
                .is_ok()
            {
                return "folder";
            }
        }
    }

    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    if app
        .opener()
        .open_path(bundle.to_string_lossy().to_string(), None::<String>)
        .is_ok()
    {
        "folder"
    } else {
        "none"
    }
}

#[cfg(not(target_os = "windows"))]
fn open_rebuilt_installer_on_windows(
    _app: &tauri::AppHandle,
    _installer: Option<&Path>,
    _repo: &Path,
) -> &'static str {
    "none"
}

fn completed_local_update_message(opened: &str) -> &'static str {
    match opened {
        "installer" => "Patched installer built and launched. Finish the installer to update this local-patched app.",
        "folder" => "Patched installer built. Opened the folder containing it.",
        _ => "Patched installer built. Open the generated installer from gg-app/src-tauri/target/release/bundle.",
    }
}

fn finish_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    emit_local_patched_update(app, payload);
    clear_local_patched_update_running(app);
}

fn clear_local_patched_update_running(app: &tauri::AppHandle) {
    let update_state: State<LocalPatchedUpdate> = app.state();
    let mut running = update_state.running.lock().unwrap();
    *running = false;
}

/// App background (#111317) painted on the native window + webview BEFORE the
/// first frame, so opening a new window never flashes white.
const APP_BG: tauri::window::Color = tauri::window::Color(15, 17, 21, 255);

/// Per-OS window chrome decision. macOS uses the Overlay title bar (webview
/// draws under the traffic lights); every other OS keeps native decorations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowChrome {
    MacOverlay,
    Native,
}

/// Compile-time chrome selection: Overlay only on macOS, native elsewhere.
fn window_chrome() -> WindowChrome {
    if cfg!(target_os = "macos") {
        WindowChrome::MacOverlay
    } else {
        WindowChrome::Native
    }
}

/// Apply the macOS Overlay title bar + hidden title to a window builder. Kept
/// behind `#[cfg(target_os = "macos")]` because `TitleBarStyle::Overlay` and
/// `hidden_title` are macOS-only builder methods.
#[cfg(target_os = "macos")]
fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

/// No-op on non-macOS: native chrome is the default, nothing to apply.
#[cfg(not(target_os = "macos"))]
fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// Build an app window with the standard chrome. On macOS this includes the
/// Overlay title bar + `hidden_title(true)` so the native title text never
/// shows — the in-app `chat-head-title` is the ONLY title. Building via the
/// builder (rather than the config + a runtime patch) is the only way to hide
/// the native title, since there's no runtime `set_hidden_title` setter.
fn build_app_window(app: &tauri::AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Supah Coder")
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .background_color(APP_BG);
    // Windows needs HTML5 drop enabled for the existing browser attachment path.
    // macOS keeps Tauri's native handler so folder drops include absolute paths.
    #[cfg(target_os = "windows")]
    {
        builder = builder.disable_drag_drop_handler();
    }
    if matches!(window_chrome(), WindowChrome::MacOverlay) {
        builder = apply_mac_overlay(builder);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Open enough new project windows to reach `count` total (each with its own
/// agent sidecar at the default cwd), then tile the first `count` windows across
/// the work area like macOS fill&arrange. Project selection per window happens
/// in-app via the picker; windows open immediately.
///
/// MUST be `async`: on Windows, `WebviewWindowBuilder::build()` deadlocks when
/// called from a SYNCHRONOUS command (WebView2 runs window creation on the
/// event loop the sync command is blocking). The symptom was a blank,
/// unresponsive, uncloseable window. An async command runs off that thread, so
/// creation completes normally. See the docs.rs WebviewWindowBuilder "Known
/// issues" note.
#[tauri::command]
async fn setup_windows(app: tauri::AppHandle, count: usize) -> Result<(), String> {
    let existing = app.webview_windows().len();
    let to_create = count.saturating_sub(existing);
    for _ in 0..to_create {
        let label = next_window_label(&app);
        // macOS-only chrome: the Overlay title bar + hidden title lets the
        // webview draw under the traffic lights. Windows/Linux keep native
        // chrome (Overlay is a no-op / unsupported there) and the webview CSS
        // drops the mac traffic-light insets via the `.platform-*` class.
        let win = build_app_window(&app, &label)?;
        start_window_session(app.clone(), label, default_cwd(), None);
        let _ = win.set_focus();
    }
    arrange_windows(&app, count);
    broadcast_window_order(&app);
    Ok(())
}

/// Open a single new project window with its own agent sidecar (default cwd) and
/// focus it. Unlike `setup_windows`, this never re-tiles existing windows — it's
/// the Cmd/Ctrl+N "new window" shortcut. Project selection happens per-window.
///
/// `async` for the same reason as `setup_windows`: a synchronous window-building
/// command deadlocks WebView2 on Windows.
#[tauri::command]
async fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = next_window_label(&app);
    let win = build_app_window(&app, &label)?;
    start_window_session(app.clone(), label, default_cwd(), None);
    let _ = win.set_focus();
    broadcast_window_order(&app);
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PaneCopyTarget {
    cwd: PathBuf,
    session_path: Option<String>,
    session_id: String,
}

fn resolve_pane_copy_target(
    registry: &PaneRegistry,
    owner_label: &str,
    pane_id: &str,
) -> Result<PaneCopyTarget, String> {
    validate_pane_id(pane_id)?;
    let pane = resolve_owned_pane(registry, owner_label, pane_id)
        .ok_or_else(|| format!("pane '{pane_id}' does not exist in this window"))?;
    Ok(PaneCopyTarget {
        cwd: pane
            .cwd
            .clone()
            .ok_or_else(|| format!("pane '{pane_id}' has no project"))?,
        session_path: pane.session_path.clone(),
        session_id: pane
            .session_id
            .clone()
            .ok_or_else(|| format!("pane '{pane_id}' is not ready"))?,
    })
}

fn validate_pane_copy_target(target: &PaneCopyTarget) -> Result<(), String> {
    if !target.cwd.is_dir() {
        return Err(format!(
            "project folder no longer exists: {}",
            target.cwd.display()
        ));
    }
    if let Some(path) = target.session_path.as_deref() {
        if !Path::new(path).is_file() {
            return Err(format!("session file no longer exists: {path}"));
        }
    }
    Ok(())
}

fn merge_live_pane_copy_target(
    durable: PaneCopyTarget,
    live_state: Option<&serde_json::Value>,
) -> PaneCopyTarget {
    let Some(state) = live_state else {
        return durable;
    };
    let cwd = state
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| durable.cwd.clone());
    // A successful live response is authoritative: a missing sessionPath means
    // the pane is currently a fresh session, not the stale durable session.
    let session_path = state
        .get("sessionPath")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    PaneCopyTarget {
        cwd,
        session_path,
        session_id: durable.session_id,
    }
}

async fn live_pane_copy_target(
    app: &tauri::AppHandle,
    port: u16,
    durable: PaneCopyTarget,
) -> PaneCopyTarget {
    let client = app.state::<reqwest::Client>().inner().clone();
    let state = async {
        client
            .get(format!("{}/state", sidecar_base(port)))
            .header("x-gg-session", &durable.session_id)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<serde_json::Value>()
            .await
            .ok()
    }
    .await;
    merge_live_pane_copy_target(durable, state.as_ref())
}

fn next_project_window_label(
    registry: &PaneRegistry,
    mut native_window_exists: impl FnMut(&str) -> bool,
) -> String {
    let mut ordinal = 1;
    loop {
        let candidate = format!("project-{ordinal}");
        if !native_window_exists(&candidate) && !registry.contains_key(&candidate) {
            return candidate;
        }
        ordinal += 1;
    }
}

fn rollback_open_pane_state(
    registry: &mut PaneRegistry,
    restore_targets: &mut HashMap<String, RestoreEntry>,
    label: &str,
) -> Vec<PaneSession> {
    restore_targets.remove(label);
    take_window_panes(registry, label)
}

async fn rollback_open_pane_window(app: &tauri::AppHandle, label: &str) {
    let panes = {
        let windows: State<Windows> = app.state();
        let restore_targets: State<RestoreTargets> = app.state();
        let mut registry = windows.map.lock().unwrap();
        let mut targets = restore_targets.map.lock().unwrap();
        rollback_open_pane_state(&mut registry, &mut targets, label)
    };
    let port = { *app.state::<Daemon>().port.lock().unwrap() };
    if let Some(port) = port {
        for pane in panes {
            if let Some(session_id) = pane.session_id {
                daemon_delete_session(app, port, &session_id).await;
            }
        }
    }
}

#[tauri::command]
async fn open_pane_in_new_window(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<(), String> {
    let durable = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        resolve_pane_copy_target(&registry, webview.label(), &pane_id)?
    };
    let port = port_for(&webview).ok_or_else(|| format!("pane '{pane_id}' is not ready"))?;
    let target = live_pane_copy_target(&app, port, durable).await;
    validate_pane_copy_target(&target)?;

    // Reserve the owner label and pane target under one registry lock. The native
    // window does not exist until startup succeeds, so looking only at live
    // webviews would let simultaneous copy commands choose the same label.
    let (label, generation) = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock().unwrap();
        let label = next_project_window_label(&registry, |candidate| {
            app.get_webview_window(candidate).is_some()
        });
        let generation = create_pane_target(
            &mut registry,
            &label,
            PRIMARY_PANE_ID,
            target.cwd.clone(),
            target.session_path.clone(),
        )?;
        (label, generation)
    };
    launch_pane_session(
        app.clone(),
        label.clone(),
        PRIMARY_PANE_ID.to_string(),
        target.cwd.clone(),
        target.session_path.clone(),
        generation,
    );
    let mut startup_error = None;
    for _ in 0..600 {
        let status = {
            let windows: State<Windows> = app.state();
            let registry = windows.map.lock().unwrap();
            let daemon_error = app.state::<Daemon>().startup_error.lock().unwrap().clone();
            pane_startup_status(&registry, &label, PRIMARY_PANE_ID, daemon_error.as_deref())
        };
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                rollback_open_pane_window(&app, &label).await;
                return Err(error);
            }
        };
        if status.ready {
            break;
        }
        if status.error.is_some() {
            startup_error = status.error;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if let Some(error) = startup_error {
        rollback_open_pane_window(&app, &label).await;
        return Err(error);
    }
    let ready = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock().unwrap();
        pane_startup_status(&registry, &label, PRIMARY_PANE_ID, None)
            .map(|status| status.ready)
            .unwrap_or(false)
    };
    if !ready {
        rollback_open_pane_window(&app, &label).await;
        return Err("new window session did not start in time".into());
    }

    app.state::<RestoreTargets>().map.lock().unwrap().insert(
        label.clone(),
        RestoreEntry {
            cwd: target.cwd.to_string_lossy().to_string(),
            session_path: target.session_path,
        },
    );
    let win = match build_app_window(&app, &label) {
        Ok(window) => window,
        Err(error) => {
            rollback_open_pane_window(&app, &label).await;
            return Err(error);
        }
    };
    snapshot_workspace(&app);
    let _ = win.set_focus();
    broadcast_window_order(&app);
    Ok(())
}

/// The "What's new" modal lives in its OWN dedicated window so it appears EXACTLY
/// once (the main webview decides; see WhatsNewTrigger) and centers on the user's
/// SCREEN rather than inside whichever tiled project window happens to be open.
/// Reuses `index.html` with a `?whatsnew=1` flag — main.tsx renders only the
/// modal for that flag, so no second Vite entry / build-config change is needed.
/// Borderless + centered + always-on-top + off the taskbar so it reads as a
/// transient OS dialog. The window closes itself from the webview
/// (`getCurrentWebviewWindow().close()`); re-invoking just refocuses an open one.
///
/// `async` for the same WebView2 reason as `setup_windows`/`new_window`.
#[tauri::command]
async fn open_whatsnew_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("whatsnew") {
        let _ = win.set_focus();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        &app,
        "whatsnew",
        WebviewUrl::App("index.html?whatsnew=1".into()),
    )
    .title("What's new")
    .inner_size(600.0, 640.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

/// Cycle keyboard focus by `offset` (±1) through windows in reading order,
/// wrapping around. No-op when ≤1 window is open. Forward = +1, backward = -1
/// (Shift held). Bound to Cmd/Ctrl + Backquote (±Shift).
#[tauri::command]
fn focus_window_by_offset(app: tauri::AppHandle, offset: i32) -> Result<(), String> {
    let order = compute_window_order(&app);
    if order.len() <= 1 {
        return Ok(());
    }
    let cur = app
        .state::<FocusedWindow>()
        .0
        .lock()
        .unwrap()
        .clone()
        .and_then(|f| order.iter().position(|l| l == &f))
        .unwrap_or(0) as i32;
    let len = order.len() as i32;
    // Wrap-safe modulo for negative offsets (backward cycling).
    let next = ((cur + offset) % len + len) % len;
    if let Some(label) = order.get(next as usize) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Re-tile EVERY currently open window into a clean grid (no create/destroy),
/// then broadcast the new order. Works for any count (3, 5, 7, 9, 12, …).
///
/// Applies the rects in a STAGGERED async loop (~30ms between windows). On macOS
/// `set_size`/`set_position` dispatch to the main thread asynchronously, and
/// firing all of them in a tight loop lets the window server coalesce the later
/// dispatches — so the trailing windows would move but keep their old size.
/// Staggering lets each window's size+position fully commit before the next's
/// hits the main-thread queue.
#[tauri::command]
async fn arrange_all(app: tauri::AppHandle) -> Result<(), String> {
    let count = app.webview_windows().len();
    let tiles = sorted_windows(&app, count);
    let rects = if tiles.is_empty() {
        Vec::new()
    } else {
        let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
            broadcast_window_order(&app);
            return Ok(());
        };
        let area = monitor.work_area();
        tile_rects(
            count,
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        )
    };
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
        // Let the main thread commit this window before queuing the next.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    broadcast_window_order(&app);
    Ok(())
}

/// Re-point one pane's agent at a chosen project. Omitted pane identity means
/// primary, preserving the existing project-picker lifecycle seam. Auxiliary
/// replacements must identify the generation they intend to replace.
#[tauri::command]
fn select_project(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    cwd: String,
    session_path: Option<String>,
    pane_id: Option<String>,
    expected_generation: Option<u64>,
) -> Result<u64, String> {
    let pane_id = pane_id_or_primary(pane_id.as_deref())?.to_string();
    let label = webview.label().to_string();
    let old_id = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock().unwrap();
        let pane = if pane_id == PRIMARY_PANE_ID {
            dispose_pane_target(&mut map, &label, &pane_id, true, None).ok()
        } else {
            let expected = expected_generation
                .ok_or_else(|| format!("pane '{pane_id}' replacement requires its generation"))?;
            Some(dispose_pane_target(
                &mut map,
                &label,
                &pane_id,
                true,
                Some(expected),
            )?)
        };
        pane.and_then(|pane| pane.session_id)
    };
    if let Some(id) = old_id {
        if let Some(port) = port_for(&webview) {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                daemon_delete_session(&app2, port, &id).await;
            });
        }
    }
    let generation = start_pane_session(
        app.clone(),
        label,
        pane_id.clone(),
        PathBuf::from(cwd),
        session_path,
    );
    if pane_id == PRIMARY_PANE_ID {
        snapshot_workspace(&app);
    }
    Ok(generation)
}

#[tauri::command]
fn agent_pane_create(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    cwd: String,
    session_path: Option<String>,
) -> Result<u64, String> {
    validate_pane_id(&pane_id)?;
    let label = webview.label().to_string();
    let generation = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock().unwrap();
        create_pane_target(
            &mut map,
            &label,
            &pane_id,
            PathBuf::from(&cwd),
            session_path.clone(),
        )?
    };
    launch_pane_session(
        app,
        label,
        pane_id,
        PathBuf::from(cwd),
        session_path,
        generation,
    );
    Ok(generation)
}

#[tauri::command]
fn agent_pane_dispose(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let pane = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock().unwrap();
        dispose_pane_target(&mut map, webview.label(), &pane_id, false, generation)?
    };
    terminal::close_for_pane(
        &app.state::<terminal::TerminalRegistry>(),
        webview.label(),
        &pane_id,
    );
    if let (Some(port), Some(id)) = (port_for(&webview), pane.session_id) {
        tauri::async_runtime::spawn(async move {
            daemon_delete_session(&app, port, &id).await;
        });
    }
    Ok(())
}

/// Map a normalized gaze point to a window and (optionally) focus it.
///
/// The webview can't see other windows' screen rectangles, so the gaze tracker
/// (which only knows a normalized point across the primary monitor) hands the
/// point to Rust. We convert it to physical coordinates using the primary
/// monitor work area, hit-test every open window's outer rect, then:
///   - emit `gaze-target { target, committed }` to ALL windows so each paints
///     its own border: the `committed` (currently focused) window holds a solid
///     ring, the `target` window a soft "dwelling here" highlight, and
///   - call `set_focus()` on the hit window only when `commit` is true (after
///     the controller's dwell), so a glance never steals keyboard focus.
///
/// `committed` is the controller's currently-focused window label, passed every
/// frame so the focused border PERSISTS rather than flashing for one frame.
///
/// Returns the hit window's label (or null when the point lands on no window).
#[tauri::command]
fn gaze_focus(
    app: tauri::AppHandle,
    nx: f64,
    ny: f64,
    commit: bool,
    committed: Option<String>,
) -> Result<Option<String>, String> {
    let windows = app.webview_windows();
    let Some(any) = windows.values().next() else {
        return Ok(None);
    };
    let Some(monitor) = any.primary_monitor().ok().flatten() else {
        return Ok(None);
    };
    let area = monitor.work_area();
    let nx = nx.clamp(0.0, 1.0);
    let ny = ny.clamp(0.0, 1.0);
    let px = area.position.x as f64 + nx * area.size.width as f64;
    let py = area.position.y as f64 + ny * area.size.height as f64;

    // Hit-test: first window whose outer rect contains the point.
    let mut target: Option<String> = None;
    for (label, win) in windows.iter() {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let x0 = pos.x as f64;
        let y0 = pos.y as f64;
        let x1 = x0 + size.width as f64;
        let y1 = y0 + size.height as f64;
        if px >= x0 && px < x1 && py >= y0 && py < y1 {
            target = Some(label.clone());
            break;
        }
    }

    // Broadcast both labels to every window; each computes its own border style.
    for (label, win) in windows.iter() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "gaze-target",
            serde_json::json!({ "target": target, "committed": committed }),
        );
        if commit {
            if let Some(t) = &target {
                if t == label {
                    let _ = win.set_focus();
                }
            }
        }
    }
    Ok(target)
}

/// Allocate a unique `project-N` window label.
fn next_window_label(app: &tauri::AppHandle) -> String {
    let mut n = 1;
    loop {
        let label = format!("project-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Pure: the tile rects `(x, y, width, height)` for `count` windows arranged in
/// a generalized grid (`cols = ceil(sqrt(N))`) filling the work area `(ox, oy, w, h)`,
/// in order (row-major: left→right within a row, top→bottom across rows).
fn tile_rects(count: usize, ox: i32, oy: i32, w: i32, h: i32) -> Vec<(i32, i32, u32, u32)> {
    if count == 0 {
        return Vec::new();
    }
    let cols = grid_cols(count);
    let rows: i32 = ((count as i32) + cols - 1) / cols;
    let cell_w = w / cols;
    let cell_h = h / rows;
    (0..count as i32)
        .map(|i| {
            let col = i % cols;
            let row = i / cols;
            (
                ox + col * cell_w,
                oy + row * cell_h,
                cell_w as u32,
                cell_h as u32,
            )
        })
        .collect()
}

/// The first `count` open windows (main first, then project-N ascending). Returns
/// the live window handles in label order. `take`-limited by `count`.
fn sorted_windows(app: &tauri::AppHandle, count: usize) -> Vec<WebviewWindow> {
    let mut windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    // Deterministic order: main first, then project-N ascending.
    windows.sort_by_key(|w| label_rank(w.label()));
    windows.into_iter().take(count).collect()
}

/// Apply one tile rect to a window. Order matters on macOS: `set_size` and
/// `set_position` both dispatch to the main thread asynchronously (tao's
/// `set_content_size_async` / `set_frame_top_left_point_async`), and
/// `setFrameTopLeftPoint` anchors against the window's CURRENT frame size — so
/// resize FIRST (establish correct dimensions), then move to the cell origin.
fn apply_tile(win: &WebviewWindow, rect: (i32, i32, u32, u32)) {
    let (x, y, w, h) = rect;
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Tile the first `count` windows into a grid filling the primary work area.
/// Synchronous (applies all rects immediately) — used at window-creation time
/// (`setup_windows` / restore), where the OS commits each before the next shows.
fn arrange_windows(app: &tauri::AppHandle, count: usize) {
    let tiles = sorted_windows(app, count);
    if tiles.is_empty() {
        return;
    }
    let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
        return;
    };
    let area = monitor.work_area();
    let rects = tile_rects(
        count,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    );
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
    }
}

fn label_rank(label: &str) -> (u8, u32) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("project-").and_then(|s| s.parse().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Pure: labels in reading order — rows top→bottom, left→right within a row.
/// Windows whose y differs by < `row_tolerance` from the row's anchor (first
/// member) are treated as the same row. `positions` is `(label, x, y)`.
fn reading_order(positions: &[(String, i32, i32)], row_tolerance: i32) -> Vec<String> {
    if positions.is_empty() {
        return Vec::new();
    }
    // Sort by y so we can walk top→bottom and group into rows.
    let mut sorted: Vec<&(String, i32, i32)> = positions.iter().collect();
    sorted.sort_by_key(|p| p.2);

    let mut rows: Vec<Vec<&(String, i32, i32)>> = Vec::new();
    for &p in &sorted {
        let need_new_row = match rows.last() {
            // Same row when the y gap to the row's anchor is within tolerance.
            Some(row) => (p.2 - row[0].2).abs() > row_tolerance,
            None => true,
        };
        if need_new_row {
            rows.push(vec![p]);
        } else {
            rows.last_mut().unwrap().push(p);
        }
    }

    // Within each row sort left→right by x, then collect labels in order.
    let mut out = Vec::with_capacity(positions.len());
    for mut row in rows {
        row.sort_by_key(|p| p.1);
        for p in row {
            out.push(p.0.clone());
        }
    }
    out
}

/// Pure: column count for a generalized grid tiling N windows.
/// cols = ceil(sqrt(N)) → 1→1, 2→2, 3→2, 4→2, 6→3, 9→3, 12→4.
fn grid_cols(count: usize) -> i32 {
    if count == 0 {
        return 1;
    }
    ((count as f64).sqrt().ceil() as i32).max(1)
}

/// Every open window's label, in reading order (rows top→bottom, left→right
/// within a row). Tolerance ≈ half the smallest window height so tiled same-row
/// windows group reliably while free-floating windows still get a stable order.
fn compute_window_order(app: &tauri::AppHandle) -> Vec<String> {
    let windows = app.webview_windows();
    let mut positions: Vec<(String, i32, i32)> = Vec::with_capacity(windows.len());
    let mut min_height: i32 = i32::MAX;
    for (label, win) in &windows {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let h = size.height as i32;
        if h > 0 && h < min_height {
            min_height = h;
        }
        positions.push((label.clone(), pos.x, pos.y));
    }
    // Floor the tolerance so a single tiny window doesn't collapse rows together.
    let tolerance = (min_height / 2).max(40);
    reading_order(&positions, tolerance)
}

/// Broadcast the current reading order + focused label to every window so each
/// can derive its own position (e.g. "1/4") and whether it's the active window.
fn broadcast_window_order(app: &tauri::AppHandle) {
    let order = compute_window_order(app);
    let focused = app.state::<FocusedWindow>().0.lock().unwrap().clone();
    let payload = serde_json::json!({ "order": order, "focused": focused });
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "window-order",
            payload.clone(),
        );
    }
}

/// Drain every complete SSE frame (frames are separated by a blank line) from a
/// rolling BYTE buffer, returning each frame's decoded text and leaving any
/// trailing partial frame in `buf`.
///
/// Why a byte buffer instead of decoding each network chunk: `bytes_stream()`
/// splits on arbitrary TCP boundaries, so a multibyte UTF-8 codepoint (emoji,
/// ✓, box-drawing, CJK, accented chars — all common in agent output) can
/// straddle two chunks. Decoding a chunk that ends mid-codepoint replaces the
/// partial bytes with U+FFFD and corrupts the stream for good. A complete frame
/// always ends at an ASCII `\n`, so its bytes never split a codepoint — decoding
/// per-frame is lossless, and any partial tail stays buffered until its rest
/// arrives.
fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        let drained: Vec<u8> = buf.drain(..pos + 2).collect();
        // Bytes before the `\n\n` are the complete frame (whole codepoints).
        frames.push(String::from_utf8_lossy(&drained[..pos]).into_owned());
    }
    frames
}

/// Pure trusted event envelope. Sidecar-provided identity is overwritten; only
/// the bridge's registry-bound pane/session tuple may identify an event.
fn event_envelope(
    mut value: serde_json::Value,
    pane_id: &str,
    session_id: &str,
) -> Option<serde_json::Value> {
    let object = value.as_object_mut()?;
    object.insert("paneId".into(), serde_json::Value::String(pane_id.into()));
    object.insert(
        "sessionId".into(),
        serde_json::Value::String(session_id.into()),
    );
    Some(value)
}

/// Connect to a window's sidecar SSE stream and re-emit each frame ONLY to that
/// window (`emit_to` the window label) as `agent-event`, so windows never see
/// each other's agent activity. Rust has no mixed-content restriction, so the
/// webview never touches plain HTTP directly. Reconnects on stream end.
fn start_event_bridge(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    port: u16,
    session_id: String,
) {
    // Reuse the app's shared HTTP client (cheap Arc clone) so the SSE connect
    // shares the connection pool with the proxy commands.
    let client = app.state::<reqwest::Client>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Stop once this window's active session has moved on (project switch
            // created a new session) or the window is gone — otherwise the old
            // bridge would reconnect to a stale session forever. Session routing
            // is by id now (the daemon port is shared across all windows).
            {
                let state: State<Windows> = app.state();
                let map = state.map.lock().unwrap();
                if !pane_bridge_is_active(&map, &label, &pane_id, &session_id) {
                    log::debug!("event bridge for {label} session {session_id} retired");
                    return;
                }
            }
            // The daemon adds this response to the target session's SSE clients.
            let url = format!(
                "{}/events?session={}",
                sidecar_base(port),
                urlencoding(&session_id)
            );
            match client.get(&url).send().await {
                Ok(res) => {
                    let mut stream = res.bytes_stream();
                    // Raw byte buffer — decode only at frame boundaries so a
                    // codepoint split across TCP chunks is never corrupted.
                    let mut buf: Vec<u8> = Vec::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break };
                        buf.extend_from_slice(&bytes);
                        for frame in drain_sse_frames(&mut buf) {
                            for line in frame.lines() {
                                if let Some(payload) = line.strip_prefix("data: ") {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(payload)
                                    {
                                        let active = {
                                            let state: State<Windows> = app.state();
                                            let map = state.map.lock().unwrap();
                                            pane_bridge_is_active(
                                                &map,
                                                &label,
                                                &pane_id,
                                                &session_id,
                                            )
                                        };
                                        if !active {
                                            return;
                                        }
                                        if let Some(value) =
                                            event_envelope(value, &pane_id, &session_id)
                                        {
                                            let _ = app.emit_to(
                                                EventTarget::webview_window(label.clone()),
                                                "agent-event",
                                                value,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    log::warn!("agent event stream ended, reconnecting");
                }
                Err(e) => {
                    log::error!("failed to connect to event stream: {e}");
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

/// Resolve the Node runtime used to run the sidecar.
///
/// Dev (debug build, or `GG_NODE_BIN` set): use `GG_NODE_BIN`, else bare
/// `"node"` from PATH — matches the workspace developer flow.
///
/// Bundled (release): use the per-platform Node staged as a Tauri `externalBin`,
/// which Tauri places next to the app executable named `ggnode` (`.exe` on
/// Windows). This removes any dependency on a Node install on the user's PATH
/// (a Finder/Dock-launched `.app` gets a minimal PATH without nvm/homebrew).
fn resolve_node(_app: &tauri::AppHandle) -> PathBuf {
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
fn pick_node(env_override: Option<String>, is_dev: bool, exe_dir: Option<&Path>) -> PathBuf {
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
fn resolve_sidecar(app: &tauri::AppHandle) -> PathBuf {
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

/// Path to the workspace dev sidecar, relative to this crate.
fn workspace_sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/ggcoder/dist/app-sidecar.js")
}

/// Pure sidecar-path decision (testable without an AppHandle).
/// - `env_override` (GG_SIDECAR_PATH) always wins.
/// - dev build → workspace `dist/app-sidecar.js`.
/// - bundled → the resolved bundle resource, falling back to the workspace path.
fn pick_sidecar(env_override: Option<String>, is_dev: bool, resource: Option<&Path>) -> PathBuf {
    if let Some(p) = env_override {
        return PathBuf::from(p);
    }
    if is_dev {
        return workspace_sidecar();
    }
    match resource {
        Some(p) => p.to_path_buf(),
        None => workspace_sidecar(),
    }
}

/// Default working directory for the main window. Override with GG_APP_CWD;
/// otherwise the workspace root in dev, or the user's home dir in release.
/// Canonicalized so traversal segments (`../..`) don't leak into the session
/// store path and surface as a stray ".." project in the picker.
fn default_cwd() -> PathBuf {
    let raw = pick_cwd(
        std::env::var("GG_APP_CWD").ok(),
        cfg!(debug_assertions),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
        home_dir(),
    );
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

/// The current user's home directory, from HOME (Unix) / USERPROFILE (Windows).
/// Falls back to "/" only if neither is set (effectively never on a real OS).
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Whether this process can read inside a macOS TCC-protected folder (probed
/// via the user's Documents directory, present on every account). Full Disk
/// Access grants blanket read access to all of them at once; a narrower grant
/// (e.g. only Desktop) would still fail this Documents probe, which is the
/// intentionally strict behavior — the Settings badge should read "not
/// granted" until Full Disk Access covers everything the subagent process
/// might need. Returns `true` immediately on non-macOS (no probe needed).
#[cfg(target_os = "macos")]
fn full_disk_access_granted() -> bool {
    let probe = home_dir().join("Documents");
    std::fs::read_dir(&probe).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn full_disk_access_granted() -> bool {
    true
}

/// Report whether there's an OS permission to grant on this platform, and
/// whether it's currently granted. Windows/Linux have nothing to grant (the
/// subagent-respawn TCC issue is macOS-only), so `applicable` is false and the
/// Settings modal hides the row entirely.
#[tauri::command]
fn permissions_status() -> PermissionsStatus {
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
fn open_permissions_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map_err(|e| e.to_string())?;
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
fn pick_cwd(
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

/// Spawn the ONE shared Node daemon. Reads its `GG_APP_LISTENING` handshake to
/// learn the shared port; on an unexpected exit (its stdout closes while the app
/// is NOT quitting) it respawns the daemon and re-creates every live window's
/// session from its stored `{cwd, session_path}` (Step 9 crash recovery).
///
/// The daemon is a process-group leader (Unix), so `terminate_child` reaps its
/// entire descendant tree (every session's MCP stdio children + LSP servers) in
/// one group-kill — no orphans on quit.
fn set_daemon_startup_error(app: &tauri::AppHandle, message: String) {
    *app.state::<Daemon>().startup_error.lock().unwrap() = Some(message.clone());
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "sidecar-error",
            message.clone(),
        );
    }
}

fn clear_daemon_startup_error(app: &tauri::AppHandle) {
    *app.state::<Daemon>().startup_error.lock().unwrap() = None;
}

fn spawn_daemon(app: tauri::AppHandle, is_respawn: bool) {
    // A retry starts a fresh readiness attempt; any new failure is recorded below.
    clear_daemon_startup_error(&app);
    let script = resolve_sidecar(&app);
    let node = resolve_node(&app);
    log::info!("spawning daemon: {} {}", node.display(), script.display());

    let mut cmd = Command::new(node);
    cmd.arg(&script)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake.
        .env("GG_APP_PORT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => {
            // Record the sidecar PID (== its process-group id on Unix, since it's
            // a group leader). The startup orphan sweep uses this ledger to
            // recognise this sidecar's MCP/LSP children by lineage if the app is
            // later crashed/force-quit — works for ANY MCP server, no name list.
            record_sidecar_pid(c.id() as i32);
            c
        }
        Err(e) => {
            let message = format!("failed to spawn daemon: {e}");
            log::error!("{message}");
            set_daemon_startup_error(&app, message);
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    if let Ok(port) = rest.trim().parse::<u16>() {
                        log::info!("daemon listening on port {port}");
                        *app2.state::<Daemon>().port.lock().unwrap() = Some(port);
                        clear_daemon_startup_error(&app2);
                        // On a respawn the windows already exist with (now
                        // stale) sessions — re-create them all. On the initial
                        // spawn `restore_or_default_windows` drives creation.
                        // (We can't infer respawn from prior port state: the
                        // crash handler resets it to None before respawning so
                        // proxy commands fail fast while the daemon is down.)
                        if is_respawn {
                            recreate_all_window_sessions(app2.clone());
                        }
                    }
                } else {
                    log::debug!("[daemon] {line}");
                }
            }
            // stdout closed → the daemon process exited. If the app isn't
            // quitting, this is a crash: invalidate every daemon-owned runtime
            // identity before respawning so readiness and event bridges cannot
            // observe a stale session on the fresh daemon port.
            let exiting = app2.state::<AppExiting>().0.load(Ordering::SeqCst);
            if !exiting {
                log::warn!("daemon exited unexpectedly — respawning");
                {
                    let daemon: State<Daemon> = app2.state();
                    *daemon.port.lock().unwrap() = None;
                }
                let cleared = {
                    let windows: State<Windows> = app2.state();
                    let mut map = windows.map.lock().unwrap();
                    clear_runtime_session_ids(&mut map)
                };
                log::debug!("cleared {cleared} stale pane session id(s)");
                spawn_daemon(app2.clone(), true);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[daemon:stderr] {line}");
                if line.starts_with("GG_APP_FATAL") {
                    set_daemon_startup_error(&app3, line.clone());
                }
            }
        });
    }

    let daemon: State<Daemon> = app.state();
    *daemon.child.lock().unwrap() = Some(child);
}

/// POST /session to the daemon for `cwd` (+ optional resume `session_path`);
/// returns the new session id or actionable backend/transport failure text.
async fn daemon_create_session(
    app: &tauri::AppHandle,
    port: u16,
    cwd: &Path,
    session_path: Option<&str>,
) -> Result<String, String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let body = serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "sessionPath": session_path,
    });
    let res = client
        .post(format!("{}/session", sidecar_base(port)))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("failed to contact agent daemon: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("failed to read agent daemon response: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        if status.is_success() {
            format!("agent daemon returned an invalid response: {e}")
        } else if text.trim().is_empty() {
            format!("agent daemon rejected session creation ({status})")
        } else {
            format!(
                "agent daemon rejected session creation ({status}): {}",
                text.trim()
            )
        }
    })?;
    if !status.is_success() {
        let detail = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| text.trim());
        return Err(if detail.is_empty() {
            format!("agent daemon rejected session creation ({status})")
        } else {
            format!("agent daemon rejected session creation ({status}): {detail}")
        });
    }
    value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "agent daemon response did not include a session id".to_string())
}

/// DELETE /session/:id on the daemon (best-effort, fire-and-forget).
async fn daemon_delete_session(app: &tauri::AppHandle, port: u16, id: &str) {
    let client = app.state::<reqwest::Client>().inner().clone();
    let _ = client
        .delete(format!(
            "{}/session/{}",
            sidecar_base(port),
            urlencoding(id)
        ))
        .send()
        .await;
}

fn start_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    cwd: PathBuf,
    session_path: Option<String>,
) -> u64 {
    let generation = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock().unwrap();
        record_pane_target(
            &mut map,
            &label,
            &pane_id,
            cwd.clone(),
            session_path.clone(),
        )
    };
    launch_pane_session(app, label, pane_id, cwd, session_path, generation);
    generation
}

fn emit_pane_start_error(app: &tauri::AppHandle, label: &str, pane_id: &str, message: &str) {
    // Session creation is pane-scoped. Only daemon-global failures use
    // `sidecar-error`, otherwise a primary failure could reject a sibling pane.
    let _ = app.emit_to(
        EventTarget::webview_window(label.to_string()),
        "agent-pane-error",
        serde_json::json!({ "paneId": pane_id, "message": message }),
    );
}

fn launch_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    cwd: PathBuf,
    session_path: Option<String>,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        let Some(port) = await_daemon_port(&app).await else {
            let message = "daemon did not start in time".to_string();
            log::error!("{message}; session for {label}/{pane_id} not created");
            let recorded = {
                let windows: State<Windows> = app.state();
                let mut map = windows.map.lock().unwrap();
                record_pane_startup_error(&mut map, &label, &pane_id, generation, message.clone())
            };
            if recorded {
                emit_pane_start_error(&app, &label, &pane_id, &message);
            }
            return;
        };
        match daemon_create_session(&app, port, &cwd, session_path.as_deref()).await {
            Ok(id) => {
                let bound = {
                    let windows: State<Windows> = app.state();
                    let mut map = windows.map.lock().unwrap();
                    bind_pane_session(&mut map, &label, &pane_id, generation, id.clone())
                };
                if !bound {
                    daemon_delete_session(&app, port, &id).await;
                    return;
                }
                start_event_bridge(app.clone(), label.clone(), pane_id.clone(), port, id);
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "agent-pane-ready",
                    serde_json::json!({ "paneId": pane_id, "port": port }),
                );
                if pane_id == PRIMARY_PANE_ID {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "sidecar-ready",
                        port,
                    );
                }
            }
            Err(message) => {
                log::error!("daemon POST /session failed for {label}/{pane_id}: {message}");
                let recorded = {
                    let windows: State<Windows> = app.state();
                    let mut map = windows.map.lock().unwrap();
                    record_pane_startup_error(
                        &mut map,
                        &label,
                        &pane_id,
                        generation,
                        message.clone(),
                    )
                };
                if recorded {
                    emit_pane_start_error(&app, &label, &pane_id, &message);
                }
            }
        }
    });
}

fn start_window_session(
    app: tauri::AppHandle,
    label: String,
    cwd: PathBuf,
    session_path: Option<String>,
) {
    start_pane_session(app, label, PRIMARY_PANE_ID.to_string(), cwd, session_path);
}

/// After daemon respawn, re-create every recorded pane target.
fn recreate_all_window_sessions(app: tauri::AppHandle) {
    let targets = {
        let windows: State<Windows> = app.state();
        let map = windows.map.lock().unwrap();
        enumerate_pane_targets(&map)
    };
    for (label, pane_id, cwd, session_path) in targets {
        start_pane_session(app.clone(), label, pane_id, cwd, session_path);
    }
}

/// Boot the app's windows. If a workspace snapshot has restorable windows (each
/// with a cwd that still exists on disk), reopen one window per entry — pointed
/// at its project + session, with saved geometry — and record a per-window
/// restore target so the webview skips the picker. Otherwise fall back to the
/// single default `main` window at the boot cwd (the picker then shows).
fn restore_or_default_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let ws = read_workspace();
    let entries = filter_restorable(ws.windows, |c| Path::new(c).exists());
    if entries.is_empty() {
        // Fresh boot / nothing to restore: the usual single main window.
        build_app_window(app, "main")?;
        start_window_session(app.clone(), "main".into(), default_cwd(), None);
        broadcast_window_order(app);
        return Ok(());
    }

    let count = entries.len();
    let mut any_geometry = false;
    for (i, entry) in entries.into_iter().enumerate() {
        // First restored window reclaims `main`; the rest get project-N.
        let label = if i == 0 {
            "main".to_string()
        } else {
            format!("project-{i}")
        };
        let win = build_app_window(app, &label)?;
        start_window_session(
            app.clone(),
            label.clone(),
            PathBuf::from(&entry.cwd),
            entry.session_path.clone(),
        );
        // Tell this window which project/session it was restored to, so it skips
        // the picker and hydrates straight away.
        {
            let state: State<RestoreTargets> = app.state();
            state.map.lock().unwrap().insert(
                label,
                RestoreEntry {
                    cwd: entry.cwd.clone(),
                    session_path: entry.session_path.clone(),
                },
            );
        }
        // Apply saved geometry when present; else we tile after the loop.
        if let (Some(x), Some(y)) = (entry.x, entry.y) {
            any_geometry = true;
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let (Some(w), Some(h)) = (entry.width, entry.height) {
            any_geometry = true;
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        }
    }
    if !any_geometry {
        arrange_windows(app, count);
    }
    broadcast_window_order(app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("gg-app".into()),
                    },
                ))
                .build(),
        )
        .manage(Daemon::default())
        .manage(Windows::default())
        .manage(terminal::TerminalRegistry::default())
        .manage(RestoreTargets::default())
        .manage(AppExiting::default())
        .manage(FocusedWindow::default())
        .manage(MoveDebounce::default())
        .manage(LocalPatchedUpdate::default())
        .manage(reqwest::Client::new())
        .invoke_handler(tauri::generate_handler![
            sidecar_port,
            agent_pane_status,
            workspace_target_status,
            terminal::terminal_create,
            terminal::terminal_input,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_open_external,
            agent_pane_create,
            agent_pane_dispose,
            dropped_path_info,
            permissions_status,
            open_permissions_settings,
            read_dropped_file_attachment,
            open_project_path,
            agent_state,
            agent_progress,
            agent_usage,
            agent_prompt,
            agent_cancel,
            agent_ken_prompt,
            agent_ken_cancel,
            agent_autopilot_set,
            agent_accept_plan,
            agent_new_session,
            agent_history,
            agent_auth_apikey,
            agent_auth_oauth_start,
            agent_auth_oauth_code,
            agent_auth_logout,
            agent_kill_task,
            agent_radio_state,
            agent_radio_set,
            agent_tasks,
            agent_run_tasks,
            agent_delete_task,
            agent_cycle_thinking,
            agent_models,
            agent_switch_model,
            agent_switch_ken_model,
            agent_enhance_prompt,
            agent_commands,
            setup_windows,
            new_window,
            open_pane_in_new_window,
            open_whatsnew_window,
            select_project,
            agent_projects,
            agent_sessions,
            agent_files,
            agent_settings,
            agent_save_settings,
            agent_create_project,
            app_settings_get,
            app_settings_save,
            app_create_project,
            app_local_patched_update_start,
            app_auth_status,
            app_auth_apikey,
            app_auth_logout,
            agent_telegram_get,
            agent_telegram_save,
            agent_serve_status,
            agent_serve_start,
            agent_serve_stop,
            agent_mcp_list,
            agent_mcp_add,
            agent_mcp_remove,
            agent_mcp_login,
            gaze_focus,
            focus_window_by_offset,
            arrange_all,
            window_restore_target
        ])
        .setup(|app| {
            // Windows-only: track per-window minimized state so restoring one
            // window can restore its siblings (macOS does this natively).
            #[cfg(target_os = "windows")]
            app.manage(MinimizeState::default());
            // Sweep orphaned sidecars from previous (crashed/force-quit) app
            // instances BEFORE spawning any new sidecars — they'd otherwise
            // accumulate forever across launches. Best-effort + logged.
            // Cross-platform: uses `ps` on Unix, PowerShell CIM on Windows.
            sweep_orphan_sidecars();
            // Spawn the ONE shared Node daemon before any window asks for a
            // session. Window session creation (in restore/setup) awaits its
            // `GG_APP_LISTENING` port via `await_daemon_port`.
            spawn_daemon(app.handle().clone(), false);
            // Restore the previous session's windows (each at its project +
            // session) when a workspace snapshot exists; otherwise build the
            // single default `main` window. Windows are built in code (not from
            // config) so macOS gets `hidden_title(true)` via the builder.
            restore_or_default_windows(&app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                terminal::close_for_window(
                    &app.state::<terminal::TerminalRegistry>(),
                    window.label(),
                );
                // Dispose only THIS window's session in the shared daemon so
                // other projects keep running. The daemon process itself is
                // never killed here (that happens only on app exit).
                let state: State<Windows> = window.state();
                let pane_sessions =
                    take_window_panes(&mut state.map.lock().unwrap(), window.label());
                // A deliberate close rewrites persistence from surviving labels,
                // so duplicate cwd/session targets remain independent.
                let exiting = app.state::<AppExiting>().0.load(Ordering::SeqCst);
                if !exiting {
                    snapshot_workspace_excluding(app, Some(window.label()));
                }
                if let Some(port) = *app.state::<Daemon>().port.lock().unwrap() {
                    for pane in pane_sessions {
                        if let Some(id) = pane.session_id {
                            let app2 = app.clone();
                            tauri::async_runtime::spawn(async move {
                                daemon_delete_session(&app2, port, &id).await;
                            });
                        }
                    }
                }
                // Update peers: the closed window is gone from the reading order.
                broadcast_window_order(app);
            }
            // Track which window holds keyboard focus and notify peers so each
            // can dim/brighten its position label + input border.
            tauri::WindowEvent::Focused(focused) if *focused => {
                let app = window.app_handle().clone();
                {
                    let state: State<FocusedWindow> = app.state();
                    *state.0.lock().unwrap() = Some(window.label().to_string());
                }
                broadcast_window_order(&app);
            }
            // Windows-only: a single taskbar click un-minimizes just the picked
            // window. Cascade the restore to its siblings so the whole workspace
            // reopens together, like macOS. Compiled out on macOS (falls to `_`).
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Resized(_) => {
                restore_sibling_windows(window);
            }
            // Debounced: native drag fires Moved per pixel. Only the last move's
            // deferred task fires (its captured Instant still matches), so peers
            // learn the new reading order ~150ms after the drag settles.
            tauri::WindowEvent::Moved(_) => {
                let app = window.app_handle().clone();
                let now = std::time::Instant::now();
                {
                    let state: State<MoveDebounce> = app.state();
                    *state.0.lock().unwrap() = Some(now);
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let fire = {
                        let state: State<MoveDebounce> = app.state();
                        let guard = state.0.lock().unwrap();
                        *guard == Some(now)
                    };
                    if fire {
                        broadcast_window_order(&app);
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Mark the quit BEFORE windows start tearing down, so the
                // Destroyed handlers preserve the snapshot, then write the final
                // snapshot (current geometry + each window's live cwd/session).
                app.state::<AppExiting>().0.store(true, Ordering::SeqCst);
                refresh_live_sessions(app);
                snapshot_workspace(app);
                terminal::close_all(&app.state::<terminal::TerminalRegistry>());
                // Terminate the daemon's process group once — reaps every
                // session's MCP/LSP children in one shot (no orphans).
                let child = app.state::<Daemon>().child.lock().unwrap().take();
                if let Some(child) = child {
                    terminate_child(child);
                }
            }
        });
}

/// Before the final exit snapshot, re-read each live session's `/state` (via the
/// shared daemon, keyed by the window's `x-gg-session` header) so a window that
/// started a new session mid-run (changing its session file) is recorded at its
/// CURRENT session, not the one it was created with. Best-effort + time-boxed:
/// any window we can't reach keeps its last-known session_path.
fn refresh_live_sessions(app: &tauri::AppHandle) {
    let Some(port) = *app.state::<Daemon>().port.lock().unwrap() else {
        return;
    };
    let targets: Vec<(String, String, String)> = {
        let state: State<Windows> = app.state();
        let map = state.map.lock().unwrap();
        map.iter()
            .flat_map(|(label, panes)| {
                panes.iter().filter_map(move |(pane_id, pane)| {
                    pane.session_id
                        .clone()
                        .map(|id| (label.clone(), pane_id.clone(), id))
                })
            })
            .collect()
    };
    if targets.is_empty() {
        return;
    }
    let client = app.state::<reqwest::Client>().inner().clone();
    // The exit callback runs on the main event-loop thread (outside the async
    // runtime), so block_on is safe here. Each request is time-boxed so a hung
    // session can't stall quit.
    let results: Vec<(String, String, String, Option<String>, Option<PathBuf>)> =
        tauri::async_runtime::block_on(async {
            let mut out = Vec::with_capacity(targets.len());
            for (label, pane_id, sid) in targets {
                let url = format!("{}/state", sidecar_base(port));
                let req = client
                    .get(&url)
                    .header("x-gg-session", &sid)
                    .timeout(std::time::Duration::from_millis(400))
                    .send()
                    .await;
                let Ok(res) = req else {
                    continue;
                };
                let Ok(body) = res.json::<serde_json::Value>().await else {
                    continue;
                };
                let session_path = body
                    .get("sessionPath")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let cwd = body
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from);
                out.push((label, pane_id, sid, session_path, cwd));
            }
            out
        });
    let state: State<Windows> = app.state();
    let mut map = state.map.lock().unwrap();
    for (label, pane_id, session_id, session_path, cwd) in results {
        if !pane_bridge_is_active(&map, &label, &pane_id, &session_id) {
            continue;
        }
        if let Some(inst) = map
            .get_mut(&label)
            .and_then(|panes| panes.get_mut(&pane_id))
        {
            if session_path.is_some() {
                inst.session_path = session_path;
            }
            if let Some(cwd) = cwd {
                inst.cwd = Some(cwd);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(session_id: &str, cwd: &str) -> PaneSession {
        PaneSession {
            session_id: Some(session_id.into()),
            cwd: Some(PathBuf::from(cwd)),
            session_path: None,
            generation: 1,
            startup_error: None,
        }
    }

    #[test]
    fn event_envelope_overwrites_untrusted_identity() {
        let value = event_envelope(
            serde_json::json!({ "type": "text", "paneId": "evil", "sessionId": "fake" }),
            "right",
            "trusted-session",
        )
        .unwrap();
        assert_eq!(value["type"], "text");
        assert_eq!(value["paneId"], "right");
        assert_eq!(value["sessionId"], "trusted-session");
    }

    #[test]
    fn pane_routes_are_owner_scoped_and_default_to_primary() {
        let mut registry = PaneRegistry::new();
        registry
            .entry("window-a".into())
            .or_default()
            .insert(PRIMARY_PANE_ID.into(), pane("a-primary", "/a/primary"));
        registry
            .get_mut("window-a")
            .unwrap()
            .insert("right".into(), pane("a-right", "/a/right"));
        registry
            .entry("window-b".into())
            .or_default()
            .insert("right".into(), pane("b-right", "/b/right"));

        let primary = pane_id_or_primary(None).unwrap();
        assert_eq!(
            resolve_owned_pane(&registry, "window-a", primary)
                .unwrap()
                .session_id
                .as_deref(),
            Some("a-primary")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "window-a", "right")
                .unwrap()
                .session_id
                .as_deref(),
            Some("a-right")
        );
        assert_eq!(
            resolve_owned_pane(&registry, "window-b", "right")
                .unwrap()
                .session_id
                .as_deref(),
            Some("b-right")
        );
        assert!(resolve_owned_pane(&registry, "window-b", PRIMARY_PANE_ID).is_none());
    }

    #[test]
    fn stale_pane_session_tuple_is_rejected() {
        let mut registry = PaneRegistry::new();
        registry
            .entry("window-a".into())
            .or_default()
            .insert("right".into(), pane("current", "/a/right"));
        assert!(pane_bridge_is_active(
            &registry, "window-a", "right", "current"
        ));
        assert!(!pane_bridge_is_active(
            &registry, "window-a", "right", "stale"
        ));
        assert!(!pane_bridge_is_active(
            &registry, "window-b", "right", "current"
        ));
    }

    #[test]
    fn keep_for_snapshot_excludes_picker_windows() {
        let default = Path::new("/home/user");
        // No project chosen yet → excluded.
        assert!(!keep_for_snapshot(None, default));
        // Still on the default boot cwd (picker) → excluded.
        assert!(!keep_for_snapshot(Some(Path::new("/home/user")), default));
        // A real project → kept.
        assert!(keep_for_snapshot(
            Some(Path::new("/home/user/proj")),
            default
        ));
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
        // The second entry omits optional fields entirely (skip_serializing_if).
        assert!(!json.contains("\"sessionPath\":null"));
    }

    #[test]
    fn snapshot_labels_exclude_registry_only_reservations_and_the_destroyed_window() {
        let live_labels = vec!["project-2".to_string(), "main".to_string()];

        assert_eq!(
            live_snapshot_labels(live_labels.iter(), Some("main")),
            vec!["project-2"]
        );
        assert!(!live_snapshot_labels(live_labels.iter(), None)
            .iter()
            .any(|label| label == "project-1"));
    }

    #[test]
    fn duplicate_workspace_targets_roundtrip_independently() {
        let duplicate = WorkspaceEntry {
            cwd: "/p/shared".into(),
            session_path: Some("/s/shared.jsonl".into()),
            ..Default::default()
        };
        let workspace = Workspace {
            windows: vec![duplicate.clone(), duplicate],
        };

        let json = serde_json::to_string(&workspace).unwrap();
        let restored: Workspace = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.windows.len(), 2);
        assert_eq!(restored.windows[0], restored.windows[1]);
    }

    #[test]
    fn workspace_parses_minimal_entry() {
        // Forward/backward compat: a bare { cwd } entry still loads.
        let ws: Workspace = serde_json::from_str(r#"{ "windows": [{ "cwd": "/p/a" }] }"#).unwrap();
        assert_eq!(ws.windows.len(), 1);
        assert_eq!(ws.windows[0].cwd, "/p/a");
        assert_eq!(ws.windows[0].session_path, None);
    }

    #[test]
    fn empty_or_missing_workspace_is_default() {
        let ws: Workspace = serde_json::from_str("{}").unwrap();
        assert!(ws.windows.is_empty());
    }

    #[test]
    fn resolve_apikey_target_gates_on_apikey_support() {
        // OAuth-only provider → not an API-key provider.
        assert!(resolve_apikey_target("anthropic", None).is_none());
        // Unknown provider → None.
        assert!(resolve_apikey_target("nope", None).is_none());
        // API-key provider with no custom base URL, no variants.
        assert_eq!(
            resolve_apikey_target("glm", None),
            Some(("glm".to_string(), None)),
        );
        // Moonshot supports both oauth + apikey, no variants.
        assert_eq!(
            resolve_apikey_target("moonshot", None),
            Some(("moonshot".to_string(), None)),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_defaults_to_token_plan() {
        // No variant requested → first/primary variant (Token Plan), storage
        // key unchanged from the provider id for backward compat.
        assert_eq!(
            resolve_apikey_target("xiaomi", None),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_credits_variant() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("xiaomi-credits")),
            Some((
                "xiaomi-credits".to_string(),
                Some("https://api.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_unknown_variant_falls_back_to_first() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("bogus")),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn apply_logout_xiaomi_drops_both_variant_keys() {
        let existing = r#"{ "xiaomi": { "accessToken": "tp", "refreshToken": "", "expiresAt": 1 }, "xiaomi-credits": { "accessToken": "cr", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "xiaomi").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xiaomi").is_none());
        assert!(v.get("xiaomi-credits").is_none());
    }

    #[test]
    fn apikey_credential_has_far_future_expiry_and_optional_base_url() {
        let now = 1_000_000_000_000i64;
        let cred = apikey_credential_json("sk-test", None, now);
        assert_eq!(cred["accessToken"], "sk-test");
        assert_eq!(cred["refreshToken"], "");
        assert_eq!(cred["expiresAt"].as_i64().unwrap(), now + API_KEY_TTL_MS);
        assert!(cred.get("baseUrl").is_none());

        let with_url = apikey_credential_json("k", Some("https://x/v1"), now);
        assert_eq!(with_url["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_creates_file_when_missing() {
        let out = apply_apikey(None, "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["glm"]["accessToken"], "sk-1");
    }

    #[test]
    fn apply_apikey_preserves_other_providers() {
        let existing = r#"{ "anthropic": { "accessToken": "oauth-tok", "refreshToken": "r", "expiresAt": 5 } }"#;
        let out = apply_apikey(Some(existing), "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // New provider added.
        assert_eq!(v["glm"]["accessToken"], "sk-1");
        // Existing provider untouched.
        assert_eq!(v["anthropic"]["accessToken"], "oauth-tok");
        assert_eq!(v["anthropic"]["refreshToken"], "r");
    }

    #[test]
    fn apply_apikey_carries_base_url() {
        let out = apply_apikey(None, "xiaomi", Some("https://x/v1"), 0, "sk-2").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["xiaomi"]["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_rejects_malformed_file() {
        assert!(apply_apikey(Some("not json"), "glm", None, 0, "k").is_err());
        assert!(apply_apikey(Some("[1,2,3]"), "glm", None, 0, "k").is_err());
    }

    #[test]
    fn apply_logout_removes_provider() {
        let existing = r#"{ "glm": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 }, "openai": { "accessToken": "o", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "glm").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("glm").is_none());
        assert_eq!(v["openai"]["accessToken"], "o");
    }

    #[test]
    fn apply_logout_moonshot_drops_both_keys() {
        let existing = r#"{ "moonshot": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "moonshot-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "moonshot").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("moonshot").is_none());
        assert!(v.get("moonshot-oauth").is_none());
    }

    #[test]
    fn apply_logout_missing_file_is_empty_object() {
        let out = apply_logout(None, "glm").unwrap();
        assert_eq!(out.trim(), "{}");
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
    fn window_chrome_matches_target_os() {
        let got = window_chrome();
        if cfg!(target_os = "macos") {
            assert_eq!(got, WindowChrome::MacOverlay);
        } else {
            assert_eq!(got, WindowChrome::Native);
        }
    }

    // ── SSE frame decoding (drain_sse_frames) ────────────────────────────────

    #[test]
    fn drains_complete_frames_and_keeps_partial() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: one\n\ndata: two\n\ndata: par");
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec!["data: one".to_string(), "data: two".to_string()]
        );
        // The unterminated "data: par" stays buffered for the next chunk.
        assert_eq!(buf, b"data: par");
    }

    #[test]
    fn no_complete_frame_leaves_buffer_intact() {
        let mut buf: Vec<u8> = b"data: incomplete\n".to_vec();
        assert!(drain_sse_frames(&mut buf).is_empty());
        assert_eq!(buf, b"data: incomplete\n");
    }

    #[test]
    fn multibyte_codepoint_split_across_chunks_is_not_corrupted() {
        // "✓ 🚀 café" — ✓ (3 bytes), 🚀 (4 bytes), é (2 bytes). Feed the
        // frame one byte at a time so every codepoint straddles a chunk
        // boundary. The old per-chunk from_utf8_lossy would emit U+FFFD; the
        // byte-buffered drainer must reconstruct the exact text.
        let payload = "data: ✓ 🚀 café";
        let wire = format!("{payload}\n\n");
        let mut buf: Vec<u8> = Vec::new();
        let mut frames: Vec<String> = Vec::new();
        for &byte in wire.as_bytes() {
            buf.push(byte);
            frames.extend(drain_sse_frames(&mut buf));
        }
        assert_eq!(frames, vec![payload.to_string()]);
        assert!(
            !frames[0].contains('\u{FFFD}'),
            "no replacement chars: {:?}",
            frames[0]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let mut buf: Vec<u8> = b"data: a\n\ndata: b\n\ndata: c\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames, vec!["data: a", "data: b", "data: c"]);
        assert!(buf.is_empty());
    }

    // ── orphan_killset classifier tests ──────────────────────────────────────

    /// Helper: build a ProcInfo row whose process group is itself (a group
    /// leader / a process not tracked by lineage). Good enough for the
    /// name+descendant cases; use `proc_g` to set an explicit pgid.
    fn proc(pid: i32, ppid: i32, command: &str) -> ProcInfo {
        proc_g(pid, ppid, pid, command)
    }

    /// Helper: build a ProcInfo row with an explicit process-group id — used to
    /// model MCP/LSP children that inherited a (now-dead) sidecar's pgid.
    fn proc_g(pid: i32, ppid: i32, pgid: i32, command: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            pgid,
            command: command.to_string(),
        }
    }

    /// The empty ledger — for tests that exercise only name + descendant rules.
    fn no_ledger() -> HashSet<i32> {
        HashSet::new()
    }

    /// A ledger containing the given sidecar pgids.
    fn ledger(pgids: &[i32]) -> HashSet<i32> {
        pgids.iter().copied().collect()
    }

    #[test]
    fn orphan_sidecar_with_ppid_1_is_killed() {
        // A sidecar reparented to init is an orphan (matched by our own name).
        let snap = vec![proc(500, 1, "node /app/sidecar/app-sidecar.mjs")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert_eq!(ks, vec![500]);
    }

    #[test]
    fn live_sidecar_with_alive_parent_is_excluded() {
        // The current gg-app (pid 100) is the parent of a live sidecar (pid 200).
        let snap = vec![
            proc(100, 1, "/Applications/GG Coder.app/Contents/MacOS/gg-app"),
            proc(200, 100, "ggnode app-sidecar.mjs"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "live sidecar must not be killed: {ks:?}");
    }

    #[test]
    fn orphan_sidecar_with_dead_parent_not_in_snapshot() {
        // Parent pid 999 is absent from the snapshot and ≠ 1 → dead → orphan.
        let snap = vec![proc(300, 999, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&300));
    }

    #[test]
    fn reparented_mcp_child_killed_by_group_lineage() {
        // THE crash case: the sidecar (pgid 500) is long gone; its MCP child
        // reparented to init (ppid 1) but kept pgid 500. The command is an
        // arbitrary user-added MCP name we've never heard of. With 500 in the
        // ledger and no live pid==500, lineage kills it — no name whitelist.
        let snap = vec![proc_g(701, 1, 500, "node some-random-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert_eq!(ks, vec![701]);
    }

    #[test]
    fn reparented_mcp_child_spared_when_group_leader_alive() {
        // Same shape, but a process with pid==500 is still alive (a live sidecar,
        // or a recycled pid). The group is NOT dead → its members are left alone.
        // The live app (pid 100, self) is in the snapshot so the sidecar's parent
        // reads as alive too.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc(500, 100, "ggnode app-sidecar.mjs"),
            proc_g(701, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "live-group members must be spared: {ks:?}");
    }

    #[test]
    fn unledgered_group_is_not_killed_by_lineage() {
        // A reparented process whose pgid is NOT in the ledger is none of our
        // business — lineage only fires for groups we recorded spawning.
        let snap = vec![proc_g(701, 1, 900, "node some-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "unledgered group must be spared: {ks:?}");
    }

    #[test]
    fn orphan_descendant_tree_is_collected() {
        // sidecar(500, orphaned) → npm exec(501) → node kencode-search(502).
        // Children still linked to the in-snapshot dead sidecar are caught by
        // the descendant walk regardless of their names.
        let snap = vec![
            proc(500, 1, "node app-sidecar.js"),
            proc(501, 500, "npm exec @kenkaiiii/kencode-search"),
            proc(502, 501, "node kencode-search"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&500));
        assert!(ks.contains(&501));
        assert!(ks.contains(&502));
        assert_eq!(ks.len(), 3);
    }

    #[test]
    fn current_app_pid_never_killed() {
        // Even if self somehow matches a pattern and has a dead parent, exclude it.
        let snap = vec![proc(100, 1, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "self pid must never be in killset: {ks:?}");
    }

    #[test]
    fn unrelated_node_with_dead_parent_excluded() {
        // A vite process with a dead parent, no matching name, no ledgered group
        // → excluded.
        let snap = vec![proc(800, 1, "node vite")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(
            ks.is_empty(),
            "non-matching process must not be killed: {ks:?}"
        );
    }

    #[test]
    fn dedup_when_descendant_also_matches_lineage() {
        // sidecar(500, orphaned) → MCP child(501) sharing pgid 500. 501 is both a
        // descendant AND a lineage member. It must appear exactly once.
        let snap = vec![
            proc_g(500, 1, 500, "node app-sidecar.js"),
            proc_g(501, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        let count_501 = ks.iter().filter(|&&p| p == 501).count();
        assert_eq!(count_501, 1, "pid 501 must appear exactly once: {ks:?}");
        assert_eq!(ks.len(), 2);
    }

    #[test]
    fn multi_instance_concurrent_dev_runs_safe() {
        // Two gg-app instances each with their own live sidecar. Both sidecar
        // pgids are ledgered, but both leaders are alive → neither is swept.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc_g(200, 100, 200, "node app-sidecar.js"),
            proc(300, 1, "gg-app"),
            proc_g(400, 300, 400, "node app-sidecar.js"),
        ];
        let led = ledger(&[200, 400]);
        // Instance 1 sweeps.
        assert!(orphan_killset(&snap, 100, &led).is_empty());
        // Instance 2 sweeps.
        assert!(orphan_killset(&snap, 300, &led).is_empty());
    }

    // ── Output parser tests (cross-platform) ────────────────────────────────
    // These verify the parsing of real OS process-listing output so the Windows
    // CIM path is exercised on macOS (where the Windows snapshot command can't
    // run, but the parser can).

    #[test]
    fn parse_ps_handles_column_padding_and_spaces_in_command() {
        // Real `ps -eo pid=,ppid=,pgid=,command=` output: multiple spaces
        // between fields. Columns are pid, ppid, pgid, then the command.
        let raw = "    1     0     1 /sbin/launchd\n\
                   11541     1 11541 /Applications/GG Coder.app/Contents/MacOS/gg-app\n\
                   11553 11541 11553 /Applications/GG Coder.app/Contents/MacOS/ggnode app-sidecar.mjs";
        let rows = parse_ps_output(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pid, 1);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].pgid, 1);
        assert_eq!(rows[0].command, "/sbin/launchd");
        // The sidecar is its own group leader (pgid == pid).
        assert_eq!(rows[2].pgid, 11553);
        // Command with spaces is rejoined correctly.
        assert!(rows[2].command.contains("app-sidecar.mjs"));
        assert!(rows[2].command.contains("ggnode"));
    }

    #[test]
    fn parse_ps_skips_unparseable_lines() {
        let raw = "pid ppid pgid command\n\
                   abc def ghi not-a-number\n\
                   42 1 42 node";
        let rows = parse_ps_output(raw);
        // Header + garbage lines are skipped; only the valid row survives.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
        assert_eq!(rows[0].pgid, 42);
    }

    #[test]
    fn parse_cim_handles_pipe_delimited_output() {
        // Real PowerShell CIM output: pid|ppid|CommandLine.
        let raw = "4|0|\n\
                   5204|5200|C:\\Program Files\\nodejs\\node.exe app-sidecar.mjs\n\
                   5300|5204|C:\\Program Files\\nodejs\\node.exe kencode-search";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 3);
        // Kernel process with empty CommandLine.
        assert_eq!(rows[0].pid, 4);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].command, "");
        // Sidecar with full path.
        assert!(rows[1].command.contains("app-sidecar.mjs"));
        // kencode grandchild.
        assert_eq!(rows[2].ppid, 5204);
        assert!(rows[2].command.contains("kencode-search"));
    }

    #[test]
    fn parse_cim_command_with_pipe_is_preserved() {
        // A command line containing a pipe character must not be split further.
        let raw = "100|1|cmd /c echo hi | findstr foo";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 100);
        assert_eq!(rows[0].ppid, 1);
        // The third field captures everything after the second '|'.
        assert_eq!(rows[0].command, "cmd /c echo hi | findstr foo");
    }

    #[test]
    fn parse_cim_skips_blank_and_garbage_lines() {
        let raw = "\n\
                   \r\n\
                   abc|def|garbage\n\
                   42|1|node app-sidecar.mjs";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
    }

    #[test]
    fn full_windows_sweep_pipeline() {
        // End-to-end: CIM output → parse → classify → killset. Simulates a
        // Windows machine where a previous gg-app instance was force-quit,
        // orphaning its sidecar tree (parent PIDs absent from the snapshot).
        let raw = "4|0|\n\
                   1000|4|C:\\Windows\\System32\\cmd.exe\n\
                   5000|9999|C:\\nodejs\\node.exe app-sidecar.mjs\n\
                   5001|5000|C:\\nodejs\\node.exe kencode-search\n\
                   6000|4|C:\\Program Files\\GG Coder\\gg-app.exe\n\
                   6001|6000|C:\\nodejs\\node.exe app-sidecar.mjs";
        let snapshot = parse_cim_output(raw);
        assert_eq!(snapshot.len(), 6);
        // Self = the new gg-app (pid 6000). Its sidecar (6001) has a live parent.
        // Windows has no pgid (all 0), so classification relies on the sidecar
        // name (5000) + descendant walk (5001) — ledger is irrelevant here.
        let killset = orphan_killset(&snapshot, 6000, &no_ledger());
        // Orphaned sidecar (5000, parent 9999 dead) + its kencode child (5001).
        assert!(killset.contains(&5000));
        assert!(killset.contains(&5001));
        // Live sidecar (6001) must NOT be killed.
        assert!(!killset.contains(&6001));
        assert_eq!(killset.len(), 2);
    }

    // ── reading_order + grid_cols tests ───────────────────────────────────────

    /// Helper: build a (label, x, y) position tuple.
    fn pos(label: &str, x: i32, y: i32) -> (String, i32, i32) {
        (label.to_string(), x, y)
    }

    #[test]
    fn reading_order_empty_is_empty() {
        assert!(reading_order(&[], 50).is_empty());
    }

    #[test]
    fn reading_order_2x2_grid_is_reading_order() {
        // Four quadrants given out of order → TL, TR, BL, BR.
        let positions = vec![
            pos("br", 500, 400),
            pos("tl", 0, 0),
            pos("tr", 500, 0),
            pos("bl", 0, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["tl", "tr", "bl", "br"]);
    }

    #[test]
    fn reading_order_single_row_left_to_right() {
        // Three same-row windows given out of order → left, center, right.
        let positions = vec![pos("c", 500, 0), pos("a", 0, 0), pos("b", 250, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn reading_order_tolerance_groups_nearby_rows() {
        // Two windows whose y differs by 30 (< tolerance 50) → same row, x order.
        let positions = vec![pos("b", 500, 30), pos("a", 0, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b"]);
    }

    #[test]
    fn reading_order_large_gap_splits_rows() {
        // y gap of 400 (> tolerance 50) → separate rows.
        let positions = vec![pos("top", 500, 0), pos("bot", 0, 400)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["top", "bot"]);
    }

    #[test]
    fn reading_order_three_rows() {
        // 3×2 grid (6 windows) → row1 L→R, row2 L→R, row3 L→R.
        let positions = vec![
            pos("c", 500, 0),
            pos("f", 500, 800),
            pos("a", 0, 0),
            pos("e", 0, 800),
            pos("d", 0, 400),
            pos("b", 500, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "c", "d", "b", "e", "f"]);
    }

    #[test]
    fn grid_cols_generalizes_any_count() {
        assert_eq!(grid_cols(0), 1); // guard against division-by-zero
        assert_eq!(grid_cols(1), 1);
        assert_eq!(grid_cols(2), 2);
        assert_eq!(grid_cols(3), 2);
        assert_eq!(grid_cols(4), 2);
        assert_eq!(grid_cols(5), 3);
        assert_eq!(grid_cols(6), 3);
        assert_eq!(grid_cols(7), 3);
        assert_eq!(grid_cols(8), 3);
        assert_eq!(grid_cols(9), 3);
        assert_eq!(grid_cols(12), 4);
    }

    #[test]
    fn tile_rects_fills_work_area_row_major() {
        // 1920×1080 work area, origin (0,0). 4 windows → 2×2.
        let rects = tile_rects(4, 0, 0, 1920, 1080);
        assert_eq!(rects.len(), 4);
        // Row 0: left & right halves.
        assert_eq!(rects[0], (0, 0, 960, 540));
        assert_eq!(rects[1], (960, 0, 960, 540));
        // Row 1: left & right halves.
        assert_eq!(rects[2], (0, 540, 960, 540));
        assert_eq!(rects[3], (960, 540, 960, 540));
    }

    #[test]
    fn tile_rects_five_is_three_cols_two_rows() {
        // 5 windows → cols=3, rows=2. The last two land in row 1 (col 0 & 1).
        let rects = tile_rects(5, 0, 0, 3000, 1000);
        assert_eq!(rects.len(), 5);
        let cell_w = 3000 / 3; // 1000
        let cell_h = 1000 / 2; // 500
                               // Indices 3 & 4 are the bottom row — they must be sized to the cell.
        assert_eq!(rects[3], (0, cell_h, cell_w as u32, cell_h as u32));
        assert_eq!(rects[4], (cell_w, cell_h, cell_w as u32, cell_h as u32));
    }

    #[test]
    fn tile_rects_empty_is_empty() {
        assert!(tile_rects(0, 0, 0, 1920, 1080).is_empty());
    }

    // ── Pane registry ownership + lifecycle ─────────────────────────────────
    // Pure tests lock in nested ownership and generalized pane lifecycle rules.

    #[test]
    fn pane_registry_scopes_identical_pane_ids_by_owner() {
        let mut registry = PaneRegistry::new();
        let main_generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            Some("/s/a.jsonl".into()),
        );
        let peer_generation = record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/b"),
            None,
        );

        assert!(bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            main_generation,
            "id-1".into(),
        ));
        assert!(bind_pane_session(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            peer_generation,
            "id-2".into(),
        ));

        let main = resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).unwrap();
        let peer = resolve_owned_pane(&registry, "project-1", PRIMARY_PANE_ID).unwrap();
        assert_eq!(main.session_id.as_deref(), Some("id-1"));
        assert_eq!(main.cwd.as_deref(), Some(Path::new("/p/a")));
        assert_eq!(main.session_path.as_deref(), Some("/s/a.jsonl"));
        assert_eq!(peer.session_id.as_deref(), Some("id-2"));
        assert!(resolve_owned_pane(&registry, "missing", PRIMARY_PANE_ID).is_none());
    }

    #[test]
    fn replacing_pane_target_rejects_stale_session_binding() {
        let mut registry = PaneRegistry::new();
        let old_generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        let new_generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/b"),
            None,
        );

        assert!(new_generation > old_generation);
        assert!(!bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            old_generation,
            "stale-id".into(),
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            new_generation,
            "current-id".into(),
        ));
        assert!(!bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            new_generation,
            "duplicate-id".into(),
        ));

        let pane = resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).unwrap();
        assert_eq!(pane.cwd.as_deref(), Some(Path::new("/p/b")));
        assert_eq!(pane.session_id.as_deref(), Some("current-id"));
        assert!(pane_bridge_is_active(
            &registry,
            "main",
            PRIMARY_PANE_ID,
            "current-id",
        ));
        assert!(!pane_bridge_is_active(
            &registry,
            "main",
            PRIMARY_PANE_ID,
            "stale-id",
        ));
    }

    #[test]
    fn taking_a_pane_prunes_only_its_empty_owner() {
        let mut registry = PaneRegistry::new();
        let primary_generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/b"),
            None,
        );
        record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/c"),
            None,
        );
        assert!(bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            primary_generation,
            "id-1".into(),
        ));

        let removed = take_pane_session(&mut registry, "main", PRIMARY_PANE_ID).unwrap();
        assert_eq!(removed.session_id.as_deref(), Some("id-1"));
        assert!(resolve_owned_pane(&registry, "main", "secondary").is_some());
        assert!(resolve_owned_pane(&registry, "project-1", PRIMARY_PANE_ID).is_some());

        assert!(take_pane_session(&mut registry, "main", "secondary").is_some());
        assert!(!registry.contains_key("main"));
        assert!(registry.contains_key("project-1"));
    }

    #[test]
    fn taking_window_panes_drains_that_owner_and_preserves_peers() {
        let mut registry = PaneRegistry::new();
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/b"),
            None,
        );
        record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/c"),
            None,
        );

        let removed = take_window_panes(&mut registry, "main");
        assert_eq!(removed.len(), 2);
        assert!(!registry.contains_key("main"));
        assert!(registry.contains_key("project-1"));
        assert!(take_window_panes(&mut registry, "missing").is_empty());
    }

    #[test]
    fn respawn_enumeration_preserves_every_pane_target() {
        let mut registry = PaneRegistry::new();
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            Some("/s/a.jsonl".into()),
        );
        record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/b"),
            Some("/s/b.jsonl".into()),
        );
        record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/c"),
            None,
        );

        let mut targets = enumerate_pane_targets(&registry);
        targets.sort();
        assert_eq!(
            targets,
            vec![
                (
                    "main".into(),
                    PRIMARY_PANE_ID.into(),
                    PathBuf::from("/p/a"),
                    Some("/s/a.jsonl".into()),
                ),
                (
                    "main".into(),
                    "secondary".into(),
                    PathBuf::from("/p/b"),
                    Some("/s/b.jsonl".into()),
                ),
                (
                    "project-1".into(),
                    PRIMARY_PANE_ID.into(),
                    PathBuf::from("/p/c"),
                    None,
                ),
            ]
        );
    }

    #[test]
    fn pane_copy_live_state_clears_stale_session_and_timeout_keeps_durable_target() {
        let durable = PaneCopyTarget {
            cwd: PathBuf::from("/p/durable"),
            session_path: Some("/s/stale.jsonl".into()),
            session_id: "source-runtime".into(),
        };

        let live = merge_live_pane_copy_target(
            durable.clone(),
            Some(&serde_json::json!({ "cwd": "/p/live" })),
        );
        assert_eq!(live.cwd, PathBuf::from("/p/live"));
        assert_eq!(live.session_path, None);

        let timed_out = merge_live_pane_copy_target(durable.clone(), None);
        assert_eq!(timed_out, durable);
    }

    #[test]
    fn concurrent_pane_copy_reservations_choose_distinct_native_window_labels() {
        let mut registry = PaneRegistry::new();
        let first = next_project_window_label(&registry, |label| label == "project-2");
        assert_eq!(first, "project-1");
        record_pane_target(
            &mut registry,
            &first,
            PRIMARY_PANE_ID,
            PathBuf::from("/p/shared"),
            None,
        );

        let second = next_project_window_label(&registry, |label| label == "project-2");
        assert_eq!(second, "project-3");
    }

    #[test]
    fn pane_copy_resolution_is_owner_scoped_and_copy_identity_is_distinct() {
        let mut registry = PaneRegistry::new();
        let source_generation = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/shared"),
            Some("/s/shared.jsonl".into()),
        );
        let peer_generation = record_pane_target(
            &mut registry,
            "peer",
            "secondary",
            PathBuf::from("/p/peer"),
            None,
        );
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "secondary",
            source_generation,
            "source-runtime".into(),
        ));
        assert!(bind_pane_session(
            &mut registry,
            "peer",
            "secondary",
            peer_generation,
            "peer-runtime".into(),
        ));

        let source = resolve_pane_copy_target(&registry, "main", "secondary").unwrap();
        assert_eq!(source.cwd, PathBuf::from("/p/shared"));
        assert_eq!(source.session_id, "source-runtime");
        assert!(resolve_pane_copy_target(&registry, "missing", "secondary").is_err());

        let destination_generation = create_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            source.cwd.clone(),
            source.session_path.clone(),
        )
        .unwrap();
        assert!(bind_pane_session(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            destination_generation,
            "destination-runtime".into(),
        ));

        let source_after = resolve_owned_pane(&registry, "main", "secondary").unwrap();
        let destination = resolve_owned_pane(&registry, "project-1", PRIMARY_PANE_ID).unwrap();
        assert_eq!(source_after.cwd, destination.cwd);
        assert_eq!(source_after.session_path, destination.session_path);
        assert_ne!(source_after.session_id, destination.session_id);
    }

    #[test]
    fn pane_copy_rollback_removes_only_destination_registry_and_restore_state() {
        let mut registry = PaneRegistry::new();
        let source_generation = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/shared"),
            Some("/s/shared.jsonl".into()),
        );
        let destination_generation = record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/shared"),
            Some("/s/shared.jsonl".into()),
        );
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "secondary",
            source_generation,
            "source-runtime".into(),
        ));
        assert!(bind_pane_session(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            destination_generation,
            "destination-runtime".into(),
        ));
        let mut restore_targets = HashMap::from([
            (
                "main".into(),
                RestoreEntry {
                    cwd: "/p/source".into(),
                    session_path: None,
                },
            ),
            (
                "project-1".into(),
                RestoreEntry {
                    cwd: "/p/shared".into(),
                    session_path: Some("/s/shared.jsonl".into()),
                },
            ),
        ]);

        let removed = rollback_open_pane_state(&mut registry, &mut restore_targets, "project-1");

        assert_eq!(removed.len(), 1);
        assert_eq!(
            removed[0].session_id.as_deref(),
            Some("destination-runtime")
        );
        assert!(resolve_owned_pane(&registry, "project-1", PRIMARY_PANE_ID).is_none());
        assert!(resolve_owned_pane(&registry, "main", "secondary").is_some());
        assert!(!restore_targets.contains_key("project-1"));
        assert!(restore_targets.contains_key("main"));
    }

    #[test]
    fn duplicate_close_and_respawn_enumeration_preserve_the_surviving_owner() {
        let mut registry = PaneRegistry::new();
        for (label, runtime) in [("main", "source-runtime"), ("project-1", "copy-runtime")] {
            let generation = record_pane_target(
                &mut registry,
                label,
                PRIMARY_PANE_ID,
                PathBuf::from("/p/shared"),
                Some("/s/shared.jsonl".into()),
            );
            assert!(bind_pane_session(
                &mut registry,
                label,
                PRIMARY_PANE_ID,
                generation,
                runtime.into(),
            ));
        }

        let targets = enumerate_pane_targets(&registry);
        assert_eq!(targets.len(), 2);
        assert!(targets.iter().all(|(_, _, cwd, session)| {
            cwd == Path::new("/p/shared") && session.as_deref() == Some("/s/shared.jsonl")
        }));

        let removed = take_window_panes(&mut registry, "project-1");
        assert_eq!(removed.len(), 1);
        let surviving = enumerate_pane_targets(&registry);
        assert_eq!(surviving.len(), 1);
        assert_eq!(surviving[0].0, "main");
        assert_eq!(surviving[0].2, PathBuf::from("/p/shared"));
    }

    #[test]
    fn daemon_crash_clears_all_runtime_ids_and_preserves_every_target() {
        let mut registry = PaneRegistry::new();
        let primary_generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            Some("/s/a.jsonl".into()),
        );
        let side_generation = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/b"),
            Some("/s/b.jsonl".into()),
        );
        let peer_generation = record_pane_target(
            &mut registry,
            "project-1",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/c"),
            None,
        );
        for (label, pane_id, generation, session_id) in [
            ("main", PRIMARY_PANE_ID, primary_generation, "old-primary"),
            ("main", "secondary", side_generation, "old-secondary"),
            ("project-1", PRIMARY_PANE_ID, peer_generation, "old-peer"),
        ] {
            assert!(bind_pane_session(
                &mut registry,
                label,
                pane_id,
                generation,
                session_id.into(),
            ));
            assert!(pane_bridge_is_active(&registry, label, pane_id, session_id));
        }
        let mut targets_before = enumerate_pane_targets(&registry);
        targets_before.sort();

        assert_eq!(clear_runtime_session_ids(&mut registry), 3);

        assert_eq!(registry.len(), 2);
        assert_eq!(registry.get("main").unwrap().len(), 2);
        assert!(resolve_owned_pane(&registry, "main", "secondary").is_some());
        for (label, pane_id, generation, old_session_id) in [
            ("main", PRIMARY_PANE_ID, primary_generation, "old-primary"),
            ("main", "secondary", side_generation, "old-secondary"),
            ("project-1", PRIMARY_PANE_ID, peer_generation, "old-peer"),
        ] {
            let pane = resolve_owned_pane(&registry, label, pane_id).unwrap();
            assert_eq!(pane.generation, generation);
            assert!(pane.session_id.is_none());
            assert!(!pane_bridge_is_active(
                &registry,
                label,
                pane_id,
                old_session_id,
            ));
        }
        let mut targets_after = enumerate_pane_targets(&registry);
        targets_after.sort();
        assert_eq!(targets_after, targets_before);
    }

    #[test]
    fn primary_default_and_pane_id_validation_preserve_legacy_identity() {
        assert_eq!(pane_id_or_primary(None).unwrap(), PRIMARY_PANE_ID);
        assert_eq!(pane_id_or_primary(Some("pane_2")).unwrap(), "pane_2");
        assert!(pane_id_or_primary(Some("")).is_err());
        assert!(pane_id_or_primary(Some("bad pane")).is_err());
        assert!(pane_id_or_primary(Some(&"x".repeat(MAX_PANE_ID_LEN + 1))).is_err());
    }

    #[test]
    fn pane_create_enforces_owner_scoped_limit_and_preserves_lifecycle() {
        let mut registry = PaneRegistry::new();
        let first_generation = create_pane_target(
            &mut registry,
            "main",
            "first",
            PathBuf::from("/p/first"),
            None,
        )
        .unwrap();
        for pane_id in ["second", "third", "fourth"] {
            assert!(create_pane_target(
                &mut registry,
                "main",
                pane_id,
                PathBuf::from(format!("/p/{pane_id}")),
                None,
            )
            .is_ok());
        }
        assert_eq!(registry.get("main").unwrap().len(), MAX_PANES_PER_WINDOW);

        let duplicate = create_pane_target(
            &mut registry,
            "main",
            "first",
            PathBuf::from("/p/duplicate"),
            None,
        )
        .unwrap_err();
        assert_eq!(duplicate, "pane 'first' already exists");

        assert!(create_pane_target(
            &mut registry,
            "main",
            "fifth",
            PathBuf::from("/p/fifth"),
            None,
        )
        .is_err());
        assert!(resolve_owned_pane(&registry, "main", "fifth").is_none());
        assert_eq!(registry.get("main").unwrap().len(), MAX_PANES_PER_WINDOW);

        assert!(create_pane_target(
            &mut registry,
            "peer",
            "fifth",
            PathBuf::from("/peer/fifth"),
            None,
        )
        .is_ok());
        assert_eq!(registry.get("peer").unwrap().len(), 1);

        let disposed = dispose_pane_target(&mut registry, "main", "first", false, None).unwrap();
        assert_eq!(disposed.generation, first_generation);
        let recreated_generation = create_pane_target(
            &mut registry,
            "main",
            "first",
            PathBuf::from("/p/recreated"),
            None,
        )
        .unwrap();
        assert!(recreated_generation > first_generation);
        assert_eq!(registry.get("main").unwrap().len(), MAX_PANES_PER_WINDOW);
        assert_eq!(
            resolve_owned_pane(&registry, "main", "first")
                .unwrap()
                .cwd
                .as_deref(),
            Some(Path::new("/p/recreated"))
        );
    }

    #[test]
    fn stale_dispose_generation_cannot_remove_a_recreated_pane() {
        let mut registry = PaneRegistry::new();
        let old_generation = create_pane_target(
            &mut registry,
            "main",
            "pane-1",
            PathBuf::from("/p/old"),
            None,
        )
        .unwrap();
        dispose_pane_target(&mut registry, "main", "pane-1", false, Some(old_generation)).unwrap();
        let current_generation = create_pane_target(
            &mut registry,
            "main",
            "pane-1",
            PathBuf::from("/p/current"),
            None,
        )
        .unwrap();

        assert!(
            dispose_pane_target(&mut registry, "main", "pane-1", false, Some(old_generation),)
                .is_err()
        );
        let current = resolve_owned_pane(&registry, "main", "pane-1").unwrap();
        assert_eq!(current.generation, current_generation);
        assert_eq!(current.cwd.as_deref(), Some(Path::new("/p/current")));
    }

    #[test]
    fn pane_dispose_protects_primary() {
        let mut registry = PaneRegistry::new();
        assert!(create_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        )
        .is_ok());
        assert!(dispose_pane_target(&mut registry, "main", PRIMARY_PANE_ID, false, None).is_err());
        assert!(resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).is_some());
    }

    #[test]
    fn exact_tuple_bridge_identity_distinguishes_panes() {
        let mut registry = PaneRegistry::new();
        let a = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        let b = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/p/b"),
            None,
        );
        assert!(bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            a,
            "same-looking-id-a".into(),
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "secondary",
            b,
            "same-looking-id-b".into(),
        ));
        assert!(pane_bridge_is_active(
            &registry,
            "main",
            "secondary",
            "same-looking-id-b",
        ));
        assert!(!pane_bridge_is_active(
            &registry,
            "main",
            PRIMARY_PANE_ID,
            "same-looking-id-b",
        ));
    }

    #[test]
    fn pane_status_is_ownership_checked() {
        let mut registry = PaneRegistry::new();
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        assert!(pane_startup_status(&registry, "peer", PRIMARY_PANE_ID, None).is_err());
        assert_eq!(
            pane_startup_status(&registry, "main", PRIMARY_PANE_ID, None).unwrap(),
            PaneStartupStatus {
                ready: false,
                error: None
            }
        );
    }

    #[test]
    fn recorded_pane_error_is_generation_and_pane_isolated() {
        let mut registry = PaneRegistry::new();
        let stale = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/old"),
            None,
        );
        let current = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/new"),
            None,
        );
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/primary"),
            None,
        );
        assert!(!record_pane_startup_error(
            &mut registry,
            "main",
            "secondary",
            stale,
            "stale".into()
        ));
        assert!(record_pane_startup_error(
            &mut registry,
            "main",
            "secondary",
            current,
            "current failure".into()
        ));
        assert_eq!(
            pane_startup_status(&registry, "main", "secondary", None)
                .unwrap()
                .error
                .as_deref(),
            Some("current failure")
        );
        assert_eq!(
            pane_startup_status(&registry, "main", PRIMARY_PANE_ID, None)
                .unwrap()
                .error,
            None
        );
        let retry = record_pane_target(
            &mut registry,
            "main",
            "secondary",
            PathBuf::from("/new"),
            None,
        );
        assert!(retry > current);
        assert_eq!(
            pane_startup_status(&registry, "main", "secondary", None)
                .unwrap()
                .error,
            None
        );
    }

    #[test]
    fn daemon_global_failure_applies_to_every_owned_pane() {
        let mut registry = PaneRegistry::new();
        record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        let status =
            pane_startup_status(&registry, "main", PRIMARY_PANE_ID, Some("daemon failed")).unwrap();
        assert_eq!(
            status,
            PaneStartupStatus {
                ready: false,
                error: Some("daemon failed".into())
            }
        );
    }

    #[test]
    fn successful_session_binding_reports_readiness_and_clears_error() {
        let mut registry = PaneRegistry::new();
        let generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            PathBuf::from("/p/a"),
            None,
        );
        assert!(record_pane_startup_error(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            generation,
            "temporary".into()
        ));
        assert!(bind_pane_session(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            generation,
            "session-1".into()
        ));
        assert_eq!(
            pane_startup_status(&registry, "main", PRIMARY_PANE_ID, None).unwrap(),
            PaneStartupStatus {
                ready: true,
                error: None
            }
        );
    }
}
