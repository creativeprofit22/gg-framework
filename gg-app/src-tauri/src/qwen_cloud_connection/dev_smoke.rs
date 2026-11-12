//! Debug-only namespace selection. No caller can supply a vault service/account.
use super::{storage::OsVault, ErrorCode, SecretStore};
use std::ffi::OsString;
use std::sync::OnceLock;

const RUN_ENV: &str = "GG_QWEN_SMOKE_RUN";
const ACTION_ENV: &str = "GG_QWEN_SMOKE_ACTION";
const PREFIX: &str = "com.ggcoder.local-fork.qwen-smoke";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    run: String,
    cleanup: bool,
}

impl Identity {
    pub(super) fn names(&self) -> (String, String) {
        (format!("{PREFIX}.{}", self.run), format!("qwen-smoke-{}", self.run))
    }

    fn entry(&self) -> Result<OsVault, ErrorCode> {
        let (service, account) = self.names();
        OsVault::new(&service, &account)
    }
}

// Parse the entire fixture configuration before constructing ANY vault entry.
// 128 random bits, represented as exactly 32 lowercase hex characters.
pub(super) fn parse(
    run: Option<OsString>,
    action: Option<OsString>,
) -> Result<Option<Identity>, ErrorCode> {
    let Some(run) = run else {
        return if action.is_none() { Ok(None) } else { Err(ErrorCode::NativeUnavailable) };
    };
    let run = run.into_string().map_err(|_| ErrorCode::NativeUnavailable)?;
    if run.len() != 32 || !run.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(ErrorCode::NativeUnavailable);
    }
    let cleanup = match action.as_deref().and_then(|value| value.to_str()) {
        Some("run") => false,
        Some("cleanup") => true,
        _ => return Err(ErrorCode::NativeUnavailable),
    };
    Ok(Some(Identity { run, cleanup }))
}

pub(super) fn parse_environment(
    run: Option<OsString>,
    action: Option<OsString>,
    fixture_marker_present: bool,
) -> Result<Option<Identity>, ErrorCode> {
    if fixture_marker_present && run.is_none() {
        return Err(ErrorCode::NativeUnavailable);
    }
    parse(run, action)
}

static CONFIG: OnceLock<Result<Option<Identity>, ErrorCode>> = OnceLock::new();

fn configuration() -> Result<Option<&'static Identity>, ErrorCode> {
    match CONFIG.get_or_init(|| parse_environment(
        std::env::var_os(RUN_ENV),
        std::env::var_os(ACTION_ENV),
        ["GG_QWEN_SMOKE_MODE", "GG_QWEN_SMOKE_AUDIT", "GG_QWEN_SMOKE_PROVIDER"]
            .iter().any(|name| std::env::var_os(name).is_some()),
    )) {
        Ok(identity) => Ok(identity.as_ref()),
        Err(error) => Err(*error),
    }
}

pub(super) fn selected_entry() -> Result<Option<OsVault>, ErrorCode> {
    configuration()?.map(Identity::entry).transpose()
}

/// Called before logging, auth discovery, WebViews or daemon creation. Cleanup
/// runs in a separate short-lived native process, not credential-readback IPC.
pub(crate) fn startup() -> Result<bool, ErrorCode> {
    let Some(identity) = configuration()? else { return Ok(false); };
    let vault = identity.entry()?;
    if identity.cleanup {
        vault.delete()?;
        if vault.get()?.is_some() {
            return Err(ErrorCode::VaultUnavailable);
        }
        println!("QWEN_SMOKE_CLEANUP_ABSENT");
        return Ok(true);
    }
    // Refuse collisions. Never replace or clean an entry this run did not own.
    if vault.get()?.is_some() {
        return Err(ErrorCode::VaultUnavailable);
    }
    println!("QWEN_SMOKE_INITIAL_ABSENT");
    Ok(false)
}
