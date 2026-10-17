use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(windows)]
const WINDOWS_CREATE_SUSPENDED: u32 = 0x0000_0004;
#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub(crate) const LOCAL_GIT_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const FETCH_GIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StatusOrigin {
    Fresh,
    Cached,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalPatchedUpdateStatus {
    pub(crate) available: bool,
    pub(crate) current_source_sha: String,
    pub(crate) upstream_integrated: bool,
    pub(crate) origin: StatusOrigin,
}

#[derive(Debug)]
pub(crate) struct CommandOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

#[derive(Debug)]
pub(crate) enum RunError {
    Start(String),
    Containment(String),
    Wait(String),
    Timeout,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Start(message) | Self::Containment(message) | Self::Wait(message) => {
                formatter.write_str(message)
            }
            Self::Timeout => formatter.write_str("git command timed out"),
        }
    }
}

pub(crate) trait GitRunner: Send + Sync {
    fn run(&self, repo: &Path, args: &[&str], timeout: Duration)
        -> Result<CommandOutput, RunError>;
}

pub(crate) struct BoundedGitRunner {
    executable: PathBuf,
    prefix_args: Vec<String>,
}

impl Default for BoundedGitRunner {
    fn default() -> Self {
        Self {
            executable: PathBuf::from("git"),
            prefix_args: Vec::new(),
        }
    }
}

#[cfg(test)]
impl BoundedGitRunner {
    pub(crate) fn new(executable: PathBuf, prefix_args: Vec<String>) -> Self {
        Self {
            executable,
            prefix_args,
        }
    }
}

impl GitRunner for BoundedGitRunner {
    fn run(
        &self,
        repo: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> Result<CommandOutput, RunError> {
        let mut command = Command::new(&self.executable);
        command
            .args(&self.prefix_args)
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_contained_child(&mut command);

        let mut child = command.spawn().map_err(|error| {
            RunError::Start(format!("failed to run git in {}: {error}", repo.display()))
        })?;
        let containment = match ChildContainment::attach(&child) {
            Ok(containment) => containment,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        if let Err(error) = containment.resume(&child) {
            containment.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdout = child.stdout.take().map(spawn_output_reader);
        let stderr = child.stderr.take().map(spawn_output_reader);
        let deadline = Instant::now() + timeout;

        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(
                    POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
                ),
                Ok(None) => {
                    containment.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(RunError::Timeout);
                }
                Err(error) => {
                    containment.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(RunError::Wait(format!(
                        "failed while waiting for git: {error}"
                    )));
                }
            }
        };

        let stdout = join_output_reader(stdout);
        let stderr = join_output_reader(stderr);
        status.map(|status| CommandOutput {
            status,
            stdout,
            stderr,
        })
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut captured = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let remaining = OUTPUT_LIMIT_BYTES.saturating_sub(captured.len());
                    captured.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
        captured
    })
}

fn join_output_reader(reader: Option<thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default()
}

#[cfg(unix)]
fn configure_contained_child(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(windows)]
fn windows_creation_flags() -> u32 {
    WINDOWS_CREATE_NO_WINDOW | WINDOWS_CREATE_SUSPENDED
}

#[cfg(windows)]
fn configure_contained_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(windows_creation_flags());
}

#[cfg(not(any(unix, windows)))]
fn configure_contained_child(_command: &mut Command) {}

#[cfg(unix)]
struct ChildContainment {
    process_group: i32,
}

#[cfg(unix)]
impl ChildContainment {
    fn attach(child: &std::process::Child) -> Result<Self, RunError> {
        Ok(Self {
            process_group: child.id() as i32,
        })
    }

    fn resume(&self, _child: &std::process::Child) -> Result<(), RunError> {
        Ok(())
    }

