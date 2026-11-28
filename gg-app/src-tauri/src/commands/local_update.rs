//! Local patched-update status, notice and installer handoff commands.

use crate::*;

/// App-wide guards for protected installation and lightweight status refreshes.
#[derive(Default)]
pub(crate) struct LocalPatchedUpdate {
    pub(crate) running: Mutex<bool>,
    pub(crate) status_check: Mutex<LocalPatchedStatusCheck>,
}

#[derive(Default)]
pub(crate) struct LocalPatchedStatusCheck {
    pub(crate) running: bool,
    pub(crate) last_completed: Option<local_patched_update::LocalPatchedUpdateStatus>,
}

impl LocalPatchedUpdate {
    /// Returns `None` to elect a leader, or the immediate follower response.
    pub(crate) fn begin_status_check(
        &self,
    ) -> Option<local_patched_update::LocalPatchedUpdateStatus> {
        let mut check = self.status_check.lock_or_recover();
        if check.running {
            return Some(check.last_completed.clone().unwrap_or(
                local_patched_update::LocalPatchedUpdateStatus {
                    available: false,
                    current_source_sha: String::new(),
                    upstream_integrated: false,
                    origin: local_patched_update::StatusOrigin::Unavailable,
                },
            ));
        }
        check.running = true;
        None
    }

    pub(crate) fn finish_status_check(
        &self,
        result: &Result<local_patched_update::LocalPatchedUpdateStatus, String>,
    ) {
        let mut check = self.status_check.lock_or_recover();
        check.running = false;
        if let Ok(status) = result {
            check.last_completed = Some(status.clone());
        }
    }
}

pub(crate) const LOCAL_PATCHED_UPDATE_EVENT: &str = "local-patched-update";

/// Check local source state without blocking Tauri's async command runtime. The
/// protected update workflow remains the sole owner of merges and builds.
#[tauri::command]
pub(crate) async fn app_local_patched_update_status(
    update_state: State<'_, LocalPatchedUpdate>,
    repo_root: String,
    built_git_sha: String,
) -> Result<local_patched_update::LocalPatchedUpdateStatus, String> {
    if built_git_sha.trim().is_empty() {
        return Err("The Local Fork build SHA is missing.".to_string());
    }

    if let Some(status) = update_state.begin_status_check() {
        return Ok(status);
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let repo = resolve_local_update_repo_root(repo_root)?;
        local_patched_update::check_local_patched_update(
            &local_patched_update::BoundedGitRunner::default(),
            &repo,
            &built_git_sha,
        )
    })
    .await
    .map_err(|error| format!("Local Fork status worker failed: {error}"))
    .and_then(|result| result);

    update_state.finish_status_check(&result);
    result
}

#[tauri::command]
pub(crate) fn app_local_patched_update_start(
    app: tauri::AppHandle,
    webview: WebviewWindow,
    update_state: State<'_, LocalPatchedUpdate>,
    repo_root: String,
    summarize_decisions: bool,
) -> Result<serde_json::Value, String> {
    let repo = resolve_local_update_repo_root(repo_root)?;
    {
        let mut running = update_state.running.lock_or_recover();
        if *running {
            return Err("A local-patched update is already running.".into());
        }
        *running = true;
    }
    let sidecar = port_for(&webview).zip(pane_session_for(&webview, PRIMARY_PANE_ID));
    std::thread::spawn(move || run_local_patched_update(app, repo, summarize_decisions, sidecar));
    Ok(serde_json::json!({ "started": true }))
}

pub(crate) fn resolve_local_update_repo_root(repo_root: String) -> Result<PathBuf, String> {
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
    if !repo.join("package.json").is_file()
        || !repo.join("gg-app/package.json").is_file()
        || !repo
            .join("gg-app/scripts/update-with-local-fixes.mjs")
            .is_file()
    {
        return Err(format!(
            "{} does not look like the local gg-framework checkout.",
            repo.display()
        ));
    }
    Ok(repo)
}

pub(crate) fn emit_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    let _ = app.emit(LOCAL_PATCHED_UPDATE_EVENT, payload);
}

