//! Native, owner-scoped pseudo terminals.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::Duration;
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{State, WebviewWindow};

use crate::{owned_pane_cwd, validate_pane_id, Windows};

const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 1;
const MAX_ROWS: u16 = 300;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const MAX_PENDING_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = MAX_PENDING_OUTPUT_BYTES / OUTPUT_CHUNK_BYTES;
const OUTPUT_COALESCE_WINDOW: StdDuration = StdDuration::from_millis(8);
const OUTPUT_OVERFLOW_MESSAGE: &str =
    "terminal output exceeded the 4 MiB pending limit; terminal was closed";
static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInfo {
    terminal_id: String,
    pane_id: String,
    cwd: String,
    shell: String,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TerminalEvent {
    Exit {
        terminal_id: String,
        pane_id: String,
        exit_code: Option<i32>,
    },
    Error {
        terminal_id: String,
        pane_id: String,
        message: String,
    },
}

#[derive(Default)]
struct RegistryState {
    sessions: HashMap<String, TerminalSession>,
    closed: HashMap<String, ClosedTerminal>,
}

#[derive(Clone)]
struct ClosedTerminal {
    pane_id: String,
    terminal_id: String,
}

#[derive(Clone, Default)]
pub(crate) struct TerminalRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

struct TerminalSession {
    terminal_id: String,
    pane_id: String,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    dimensions: Arc<Mutex<(u16, u16)>>,
    #[cfg(unix)]
    process_group: Option<libc::pid_t>,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl TerminalRegistry {
    fn insert(&self, owner: &str, session: TerminalSession) -> Result<(), TerminalSession> {
        let Ok(mut state) = self.inner.lock() else {
            return Err(session);
        };
        if state.sessions.contains_key(owner) {
            return Err(session);
        }
        state.closed.remove(owner);
        state.sessions.insert(owner.to_string(), session);
        Ok(())
    }

    fn remove_matching(
        &self,
        owner: &str,
        pane_id: &str,
        terminal_id: &str,
    ) -> Option<TerminalSession> {
        let mut state = self.inner.lock().ok()?;
        let matches = state.sessions.get(owner).is_some_and(|session| {
            session.pane_id == pane_id && session.terminal_id == terminal_id
        });
        if !matches {
            return None;
        }
        let session = state.sessions.remove(owner)?;
        state.closed.insert(
            owner.to_string(),
            ClosedTerminal {
                pane_id: pane_id.to_string(),
                terminal_id: terminal_id.to_string(),
            },
        );
        Some(session)
    }

    fn take_for_window(&self, owner: &str) -> Option<TerminalSession> {
        let mut state = self.inner.lock().ok()?;
        let session = state.sessions.remove(owner)?;
        state.closed.insert(
            owner.to_string(),
            ClosedTerminal {
                pane_id: session.pane_id.clone(),
                terminal_id: session.terminal_id.clone(),
            },
        );
        Some(session)
    }

    fn take_for_pane(&self, owner: &str, pane_id: &str) -> Option<TerminalSession> {
        let mut state = self.inner.lock().ok()?;
        if state
            .sessions
            .get(owner)
            .is_none_or(|session| session.pane_id != pane_id)
        {
            return None;
        }
        let session = state.sessions.remove(owner)?;
        state.closed.insert(
            owner.to_string(),
            ClosedTerminal {
                pane_id: session.pane_id.clone(),
                terminal_id: session.terminal_id.clone(),
            },
        );
        Some(session)
    }
}

fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) {
        return Err(format!(
            "terminal columns must be between {MIN_COLS} and {MAX_COLS}"
        ));
    }
    if !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(format!(
            "terminal rows must be between {MIN_ROWS} and {MAX_ROWS}"
        ));
    }
    Ok(())
}

