//! The shared Node daemon: spawn/respawn, per-window session lifecycle, session lookups.

use crate::*;

// Restoring several large conversations on a busy machine routinely took
// 26-35s; a 30s ceiling turned slow starts into failed projects.
pub(crate) const DAEMON_SESSION_STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

// Daemon boot precedes session creation. Loading the daemon's modules alone
// took ~20s on a loaded machine, so the old 30s port wait was too tight.
// The webview's `PANE_STARTUP_TIMEOUT_MS` (gg-app/src/agent.ts) must exceed
// this plus `DAEMON_SESSION_STARTUP_TIMEOUT`.
pub(crate) const DAEMON_PORT_WAIT_TIMEOUT: Duration = DAEMON_START_TIMEOUT;

pub(crate) const DAEMON_PORT_POLL_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) const DAEMON_SESSION_DISPOSAL_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The shared daemon port (same for every window). Named `port_for` so the ~35
/// proxy commands keep their call shape; the per-window routing is the session
/// id (`session_for`), attached as the `x-gg-session` header.
pub(crate) fn port_for(webview: &WebviewWindow) -> Option<u16> {
    let daemon: State<Daemon> = webview.state();
    let port = *daemon.port.lock_or_recover();
    port
}

pub(crate) fn pane_session_for(webview: &WebviewWindow, pane_id: &str) -> Option<String> {
    validate_pane_id(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let registry = windows.map.lock_or_recover();
    resolve_owned_pane(&registry, webview.label(), pane_id)?
        .session_id
        .clone()
}

pub(crate) fn session_for(webview: &WebviewWindow) -> Option<String> {
    pane_session_for(webview, PRIMARY_PANE_ID)
}

pub(crate) fn pane_cwd_for(webview: &WebviewWindow, pane_id: &str) -> Option<PathBuf> {
    validate_pane_id(pane_id).ok()?;
    let windows: State<Windows> = webview.state();
    let registry = windows.map.lock_or_recover();
    resolve_owned_pane(&registry, webview.label(), pane_id)?
        .cwd
        .clone()
}

/// How long a session start waits for the daemon's port. Deliberately generous:
/// a first launch after install/update can spend well over 30s while macOS
/// Gatekeeper/XProtect scans `ggnode` and the native modules, and the crash-loop
/// backoff alone sums to 31s. A daemon that has failed for good ends the wait
/// early through `Daemon::failure`.
pub(crate) const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(180);

/// Await the daemon's HTTP port (set by its `GG_APP_LISTENING` handshake),
/// polling until `DAEMON_PORT_WAIT_TIMEOUT` elapses. Fails with the daemon's
/// terminal failure as soon as one is recorded, or with a timeout message if
/// the daemon neither listens nor fails.
pub(crate) async fn await_daemon_port(app: &tauri::AppHandle) -> Result<u16, String> {
    let deadline = daemon_port_wait_deadline(std::time::Instant::now());
    loop {
        let daemon: State<Daemon> = app.state();
        if let Some(port) = *daemon.port.lock_or_recover() {
            return Ok(port);
        }
        if let Some(failure) = daemon.failure.lock_or_recover().clone() {
            return Err(failure);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "The agent daemon did not start within {} seconds.",
                DAEMON_PORT_WAIT_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(DAEMON_PORT_POLL_INTERVAL).await;
    }
}

pub(crate) fn daemon_port_wait_deadline(start: std::time::Instant) -> std::time::Instant {
    start + DAEMON_PORT_WAIT_TIMEOUT
}

/// A pane's readiness as `sidecar_port` reports it: the failed start's reason,
/// else the daemon port once the pane has a session, else `None` (starting).
pub(crate) fn pane_readiness(
    pane: Option<&PaneSession>,
    port: Option<u16>,
) -> Result<Option<u16>, String> {
    let Some(pane) = pane else {
        return Ok(None);
    };
    if let Some(error) = &pane.startup_error {
        return Err(error.clone());
    }
    Ok(pane.session_id.as_ref().and(port))
}

/// Frontend compatibility readiness seam, explicitly routed to one pane.
/// Errors with the concrete reason once that pane's session start has failed.
#[tauri::command]
pub(crate) fn sidecar_port(
    webview: WebviewWindow,
    pane_id: Option<String>,
) -> Result<Option<u16>, String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    validate_pane_id(pane_id)?;
    let pane = {
        let windows: State<Windows> = webview.state();
        let registry = windows.map.lock_or_recover();
        resolve_owned_pane(&registry, webview.label(), pane_id).cloned()
    };
    pane_readiness(pane.as_ref(), port_for(&webview))
}

/// "Try again" after a failed start. A daemon that gave up (spawn failure or
/// crash circuit breaker) is respawned with a fresh retry budget and every
/// pane's session restarted; otherwise only this pane's failed session is
/// restarted. No-op while a start is in flight or the session is live.
#[tauri::command]
pub(crate) fn retry_window_session(webview: WebviewWindow, pane_id: Option<String>) {
    let app = webview.app_handle().clone();
    let daemon_failure = app.state::<Daemon>().failure.lock_or_recover().take();
    if let Some(reason) = daemon_failure {
        log::info!("retrying daemon after failure: {reason}");
        {
            let daemon: State<Daemon> = app.state();
            *daemon.respawn_attempts.lock_or_recover() = 0;
            *daemon.last_fatal.lock_or_recover() = None;
        }
        // Fresh generations retire stale bridges before new sessions bind.
        clear_runtime_pane_sessions(&app);
        spawn_daemon(app.clone(), false);
        recreate_all_window_sessions(app);
        return;
    }

    let pane_id = pane_id.unwrap_or_else(|| PRIMARY_PANE_ID.to_string());
    if validate_pane_id(&pane_id).is_err() {
        return;
    }
    let target = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock_or_recover();
        resolve_owned_pane(&registry, webview.label(), &pane_id).and_then(|pane| {
            pane.startup_error.as_ref()?;
            let cwd = pane.cwd.clone()?;
            Some((pane.mode, pane.chat_agent, cwd, pane.session_path.clone()))
        })
    };
    if let Some((mode, chat_agent, cwd, session_path)) = target {
        let _ = start_pane_session(
            app,
            webview.label().to_string(),
            pane_id,
            mode,
            chat_agent,
            cwd,
            session_path,
        );
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionSummaryResponse {
    pub(crate) version: u8,
    pub(crate) summary: String,
}

pub(crate) fn write_decision_summary(
    app: &tauri::AppHandle,
    repo: &Path,
    sidecar: Option<(u16, String)>,
) {
    let pending = match decisions::load_pending_decision_summary(repo) {
        Ok(Some(pending)) => pending,
        Ok(None) => return,
        Err(_) => {
            eprintln!("Decision summary context was rejected; protected update remains verified.");
            emit_local_patched_update(
                app,
                serde_json::json!({
                    "type": "line",
                    "stream": "stdout",
                    "line": "Summary unavailable; protected update remains verified.",
                }),
            );
            return;
        }
    };
    emit_local_patched_update(
        app,
        serde_json::json!({
            "type": "line",
            "stream": "stdout",
            "line": "Writing a short What's New summary…",
        }),
    );

    let context_json = pending.context_json.clone();
    let summary = sidecar.and_then(|(port, session)| {
        let client = app.state::<reqwest::Client>().inner().clone();
        tauri::async_runtime::block_on(async move {
            let response = client
                .post(format!("{}/decision-summary", sidecar_base(port)))
                .header("x-gg-session", session)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(context_json)
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let envelope = response.json::<DecisionSummaryResponse>().await.ok()?;
            (envelope.version == 1).then_some(envelope.summary)
        })
    });
    let available = summary.is_some();
    if decisions::complete_pending_decision_summary(pending, summary.as_deref()).is_err() {
        eprintln!("Decision summary could not be stored or cleaned up; protected update remains verified.");
    }
    if !available {
        emit_local_patched_update(
            app,
            serde_json::json!({
                "type": "line",
                "stream": "stdout",
                "line": "Summary unavailable; protected update remains verified.",
            }),
        );
    }
}

pub(crate) const DAEMON_STABLE_UPTIME: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) const DAEMON_MAX_RESPAWNS: u32 = 5;

pub(crate) fn generate_daemon_auth_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("failed to generate daemon authentication token: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Exponential crash-loop backoff: 1s, 2s, 4s, 8s, 16s, then stop.
/// A hard retry budget prevents a broken sidecar/signature/configuration from
/// turning the desktop shell into an unbounded process-spawn and disk-write loop.
pub(crate) fn daemon_respawn_delay(attempt: u32) -> Option<std::time::Duration> {
    if attempt == 0 || attempt > DAEMON_MAX_RESPAWNS {
        return None;
    }
    Some(std::time::Duration::from_secs(1 << (attempt - 1)))
}

/// The user-facing reason once the crash loop exhausts its respawn budget,
/// carrying the last `GG_APP_FATAL` reason when the daemon reported one.
pub(crate) fn crash_loop_message(last_fatal: Option<&str>) -> String {
    let reason = last_fatal
        .map(|line| line.strip_prefix("GG_APP_FATAL").unwrap_or(line).trim())
        .filter(|reason| !reason.is_empty());
    match reason {
        Some(reason) => format!("The agent daemon kept crashing on startup: {reason}"),
        None => "The agent daemon stopped after repeated crashes.".to_string(),
    }
}

/// Record a terminal daemon failure so waiting session starts end with it.
pub(crate) fn fail_daemon(app: &tauri::AppHandle, message: String) {
    log::error!("{message}");
    *app.state::<Daemon>().failure.lock_or_recover() = Some(message.clone());
    emit_daemon_error(app, &message);
}

pub(crate) fn emit_daemon_error(app: &tauri::AppHandle, message: &str) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "sidecar-error",
            message,
        );
    }
}

