use super::ErrorCode;

const SERVICE: &str = "com.ggcoder.local-fork.qwen-cloud-token-plan";
const ACCOUNT: &str = "token-plan-key";

pub(super) trait SecretStore {
    fn get(&self) -> Result<Option<String>, ErrorCode>;
    fn set(&self, key: &str) -> Result<(), ErrorCode>;
    fn delete(&self) -> Result<(), ErrorCode>;
}

pub(super) struct Vault;
impl Vault {
    fn entry(&self) -> Result<OsVault, ErrorCode> {
        #[cfg(debug_assertions)]
        if let Some(entry) = super::dev_smoke::selected_entry()? {
            return Ok(entry);
        }
        OsVault::new(SERVICE, ACCOUNT)
    }
}
impl SecretStore for Vault {
    fn get(&self) -> Result<Option<String>, ErrorCode> {
        self.entry()?.get()
    }
    fn set(&self, key: &str) -> Result<(), ErrorCode> {
        self.entry()?.set(key)
    }
    fn delete(&self) -> Result<(), ErrorCode> {
        self.entry()?.delete()
    }
}

// Production and the opt-in runtime smoke use exactly the same OS operations.
pub(super) struct OsVault(keyring::v1::Entry);
impl OsVault {
    pub(super) fn new(service: &str, account: &str) -> Result<Self, ErrorCode> {
        keyring::v1::Entry::new(service, account)
            .map(Self)
            .map_err(|_| ErrorCode::VaultUnavailable)
    }

    #[cfg(all(test, target_os = "windows"))]
    pub(super) fn isolated_test(namespace: &str) -> Result<Self, ErrorCode> {
        assert!(namespace.starts_with("test-"));
        assert_ne!(namespace, SERVICE);
        assert_ne!(namespace, ACCOUNT);
        Self::new(namespace, namespace)
    }
}
impl SecretStore for OsVault {
    fn get(&self) -> Result<Option<String>, ErrorCode> {
        match self.0.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err(ErrorCode::VaultUnavailable),
        }
    }
    fn set(&self, key: &str) -> Result<(), ErrorCode> {
        self.0
            .set_password(key)
            .map_err(|_| ErrorCode::VaultUnavailable)
    }
    fn delete(&self) -> Result<(), ErrorCode> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => Err(ErrorCode::VaultUnavailable),
        }
    }
}
