mod commands;
#[cfg(debug_assertions)]
pub(crate) mod dev_smoke;
mod preflight;
mod storage;

pub(crate) use commands::*;
use serde::{Deserialize, Serialize};
use storage::{SecretStore, Vault};

pub(crate) const KEY_ENV: &str = "QWEN_CLOUD_TOKEN_PLAN_KEY";

// These serialized values mirror gg-core/qwen-cloud-token-plan.ts. Never add raw errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ErrorCode {
    InvalidKeyFormat,
    NativeUnavailable,
    VaultUnavailable,
    ActiveRun,
    PreparationFailed,
    ReloadFailed,
    AuthenticationFailed,
    AllowanceExhausted,
    RateLimited,
    NetworkFailed,
    RequestRejected,
    TimedOut,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Status {
    provider: &'static str,
    credential: &'static str,
    verification: &'static str,
    allowance: &'static str,
}

impl Status {
    fn new(credential: &'static str) -> Self {
        Self {
            provider: "qwen-cloud",
            credential,
            verification: "not-tested",
            allowance: "unavailable-with-inference-key",
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum ConnectionResult {
    Success { ok: bool, status: Status },
    Failure { ok: bool, code: ErrorCode },
}

impl From<Result<Status, ErrorCode>> for ConnectionResult {
    fn from(result: Result<Status, ErrorCode>) -> Self {
        match result {
            Ok(status) => Self::Success { ok: true, status },
            Err(code) => Self::Failure { ok: false, code },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveConnection {
    api_key: String,
}

fn validate_key(key: &str) -> Result<(), ErrorCode> {
    let suffix = key
        .strip_prefix("sk-sp-")
        .ok_or(ErrorCode::InvalidKeyFormat)?;
    if !(1..=250).contains(&suffix.len())
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ErrorCode::InvalidKeyFormat);
    }
    Ok(())
}

struct ConnectionManager<S>(S);
impl<S: SecretStore> ConnectionManager<S> {
    fn status(&self) -> Status {
        match self.0.get() {
            Ok(Some(key)) if validate_key(&key).is_ok() => Status::new("saved"),
            Ok(None) => Status::new("absent"),
            _ => Status::new("unavailable"),
        }
    }

    fn save(&self, key: &str) -> Result<Status, ErrorCode> {
        validate_key(key)?;
        // One OS-vault replacement, no delete-before-write and no plaintext metadata.
        self.0.set(key)?;
        Ok(Status::new("saved"))
    }

    fn remove(&self) -> Result<Status, ErrorCode> {
        self.0.delete()?;
        Ok(Status::new("absent"))
    }
}

/// Discovery exposes only vault-derived presence, never the credential.
pub(crate) fn is_connected() -> bool {
    ConnectionManager(Vault).status().credential == "saved"
}

pub(crate) fn configure_daemon_environment(command: &mut std::process::Command) {
    // Disconnect and vault failure must NEVER reactivate an inherited credential.
    inject_environment(command, Vault.get().ok().flatten().as_deref());
}

fn inject_environment(command: &mut std::process::Command, key: Option<&str>) {
    command.env_remove(KEY_ENV);
    if let Some(key) = key.filter(|key| validate_key(key).is_ok()) {
        command.env(KEY_ENV, key);
    }
}

#[cfg(test)]
mod tests;