/// Spawn the ONE shared Node daemon. Reads its `GG_APP_LISTENING` handshake to
/// learn the shared port; on an unexpected exit it reaps the dead child, applies
/// bounded exponential backoff, and re-creates every live window's session.
/// Five short-lived respawns exhaust the retry budget; one minute of stable
/// uptime resets it.
///
/// The daemon is a process-group leader (Unix), so `terminate_child` reaps its
/// entire descendant tree (every session's MCP stdio children + LSP servers) in
/// one group-kill — no orphans on quit.
pub(crate) fn spawn_daemon(app: tauri::AppHandle, is_respawn: bool) {
    let started_at = std::time::Instant::now();
    let script = resolve_sidecar(&app);
    let node = resolve_node(&app);
    let identifier = app.config().identifier.clone();
    let identity_arg = sidecar_identity_arg(&identifier);
    let identity_data_root = agent_data_root(&identifier);
    let sidecar_log = sidecar_log_filename(&identifier);
    let auth_token = match generate_daemon_auth_token() {
        Ok(token) => token,
        Err(message) => {
            fail_daemon(&app, message);
            return;
        }
    };
    let (daemon_instance_id, process_start_token) =
        match (generate_daemon_auth_token(), generate_daemon_auth_token()) {
            (Ok(instance_id), Ok(start_token)) => (instance_id, start_token),
            (Err(message), _) | (_, Err(message)) => {
                fail_daemon(&app, message);
                return;
            }
        };
    let predecessor_proof = if is_respawn {
        app.state::<Daemon>()
            .predecessor_proof
            .lock_or_recover()
            .clone()
    } else {
        None
    };
    log::info!(
        "{}",
        lifecycle_message(
            "daemon_spawn_requested",
            &format!(
                "shell_pid={} respawn={is_respawn} identity={identifier} data_root={} node={} script={}",
                std::process::id(),
                identity_data_root.display(),
                node.display(),
                script.display()
            ),
        )
    );

    let mut cmd = Command::new(node);
    hide_console(&mut cmd);
    cmd.arg(&script)
        .arg(&identity_arg)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake.
        .env("GG_APP_PORT", "0")
        .env("GG_APP_AUTH_TOKEN", &auth_token)
        .env("GG_APP_TOKEN", &app.state::<Daemon>().token)
        .env("GG_DAEMON_INSTANCE_ID", &daemon_instance_id)
        .env("GG_PROCESS_START_TOKEN", &process_start_token)
        .env("GG_APP_SIDECAR_LOG_FILE", &sidecar_log)
        .env("ERROR_MOM_RELEASE", env!("CARGO_PKG_VERSION"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(proof) = predecessor_proof.as_ref() {
        if let Ok(serialized) = serde_json::to_string(proof) {
            cmd.env("GG_DAEMON_PREDECESSOR_PROOF", serialized);
        }
    }
    if identifier == PRODUCTION_APP_IDENTIFIER {
        cmd.env_remove("GG_AGENT_DIR");
    } else {
        cmd.env("GG_AGENT_DIR", &identity_data_root);
    }
    // Release shells never forward inherited development credential routing.
    cmd.env_remove("GG_APP_DEV_AUTH_FILE");
    cmd.env_remove("GG_APP_NATIVE_DEBUG_AUTH_ALLOWED");
    #[cfg(debug_assertions)]
    if std::env::var_os("GG_APP_DEV_AUTH_FILE").is_some() {
        cmd.env("GG_APP_DEV_AUTH_FILE", auth_file_path(&identifier));
        cmd.env("GG_APP_NATIVE_DEBUG_AUTH_ALLOWED", "1");
    }
    let secure_azure = azure_connection::secure_config().unwrap_or_else(|_| {
        log::warn!("Azure secure configuration is unavailable; preserving inherited environment");
        None
    });
    azure_connection::lifecycle::configure_daemon_azure_environment(
        &mut cmd,
        secure_azure.as_ref(),
    );
    qwen_cloud_connection::configure_daemon_environment(&mut cmd);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(child) => {
            // The identity-scoped ledger lets orphan cleanup attribute this
            // daemon tree without touching another installed GG Coder identity.
            record_sidecar_pid(&identifier, child.id() as i32);
            child
        }
        Err(e) => {
            let message = format!(
                "{}",
                lifecycle_message(
                    "daemon_spawn_failed",
                    &format!(
                        "shell_pid={} respawn={is_respawn} error={e}",
                        std::process::id()
                    ),
                )
            );
            fail_daemon(&app, message);
            return;
        }
    };
    let daemon_pid = child.id();
    // Contain the daemon before it can start agent tools. It spawns nothing
    // until its HTTP server accepts a session, which is far later than this.
    // Containment is cleanup, so a failure is logged and startup continues.
    #[cfg(windows)]
    {
        let job = match daemon_job::DaemonJob::contain(&child) {
            Ok(job) => Some(job),
            Err(message) => {
                log::warn!("{message}; agent tool processes may outlive the app");
                None
            }
        };
        *app.state::<Daemon>().job.lock_or_recover() = job;
    }
    log::info!(
        "{}",
        lifecycle_message(
            "daemon_start",
            &format!(
                "shell_pid={} daemon_pid={daemon_pid} respawn={is_respawn}",
                std::process::id()
            ),
        )
    );

    // Publish the child before starting pipe readers. A process can fail before
    // the reader thread starts; storing first guarantees the crash handler can
    // still take and reap that exact child instead of leaving a zombie behind.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let daemon: State<Daemon> = app.state();
        *daemon.child.lock_or_recover() = Some(child);
        *daemon.auth_token.lock_or_recover() = Some(auth_token);
        *daemon.process_identity.lock_or_recover() = Some(DaemonProcessIdentity {
            daemon_instance_id,
            process_id: daemon_pid,
            process_start_token,
        });
    }

    if let Some(stdout) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    // Format: `GG_APP_LISTENING <port> <token>`; Rust already owns
                    // the configured token, while non-Rust spawners consume the second field.
                    if let Ok(port) = rest.split_whitespace().next().unwrap_or("").parse::<u16>() {
                        log::info!(
                            "{}",
                            lifecycle_message(
                                "daemon_listening",
                                &format!(
                                    "shell_pid={} daemon_pid={daemon_pid} port={port}",
                                    std::process::id()
                                ),
                            )
                        );
                        let daemon = app2.state::<Daemon>();
                        *daemon.port.lock_or_recover() = Some(port);
                        daemon.generation.fetch_add(1, Ordering::SeqCst);
                        // On a respawn the windows already exist with (now
                        // stale) sessions — re-create them all. On the initial
                        // spawn `restore_or_default_windows` drives creation.
                        if is_respawn {
                            recreate_all_window_sessions(app2.clone());
                        }
                    }
                } else {
                    log::debug!("[daemon] {line}");
                }
            }

            // stdout closed → the daemon exited (or lost its control pipe). If
            // the app isn't quitting, remove the stale port and reap/terminate
            // the exact child before considering a bounded respawn.
            if app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                log::info!(
                    "{}",
                    lifecycle_message(
                        "daemon_control_pipe_closed",
                        &format!(
                            "shell_pid={} daemon_pid={daemon_pid} reason=shell_exit",
                            std::process::id()
                        ),
                    )
                );
                return;
            }

            let (attempt, planned) = {
                let daemon: State<Daemon> = app2.state();
                let planned = daemon.planned_reload.swap(false, Ordering::SeqCst);
                let termination_reason = if planned {
                    "configuration_refresh"
                } else {
                    "unexpected_control_pipe_close"
                };
                *daemon.port.lock_or_recover() = None;
                *daemon.auth_token.lock_or_recover() = None;
                if let Some(mut old_child) = daemon.child.lock_or_recover().take() {
                    match old_child.try_wait() {
                        Ok(Some(status)) => {
                            log::info!(
                                "{}",
                                lifecycle_message(
                                    "daemon_exit",
                                    &format!(
                                        "shell_pid={} daemon_pid={daemon_pid} reason={termination_reason} status={status}",
                                        std::process::id()
                                    ),
                                )
                            );
                            let _ = old_child.wait();
                        }
                        Ok(None) => terminate_child(old_child, termination_reason),
                        Err(error) => {
                            log::warn!(
                                "{}",
                                lifecycle_message(
                                    "daemon_status_failed",
                                    &format!(
                                        "shell_pid={} daemon_pid={daemon_pid} reason={termination_reason} error={error}",
                                        std::process::id()
                                    ),
                                )
                            );
                            terminate_child(old_child, termination_reason);
                        }
                    }
                }
                // The daemon is gone; end any tool processes it left running
                // now, even if the respawn circuit breaker keeps it down.
                #[cfg(windows)]
                drop(daemon.job.lock_or_recover().take());
                if let Some(identity) = daemon.process_identity.lock_or_recover().take() {
                    if identity.process_id == daemon_pid {
                        *daemon.predecessor_proof.lock_or_recover() =
                            Some(DaemonPredecessorProof::from_terminated(identity));
                    }
                }
                // A daemon that died on its own leaves its MCP/LSP children
                // running in its (now leaderless) process group, and on Windows
                // `taskkill /T` can no longer reach them through the dead
                // parent. The ledger sweep kills dead-leader groups, so run it
                // now rather than waiting for the next app launch.
                sweep_orphan_sidecars(&app2.config().identifier);
                let mut attempts = daemon.respawn_attempts.lock_or_recover();
                if planned || started_at.elapsed() >= DAEMON_STABLE_UPTIME {
                    *attempts = 0;
                }
                *attempts += 1;
                (*attempts, planned)
            };

            let Some(delay) = daemon_respawn_delay(attempt) else {
                log::error!("daemon crash circuit breaker opened after {attempt} crashes");
                let last_fatal = app2.state::<Daemon>().last_fatal.lock_or_recover().clone();
                fail_daemon(&app2, crash_loop_message(last_fatal.as_deref()));
                return;
            };

            if planned {
                log::info!(
                    "daemon configuration refresh — respawn {attempt}/{DAEMON_MAX_RESPAWNS} in {}s",
                    delay.as_secs()
                );
            } else {
                log::warn!(
                    "daemon exited unexpectedly — respawn {attempt}/{DAEMON_MAX_RESPAWNS} in {}s",
                    delay.as_secs()
                );
            }
            std::thread::sleep(delay);
            if !app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                clear_runtime_pane_sessions(&app2);
                spawn_daemon(app2.clone(), true);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[daemon:stderr] {line}");
                // Not surfaced yet: the crash is respawned, and only a crash
                // loop that exhausts the budget reports this reason.
                if line.starts_with("GG_APP_FATAL") {
                    *app3.state::<Daemon>().last_fatal.lock_or_recover() = Some(line);
                }
            }
        });
    }
}