    fn terminate(&self) {
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
struct ChildContainment {
    job: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process_handle: windows::Win32::Foundation::HANDLE) -> i32;
}

#[cfg(windows)]
impl ChildContainment {
    fn attach(child: &std::process::Child) -> Result<Self, RunError> {
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(None, None).map_err(|error| {
                RunError::Containment(format!("failed to create git Job Object: {error}"))
            })?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err(RunError::Containment(format!(
                    "failed to configure git Job Object: {error}"
                )));
            }
            let process = HANDLE(child.as_raw_handle());
            if let Err(error) = AssignProcessToJobObject(job, process) {
                let _ = windows::Win32::Foundation::CloseHandle(job);
                return Err(RunError::Containment(format!(
                    "failed to assign git to Job Object: {error}"
                )));
            }
            Ok(Self { job })
        }
    }

    fn resume(&self, child: &std::process::Child) -> Result<(), RunError> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;

        let status = unsafe { NtResumeProcess(HANDLE(child.as_raw_handle())) };
        if status >= 0 {
            Ok(())
        } else {
            Err(RunError::Containment(format!(
                "failed to resume contained git process: NTSTATUS 0x{:08X}",
                status as u32
            )))
        }
    }

    fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ChildContainment {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct ChildContainment;

#[cfg(not(any(unix, windows)))]
impl ChildContainment {
    fn attach(_child: &std::process::Child) -> Result<Self, RunError> {
        Ok(Self)
    }

    fn resume(&self, _child: &std::process::Child) -> Result<(), RunError> {
        Ok(())
    }

    fn terminate(&self) {}
}

pub(crate) fn full_source_head(runner: &dyn GitRunner, repo: &Path) -> Result<String, String> {
    let head = runner
        .run(repo, &["rev-parse", "HEAD"], LOCAL_GIT_TIMEOUT)
        .map_err(|error| format!("failed to inspect local source HEAD: {error}"))?;
    if !head.status.success() {
        return Err(command_failure(
            "failed to inspect local source HEAD",
            &head,
        ));
    }
    let revision = output_text(&head.stdout);
    if revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The local source checkout HEAD is not a full 40-character Git SHA.".into());
    }
    Ok(revision.to_ascii_lowercase())
}

pub(crate) fn check_local_patched_update(
    runner: &dyn GitRunner,
    repo: &Path,
    built_git_sha: &str,
) -> Result<LocalPatchedUpdateStatus, String> {
    let built_git_sha = built_git_sha.trim();
    if built_git_sha.is_empty() {
        return Err("The Local Fork build SHA is missing.".to_string());
    }

    let head = runner
        .run(repo, &["rev-parse", "HEAD"], LOCAL_GIT_TIMEOUT)
        .map_err(|error| format!("failed to inspect local source HEAD: {error}"))?;
    if !head.status.success() {
        return Err(command_failure(
            "failed to inspect local source HEAD",
            &head,
        ));
    }
    let current_source_sha = output_text(&head.stdout);
    if current_source_sha.is_empty() {
        return Err("The local source checkout has no HEAD revision.".to_string());
    }

    let cached_upstream = read_upstream_ref(runner, repo);
    let fetch_succeeded = runner
        .run(
            repo,
            &["fetch", "--quiet", "upstream", "main"],
            FETCH_GIT_TIMEOUT,
        )
        .map(|output| output.status.success())
        .unwrap_or(false);
    let upstream_sha = if fetch_succeeded {
        read_upstream_ref(runner, repo).or(cached_upstream.clone())
    } else {
        cached_upstream.clone()
    };

    let Some(_upstream_sha) = upstream_sha else {
        return Ok(LocalPatchedUpdateStatus {
            available: false,
            current_source_sha,
            upstream_integrated: false,
            origin: StatusOrigin::Unavailable,
        });
    };

    let upstream_integrated = match runner.run(
        repo,
        &["merge-base", "--is-ancestor", "upstream/main", "HEAD"],
        LOCAL_GIT_TIMEOUT,
    ) {
        Ok(output) => match output.status.code() {
            Some(0) => true,
            Some(1) => false,
            _ => {
                return Ok(LocalPatchedUpdateStatus {
                    available: false,
                    current_source_sha,
                    upstream_integrated: false,
                    origin: StatusOrigin::Unavailable,
                });
            }
        },
        Err(_) => {
            return Ok(LocalPatchedUpdateStatus {
                available: false,
                current_source_sha,
                upstream_integrated: false,
                origin: StatusOrigin::Unavailable,
            });
        }
    };
    let origin = if fetch_succeeded {
        StatusOrigin::Fresh
    } else {
        StatusOrigin::Cached
    };
    Ok(LocalPatchedUpdateStatus {
        available: local_patched_update_available(
            built_git_sha,
            &current_source_sha,
            upstream_integrated,
        ),
        current_source_sha,
        upstream_integrated,
        origin,
    })
}