fn runtime_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let generation = NEXT_TERMINAL_ID.fetch_add(1, Ordering::Relaxed);
    format!("terminal-{millis:x}-{generation:x}")
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub(crate) fn terminal_create(
    webview: WebviewWindow,
    windows: State<'_, Windows>,
    terminals: State<'_, TerminalRegistry>,
    pane_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> Result<TerminalInfo, String> {
    validate_pane_id(&pane_id)?;
    validate_size(cols, rows)?;
    let owner = webview.label().to_string();

    {
        let state = terminals
            .inner
            .lock()
            .map_err(|_| "terminal registry lock poisoned")?;
        if state.sessions.contains_key(&owner) {
            return Err("a terminal is already open in this window".into());
        }
    }

    let cwd = owned_pane_cwd(&windows, &owner, &pane_id)?;
    let canonical_cwd = std::fs::canonicalize(&cwd)
        .map_err(|error| format!("failed to resolve terminal directory: {error}"))?;
    if !canonical_cwd.is_dir() {
        return Err("terminal project path is not a directory".into());
    }

    let terminal_id = runtime_id();
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|error| format!("failed to open terminal: {error:#}"))?;

    let mut command = CommandBuilder::new_default_prog();
    command.cwd(&canonical_cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let shell = command.get_shell();

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal shell: {error:#}"))?;
    drop(pair.slave);

    #[cfg(windows)]
    let job = match WindowsJob::for_child(child.as_ref()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    #[cfg(unix)]
    let process_group = pair.master.process_group_leader();

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("failed to open terminal output: {error:#}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(format!("failed to open terminal input: {error:#}"));
        }
    };
    let killer = child.clone_killer();
    let child = Arc::new(Mutex::new(child));

    let session = TerminalSession {
        terminal_id: terminal_id.clone(),
        pane_id: pane_id.clone(),
        writer: Arc::new(Mutex::new(Some(writer))),
        master: Arc::new(Mutex::new(Some(pair.master))),
        child: child.clone(),
        killer: Mutex::new(killer),
        dimensions: Arc::new(Mutex::new((cols, rows))),
        #[cfg(unix)]
        process_group,
        #[cfg(windows)]
        job: Some(job),
    };
    if let Err(session) = terminals.insert(&owner, session) {
        teardown_session(session);
        return Err("a terminal is already open in this window".into());
    }

    spawn_output_pump(
        reader,
        child,
        terminals.inner().clone(),
        owner,
        pane_id.clone(),
        terminal_id.clone(),
        on_event,
    );

    Ok(TerminalInfo {
        terminal_id,
        pane_id,
        cwd: canonical_cwd.to_string_lossy().into_owned(),
        shell,
        cols,
        rows,
    })
}

fn bounded_output_channel() -> (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) {
    std::sync::mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY)
}

fn reserve_pending_bytes(pending: &AtomicUsize, count: usize) -> bool {
    pending
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current
                .checked_add(count)
                .filter(|&next| next <= MAX_PENDING_OUTPUT_BYTES)
        })
        .is_ok()
}

fn coalesce_output(first: Vec<u8>, receiver: &Receiver<Vec<u8>>) -> Vec<u8> {
    let deadline = Instant::now() + OUTPUT_COALESCE_WINDOW;
    let mut output = first;
    while output.len() < MAX_PENDING_OUTPUT_BYTES {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }
    output
}