pub(crate) fn parse_daemon_create_session_response(
    status: reqwest::StatusCode,
    value: &serde_json::Value,
) -> Result<String, String> {
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("agent daemon rejected session with HTTP {status}")));
    }
    value
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| "agent daemon response did not include a session id".to_string())
}

pub(crate) async fn send_daemon_create_session_request(
    request: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<reqwest::Response, String> {
    request.timeout(timeout).send().await.map_err(|error| {
        if error.is_timeout() {
            "agent daemon session startup timed out; retry selecting the project".to_string()
        } else {
            format!("failed to reach agent daemon: {error}")
        }
    })
}

/// Authenticated POST /session to the daemon for `cwd` (+ optional resume
/// `session_path`); returns the new session id or the daemon's concrete rejection reason.
pub(crate) async fn daemon_create_session(
    app: &tauri::AppHandle,
    port: u16,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: &Path,
    session_path: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let auth_token = app
        .state::<Daemon>()
        .auth_token
        .lock_or_recover()
        .clone()
        .ok_or_else(|| "agent daemon authentication is not ready".to_string())?;
    let body = serde_json::json!({
        "mode": mode,
        "chatAgent": chat_agent,
        "cwd": cwd.to_string_lossy(),
        "sessionPath": session_path,
    });
    let request = client
        .post(format!("{}/session", sidecar_base(port)))
        .header("x-gg-daemon-token", auth_token)
        .json(&body);
    let response =
        send_daemon_create_session_request(request, DAEMON_SESSION_STARTUP_TIMEOUT).await?;
    let status = response.status();
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("agent daemon returned an invalid response: {error}"))?;
    let id = parse_daemon_create_session_response(status, &value)?;
    Ok((id, json_session_path(&value)))
}

