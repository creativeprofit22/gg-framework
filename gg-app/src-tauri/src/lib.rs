#[cfg(all(debug_assertions, target_os = "windows"))]
mod appearance_background_probe;
mod azure_connection;
#[path = "agent/notes.rs"]
mod notes_phase_deletion;
mod qwen_cloud_connection;
use qwen_cloud_connection::{
    qwen_cloud_connection_remove, qwen_cloud_connection_save, qwen_cloud_connection_status,
    qwen_cloud_connection_test,
};
mod auth;
mod commands;
mod daemon;
mod daemon_job;
mod decisions;
mod events;
mod identity;
mod local_patched_update;
mod notifications;
mod paths;
mod process;
mod settings;
mod state;
mod tray;
mod window_theme;
mod windows;
use auth::*;
use commands::agent::*;
use commands::agent_admin::*;
use commands::local_update::*;
use commands::notes::*;
use daemon::*;
use events::*;
use identity::*;
use paths::*;
use process::*;
use settings::*;
use state::*;
use tray::*;
use windows::*;

use azure_connection::commands::{
    azure_connection_remove, azure_connection_save, azure_connection_status,
    AzureConnectionMutations,
};
#[cfg(test)]
use local_patched_update::local_patched_update_available;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;
#[cfg(any(test, not(target_os = "windows")))]
use std::time::SystemTime;
use unicode_normalization::UnicodeNormalization;