fn spawn_output_pump(
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    terminals: TerminalRegistry,
    owner: String,
    pane_id: String,
    terminal_id: String,
    on_event: Channel<InvokeResponseBody>,
) {
    let (exit_sender, exit_receiver) = std::sync::mpsc::sync_channel(1);
    let (output_sender, output_receiver) = bounded_output_channel();
    let output_overflowed = Arc::new(AtomicBool::new(false));
    let pending_output_bytes = Arc::new(AtomicUsize::new(0));
    let waiter_registry = terminals.clone();
    let waiter_owner = owner.clone();
    let waiter_pane_id = pane_id.clone();
    let waiter_terminal_id = terminal_id.clone();
    std::thread::spawn(move || {
        let exit_code = child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| i32::try_from(status.exit_code()).ok());
        if let Some(session) =
            waiter_registry.remove_matching(&waiter_owner, &waiter_pane_id, &waiter_terminal_id)
        {
            // ClosePseudoConsole must run separately while the reader continues
            // draining; otherwise older ConPTY versions can deadlock on exit.
            teardown_session(session);
        }
        let _ = exit_sender.send(exit_code);
    });

    let reader_registry = terminals.clone();
    let reader_owner = owner.clone();
    let reader_pane_id = pane_id.clone();
    let reader_terminal_id = terminal_id.clone();
    let reader_channel = on_event.clone();
    let reader_overflowed = output_overflowed.clone();
    let reader_pending_bytes = pending_output_bytes.clone();
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(count) => {
                    if !reserve_pending_bytes(&reader_pending_bytes, count) {
                        reader_overflowed.store(true, Ordering::Release);
                        let _ = send_terminal_event(
                            &reader_channel,
                            &TerminalEvent::Error {
                                terminal_id: reader_terminal_id.clone(),
                                pane_id: reader_pane_id.clone(),
                                message: OUTPUT_OVERFLOW_MESSAGE.into(),
                            },
                        );
                        if let Some(session) = reader_registry.remove_matching(
                            &reader_owner,
                            &reader_pane_id,
                            &reader_terminal_id,
                        ) {
                            teardown_session(session);
                        }
                        return;
                    }
                    match output_sender.try_send(buffer[..count].to_vec()) {
                        Ok(()) => {}
                        Err(TrySendError::Full(chunk)) => {
                            reader_pending_bytes.fetch_sub(chunk.len(), Ordering::AcqRel);
                            reader_overflowed.store(true, Ordering::Release);
                            let _ = send_terminal_event(
                                &reader_channel,
                                &TerminalEvent::Error {
                                    terminal_id: reader_terminal_id.clone(),
                                    pane_id: reader_pane_id.clone(),
                                    message: OUTPUT_OVERFLOW_MESSAGE.into(),
                                },
                            );
                            if let Some(session) = reader_registry.remove_matching(
                                &reader_owner,
                                &reader_pane_id,
                                &reader_terminal_id,
                            ) {
                                teardown_session(session);
                            }
                            return;
                        }
                        Err(TrySendError::Disconnected(chunk)) => {
                            reader_pending_bytes.fetch_sub(chunk.len(), Ordering::AcqRel);
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = send_terminal_event(
                        &reader_channel,
                        &TerminalEvent::Error {
                            terminal_id: reader_terminal_id.clone(),
                            pane_id: reader_pane_id.clone(),
                            message: format!("terminal output failed: {error}"),
                        },
                    );
                    if let Some(session) = reader_registry.remove_matching(
                        &reader_owner,
                        &reader_pane_id,
                        &reader_terminal_id,
                    ) {
                        teardown_session(session);
                    }
                    return;
                }
            }
        }
    });

    std::thread::spawn(move || {
        while let Ok(first) = output_receiver.recv() {
            if output_overflowed.load(Ordering::Acquire) {
                return;
            }
            let output = coalesce_output(first, &output_receiver);
            if output_overflowed.load(Ordering::Acquire) {
                return;
            }
            let output_len = output.len();
            if on_event.send(InvokeResponseBody::Raw(output)).is_err() {
                pending_output_bytes.fetch_sub(output_len, Ordering::AcqRel);
                if let Some(session) = terminals.remove_matching(&owner, &pane_id, &terminal_id) {
                    teardown_session(session);
                }
                return;
            }
            pending_output_bytes.fetch_sub(output_len, Ordering::AcqRel);
        }

        if output_overflowed.load(Ordering::Acquire) {
            return;
        }
        let exit_code = exit_receiver.recv().unwrap_or(None);
        let _ = send_terminal_event(
            &on_event,
            &TerminalEvent::Exit {
                terminal_id,
                pane_id,
                exit_code,
            },
        );
    });
}

fn send_terminal_event(
    channel: &Channel<InvokeResponseBody>,
    event: &TerminalEvent,
) -> tauri::Result<()> {
    channel.send(InvokeResponseBody::Json(serde_json::to_string(event)?))
}

const PANE_ID_HEADER: &str = "Tauri-Terminal-Pane-Id";
const TERMINAL_ID_HEADER: &str = "Tauri-Terminal-Id";

fn terminal_input_header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing terminal input header {name}"))
}