/// The conversation file a daemon response names, if any.
pub(crate) fn json_session_path(value: &serde_json::Value) -> Option<String> {
    value
        .get("sessionPath")
        .and_then(|path| path.as_str())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

/// DELETE /session/:id on the daemon and require an acknowledged success response.
pub(crate) async fn daemon_delete_session(
    app: &tauri::AppHandle,
    port: u16,
    id: &str,
) -> Result<(), String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let response = client
        .delete(format!(
            "{}/session/{}",
            sidecar_base(port),
            urlencoding(id)
        ))
        .timeout(DAEMON_SESSION_DISPOSAL_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "agent daemon timed out during session disposal; retry closing the pane".to_string()
            } else {
                format!("failed to reach agent daemon for session disposal: {error}")
            }
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    let detail = body.trim();
    Err(if detail.is_empty() {
        format!("agent daemon rejected session disposal with HTTP {status}")
    } else {
        format!("agent daemon rejected session disposal with HTTP {status}: {detail}")
    })
}

pub(crate) fn start_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) -> (u64, PaneStartupCompletion) {
    let generation = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock_or_recover();
        record_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            cwd.clone(),
            session_path.clone(),
        )
    };
    let completion = launch_pane_session(
        app,
        label,
        pane_id,
        mode,
        chat_agent,
        cwd,
        session_path,
        generation,
    );
    (generation, completion)
}