pub(crate) fn run_local_patched_update(
    app: tauri::AppHandle,
    repo: PathBuf,
    summarize_decisions: bool,
    sidecar: Option<(u16, String)>,
) {
    emit_local_patched_update(
        &app,
        serde_json::json!({
            "type": "started",
            "message": "Starting protected source update: backup, fetch, rebase, restore, check, and build.",
        }),
    );
    let mut command = local_patched_update_command(summarize_decisions);
    command
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_local_patched_update(
                &app,
                serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to start the local source updater: {error}"),
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
            if summarize_decisions {
                write_decision_summary(&app, &repo, sidecar);
            }
            #[cfg(target_os = "windows")]
            {
                match schedule_local_patched_installer_handoff(&repo) {
                    Ok(disposition) => {
                        emit_local_patched_update(
                            &app,
                            serde_json::json!({
                                "type": "completed",
                                "exitCode": status.code().unwrap_or(0),
                                "disposition": disposition,
                                "message": completed_local_update_message(disposition),
                            }),
                        );
                        clear_local_patched_update_running(&app);
                        if disposition == "install-scheduled" {
                            app.exit(0);
                        }
                    }
                    Err(error) => finish_local_patched_update(
                        &app,
                        serde_json::json!({
                            "type": "error",
                            "message": format!("Failed to schedule the guarded Local Fork installer: {error}"),
                        }),
                    ),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let installer = newest_rebuilt_installer(&repo);
                let opened = open_rebuilt_update_result(&app, installer.as_deref(), &repo);
                emit_local_patched_update(
                    &app,
                    serde_json::json!({
                        "type": "completed",
                        "exitCode": status.code().unwrap_or(0),
                        "installerPath": installer.map(|path| path.to_string_lossy().to_string()),
                        "opened": opened,
                        "message": completed_local_update_message(opened),
                    }),
                );
                clear_local_patched_update_running(&app);
            }
        }
        Ok(status) => finish_local_patched_update(
            &app,
            serde_json::json!({
                "type": "error",
                "exitCode": status.code(),
                "message": format!(
                    "Local-patched update failed with exit code {}. Review the progress output for recovery instructions.",
                    status.code().map_or_else(|| "unknown".into(), |code| code.to_string())
                ),
            }),
        ),
        Err(error) => finish_local_patched_update(
            &app,
            serde_json::json!({
                "type": "error",
                "message": format!("Local-patched update process failed: {error}"),
            }),
        ),
    }
}

pub(crate) fn local_patched_update_command(summarize_decisions: bool) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args([
            "/C",
            "pnpm",
            "--filter",
            "gg-app",
            "update:local-fixes",
            "--",
            "--check",
        ]);
        if summarize_decisions {
            command.arg("--decision-summary-context");
        }
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("pnpm");
        command.args(["--filter", "gg-app", "update:local-fixes", "--", "--check"]);
        if summarize_decisions {
            command.arg("--decision-summary-context");
        }
        command
    }
}