fn validate_input_size(byte_len: usize) -> Result<(), String> {
    if byte_len > MAX_INPUT_BYTES {
        return Err("terminal input exceeds 64 KiB".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn terminal_input(
    webview: WebviewWindow,
    terminals: State<'_, TerminalRegistry>,
    request: Request<'_>,
) -> Result<(), String> {
    let pane_id = terminal_input_header(&request, PANE_ID_HEADER)?;
    let terminal_id = terminal_input_header(&request, TERMINAL_ID_HEADER)?;
    validate_pane_id(&pane_id)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("terminal input must be raw bytes".into());
    };
    validate_input_size(data.len())?;

    let writer = {
        let state = terminals
            .inner
            .lock()
            .map_err(|_| "terminal registry lock poisoned")?;
        let session = state
            .sessions
            .get(webview.label())
            .ok_or("terminal is not running")?;
        validate_owner(session, &pane_id, &terminal_id)?;
        session.writer.clone()
    };
    let mut writer = writer.lock().map_err(|_| "terminal input lock poisoned")?;
    let writer = writer.as_mut().ok_or("terminal input is closed")?;
    writer
        .write_all(data)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("failed to write terminal input: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(
    webview: WebviewWindow,
    terminals: State<'_, TerminalRegistry>,
    pane_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_pane_id(&pane_id)?;
    validate_size(cols, rows)?;
    let (master, dimensions) = {
        let state = terminals
            .inner
            .lock()
            .map_err(|_| "terminal registry lock poisoned")?;
        let session = state
            .sessions
            .get(webview.label())
            .ok_or("terminal is not running")?;
        validate_owner(session, &pane_id, &terminal_id)?;
        (session.master.clone(), session.dimensions.clone())
    };
    let mut dimensions = dimensions
        .lock()
        .map_err(|_| "terminal size lock poisoned")?;
    if *dimensions == (cols, rows) {
        return Ok(());
    }
    master
        .lock()
        .map_err(|_| "terminal master lock poisoned")?
        .as_ref()
        .ok_or("terminal is closing")?
        .resize(pty_size(cols, rows))
        .map_err(|error| format!("failed to resize terminal: {error:#}"))?;
    *dimensions = (cols, rows);
    Ok(())
}

#[tauri::command]
pub(crate) fn terminal_close(
    webview: WebviewWindow,
    terminals: State<'_, TerminalRegistry>,
    pane_id: String,
    terminal_id: String,
) -> Result<(), String> {
    validate_pane_id(&pane_id)?;
    let owner = webview.label();
    let session =
        {
            let mut state = terminals
                .inner
                .lock()
                .map_err(|_| "terminal registry lock poisoned")?;
            if let Some(session) = state.sessions.get(owner) {
                validate_owner(session, &pane_id, &terminal_id)?;
                let session = state
                    .sessions
                    .remove(owner)
                    .expect("terminal existence checked");
                state.closed.insert(
                    owner.to_string(),
                    ClosedTerminal {
                        pane_id: pane_id.clone(),
                        terminal_id: terminal_id.clone(),
                    },
                );
                Some(session)
            } else if state.closed.get(owner).is_some_and(|closed| {
                closed.pane_id == pane_id && closed.terminal_id == terminal_id
            }) {
                None
            } else {
                return Err("terminal is not running or belongs to another pane".into());
            }
        };
    if let Some(session) = session {
        teardown_session(session);
    }
    Ok(())
}

fn validate_owner(
    session: &TerminalSession,
    pane_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    if session.pane_id != pane_id || session.terminal_id != terminal_id {
        return Err("terminal belongs to another pane or runtime".into());
    }
    Ok(())
}

pub(crate) fn close_for_window(terminals: &TerminalRegistry, owner: &str) {
    if let Some(session) = terminals.take_for_window(owner) {
        teardown_session(session);
    }
}

pub(crate) fn close_for_pane(terminals: &TerminalRegistry, owner: &str, pane_id: &str) {
    if let Some(session) = terminals.take_for_pane(owner, pane_id) {
        teardown_session(session);
    }
}

pub(crate) fn close_all(terminals: &TerminalRegistry) {
    let sessions = {
        let Ok(mut state) = terminals.inner.lock() else {
            return;
        };
        let sessions = state
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        state.closed.clear();
        sessions
    };
    for session in sessions {
        teardown_session(session);
    }
}

#[cfg(unix)]
fn valid_owned_process_group(
    process_group: Option<libc::pid_t>,
    app_process_group: libc::pid_t,
) -> Option<libc::pid_t> {
    process_group.filter(|&process_group| process_group > 1 && process_group != app_process_group)
}

#[cfg(unix)]
fn signal_owned_process_group_with<F>(
    process_group: Option<libc::pid_t>,
    app_process_group: libc::pid_t,
    signal: libc::c_int,
    mut signal_group: F,
) -> bool
where
    F: FnMut(libc::pid_t, libc::c_int) -> libc::c_int,
{
    let Some(process_group) = valid_owned_process_group(process_group, app_process_group) else {
        return false;
    };
    signal_group(-process_group, signal) == 0
}

#[cfg(unix)]
fn signal_owned_process_group(process_group: Option<libc::pid_t>, signal: libc::c_int) -> bool {
    let app_process_group = unsafe { libc::getpgrp() };
    signal_owned_process_group_with(
        process_group,
        app_process_group,
        signal,
        |target, signal| unsafe { libc::kill(target, signal) },
    )
}

fn teardown_session(mut session: TerminalSession) {
    #[cfg(unix)]
    signal_owned_process_group(session.process_group, libc::SIGHUP);

    if let Ok(mut killer) = session.killer.lock() {
        let _ = killer.kill();
    }

    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            if let Ok(mut writer) = session.writer.lock() {
                writer.take();
            }
            std::thread::sleep(Duration::from_millis(150));
            let still_running = session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok())
                .flatten()
                .is_none();
            if still_running {
                signal_owned_process_group(session.process_group, libc::SIGKILL);
            }
            if let Ok(mut master) = session.master.lock() {
                master.take();
            }
        }
        #[cfg(windows)]
        {
            // Closing the job kills descendants; output remains serviced by the
            // dedicated reader while dropping the ConPTY master on this thread.
            drop(session.job.take());
            if let Ok(mut writer) = session.writer.lock() {
                writer.take();
            }
            if let Ok(mut master) = session.master.lock() {
                master.take();
            }
            let _ = session
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.wait().ok());
        }
    });
}