pub(crate) async fn orchestrate_pane_session_startup<
    DaemonFuture,
    BindSession,
    RecordError,
    DeleteSession,
    DeleteFuture,
>(
    pane_id: &str,
    generation: u64,
    daemon_session: DaemonFuture,
    bind_session: BindSession,
    record_error: RecordError,
    delete_session: DeleteSession,
    completion_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) -> PaneStartupOutcome
where
    DaemonFuture: std::future::Future<Output = Result<(u16, String), String>>,
    BindSession: FnOnce(&str) -> bool,
    RecordError: FnOnce(&str) -> bool,
    DeleteSession: FnOnce(u16, String) -> DeleteFuture,
    DeleteFuture: std::future::Future<Output = ()>,
{
    match daemon_session.await {
        Ok((port, session_id)) if bind_session(&session_id) => {
            let _ = completion_tx.send(Ok(()));
            PaneStartupOutcome::Ready { port, session_id }
        }
        Ok((port, session_id)) => {
            delete_session(port, session_id).await;
            let message =
                format!("pane '{pane_id}' generation {generation} was superseded during startup");
            let _ = completion_tx.send(Err(message));
            PaneStartupOutcome::Superseded
        }
        Err(message) if record_error(&message) => {
            let _ = completion_tx.send(Err(message.clone()));
            PaneStartupOutcome::Failed(message)
        }
        Err(_) => {
            let message =
                format!("pane '{pane_id}' generation {generation} was superseded during startup");
            let _ = completion_tx.send(Err(message));
            PaneStartupOutcome::Superseded
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "launch requires the complete immutable pane target and generation"
)]
pub(crate) fn launch_pane_session(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
    generation: u64,
) -> PaneStartupCompletion {
    let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let started_at = std::time::Instant::now();
        // The conversation file the daemon opened (a fresh session has none
        // until now), recorded on bind so a daemon respawn reopens it.
        let opened_path: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
        let daemon_app = app.clone();
        let daemon_opened_path = opened_path.clone();
        let daemon_session = async move {
            let port = await_daemon_port(&daemon_app).await?;
            let (session_id, path) = daemon_create_session(
                &daemon_app,
                port,
                mode,
                chat_agent,
                &cwd,
                session_path.as_deref(),
            )
            .await?;
            *daemon_opened_path.lock_or_recover() = path;
            Ok((port, session_id))
        };
        let bind_app = app.clone();
        let bind_label = label.clone();
        let bind_pane_id = pane_id.clone();
        let error_app = app.clone();
        let error_label = label.clone();
        let error_pane_id = pane_id.clone();
        let delete_app = app.clone();
        let outcome = orchestrate_pane_session_startup(
            &pane_id,
            generation,
            daemon_session,
            move |session_id| {
                let opened = opened_path.lock_or_recover().take();
                let windows: State<Windows> = bind_app.state();
                let mut registry = windows.map.lock_or_recover();
                bind_pane_session_with_path(
                    &mut registry,
                    &bind_label,
                    &bind_pane_id,
                    generation,
                    session_id.to_string(),
                    opened,
                )
            },
            move |message| {
                let windows: State<Windows> = error_app.state();
                let mut registry = windows.map.lock_or_recover();
                record_pane_startup_error(
                    &mut registry,
                    &error_label,
                    &error_pane_id,
                    generation,
                    message.to_string(),
                )
            },
            move |port, session_id| async move {
                let _ = daemon_delete_session(&delete_app, port, &session_id).await;
            },
            completion_tx,
        )
        .await;

        match outcome {
            PaneStartupOutcome::Ready { port, session_id } => {
                log::info!(
                    "pane session bound: window_label={label} pane_id={pane_id} generation={generation} session_id={session_id} elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                start_event_bridge(
                    app.clone(),
                    label.clone(),
                    pane_id.clone(),
                    generation,
                    port,
                    session_id,
                );
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "agent-pane-ready",
                    serde_json::json!({
                        "paneId": pane_id,
                        "generation": generation,
                    }),
                );
                azure_connection::lifecycle::take_ready_model_refresh_windows(&app);
                if pane_id == PRIMARY_PANE_ID {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "sidecar-ready",
                        port,
                    );
                }
            }
            PaneStartupOutcome::Failed(message) => {
                log::error!(
                    "pane session start failed: window_label={label} pane_id={pane_id} generation={generation} error={message} elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                let _ = app.emit_to(
                    EventTarget::webview_window(label.clone()),
                    "agent-pane-error",
                    serde_json::json!({
                        "paneId": pane_id,
                        "generation": generation,
                        "error": message,
                    }),
                );
                // Upstream readiness contract: the primary pane's failure also
                // surfaces as `sidecar-error` so the webview shows the cause.
                if pane_id == PRIMARY_PANE_ID {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "sidecar-error",
                        message,
                    );
                }
            }
            PaneStartupOutcome::Superseded => {}
        }
    });
    completion_rx
}

