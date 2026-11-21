//! Windows containment for the agent daemon's whole process tree.
//!
//! Agent tools launch dev servers, test runners and browsers as *detached*
//! processes. On Windows those are reparented away from the daemon, so neither
//! `taskkill /T` nor the startup orphan sweep can find them once the shell is
//! force-closed, crashes, or is replaced by an installer. They then run
//! indefinitely and starve the machine until project startup times out.
//!
//! A Job Object with `KILL_ON_JOB_CLOSE` follows every descendant regardless of
//! reparenting (Node's detached spawn does not request job breakaway). Only this
//! process holds the handle, so the kernel terminates the tree whenever the
//! handle closes: on normal exit, on a crash, or when the job is replaced after a
//! daemon respawn.

#[cfg(windows)]
pub(crate) struct DaemonJob {
    job: windows::Win32::Foundation::HANDLE,
}

// SAFETY: a Job Object handle is a kernel handle usable from any thread. It is
// only closed once, in `Drop`, and never exposed outside this type.
#[cfg(windows)]
unsafe impl Send for DaemonJob {}
#[cfg(windows)]
unsafe impl Sync for DaemonJob {}

#[cfg(windows)]
impl DaemonJob {
    /// Create a kill-on-close job and place `child` (and its future
    /// descendants) inside it.
    pub(crate) fn contain(child: &std::process::Child) -> Result<Self, String> {
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|error| format!("failed to create daemon Job Object: {error}"))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(job);
                return Err(format!("failed to configure daemon Job Object: {error}"));
            }
            if let Err(error) = AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) {
                let _ = CloseHandle(job);
                return Err(format!("failed to assign daemon to Job Object: {error}"));
            }
            Ok(Self { job })
        }
    }
}

#[cfg(windows)]
impl Drop for DaemonJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::DaemonJob;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn process_alive(pid: u32) -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }

    fn wait_until(deadline: Duration, mut done: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        done()
    }

    /// The exact leak: a parent starts a detached grandchild and exits, so the
    /// grandchild is reparented. Closing the job must still terminate it.
    #[test]
    fn closing_job_kills_detached_reparented_grandchild() {
        let pid_file = std::env::temp_dir().join(format!(
            "gg-daemon-job-test-{}-{}.pid",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let script = format!(
            "const {{spawn}} = require('node:child_process');\
             const c = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], \
               {{ detached: true, stdio: 'ignore', windowsHide: true }});\
             c.unref();\
             require('node:fs').writeFileSync({:?}, String(c.pid));",
            pid_file.to_string_lossy()
        );
        let mut parent = Command::new("node")
            .args(["-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node is available for this test");
        let job = DaemonJob::contain(&parent).expect("job assignment succeeds");
        parent
            .wait()
            .expect("parent exits after starting the grandchild");

        let grandchild: u32 = std::fs::read_to_string(&pid_file)
            .expect("grandchild pid recorded")
            .trim()
            .parse()
            .expect("numeric pid");
        let _ = std::fs::remove_file(&pid_file);
        assert!(
            process_alive(grandchild),
            "detached grandchild outlives its parent"
        );

        drop(job);

        assert!(
            wait_until(Duration::from_secs(10), || !process_alive(grandchild)),
            "closing the daemon job must terminate the reparented grandchild"
        );
    }
}