#[cfg(windows)]
struct WindowsJob(isize);

#[cfg(windows)]
impl WindowsJob {
    fn for_child(child: &(dyn Child + Send + Sync)) -> Result<Self, String> {
        let process = child
            .as_raw_handle()
            .ok_or("terminal child process handle is unavailable")?;
        Self::for_process_handle(process)
    }

    fn for_process_handle(process: std::os::windows::io::RawHandle) -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "failed to create terminal Job Object: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned =
            configured != 0 && unsafe { AssignProcessToJobObject(handle, process.cast()) } != 0;
        if !assigned {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(format!(
                "failed to secure terminal process tree: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(handle as isize))
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    #[derive(Debug)]
    struct FakeChild;

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(Some(portable_pty::ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    struct FakeMaster;

    impl MasterPty for FakeMaster {
        fn resize(&self, _: PtySize) -> anyhow::Result<()> {
            Ok(())
        }

        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(PtySize::default())
        }

        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
            Ok(Box::new(std::io::Cursor::new(Vec::<u8>::new())))
        }

        fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
            Ok(Box::new(std::io::sink()))
        }

        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<libc::pid_t> {
            None
        }

        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
            None
        }

        #[cfg(unix)]
        fn tty_name(&self) -> Option<std::path::PathBuf> {
            None
        }
    }

    fn fake_session(pane_id: &str, terminal_id: &str) -> TerminalSession {
        TerminalSession {
            terminal_id: terminal_id.into(),
            pane_id: pane_id.into(),
            writer: Arc::new(Mutex::new(Some(Box::new(std::io::sink())))),
            master: Arc::new(Mutex::new(Some(Box::new(FakeMaster)))),
            child: Arc::new(Mutex::new(Box::new(FakeChild))),
            killer: Mutex::new(Box::new(FakeChild)),
            dimensions: Arc::new(Mutex::new((80, 24))),
            #[cfg(unix)]
            process_group: None,
            #[cfg(windows)]
            job: None,
        }
    }

    #[test]
    fn registry_rejects_duplicates_and_cross_owner_controls() {
        let registry = TerminalRegistry::default();
        assert!(registry
            .insert("main", fake_session("primary", "terminal-1"))
            .is_ok());
        assert!(registry
            .insert("main", fake_session("secondary", "terminal-2"))
            .is_err());
        assert!(registry
            .remove_matching("other-window", "primary", "terminal-1")
            .is_none());
        assert!(registry
            .remove_matching("main", "secondary", "terminal-1")
            .is_none());
        assert!(registry
            .remove_matching("main", "primary", "stale-terminal")
            .is_none());
        assert!(registry
            .remove_matching("main", "primary", "terminal-1")
            .is_some());
    }

    #[test]
    fn window_and_app_drains_are_idempotent() {
        let registry = TerminalRegistry::default();
        assert!(registry
            .insert("main", fake_session("primary", "terminal-1"))
            .is_ok());
        close_for_pane(&registry, "main", "other-pane");
        assert_eq!(registry.inner.lock().unwrap().sessions.len(), 1);
        close_for_pane(&registry, "main", "primary");
        close_for_window(&registry, "main");
        close_all(&registry);
        assert!(registry.inner.lock().unwrap().sessions.is_empty());
    }

    #[test]
    fn validates_terminal_dimensions() {
        assert!(validate_size(2, 1).is_ok());
        assert!(validate_size(500, 300).is_ok());
        assert!(validate_size(1, 24).is_err());
        assert!(validate_size(80, 301).is_err());
    }

    #[test]
    fn enforces_raw_input_byte_limit() {
        assert!(validate_input_size(MAX_INPUT_BYTES).is_ok());
        assert!(validate_input_size(MAX_INPUT_BYTES + 1).is_err());
    }

    #[test]
    fn output_queue_accepts_exactly_four_mib_then_backpressures() {
        let pending = AtomicUsize::new(0);
        for _ in 0..OUTPUT_CHANNEL_CAPACITY {
            assert!(reserve_pending_bytes(&pending, OUTPUT_CHUNK_BYTES));
        }
        assert_eq!(pending.load(Ordering::Acquire), MAX_PENDING_OUTPUT_BYTES);
        assert!(!reserve_pending_bytes(&pending, 1));
        assert_eq!(pending.load(Ordering::Acquire), MAX_PENDING_OUTPUT_BYTES);
    }

    #[test]
    fn coalesces_all_immediately_pending_output_without_reordering() {
        let (sender, receiver) = bounded_output_channel();
        sender.try_send(b"second".to_vec()).unwrap();
        sender.try_send(b"third".to_vec()).unwrap();
        drop(sender);

        let output = coalesce_output(b"first".to_vec(), &receiver);
        assert_eq!(output, b"firstsecondthird");
        assert!(matches!(
            receiver.try_recv(),
            Err(TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn runtime_ids_are_opaque_and_unique() {
        let first = runtime_id();
        let second = runtime_id();
        assert_ne!(first, second);
        assert!(first.starts_with("terminal-"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_invalid_and_app_process_groups() {
        let app_process_group = unsafe { libc::getpgrp() };
        for process_group in [None, Some(-1), Some(0), Some(1), Some(app_process_group)] {
            assert!(!signal_owned_process_group_with(
                process_group,
                app_process_group,
                libc::SIGHUP,
                |_, _| panic!("invalid process group must not be signaled"),
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn signals_only_the_safe_owned_process_group() {
        let app_process_group = unsafe { libc::getpgrp() };
        let owned_process_group = if app_process_group == libc::pid_t::MAX {
            app_process_group - 1
        } else {
            app_process_group + 1
        };
        let mut call = None;

        assert!(signal_owned_process_group_with(
            Some(owned_process_group),
            app_process_group,
            libc::SIGKILL,
            |target, signal| {
                call = Some((target, signal));
                0
            },
        ));
        assert_eq!(call, Some((-owned_process_group, libc::SIGKILL)));
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_echoes_input_and_exits_within_timeout() {
        let pair = native_pty_system().openpty(pty_size(80, 24)).unwrap();
        let mut command = if cfg!(windows) {
            CommandBuilder::new("cmd.exe")
        } else {
            CommandBuilder::new("/bin/sh")
        };
        if cfg!(windows) {
            command.args(["/V:ON", "/C", "set /p line= & echo MARKER:!line!"]);
        } else {
            command.args(["-c", "read line; printf 'MARKER:%s\\n' \"$line\""]);
        }
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let reader_thread = std::thread::spawn(move || {
            let mut output = Vec::new();
            reader.read_to_end(&mut output).unwrap();
            output
        });
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"hello\r\n").unwrap();
        writer.flush().unwrap();

        let deadline = std::time::Instant::now() + StdDuration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                break None;
            }
            std::thread::sleep(StdDuration::from_millis(20));
        };

        drop(writer);
        // Keep output draining on its own thread while the pseudoconsole closes.
        drop(pair.master);
        let output = reader_thread.join().unwrap();
        let status = status.expect("PTY child did not exit within 10 seconds");
        assert!(status.success());
        assert!(String::from_utf8_lossy(&output).contains("MARKER:hello"));
    }

    #[cfg(windows)]
    fn direct_child_pid(parent_pid: u32) -> Option<u32> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                if entry.th32ParentProcessID == parent_pid {
                    found = Some(entry.th32ProcessID);
                    break;
                }
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        unsafe { CloseHandle(snapshot) };
        found
    }

    #[cfg(windows)]
    fn windows_process_is_running(pid: u32) -> bool {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let running = unsafe { GetExitCodeProcess(process, &mut exit_code) != 0 }
            && exit_code == STILL_ACTIVE;
        unsafe { windows_sys::Win32::Foundation::CloseHandle(process) };
        running
    }

    #[cfg(windows)]
    struct WindowsProcessCleanup(Vec<u32>);

    #[cfg(windows)]
    impl Drop for WindowsProcessCleanup {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, TerminateProcess, PROCESS_TERMINATE,
            };
            for &pid in self.0.iter().rev() {
                let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
                if !process.is_null() {
                    unsafe {
                        TerminateProcess(process, 1);
                        windows_sys::Win32::Foundation::CloseHandle(process);
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn closing_terminal_job_kills_parent_and_child_processes() {
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        let mut parent = Command::new("cmd.exe")
            .args(["/d", "/q"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn parent command process");
        let parent_pid = parent.id();
        let mut cleanup = WindowsProcessCleanup(vec![parent_pid]);
        let job = WindowsJob::for_process_handle(std::os::windows::io::AsRawHandle::as_raw_handle(
            &parent,
        ))
        .expect("assign parent process to terminal Job Object");

        parent
            .stdin
            .as_mut()
            .expect("parent stdin")
            .write_all(b"ping.exe -t 127.0.0.1\r\n")
            .expect("start child process");

        let deadline = Instant::now() + StdDuration::from_secs(10);
        let child_pid = loop {
            if let Some(pid) = direct_child_pid(parent_pid) {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "parent did not spawn a child process"
            );
            std::thread::sleep(StdDuration::from_millis(20));
        };
        cleanup.0.push(child_pid);
        assert!(windows_process_is_running(parent_pid));
        assert!(windows_process_is_running(child_pid));

        drop(job);

        let deadline = Instant::now() + StdDuration::from_secs(10);
        while (windows_process_is_running(parent_pid) || windows_process_is_running(child_pid))
            && Instant::now() < deadline
        {
            std::thread::sleep(StdDuration::from_millis(20));
        }
        assert!(
            !windows_process_is_running(parent_pid),
            "parent survived Job Object close"
        );
        assert!(
            !windows_process_is_running(child_pid),
            "child survived Job Object close"
        );
    }
}