pub(crate) fn start_window_session(
    app: tauri::AppHandle,
    label: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) {
    decisions::initialize_project_decisions(&cwd);
    let _ = start_pane_session(
        app,
        label,
        PRIMARY_PANE_ID.to_string(),
        mode,
        chat_agent,
        cwd,
        session_path,
    );
}

/// Invalidate every daemon-owned runtime identity immediately after a crash so
/// stale bridges and proxy calls retire while the replacement daemon starts.
pub(crate) fn clear_runtime_pane_sessions(app: &tauri::AppHandle) {
    let windows: State<Windows> = app.state();
    let mut registry = windows.map.lock_or_recover();
    let labels: Vec<String> = registry.keys().cloned().collect();
    for label in labels {
        let pane_ids: Vec<String> = registry
            .get(&label)
            .map(|panes| panes.keys().cloned().collect())
            .unwrap_or_default();
        for pane_id in pane_ids {
            registry.next_generation = registry.next_generation.saturating_add(1);
            let generation = registry.next_generation;
            if let Some(pane) = registry
                .get_mut(&label)
                .and_then(|panes| panes.get_mut(&pane_id))
            {
                pane.session_id = None;
                pane.startup_error = None;
                pane.generation = generation;
            }
        }
    }
}

/// After a daemon respawn, re-create a session for every live pane from its
/// stored `{mode, chat_agent, cwd, session_path}` target.
pub(crate) fn recreate_all_window_sessions(app: tauri::AppHandle) {
    let targets = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock_or_recover();
        recovery_targets(&registry)
    };
    for (label, pane_id, mode, chat_agent, cwd, session_path, generation) in targets {
        let _ = launch_pane_session(
            app.clone(),
            label,
            pane_id,
            mode,
            chat_agent,
            cwd,
            session_path,
            generation,
        );
    }
}

/// Boot the app's windows. If a workspace snapshot has restorable windows (each
/// with a cwd that still exists on disk), reopen one window per entry — pointed
/// at its project + session, with saved geometry — and record a per-window
/// restore target so the webview skips the picker. Otherwise fall back to the
/// single default `main` window at the boot cwd (the picker then shows).
pub(crate) fn restore_or_default_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let ws = read_workspace(&app.config().identifier);
    let entries = filter_restorable(ws.windows, |c| Path::new(c).exists());
    if entries.is_empty() {
        // Fresh boot / nothing to restore: the usual single main window.
        build_app_window(app, "main")?;
        start_window_session(
            app.clone(),
            "main".into(),
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
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
        // Register the target before constructing the webview: even a hidden
        // webview may execute immediately after build() returns.
        {
            let state: State<RestoreTargets> = app.state();
            register_restore_target(
                &mut state.map.lock_or_recover(),
                label.clone(),
                RestoreEntry {
                    mode: entry.mode,
                    chat_agent: entry.chat_agent,
                    cwd: entry.cwd.clone(),
                    session_path: entry.session_path.clone(),
                },
            );
        }
        // Revealed once loaded; setup finishes (geometry included) before the event
        // loop can deliver that page-load, so the window appears already in place.
        // Dev-smoke minimizing is deferred until the saved geometry is applied.
        let win = match build_app_window_with_visibility(
            app,
            &label,
            WindowReveal::WhenLoadedCallerMinimizes,
        ) {
            Ok(win) => win,
            Err(error) => {
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock_or_recover(),
                    &label,
                );
                return Err(error);
            }
        };
        start_window_session(
            app.clone(),
            label.clone(),
            entry.mode,
            entry.chat_agent,
            PathBuf::from(&entry.cwd),
            entry.session_path.clone(),
        );
        // Apply saved geometry when present; else we tile after the loop.
        if let (Some(x), Some(y)) = (entry.x, entry.y) {
            any_geometry = true;
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let (Some(w), Some(h)) = (entry.width, entry.height) {
            any_geometry = true;
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        }
        apply_dev_smoke_window_state(&win)?;
    }
    if !any_geometry {
        arrange_windows(app, count);
    }
    broadcast_window_order(app);
    Ok(())
}