fn read_upstream_ref(runner: &dyn GitRunner, repo: &Path) -> Option<String> {
    runner
        .run(
            repo,
            &["rev-parse", "--verify", "upstream/main"],
            LOCAL_GIT_TIMEOUT,
        )
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output_text(&output.stdout))
        .filter(|sha| !sha.is_empty())
}

fn output_text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_string()
}

fn command_failure(context: &str, output: &CommandOutput) -> String {
    let stderr = output_text(&output.stderr);
    if stderr.is_empty() {
        context.to_string()
    } else {
        format!("{context}: {stderr}")
    }
}

pub(crate) fn local_patched_update_available(
    built_git_sha: &str,
    current_source_sha: &str,
    upstream_integrated: bool,
) -> bool {
    let built_sha = built_git_sha.trim();
    let built_sha_is_known =
        built_sha.len() >= 7 && built_sha.bytes().all(|byte| byte.is_ascii_hexdigit());
    let build_matches_source =
        current_source_sha.starts_with(built_sha) || built_sha.starts_with(current_source_sha);
    (built_sha_is_known && !build_matches_source) || !upstream_integrated
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct FakeResponse {
        code: i32,
        stdout: &'static str,
        delay: Duration,
        error: Option<RunError>,
    }

    struct FakeRunner {
        responses: Mutex<VecDeque<FakeResponse>>,
        calls: Mutex<Vec<(Vec<String>, Duration)>>,
        fetches: AtomicUsize,
    }

    impl FakeRunner {
        fn new(responses: Vec<FakeResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
                fetches: AtomicUsize::new(0),
            }
        }
    }

    impl GitRunner for FakeRunner {
        fn run(
            &self,
            _repo: &Path,
            args: &[&str],
            timeout: Duration,
        ) -> Result<CommandOutput, RunError> {
            self.calls
                .lock()
                .unwrap()
                .push((args.iter().map(|arg| (*arg).to_string()).collect(), timeout));
            if args.first() == Some(&"fetch") {
                self.fetches.fetch_add(1, Ordering::SeqCst);
            }
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake response");
            thread::sleep(response.delay);
            if let Some(error) = response.error {
                return Err(error);
            }
            Ok(CommandOutput {
                status: exit_status(response.code),
                stdout: response.stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
        }
    }

    fn response(code: i32, stdout: &'static str) -> FakeResponse {
        FakeResponse {
            code,
            stdout,
            delay: Duration::ZERO,
            error: None,
        }
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn full_source_head_requires_and_normalizes_exact_revision() {
        let runner = FakeRunner::new(vec![response(
            0,
            "ABCDEF0123456789ABCDEF0123456789ABCDEF01\n",
        )]);
        assert_eq!(
            full_source_head(&runner, Path::new("repo")).unwrap(),
            "abcdef0123456789abcdef0123456789abcdef01"
        );
    }

    #[test]
    fn full_source_head_rejects_abbreviated_revision() {
        let runner = FakeRunner::new(vec![response(0, "abcdef0\n")]);
        assert!(full_source_head(&runner, Path::new("repo")).is_err());
    }

    #[test]
    fn local_patched_update_fast_fetch_returns_fresh_status() {
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            response(0, ""),
            response(0, "bbbbbbb\n"),
            response(0, ""),
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Fresh);
        assert!(!status.available);
        assert_eq!(status.current_source_sha, "aaaaaaa");
        assert!(status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_merge_base_exit_one_reports_update_from_cached_ref() {
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            response(1, ""),
            response(1, ""),
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Cached);
        assert!(status.available);
        assert!(!status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_merge_base_timeout_is_unavailable() {
        let mut timeout = response(1, "");
        timeout.error = Some(RunError::Timeout);
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            response(0, ""),
            response(0, "bbbbbbb\n"),
            timeout,
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Unavailable);
        assert!(!status.available);
        assert_eq!(status.current_source_sha, "aaaaaaa");
        assert!(!status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_merge_base_runner_error_is_unavailable() {
        let mut error = response(1, "");
        error.error = Some(RunError::Wait("merge-base failed".to_string()));
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            response(0, ""),
            response(0, "bbbbbbb\n"),
            error,
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Unavailable);
        assert!(!status.available);
        assert_eq!(status.current_source_sha, "aaaaaaa");
        assert!(!status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_merge_base_exit_above_one_is_unavailable() {
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            response(0, ""),
            response(0, "bbbbbbb\n"),
            response(128, ""),
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Unavailable);
        assert!(!status.available);
        assert_eq!(status.current_source_sha, "aaaaaaa");
        assert!(!status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_failed_fetch_without_cache_is_unavailable() {
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(1, ""),
            response(1, ""),
        ]);

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Unavailable);
        assert!(!status.available);
        assert_eq!(status.current_source_sha, "aaaaaaa");
        assert!(!status.upstream_integrated);
    }

    #[test]
    fn local_patched_update_hung_fetch_observes_deadline_and_uses_cache() {
        let mut timeout = response(1, "");
        timeout.delay = Duration::from_millis(60);
        timeout.error = Some(RunError::Timeout);
        let runner = FakeRunner::new(vec![
            response(0, "aaaaaaa\n"),
            response(0, "bbbbbbb\n"),
            timeout,
            response(0, ""),
        ]);
        let started = Instant::now();

        let status = check_local_patched_update(&runner, Path::new("repo"), "aaaaaaa").unwrap();

        assert_eq!(status.origin, StatusOrigin::Cached);
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_millis(500));
        let calls = runner.calls.lock().unwrap();
        let fetch = calls
            .iter()
            .find(|(args, _)| args.first() == Some(&"fetch".to_string()))
            .unwrap();
        assert_eq!(fetch.1, FETCH_GIT_TIMEOUT);
    }

    #[cfg(windows)]
    #[test]
    fn contained_git_spawn_is_suspended_and_windowless() {
        assert_eq!(windows_creation_flags(), 0x0800_0004);
    }

    #[cfg(windows)]
    #[test]
    fn local_patched_update_timeout_kills_immediately_spawned_descendant_and_reaps_child() {
        let directory = std::env::temp_dir().join(format!(
            "gg-local-update-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let script = directory.join("fake-git.ps1");
        let pid_file = directory.join("descendant.pid");
        std::fs::write(
            &script,
            format!(
                "param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)\n# The fake Git's first action is to spawn a descendant.\n$info = [Diagnostics.ProcessStartInfo]::new('cmd.exe', '/C ping -n 30 127.0.0.1 >NUL')\n$info.CreateNoWindow = $true\n$info.UseShellExecute = $false\n$child = [Diagnostics.Process]::Start($info)\nSet-Content -Path '{}' -Value $child.Id\n$child.WaitForExit()\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let runner = BoundedGitRunner::new(
            PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                script.display().to_string(),
            ],
        );
        let started = Instant::now();

        // PowerShell startup can exceed two seconds while the full Rust suite saturates Windows.
        let result = runner.run(&directory, &["fetch"], Duration::from_secs(10));

        assert!(matches!(result, Err(RunError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(13));
        let descendant_pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        let tasklist = Command::new("tasklist")
            .args([
                "/FI",
                &format!("PID eq {descendant_pid}"),
                "/FO",
                "CSV",
                "/NH",
            ])
            .output()
            .unwrap();
        let output = String::from_utf8_lossy(&tasklist.stdout);
        assert!(
            !output.contains(&format!("\"{descendant_pid}\"")),
            "descendant survived: {output}"
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