pub(crate) fn stream_local_update_output<R: Read + Send + 'static>(
    app: tauri::AppHandle,
    stream: &'static str,
    reader: R,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            emit_local_patched_update(
                &app,
                serde_json::json!({ "type": "line", "stream": stream, "line": line }),
            );
        }
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn local_patched_installer_handoff_command(
    repo: &Path,
    source_revision: &str,
) -> Command {
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
    let mut command = Command::new(powershell);
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(
        repo.join("gg-app")
            .join("scripts")
            .join("launch-local-patched.ps1"),
    );
    command.arg("-MetadataPath");
    command.arg(
        repo.join(".gg")
            .join("local-fixes")
            .join("latest-installer.json"),
    );
    command.args([
        "-ExpectedVersion",
        env!("CARGO_PKG_VERSION"),
        "-ExpectedSourceRevision",
        source_revision,
    ]);
    command
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalPatchedInstallerHandoff {
    pub(crate) disposition: String,
    pub(crate) expected_version: String,
    pub(crate) source_revision: String,
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_local_patched_installer_handoff(
    stdout: &[u8],
    expected_version: &str,
    expected_source_revision: &str,
) -> Result<&'static str, String> {
    let result: LocalPatchedInstallerHandoff = serde_json::from_slice(stdout)
        .map_err(|error| format!("launcher returned malformed output: {error}"))?;
    if result.expected_version != expected_version {
        return Err("launcher did not confirm the expected version".into());
    }
    if result.source_revision != expected_source_revision {
        return Err("launcher did not echo the expected source revision".into());
    }
    match result.disposition.as_str() {
        "install-scheduled" => Ok("install-scheduled"),
        "existing-and-verified" => Ok("existing-and-verified"),
        _ => Err("launcher returned an unexpected disposition".into()),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn schedule_local_patched_installer_handoff(
    repo: &Path,
) -> Result<&'static str, String> {
    let source_revision = local_patched_update::full_source_head(
        &local_patched_update::BoundedGitRunner::default(),
        repo,
    )?;
    let output = hide_console(&mut local_patched_installer_handoff_command(
        repo,
        &source_revision,
    ))
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|error| format!("failed to start canonical launcher: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "launcher exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_local_patched_installer_handoff(
        &output.stdout,
        env!("CARGO_PKG_VERSION"),
        &source_revision,
    )
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn newest_rebuilt_installer(repo: &Path) -> Option<PathBuf> {
    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    let directories = ["nsis", "msi", "dmg", "appimage", "deb", "rpm"];
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for directory in directories.map(|name| bundle.join(name)) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if !["exe", "msi", "dmg", "AppImage", "deb", "rpm"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
                continue;
            };
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn open_rebuilt_update_result(
    app: &tauri::AppHandle,
    installer: Option<&Path>,
    repo: &Path,
) -> &'static str {
    if let Some(installer) = installer {
        if open_with_default(&installer.to_string_lossy()).is_ok() {
            return "installer";
        }
    }
    let bundle = repo.join("gg-app/src-tauri/target/release/bundle");
    if open_with_default(&bundle.to_string_lossy()).is_ok() {
        "folder"
    } else {
        "none"
    }
}

pub(crate) fn completed_local_update_message(opened: &str) -> &'static str {
    match opened {
        "install-scheduled" => {
            "Verified replacement scheduled. GG Coder will close and restart after installation."
        }
        "installer" => "Patched installer built and opened. Finish installation to update the app.",
        "folder" => "Patched installer built. Opened its containing folder.",
        _ => "Patched installer built under gg-app/src-tauri/target/release/bundle.",
    }
}

pub(crate) fn finish_local_patched_update(app: &tauri::AppHandle, payload: serde_json::Value) {
    emit_local_patched_update(app, payload);
    clear_local_patched_update_running(app);
}

pub(crate) fn clear_local_patched_update_running(app: &tauri::AppHandle) {
    let state: State<LocalPatchedUpdate> = app.state();
    *state.running.lock_or_recover() = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn local_patched_installer_handoff_uses_canonical_launcher_and_revision() {
        let repo = Path::new(r"C:\repo");
        let source_revision = "0123456789abcdef0123456789abcdef01234567";
        let command = local_patched_installer_handoff_command(repo, source_revision);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            Path::new(command.get_program()),
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        );
        assert_eq!(
            args,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                r"C:\repo\gg-app\scripts\launch-local-patched.ps1",
                "-MetadataPath",
                r"C:\repo\.gg\local-fixes\latest-installer.json",
                "-ExpectedVersion",
                env!("CARGO_PKG_VERSION"),
                "-ExpectedSourceRevision",
                source_revision,
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_patched_installer_handoff_requires_revision_echo() {
        let source_revision = "0123456789abcdef0123456789abcdef01234567";
        for disposition in ["install-scheduled", "existing-and-verified"] {
            let stdout = format!(
                r#"{{"disposition":"{disposition}","expectedVersion":"{}","sourceRevision":"{source_revision}"}}"#,
                env!("CARGO_PKG_VERSION")
            );
            assert_eq!(
                parse_local_patched_installer_handoff(
                    stdout.as_bytes(),
                    env!("CARGO_PKG_VERSION"),
                    source_revision,
                )
                .expect("canonical launcher result"),
                disposition
            );
        }
        assert!(parse_local_patched_installer_handoff(
            b"not-json",
            env!("CARGO_PKG_VERSION"),
            source_revision,
        )
        .is_err());
        assert!(parse_local_patched_installer_handoff(
            br#"{"disposition":"unexpected","expectedVersion":"0.53.9","sourceRevision":"0123456789abcdef0123456789abcdef01234567"}"#,
            env!("CARGO_PKG_VERSION"),
            source_revision,
        )
        .is_err());
        let mismatched = format!(
            r#"{{"disposition":"install-scheduled","expectedVersion":"{}","sourceRevision":"{}"}}"#,
            env!("CARGO_PKG_VERSION"),
            "a".repeat(40),
        );
        assert!(parse_local_patched_installer_handoff(
            mismatched.as_bytes(),
            env!("CARGO_PKG_VERSION"),
            source_revision,
        )
        .is_err());
    }

    #[test]
    fn local_patched_update_notice_requires_a_real_source_difference() {
        let full_sha = "0123456789abcdef0123456789abcdef01234567";
        assert!(!local_patched_update_available(full_sha, full_sha, true));
        assert!(!local_patched_update_available("0123456", full_sha, true));
        assert!(local_patched_update_available(
            "abcdef0123456789abcdef0123456789abcdef01",
            full_sha,
            true
        ));
        assert!(local_patched_update_available(full_sha, full_sha, false));
        assert!(!local_patched_update_available("unknown", full_sha, true));
    }

    #[test]
    fn local_patched_update_status_guard_is_single_flight_and_reuses_cache() {
        let state = LocalPatchedUpdate::default();
        assert!(
            state.begin_status_check().is_none(),
            "first caller is leader"
        );
        let follower = state
            .begin_status_check()
            .expect("follower gets immediate status");
        assert_eq!(
            follower.origin,
            local_patched_update::StatusOrigin::Unavailable
        );

        let completed = local_patched_update::LocalPatchedUpdateStatus {
            available: true,
            current_source_sha: "aaaaaaa".to_string(),
            upstream_integrated: false,
            origin: local_patched_update::StatusOrigin::Cached,
        };
        state.finish_status_check(&Ok(completed.clone()));
        assert!(
            state.begin_status_check().is_none(),
            "completed check releases guard"
        );
        let cached_follower = state
            .begin_status_check()
            .expect("next follower gets cache");
        assert_eq!(cached_follower, completed);
        state.finish_status_check(&Ok(completed));
    }

    #[test]
    fn local_patched_update_spawn_blocking_keeps_async_runtime_responsive() {
        tauri::async_runtime::block_on(async {
            let worker = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(250));
                1
            });
            let sentinel = tauri::async_runtime::spawn(async { 2 });
            let sentinel_result = tokio::time::timeout(Duration::from_millis(100), sentinel)
                .await
                .expect("sentinel must not wait for blocking status work")
                .expect("sentinel task succeeds");
            assert_eq!(sentinel_result, 2);
            assert_eq!(worker.await.unwrap(), 1);
        });
    }
}