/// Before the final exit snapshot, re-read each live session's `/state` (via the
/// shared daemon, keyed by the window's `x-gg-session` header) so a window that
/// started a new session mid-run (changing its session file) is recorded at its
/// CURRENT session, not the one it was created with. Best-effort + time-boxed:
/// any window we can't reach keeps its last-known session_path.
pub(crate) fn refresh_live_sessions(app: &tauri::AppHandle) {
    let Some(port) = *app.state::<Daemon>().port.lock_or_recover() else {
        return;
    };
    let targets: Vec<(String, String)> = {
        let state: State<Windows> = app.state();
        let map = state.map.lock_or_recover();
        map.iter()
            .filter_map(|(label, panes)| {
                panes
                    .get(PRIMARY_PANE_ID)
                    .and_then(|pane| pane.session_id.clone())
                    .map(|id| (label.clone(), id))
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
    let results: Vec<(String, Option<String>, Option<PathBuf>)> =
        tauri::async_runtime::block_on(async {
            let mut out = Vec::with_capacity(targets.len());
            for (label, sid) in targets {
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
                out.push((label, session_path, cwd));
            }
            out
        });
    let state: State<Windows> = app.state();
    let mut map = state.map.lock_or_recover();
    for (label, session_path, cwd) in results {
        if let Some(inst) = map
            .get_mut(&label)
            .and_then(|panes| panes.get_mut(PRIMARY_PANE_ID))
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

    // Local Fork: upstream's single-session window tests
    // (window_session_records_project_before_daemon_answers, select_project_repoints_to_a_fresh_session,
    // closing_one_window_leaves_peers_intact, stale_window_session_generation_cannot_overwrite_newer_result)
    // are replaced by the generation-checked pane-registry tests in state.rs and daemon.rs:
    // stale_create_or_select_bind_cannot_overwrite_newer_generation, the pane_selection_* tests,
    // window_close_drains_only_its_panes, generation_mismatched_disposal_cannot_remove_replacement and
    // replacing_secondary_preserves_primary_identity_and_recovery_target.

    #[test]
    fn daemon_port_wait_outlasts_slow_daemon_boot() {
        let start = std::time::Instant::now();
        let deadline = daemon_port_wait_deadline(start);
        assert_eq!(deadline - start, DAEMON_PORT_WAIT_TIMEOUT);
        // Measured ~20s daemon module load under load; the old ceiling was 30s.
        assert!(DAEMON_PORT_WAIT_TIMEOUT >= Duration::from_secs(60));
        assert!(DAEMON_PORT_POLL_INTERVAL < DAEMON_PORT_WAIT_TIMEOUT);
    }

    #[test]
    fn daemon_session_response_preserves_resume_identity_rejections() {
        for message in [
            "Cannot resume a session from another project",
            "Cannot resume phase context from another project",
        ] {
            assert_eq!(
                parse_daemon_create_session_response(
                    reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                    &serde_json::json!({ "error": message }),
                ),
                Err(message.to_string())
            );
        }
        assert_eq!(
            parse_daemon_create_session_response(
                reqwest::StatusCode::OK,
                &serde_json::json!({ "sessionId": "same-project-session" }),
            ),
            Ok("same-project-session".to_string())
        );
    }

    #[test]
    fn daemon_respawns_with_bounded_exponential_backoff() {
        let delays: Vec<u64> = (1..=DAEMON_MAX_RESPAWNS)
            .map(|attempt| daemon_respawn_delay(attempt).unwrap().as_secs())
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16]);
    }

    #[test]
    fn daemon_start_wait_outlasts_the_crash_loop_and_slow_first_launch() {
        // Live bug: a 30s wait gave up on a daemon still being scanned by
        // macOS on first launch, and that window never got a session.
        let backoff: u64 = (1..=DAEMON_MAX_RESPAWNS)
            .map(|attempt| daemon_respawn_delay(attempt).unwrap().as_secs())
            .sum();
        assert!(DAEMON_START_TIMEOUT.as_secs() >= backoff + 120);
    }

    #[test]
    fn window_readiness_reports_the_failed_start_reason() {
        // Upstream test ported to the per-pane readiness seam.
        let mut pane = PaneSession {
            generation: 1,
            ..Default::default()
        };
        assert_eq!(pane_readiness(None, Some(9)), Ok(None));
        assert_eq!(pane_readiness(Some(&pane), Some(9)), Ok(None));
        pane.session_id = Some("sid".into());
        assert_eq!(pane_readiness(Some(&pane), None), Ok(None));
        assert_eq!(pane_readiness(Some(&pane), Some(9)), Ok(Some(9)));
        pane.session_id = None;
        pane.startup_error = Some("boom".into());
        assert_eq!(pane_readiness(Some(&pane), Some(9)), Err("boom".into()));
    }

    #[test]
    fn stale_start_failure_does_not_mask_a_newer_attempt() {
        // Upstream test ported to the pane registry's generation check.
        let mut registry = PaneRegistry::default();
        let first = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("/p"),
            None,
        );
        let second = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("/p"),
            None,
        );
        assert!(!record_pane_startup_error(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            first,
            "old failure".into()
        ));
        let pane = resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).unwrap();
        assert!(pane.startup_error.is_none());
        assert!(record_pane_startup_error(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            second,
            "new failure".into()
        ));
        let pane = resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).unwrap();
        assert_eq!(pane.startup_error.as_deref(), Some("new failure"));
        assert!(!record_pane_startup_error(
            &mut registry,
            "gone",
            PRIMARY_PANE_ID,
            second,
            "closed window".into()
        ));
    }

    #[test]
    fn crash_loop_message_carries_the_fatal_reason() {
        assert_eq!(
            crash_loop_message(Some("GG_APP_FATAL EACCES: ~/.gg/settings.json")),
            "The agent daemon kept crashing on startup: EACCES: ~/.gg/settings.json"
        );
        assert_eq!(
            crash_loop_message(Some("GG_APP_FATAL ")),
            "The agent daemon stopped after repeated crashes."
        );
        assert_eq!(
            crash_loop_message(None),
            "The agent daemon stopped after repeated crashes."
        );
    }

    #[test]
    fn daemon_crash_loop_opens_circuit_breaker() {
        assert!(daemon_respawn_delay(0).is_none());
        assert!(daemon_respawn_delay(DAEMON_MAX_RESPAWNS + 1).is_none());
    }

    #[test]
    fn pane_selection_rejects_cancelled_startup_orchestration() {
        tauri::async_runtime::block_on(async {
            let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
            let startup = orchestrate_pane_session_startup(
                "chat",
                42,
                std::future::pending::<Result<(u16, String), String>>(),
                |_| unreachable!(),
                |_| unreachable!(),
                |_, _| async {},
                completion_tx,
            );
            drop(startup);

            assert_eq!(
                settle_pane_selection("chat", 42, completion_rx)
                    .await
                    .unwrap_err(),
                "pane 'chat' generation 42 startup ended without settlement"
            );
        });
    }

    #[test]
    fn pane_session_startup_times_out_when_daemon_does_not_respond() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("POST /session HTTP/1.1"));
            std::thread::sleep(Duration::from_millis(250));
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"sessionId\":\"too-late\"}",
            );
        });

        let request = http_client_builder()
            .build()
            .unwrap()
            .post(format!("http://{address}/session"))
            .header("x-gg-daemon-token", "test-token")
            .json(&serde_json::json!({ "cwd": "/test" }));
        let result = tauri::async_runtime::block_on(send_daemon_create_session_request(
            request,
            Duration::from_millis(50),
        ));
        server.join().unwrap();

        assert_eq!(
            result.err().as_deref(),
            Some("agent daemon session startup timed out; retry selecting the project")
        );
    }

    #[test]
    fn restore_target_survives_repeated_webview_mounts_until_cleanup() {
        let mut targets = HashMap::new();
        let entry = RestoreEntry {
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: "/project".into(),
            session_path: Some("/sessions/one.jsonl".into()),
        };

        register_restore_target(&mut targets, "main".into(), entry);
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert!(remove_restore_target(&mut targets, "main").is_some());
        assert!(restore_target(&targets, "main").is_none());
    }

    #[test]
    fn stale_pane_session_generation_cannot_overwrite_newer_result() {
        // Upstream's stale_window_session_generation_cannot_overwrite_newer_result,
        // ported to the pane registry.
        let mut registry = PaneRegistry::default();
        let generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("/new-project"),
            None,
        );
        assert!(!bind_pane_session_with_path(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            generation - 1,
            "stale-session".into(),
            Some("/sessions/stale.jsonl".into())
        ));
        assert!(bind_pane_session_with_path(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            generation,
            "new-session".into(),
            Some("/sessions/new.jsonl".into())
        ));
        let pane = resolve_owned_pane(&registry, "main", PRIMARY_PANE_ID).unwrap();
        assert_eq!(pane.session_id.as_deref(), Some("new-session"));
        assert_eq!(pane.session_path.as_deref(), Some("/sessions/new.jsonl"));
    }

    #[test]
    fn a_fresh_session_records_its_path_so_a_daemon_respawn_reopens_it() {
        // Live bug: a goal window opened without a path; after a daemon
        // respawn it was recreated with none and lost its conversation.
        let mut registry = PaneRegistry::default();
        let generation = record_pane_target(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            WorkspaceMode::Code,
            ChatAgent::General,
            PathBuf::from("/project"),
            None,
        );
        assert!(bind_pane_session_with_path(
            &mut registry,
            "main",
            PRIMARY_PANE_ID,
            generation,
            "sid".into(),
            Some("/sessions/fresh.jsonl".into())
        ));
        let targets = recovery_targets(&registry);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].5.as_deref(), Some("/sessions/fresh.jsonl"));
        assert_eq!(
            json_session_path(&serde_json::json!({ "sessionId": "x", "sessionPath": "" })),
            None
        );
        assert_eq!(
            json_session_path(&serde_json::json!({ "sessionId": "x", "sessionPath": "/s.jsonl" })),
            Some("/s.jsonl".into())
        );
    }
}