/// `Mutex::lock` that recovers from poisoning instead of panicking: a panic
/// on one thread while holding a lock must not take down every later caller.
pub(crate) trait LockExt<T> {
    fn lock_or_recover(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

use base64::Engine as _;
use futures_util::StreamExt;
use tauri::{
    Emitter, EventTarget, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;

/// Install the process-wide rustls crypto provider before constructing an HTTP client.
///
/// reqwest 0.13 is compiled with `rustls-no-provider` (tauri-plugin-updater
/// asks for it, and cargo unifies features across the one shared build), and in
/// that mode `ClientBuilder::build()` PANICS rather than returning an error if
/// no provider has been installed. `unwrap_or_else` cannot catch that.
///
/// The updater installs `ring` lazily, but that may happen after another runtime
/// path or a test constructs a client. Centralizing provider setup here keeps every
/// client constructor safe; `ring` also matches the updater's provider.
fn install_rustls_provider() {
    // Fails only if a provider is already installed, which is the outcome we
    // want anyway — so the result is deliberately ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    install_rustls_provider();
    reqwest::Client::builder()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    match qwen_cloud_connection::dev_smoke::startup() {
        Ok(true) => return,
        Ok(false) => {}
        Err(_) => {
            eprintln!(
                "Qwen smoke startup refused: invalid configuration or isolated vault unavailable"
            );
            std::process::exit(2);
        }
    }
    install_panic_diagnostics();
    let logging = native_log_builder(
        cfg!(debug_assertions),
        std::env::var_os("GG_APP_DEV_LOG_DIR").as_deref(),
    )
    .expect("invalid native logging configuration");
    let daemon_token =
        generate_daemon_auth_token().expect("failed to generate per-launch daemon bearer token");
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        "x-gg-token",
        reqwest::header::HeaderValue::from_str(&daemon_token)
            .expect("generated token must be valid header ASCII"),
    );
    let http_client = http_client_builder()
        .default_headers(default_headers)
        // The daemon is on loopback, so a connect that doesn't land quickly
        // never will. No overall timeout here: the SSE stream is long-lived.
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("failed to build authenticated loopback client");

    let builder = tauri::Builder::default();
    #[cfg(all(debug_assertions, target_os = "macos"))]
    let builder = if phase26_macos_smoke_enabled() {
        builder.plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        builder
    };
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(logging.build())
        .manage(Daemon {
            token: daemon_token,
            ..Default::default()
        })
        .manage(Windows::default())
        .manage(RestoreTargets::default())
        .manage(PaneCopies::default())
        .manage(AppExiting::default())
        .manage(FocusedWindow::default())
        .manage(MoveDebounce::default())
        .manage(TrayState::default())
        .manage(TrayIntents::default())
        .manage(AzureConnectionMutations::default())
        .manage(LocalPatchedUpdate::default())
        .manage(http_client)
        .invoke_handler(tauri::generate_handler![
            #[cfg(all(debug_assertions, target_os = "windows"))]
            appearance_background_probe::appearance_background_probe,
            window_theme::set_window_theme_hint,
            daemon::sidecar_port,
            daemon::retry_window_session,
            commands::agent::agent_pane_status,
            commands::agent::agent_pane_create,
            commands::agent::agent_pane_restore,
            commands::agent::agent_pane_dispose,
            commands::agent::agent_pane_copy,
            commands::agent::agent_pane_copy_startup,
            commands::agent::agent_pane_copy_restore,
            commands::agent::agent_pane_copy_rollback,
            commands::files::dropped_path_info,
            paths::permissions_status,
            paths::open_permissions_settings,
            commands::files::read_dropped_file_attachment,
            commands::files::open_project_path,
            commands::files::open_image_data,
            commands::files::open_url,
            commands::agent::agent_state,
            commands::notes::agent_notes_get,
            notes_phase_deletion::agent_notes_phase_deletion,
            notes_phase_deletion::agent_notes_phase_status,
            commands::notes::agent_notes_diagnostics,
            commands::notes::agent_notes_phase_binding,
            commands::notes::agent_phase_start,
            commands::notes::agent_phase_advancement_start,
            commands::notes::agent_phase_cancel,
            commands::notes::agent_roadmap_phase_draft_get,
            commands::notes::agent_roadmap_phase_draft_approve,
            commands::notes::agent_roadmap_phase_draft_reject,
            commands::notes::agent_notes_migrate,
            commands::notes::agent_notes_resolve_roadmap_blocker,
            commands::notes::agent_notes_save,
            commands::notes::agent_reminder_reserve,
            commands::notes::agent_reminder_claim,
            commands::notes::agent_reminder_release,
            notifications::roadmap_reminder_notification_permission,
            notifications::show_roadmap_reminder_notification,
            commands::agent::agent_memories,
            commands::agent::agent_delete_memory,
            commands::agent::agent_jiwa,
            commands::agent::agent_delete_jiwa,
            commands::agent::agent_progress,
            commands::agent::agent_keep_awake_get,
            commands::agent::agent_keep_awake_set,
            commands::agent::agent_usage,
            commands::agent::agent_prompt,
            commands::agent::agent_continuation_handoff,
            commands::agent::agent_programmatic,
            commands::agent::agent_commit_continuation,
            commands::agent::agent_cancel,
            commands::agent::agent_cancel_roadmap_status_retry,
            commands::agent::agent_ken_prompt,
            commands::agent::agent_ken_cancel,
            commands::agent::agent_autopilot_set,
            commands::agent::agent_accept_plan,
            commands::agent::agent_revise_plan,
            commands::agent::agent_new_session,
            commands::agent::agent_history,
            commands::agent::agent_export_transcript,
            commands::agent::agent_auth_oauth_start,
            commands::agent::agent_auth_oauth_code,
            commands::agent::agent_mcp_elicit,
            commands::agent::agent_ask_user,
            commands::agent::agent_kill_task,
            commands::agent::agent_import_transcript,
            commands::agent::agent_cancel_queued,
            commands::agent::agent_radio_state,
            commands::agent::agent_radio_set,
            commands::agent::agent_radio_volume,
            commands::agent::agent_tasks,
            commands::agent::agent_checklist,
            commands::agent::agent_run_tasks,
            commands::agent::agent_delete_task,
            commands::agent::agent_cycle_thinking,
            commands::agent::agent_prewarm,
            commands::agent::agent_models,
            commands::agent::agent_switch_model,
            commands::agent::agent_set_context_profile,
            commands::agent::agent_set_openai_codex_fast,
            commands::agent::agent_switch_ken_model,
            commands::agent::agent_enhance_prompt,
            commands::agent::agent_commands,
            windows::setup_windows,
            windows::new_window,
            windows::open_whatsnew_window,
            windows::reveal_whatsnew_window,
            windows::select_project,
            commands::agent_admin::agent_projects,
            commands::agent_admin::agent_goals,
            commands::agent_admin::agent_create_goal,
            commands::agent_admin::agent_goal_kickoff,
            commands::agent_admin::agent_update_goal,
            commands::agent_admin::agent_goal_pause,
            commands::agent_admin::agent_goal_resume,
            commands::agent_admin::agent_delete_goal,
            commands::agent_admin::agent_set_critter_model,
            commands::agent_admin::agent_sessions,
            commands::agent_admin::agent_files,
            commands::agent::agent_plugins,
            commands::agent::agent_install_plugin,
            commands::agent::agent_remove_plugin,
            commands::agent_admin::agent_set_project_hidden,
            settings::app_settings_get,
            settings::app_settings_save,
            settings::app_create_project,
            commands::agent_admin::app_verified_decisions,
            commands::local_update::app_local_patched_update_status,
            commands::local_update::app_local_patched_update_start,
            auth::app_auth_status,
            auth::app_auth_apikey,
            auth::app_auth_logout,
            azure_connection_status,
            azure_connection_save,
            azure_connection_remove,
            qwen_cloud_connection_status,
            qwen_cloud_connection_save,
            qwen_cloud_connection_remove,
            qwen_cloud_connection_test,
            commands::agent_admin::agent_telegram_get,
            commands::agent_admin::agent_telegram_save,
            commands::agent_admin::agent_local,
            commands::agent_admin::agent_local_scan,
            commands::agent_admin::agent_local_endpoint_add,
            commands::agent_admin::agent_local_endpoint_remove,
            commands::agent_admin::agent_hf_search,
            commands::agent_admin::agent_hf_pull,
            commands::agent_admin::agent_hf_pull_status,
            commands::agent_admin::agent_hf_pull_cancel,
            commands::agent_admin::agent_serve_status,
            commands::agent_admin::agent_serve_start,
            commands::agent_admin::agent_serve_stop,
            commands::agent_admin::agent_steroids_status,
            commands::agent_admin::agent_steroids_install,
            commands::agent_admin::agent_mcp_list,
            commands::agent_admin::agent_mcp_add,
            commands::agent_admin::agent_mcp_remove,
            commands::agent_admin::agent_mcp_login,
            windows::focus_window_by_offset,
            windows::arrange_all,
            settings::window_restore_target,
            tray::window_tray_intent,
            tray::set_update_available,
            tray::set_remote_active
        ])
        .setup(|app| {
            log::info!(
                "{}",
                lifecycle_message(
                    "shell_start",
                    &format!(
                        "shell_pid={} app_version={}",
                        std::process::id(),
                        env!("CARGO_PKG_VERSION")
                    ),
                )
            );
            let identifier = app.config().identifier.clone();
            let identity_root = agent_data_root(&identifier);
            // Sweep only orphaned sidecars from this exact Tauri identity before
            // any identity migration can touch files they may have held open.
            // The isolated Phase 25 dev fixture must never inspect or terminate
            // a pre-existing host sidecar.
            if !phase25_dev_fixture_enabled() {
                sweep_orphan_sidecars(&identifier);
            }
            let bootstrapped = bootstrap_identity_data(&home_dir(), &identifier)?;
            let sessions_bootstrapped =
                bootstrap_identity_sessions(&home_dir(), &identifier)?;
            let rank_bootstrapped =
                bootstrap_identity_rank_progress_v2(&home_dir(), &identifier)?;
            log::info!(
                "identity data root: identity={identifier} root={} bootstrapped={bootstrapped} sessions_bootstrapped={sessions_bootstrapped} rank_bootstrapped={rank_bootstrapped}",
                identity_root.display()
            );
            // Windows-only: track per-window minimized state so restoring one
            // window can restore its siblings (macOS does this natively).
            #[cfg(target_os = "windows")]
            app.manage(MinimizeState::default());
            // macOS menu-bar / Windows notification-area presence.
            #[cfg(any(target_os = "macos", windows))]
            if let Err(e) = init_tray(&app.handle().clone()) {
                log::warn!("tray init failed: {e}");
            }
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
                // A target can remain pending when a webview closes before mount.
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock_or_recover(),
                    window.label(),
                );
                // Rollback-created windows were never committed to the workspace;
                // pruning by cwd could otherwise delete the still-open source copy.
                let rolling_back = app
                    .state::<PaneCopies>()
                    .map
                    .lock_or_recover()
                    .rolling_back
                    .remove(window.label());
                // A deliberate close (app NOT quitting) drops this window from the
                // workspace so it doesn't reopen next launch. During quit the
                // AppExiting flag is set, so the snapshot is preserved intact.
                let exiting = app.state::<AppExiting>().0.load(Ordering::SeqCst);
                if !exiting && !rolling_back {
                    remove_window_from_workspace(app, window.label());
                }
                let stale_source_copies = {
                    let copies: State<PaneCopies> = app.state();
                    let mut registry = copies.map.lock_or_recover();
                    if let Some(key) = registry.target_owners.get(window.label()).cloned() {
                        let started = registry
                            .operations
                            .get(&key)
                            .is_some_and(|operation| operation.started);
                        if started {
                            registry.target_owners.remove(window.label());
                            registry.operations.remove(&key);
                        }
                    }
                    let stale_keys: Vec<_> = registry
                        .operations
                        .iter()
                        .filter(|(_, operation)| {
                            operation.source_owner == window.label() && !operation.started
                        })
                        .map(|(key, _)| key.clone())
                        .collect();
                    stale_keys
                        .into_iter()
                        .filter_map(|key| {
                            let operation = registry.operations.remove(&key)?;
                            registry.target_owners.remove(&operation.target_label);
                            Some(operation)
                        })
                        .collect::<Vec<_>>()
                };
                for operation in stale_source_copies {
                    remove_restore_target(
                        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
                        &operation.target_label,
                    );
                    if let Some(path) = operation.cloned_session_path {
                        let _ = std::fs::remove_file(path);
                    }
                    if let Some(copy_window) = app.get_webview_window(&operation.target_label) {
                        let _ = copy_window.close();
                    }
                }
                // Dispose only THIS window's session in the shared daemon so
                // other projects keep running. The daemon process itself is
                // never killed here (that happens only on app exit).
                let state: State<Windows> = window.state();
                let panes = {
                    let mut registry = state.map.lock_or_recover();
                    take_window_panes(&mut registry, window.label())
                };
                if let Some(port) = *app.state::<Daemon>().port.lock_or_recover() {
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        for pane in panes {
                            if let Some(id) = pane.session_id {
                                let _ = daemon_delete_session(&app2, port, &id).await;
                            }
                        }
                    });
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
                    *state.0.lock_or_recover() = Some(window.label().to_string());
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
                    *state.0.lock_or_recover() = Some(now);
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let fire = {
                        let state: State<MoveDebounce> = app.state();
                        let guard = state.0.lock_or_recover();
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
        .run(|app, event| match event {
            RunEvent::Ready => {
                for window in app.webview_windows().values() {
                    if let Err(error) = apply_dev_smoke_window_state(window) {
                        log::error!("failed to apply dev smoke window state: {error}");
                        app.exit(1);
                        break;
                    }
                }
            }
            RunEvent::ExitRequested { code, .. } => {
                log::info!(
                    "{}",
                    lifecycle_message(
                        "tauri_exit_requested",
                        &format!(
                            "shell_pid={} code={}",
                            std::process::id(),
                            code.map_or_else(|| "user".to_string(), |code| code.to_string())
                        ),
                    )
                );
                // Mark the quit BEFORE windows start tearing down, so the
                // Destroyed handlers preserve the snapshot, then write the final
                // snapshot (current geometry + each window's live cwd/session).
                app.state::<AppExiting>().0.store(true, Ordering::SeqCst);
                refresh_live_sessions(app);
                snapshot_workspace(app);
                // On Windows the daemon must stay owned until `RunEvent::Exit`,
                // where it is synchronously reaped before bypassing Tauri/Tao cleanup.
                #[cfg(not(target_os = "windows"))]
                {
                    // Terminate the daemon's process group once — reaps every
                    // session's MCP/LSP children in one shot (no orphans).
                    let child = app.state::<Daemon>().child.lock_or_recover().take();
                    if let Some(child) = child {
                        terminate_child(child, "tauri_exit_requested");
                    }
                }
            }
            RunEvent::Exit => {
                #[cfg(target_os = "windows")]
                {
                    let child = app.state::<Daemon>().child.lock_or_recover().take();
                    if let Some(child) = child {
                        terminate_child_synchronously(child, "tauri_exit_requested");
                    }
                }
                log::info!(
                    "{}",
                    lifecycle_message("shell_exit", &format!("shell_pid={}", std::process::id()),)
                );
                #[cfg(target_os = "windows")]
                std::process::exit(0);
            }
            _ => {}
        });
}

// Test helpers shared by the test suites of several modules.

#[cfg(test)]
fn identity_bootstrap_test_home(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("gg-app-{label}-{}-{unique}", std::process::id()))
}

#[cfg(test)]
// ── Pane registry lifecycle ──────────────────────────────────────────────

fn add_pane(registry: &mut PaneRegistry, window: &str, pane: &str, cwd: &str) -> u64 {
    create_pane_target(
        registry,
        window,
        pane,
        WorkspaceMode::Code,
        ChatAgent::General,
        PathBuf::from(cwd),
        None,
    )
    .unwrap()
}

#[cfg(test)]
fn copy_operation(owner: &str, target: &str) -> PaneCopyOperation {
    PaneCopyOperation {
        source_owner: owner.into(),
        target_label: target.into(),
        restore: RestoreEntry {
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: "/project".into(),
            session_path: Some("/sessions/copy.jsonl".into()),
        },
        cloned_session_path: Some(PathBuf::from("/sessions/copy.jsonl")),
        started: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the startup crash from the reqwest 0.13 bump: the shared client is
    /// built before anything else in `run()`, and without a rustls provider that
    /// build PANICS, so the packaged app died on launch with no error of its
    /// own. Asserting `build()` succeeds after `install_rustls_provider` catches
    /// a provider that stops covering the feature set reqwest is compiled with.
    ///
    /// It cannot see the CALL being dropped from `run()` — that ordering is only
    /// observable by launching the app, which is the Windows packaged smoke's job.
    #[test]
    fn shared_http_client_builds_after_provider_install() {
        install_rustls_provider();
        assert!(
            reqwest::Client::builder().build().is_ok(),
            "shared client must build once the rustls provider is installed",
        );
    }
}
