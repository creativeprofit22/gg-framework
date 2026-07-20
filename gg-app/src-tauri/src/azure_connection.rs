use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.ggcoder.app.azure-openai";
const KEYRING_ACCOUNT: &str = "api-key";
const METADATA_FILE: &str = "gg-app-azure.json";
const MAX_ENDPOINT_LENGTH: usize = 2_048;
const MAX_DEPLOYMENT_LENGTH: usize = 256;
const MAX_API_KEY_LENGTH: usize = 8_192;
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct AzureMetadata {
    endpoint: String,
    deployment: String,
}

pub(crate) struct SecureAzureConfig {
    pub(crate) base_url: String,
    pub(crate) deployment: String,
    pub(crate) api_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AzureConnectionSource {
    Secure,
    Environment,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AzureConnectionStatus {
    pub(crate) configured: bool,
    pub(crate) source: AzureConnectionSource,
    pub(crate) endpoint: Option<String>,
    pub(crate) deployment: Option<String>,
    pub(crate) endpoint_summary: Option<String>,
    pub(crate) deployment_summary: Option<String>,
    pub(crate) has_stored_key: bool,
}

#[derive(Clone, Default)]
pub(crate) struct AzureEnvironment {
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) deployment: Option<String>,
}

impl AzureEnvironment {
    pub(crate) fn inherited() -> Self {
        Self {
            api_key: std::env::var("AZURE_OPENAI_API_KEY").ok(),
            base_url: std::env::var("AZURE_OPENAI_BASE_URL").ok(),
            deployment: std::env::var("AZURE_OPENAI_DEPLOYMENT").ok(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAzureConnection {
    pub(crate) endpoint: String,
    pub(crate) deployment: String,
    /// Missing or blank preserves the existing vault entry.
    pub(crate) api_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AzureErrorField {
    Endpoint,
    Deployment,
    ApiKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AzureConnectionError {
    pub(crate) code: &'static str,
    pub(crate) field: Option<AzureErrorField>,
    pub(crate) message: &'static str,
}

impl AzureConnectionError {
    fn field(field: AzureErrorField, code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            field: Some(field),
            message,
        }
    }

    fn general(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            field: None,
            message,
        }
    }

    fn storage_read() -> Self {
        Self::general(
            "secure_storage_unavailable",
            "The Azure connection could not be read from secure storage. Try again after unlocking your operating-system credential vault.",
        )
    }

    fn metadata_read() -> Self {
        Self::general(
            "metadata_unavailable",
            "The saved Azure connection metadata could not be read. Re-enter the connection details and try again.",
        )
    }

    fn metadata_write() -> Self {
        Self::general(
            "metadata_save_failed",
            "The Azure connection could not be saved. The previous connection is still active.",
        )
    }
}

impl std::fmt::Display for AzureConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for AzureConnectionError {}

#[derive(Debug)]
pub(crate) enum SecretStoreError {
    Unavailable,
}

pub(crate) trait SecretStore {
    fn get(&self) -> Result<Option<String>, SecretStoreError>;
    fn set(&self, value: &str) -> Result<(), SecretStoreError>;
    fn delete(&self) -> Result<(), SecretStoreError>;
}

#[derive(Default)]
pub(crate) struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(&self) -> Result<keyring::v1::Entry, SecretStoreError> {
        keyring::v1::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|_| SecretStoreError::Unavailable)
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self) -> Result<Option<String>, SecretStoreError> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }

    fn set(&self, value: &str) -> Result<(), SecretStoreError> {
        self.entry()?
            .set_password(value)
            .map_err(|_| SecretStoreError::Unavailable)
    }

    fn delete(&self) -> Result<(), SecretStoreError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }
}

#[derive(Debug)]
pub(crate) enum MetadataStoreError {
    Unavailable,
    Invalid,
}

pub(crate) trait MetadataStore {
    fn load(&self) -> Result<Option<AzureMetadata>, MetadataStoreError>;
    fn write(&self, metadata: &AzureMetadata) -> Result<(), MetadataStoreError>;
    fn remove(&self) -> Result<(), MetadataStoreError>;
}

pub(crate) struct FileMetadataStore {
    path: PathBuf,
}

impl FileMetadataStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn default_path() -> PathBuf {
        home_dir().join(".gg").join(METADATA_FILE)
    }
}

impl MetadataStore for FileMetadataStore {
    fn load(&self) -> Result<Option<AzureMetadata>, MetadataStoreError> {
        let contents = match std::fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MetadataStoreError::Unavailable),
        };
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|_| MetadataStoreError::Invalid)
    }

    fn write(&self, metadata: &AzureMetadata) -> Result<(), MetadataStoreError> {
        let parent = self.path.parent().ok_or(MetadataStoreError::Unavailable)?;
        std::fs::create_dir_all(parent).map_err(|_| MetadataStoreError::Unavailable)?;
        let serialized =
            serde_json::to_vec_pretty(metadata).map_err(|_| MetadataStoreError::Invalid)?;
        #[allow(unused_mut)] // Mutated only on Unix to enforce private permissions.
        let mut options = atomic_write_file::OpenOptions::new();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as AtomicOpenOptionsExt;
            use std::os::unix::fs::OpenOptionsExt as StdOpenOptionsExt;
            // The file contains no secret, but private permissions avoid leaking resource names.
            options.preserve_mode(false).mode(0o600);
        }
        let mut file = options
            .open(&self.path)
            .map_err(|_| MetadataStoreError::Unavailable)?;
        file.write_all(&serialized)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|_| MetadataStoreError::Unavailable)?;
        file.commit().map_err(|_| MetadataStoreError::Unavailable)
    }

    fn remove(&self) -> Result<(), MetadataStoreError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(MetadataStoreError::Unavailable),
        }
    }
}

pub(crate) type ValidationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), AzureConnectionError>> + Send + 'a>>;

pub(crate) trait RemoteValidator {
    fn validate<'a>(&'a self, config: &'a SecureAzureConfig) -> ValidationFuture<'a>;
}

pub(crate) struct ReqwestRemoteValidator {
    client: reqwest::Client,
}

impl ReqwestRemoteValidator {
    pub(crate) fn new() -> Result<Self, AzureConnectionError> {
        let client = reqwest::Client::builder()
            .timeout(VALIDATION_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                AzureConnectionError::general(
                    "validation_unavailable",
                    "Azure validation could not start. Check your network settings and try again.",
                )
            })?;
        Ok(Self { client })
    }
}

impl RemoteValidator for ReqwestRemoteValidator {
    fn validate<'a>(&'a self, config: &'a SecureAzureConfig) -> ValidationFuture<'a> {
        Box::pin(async move {
            let api_key = sensitive_api_key_header(&config.api_key)?;
            let response = self
                .client
                .post(&config.base_url)
                .header("api-key", api_key)
                .json(&serde_json::json!({
                    "model": config.deployment,
                    "input": "Reply with OK.",
                    "max_output_tokens": 1,
                    "stream": false
                }))
                .send()
                .await
                .map_err(map_network_error)?;

            match response.status().as_u16() {
                200..=299 => Ok(()),
                401 => Err(AzureConnectionError::field(
                    AzureErrorField::ApiKey,
                    "invalid_api_key",
                    "Azure rejected this API key. Check the key and try again.",
                )),
                403 => Err(AzureConnectionError::general(
                    "access_forbidden",
                    "This key cannot access the Azure deployment. Check its role and resource access.",
                )),
                404 => Err(AzureConnectionError::general(
                    "deployment_not_found",
                    "Azure could not find this resource endpoint or deployment. Check both values.",
                )),
                429 => Err(AzureConnectionError::general(
                    "throttled",
                    "Azure is throttling requests. Wait a moment, then validate again.",
                )),
                500..=599 => Err(AzureConnectionError::general(
                    "azure_unavailable",
                    "Azure is temporarily unavailable. Try again shortly.",
                )),
                _ => Err(AzureConnectionError::general(
                    "validation_failed",
                    "Azure could not validate this connection. Check the details and try again.",
                )),
            }
        })
    }
}

fn sensitive_api_key_header(
    value: &str,
) -> Result<reqwest::header::HeaderValue, AzureConnectionError> {
    let mut header = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
        AzureConnectionError::field(
            AzureErrorField::ApiKey,
            "invalid_api_key",
            "Enter a valid Azure OpenAI API key.",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

fn map_network_error(error: reqwest::Error) -> AzureConnectionError {
    if error.is_timeout() {
        AzureConnectionError::general(
            "validation_timeout",
            "Azure validation timed out. Check the endpoint and network, then try again.",
        )
    } else {
        AzureConnectionError::general(
            "validation_network_error",
            "Azure validation could not reach the endpoint. Check DNS, TLS, and network access.",
        )
    }
}

pub(crate) struct AzureConnectionManager<S, M, V> {
    secrets: S,
    metadata: M,
    validator: V,
}

impl<S, M, V> AzureConnectionManager<S, M, V>
where
    S: SecretStore,
    M: MetadataStore,
    V: RemoteValidator,
{
    fn new(secrets: S, metadata: M, validator: V) -> Self {
        Self {
            secrets,
            metadata,
            validator,
        }
    }

    pub(crate) fn status(
        &self,
        environment: &AzureEnvironment,
    ) -> Result<AzureConnectionStatus, AzureConnectionError> {
        let saved_metadata = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        let stored_key = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?;

        if let (Some(metadata), Some(_)) = (&saved_metadata, &stored_key) {
            return Ok(status_for(
                AzureConnectionSource::Secure,
                &metadata.endpoint,
                &metadata.deployment,
                true,
                true,
            ));
        }

        if let Some(config) = resolve_environment(environment) {
            return Ok(status_for(
                AzureConnectionSource::Environment,
                &config.base_url,
                &config.deployment,
                false,
                false,
            ));
        }

        Ok(AzureConnectionStatus {
            configured: false,
            source: AzureConnectionSource::None,
            endpoint: saved_metadata.as_ref().map(|value| value.endpoint.clone()),
            deployment: saved_metadata
                .as_ref()
                .map(|value| value.deployment.clone()),
            endpoint_summary: saved_metadata
                .as_ref()
                .map(|value| mask_endpoint(&value.endpoint)),
            deployment_summary: saved_metadata
                .as_ref()
                .map(|value| mask_value(&value.deployment)),
            has_stored_key: stored_key.is_some(),
        })
    }

    pub(crate) fn secure_config(&self) -> Result<Option<SecureAzureConfig>, AzureConnectionError> {
        let Some(metadata) = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?
        else {
            return Ok(None);
        };
        let Some(api_key) = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?
        else {
            return Ok(None);
        };
        Ok(Some(SecureAzureConfig {
            base_url: responses_url(&metadata.endpoint),
            deployment: metadata.deployment,
            api_key,
        }))
    }

    pub(crate) async fn save(
        &self,
        input: SaveAzureConnection,
    ) -> Result<AzureConnectionStatus, AzureConnectionError> {
        let metadata = validate_metadata(&input.endpoint, &input.deployment)?;
        let _prior_metadata = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        let prior_secret = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?;
        let replacement_key = validate_optional_key(input.api_key.as_deref())?;
        let api_key = replacement_key
            .as_deref()
            .or(prior_secret.as_deref())
            .ok_or_else(|| {
                AzureConnectionError::field(
                    AzureErrorField::ApiKey,
                    "api_key_required",
                    "An Azure OpenAI API key is required.",
                )
            })?;

        let candidate = SecureAzureConfig {
            base_url: responses_url(&metadata.endpoint),
            deployment: metadata.deployment.clone(),
            api_key: api_key.to_owned(),
        };
        self.validator.validate(&candidate).await?;

        if let Some(ref key) = replacement_key {
            self.secrets.set(key).map_err(|_| AzureConnectionError::general(
                "secure_storage_save_failed",
                "The API key could not be saved in the operating-system credential vault. The previous connection is still active.",
            ))?;
        }

        if self.metadata.write(&metadata).is_err() {
            if replacement_key.is_some()
                && restore_secret(&self.secrets, prior_secret.as_deref()).is_err()
            {
                return Err(AzureConnectionError::general(
                    "connection_rollback_failed",
                    "The connection metadata could not be saved, and the previous credential could not be restored. Reconnect Azure before using it.",
                ));
            }
            return Err(AzureConnectionError::metadata_write());
        }

        Ok(status_for(
            AzureConnectionSource::Secure,
            &metadata.endpoint,
            &metadata.deployment,
            true,
            true,
        ))
    }

    pub(crate) fn remove(&self) -> Result<(), AzureConnectionError> {
        let prior_metadata = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        self.metadata.remove().map_err(|_| {
            AzureConnectionError::general(
                "metadata_remove_failed",
                "The Azure connection could not be removed. The existing connection is still active.",
            )
        })?;

        if self.secrets.delete().is_err() {
            if let Some(metadata) = prior_metadata {
                if self.metadata.write(&metadata).is_err() {
                    return Err(AzureConnectionError::general(
                        "connection_remove_recovery_failed",
                        "The credential vault rejected removal, and the connection metadata could not be restored. Reconnect Azure before using it.",
                    ));
                }
            }
            return Err(AzureConnectionError::general(
                "secure_storage_remove_failed",
                "The operating-system credential vault rejected removal. The Azure connection remains active.",
            ));
        }
        Ok(())
    }
}

pub(crate) type ProductionAzureConnectionManager =
    AzureConnectionManager<KeyringSecretStore, FileMetadataStore, ReqwestRemoteValidator>;

pub(crate) fn production_manager() -> Result<ProductionAzureConnectionManager, AzureConnectionError>
{
    Ok(AzureConnectionManager::new(
        KeyringSecretStore,
        FileMetadataStore::new(FileMetadataStore::default_path()),
        ReqwestRemoteValidator::new()?,
    ))
}

fn restore_secret<S: SecretStore>(
    store: &S,
    previous: Option<&str>,
) -> Result<(), SecretStoreError> {
    match previous {
        Some(value) => store.set(value),
        None => store.delete(),
    }
}

fn validate_metadata(
    endpoint: &str,
    deployment: &str,
) -> Result<AzureMetadata, AzureConnectionError> {
    Ok(AzureMetadata {
        endpoint: normalize_resource_endpoint(endpoint)?,
        deployment: normalize_deployment(deployment)?,
    })
}

fn normalize_resource_endpoint(value: &str) -> Result<String, AzureConnectionError> {
    let value = value.trim();
    let invalid = || {
        AzureConnectionError::field(
            AzureErrorField::Endpoint,
            "invalid_endpoint",
            "Enter an HTTPS Azure resource endpoint like https://resource.openai.azure.com.",
        )
    };
    if value.is_empty() || value.len() > MAX_ENDPOINT_LENGTH || value.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let host = parsed.host_str().ok_or_else(invalid)?;
    let resource = host.strip_suffix(".openai.azure.com").ok_or_else(invalid)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.port().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
        || resource.is_empty()
        || resource.contains('.')
    {
        return Err(invalid());
    }
    Ok(format!("https://{host}"))
}

fn normalize_deployment(value: &str) -> Result<String, AzureConnectionError> {
    let deployment = value.trim();
    if deployment.is_empty()
        || deployment.len() > MAX_DEPLOYMENT_LENGTH
        || deployment.chars().any(char::is_control)
    {
        return Err(AzureConnectionError::field(
            AzureErrorField::Deployment,
            "invalid_deployment",
            "Enter an Azure deployment name containing 1 to 256 characters.",
        ));
    }
    Ok(deployment.to_owned())
}

fn validate_optional_key(value: Option<&str>) -> Result<Option<String>, AzureConnectionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_API_KEY_LENGTH || value.chars().any(char::is_control) {
        return Err(AzureConnectionError::field(
            AzureErrorField::ApiKey,
            "invalid_api_key",
            "Enter a valid Azure OpenAI API key.",
        ));
    }
    Ok(Some(value.to_owned()))
}

fn responses_url(endpoint: &str) -> String {
    format!("{endpoint}/openai/v1/responses")
}

fn resolve_environment(environment: &AzureEnvironment) -> Option<SecureAzureConfig> {
    let api_key = environment.api_key.as_deref()?.trim();
    let base_url = environment.base_url.as_deref()?.trim();
    let deployment = environment.deployment.as_deref()?.trim();
    if api_key.is_empty()
        || deployment.is_empty()
        || !is_strict_responses_url(base_url)
        || deployment.len() > MAX_DEPLOYMENT_LENGTH
        || deployment.chars().any(char::is_control)
    {
        return None;
    }
    Some(SecureAzureConfig {
        api_key: api_key.to_owned(),
        base_url: base_url.to_owned(),
        deployment: deployment.to_owned(),
    })
}

fn is_strict_responses_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.path().ends_with("/responses")
}

fn status_for(
    source: AzureConnectionSource,
    endpoint: &str,
    deployment: &str,
    editable: bool,
    has_stored_key: bool,
) -> AzureConnectionStatus {
    AzureConnectionStatus {
        configured: true,
        source,
        endpoint: editable.then(|| endpoint.to_owned()),
        deployment: editable.then(|| deployment.to_owned()),
        endpoint_summary: Some(mask_endpoint(endpoint)),
        deployment_summary: Some(mask_value(deployment)),
        has_stored_key,
    }
}

fn mask_endpoint(value: &str) -> String {
    let host = reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| value.to_owned());
    let resource = host.split('.').next().unwrap_or(&host);
    format!("{}…azure.com", mask_value(resource))
}

fn mask_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    match chars.len() {
        0 => String::new(),
        1..=4 => "•".repeat(chars.len()),
        _ => format!(
            "{}{}{}",
            chars[0],
            "•".repeat(chars.len() - 2),
            chars[chars.len() - 1]
        ),
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn canary() -> String {
        std::env::var("GG_AZURE_TEST_CANARY").unwrap_or_else(|_| {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("azure-stage1-test-key-{}-{nonce}", std::process::id())
        })
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[derive(Clone, Default)]
    struct MockSecretStore {
        value: Arc<Mutex<Option<String>>>,
        fail_delete: Arc<Mutex<bool>>,
    }

    impl MockSecretStore {
        fn with(value: Option<&str>) -> Self {
            Self {
                value: Arc::new(Mutex::new(value.map(str::to_owned))),
                fail_delete: Arc::new(Mutex::new(false)),
            }
        }
    }

    impl SecretStore for MockSecretStore {
        fn get(&self) -> Result<Option<String>, SecretStoreError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn set(&self, value: &str) -> Result<(), SecretStoreError> {
            *self.value.lock().unwrap() = Some(value.to_owned());
            Ok(())
        }

        fn delete(&self) -> Result<(), SecretStoreError> {
            if *self.fail_delete.lock().unwrap() {
                return Err(SecretStoreError::Unavailable);
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct MockMetadataStore {
        value: Arc<Mutex<Option<AzureMetadata>>>,
        serialized: Arc<Mutex<Vec<String>>>,
        fail_write: Arc<Mutex<bool>>,
    }

    impl MockMetadataStore {
        fn with(value: Option<AzureMetadata>) -> Self {
            Self {
                value: Arc::new(Mutex::new(value)),
                serialized: Arc::new(Mutex::new(Vec::new())),
                fail_write: Arc::new(Mutex::new(false)),
            }
        }
    }

    impl MetadataStore for MockMetadataStore {
        fn load(&self) -> Result<Option<AzureMetadata>, MetadataStoreError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn write(&self, metadata: &AzureMetadata) -> Result<(), MetadataStoreError> {
            if *self.fail_write.lock().unwrap() {
                return Err(MetadataStoreError::Unavailable);
            }
            self.serialized
                .lock()
                .unwrap()
                .push(serde_json::to_string(metadata).unwrap());
            *self.value.lock().unwrap() = Some(metadata.clone());
            Ok(())
        }

        fn remove(&self) -> Result<(), MetadataStoreError> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    struct AcceptValidator;

    impl RemoteValidator for AcceptValidator {
        fn validate<'a>(&'a self, _config: &'a SecureAzureConfig) -> ValidationFuture<'a> {
            Box::pin(async { Ok(()) })
        }
    }

    fn metadata(endpoint: &str, deployment: &str) -> AzureMetadata {
        AzureMetadata {
            endpoint: endpoint.to_owned(),
            deployment: deployment.to_owned(),
        }
    }

    fn valid_input(key: Option<&str>) -> SaveAzureConnection {
        SaveAzureConnection {
            endpoint: "https://my-resource.openai.azure.com".into(),
            deployment: "gpt-production".into(),
            api_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn normalizes_only_azure_resource_origins() {
        assert_eq!(
            normalize_resource_endpoint(" HTTPS://My-Resource.OPENAI.AZURE.COM/ ").unwrap(),
            "https://my-resource.openai.azure.com"
        );
        for malformed in [
            "http://resource.openai.azure.com",
            "https://user:pass@resource.openai.azure.com",
            "https://resource.openai.azure.com/openai/v1/responses",
            "https://resource.openai.azure.com?key=value",
            "https://resource.openai.azure.com#fragment",
            "https://resource.openai.azure.com:8443",
            "https://nested.resource.openai.azure.com",
            "https://example.com",
            "https://resource.openai.azure.com/\nheader",
        ] {
            let error = normalize_resource_endpoint(malformed).unwrap_err();
            assert_eq!(error.field, Some(AzureErrorField::Endpoint), "{malformed}");
        }
    }

    #[test]
    fn validates_deployment_and_key_without_echoing_them() {
        let canary = canary();
        let sensitive_header = sensitive_api_key_header(&canary).unwrap();
        assert!(!format!("{sensitive_header:?}").contains(&canary));
        let deployment_error = normalize_deployment("bad\ndeployment").unwrap_err();
        let key_value = format!("{canary}\ninvalid");
        let key_error = validate_optional_key(Some(&key_value)).unwrap_err();
        for serialized in [
            serde_json::to_string(&deployment_error).unwrap(),
            serde_json::to_string(&key_error).unwrap(),
            deployment_error.to_string(),
            key_error.to_string(),
        ] {
            assert!(!serialized.contains(&canary));
            assert!(!serialized.contains("bad\ndeployment"));
        }
    }

    #[test]
    fn resolves_only_complete_environment_fallback() {
        let canary = canary();
        let complete = AzureEnvironment {
            api_key: Some(canary.clone()),
            base_url: Some(
                "https://example.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview"
                    .into(),
            ),
            deployment: Some("gpt-env".into()),
        };
        let resolved = resolve_environment(&complete).unwrap();
        assert_eq!(resolved.deployment, "gpt-env");
        assert_eq!(resolved.api_key, canary);

        let mut partial = complete.clone();
        partial.deployment = None;
        assert!(resolve_environment(&partial).is_none());
        partial = complete.clone();
        partial.base_url = Some("https://example.openai.azure.com/openai/v1".into());
        assert!(resolve_environment(&partial).is_none());
    }

    #[test]
    fn complete_secure_config_overrides_environment_without_exposing_key_in_status() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some(&canary));
        let metadata = MockMetadataStore::with(Some(metadata(
            "https://secure.openai.azure.com",
            "gpt-secure",
        )));
        let manager = AzureConnectionManager::new(secrets, metadata, AcceptValidator);
        let environment = AzureEnvironment {
            api_key: Some("environment-key".into()),
            base_url: Some("https://env.openai.azure.com/openai/v1/responses".into()),
            deployment: Some("gpt-env".into()),
        };
        let status = manager.status(&environment).unwrap();
        let serialized = serde_json::to_string(&status).unwrap();
        assert_eq!(status.source, AzureConnectionSource::Secure);
        assert_eq!(status.deployment.as_deref(), Some("gpt-secure"));
        assert!(status.has_stored_key);
        assert!(!serialized.contains(&canary));
        assert!(!serialized.contains("environment-key"));
    }

    #[test]
    fn saves_only_non_secret_metadata() {
        let canary = canary();
        let secrets = MockSecretStore::default();
        let metadata = MockMetadataStore::default();
        let manager =
            AzureConnectionManager::new(secrets.clone(), metadata.clone(), AcceptValidator);
        let status = block_on(manager.save(valid_input(Some(&canary)))).unwrap();

        assert_eq!(secrets.get().unwrap().as_deref(), Some(canary.as_str()));
        let writes = metadata.serialized.lock().unwrap();
        assert_eq!(writes.len(), 1);
        assert!(!writes[0].contains(&canary));
        assert!(!serde_json::to_string(&status).unwrap().contains(&canary));
    }

    #[test]
    fn blank_key_preserves_existing_vault_secret() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some(&canary));
        let metadata = MockMetadataStore::with(Some(metadata(
            "https://old.openai.azure.com",
            "old-deployment",
        )));
        let manager = AzureConnectionManager::new(secrets.clone(), metadata, AcceptValidator);
        block_on(manager.save(valid_input(Some("   ")))).unwrap();
        assert_eq!(secrets.get().unwrap().as_deref(), Some(canary.as_str()));
    }

    #[test]
    fn metadata_failure_rolls_back_replaced_secret() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some("previous-secret"));
        let metadata = MockMetadataStore::with(Some(metadata(
            "https://old.openai.azure.com",
            "old-deployment",
        )));
        *metadata.fail_write.lock().unwrap() = true;
        let manager =
            AzureConnectionManager::new(secrets.clone(), metadata.clone(), AcceptValidator);

        let error = block_on(manager.save(valid_input(Some(&canary)))).unwrap_err();
        assert_eq!(error.code, "metadata_save_failed");
        assert_eq!(secrets.get().unwrap().as_deref(), Some("previous-secret"));
        assert_eq!(
            metadata.load().unwrap().unwrap().deployment,
            "old-deployment"
        );
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn failed_vault_delete_restores_metadata() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some(&canary));
        *secrets.fail_delete.lock().unwrap() = true;
        let saved = metadata("https://old.openai.azure.com", "old-deployment");
        let metadata = MockMetadataStore::with(Some(saved.clone()));
        let manager = AzureConnectionManager::new(secrets, metadata.clone(), AcceptValidator);

        let error = manager.remove().unwrap_err();
        assert_eq!(error.code, "secure_storage_remove_failed");
        assert_eq!(metadata.load().unwrap(), Some(saved));
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn file_store_atomically_overwrites_non_secret_metadata() {
        let canary = canary();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gg-app-azure-stage1-{}-{nonce}",
            std::process::id()
        ));
        let path = root.join(METADATA_FILE);
        let store = FileMetadataStore::new(path.clone());
        store
            .write(&metadata("https://one.openai.azure.com", "first"))
            .unwrap();
        store
            .write(&metadata("https://two.openai.azure.com", "second"))
            .unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("second"));
        assert!(!contents.contains("first"));
        assert!(!contents.contains(&canary));
        std::fs::remove_dir_all(root).unwrap();
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = vec![0_u8; 16_384];
        let count = stream.read(&mut bytes).unwrap();
        String::from_utf8_lossy(&bytes[..count]).into_owned()
    }

    fn send_response(mut stream: TcpStream, status: &str, headers: &[(&str, String)]) -> String {
        let request = read_request(&mut stream);
        let mut response =
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        stream.write_all(response.as_bytes()).unwrap();
        request
    }

    #[test]
    fn remote_validation_disables_redirects() {
        let canary = canary();
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_url = format!("http://{}/stolen", redirect_target.local_addr().unwrap());
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_url = format!("http://{}/responses", source.local_addr().unwrap());
        let source_thread = thread::spawn(move || {
            let (stream, _) = source.accept().unwrap();
            send_response(stream, "302 Found", &[("Location", target_url)])
        });

        let validator = ReqwestRemoteValidator::new().unwrap();
        let config = SecureAzureConfig {
            base_url: source_url,
            deployment: "gpt-test".into(),
            api_key: canary.clone(),
        };
        let error = block_on(validator.validate(&config)).unwrap_err();
        let request = source_thread.join().unwrap();
        assert!(request.contains("api-key"));
        assert!(request.contains(&canary)); // Allowed request-boundary assertion.
        assert_eq!(error.code, "validation_failed");
        thread::sleep(Duration::from_millis(100));
        assert!(
            redirect_target.accept().is_err(),
            "redirect target received the secret request"
        );
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn provider_body_and_secret_never_enter_validation_error() {
        let canary = canary();
        let server_canary = canary.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let body = format!("raw provider body containing {server_canary}");
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        let validator = ReqwestRemoteValidator::new().unwrap();
        let config = SecureAzureConfig {
            base_url: url,
            deployment: "gpt-test".into(),
            api_key: canary.clone(),
        };
        let error = block_on(validator.validate(&config)).unwrap_err();
        let _request = server.join().unwrap();
        let serialized = serde_json::to_string(&error).unwrap();
        assert_eq!(error.code, "invalid_api_key");
        assert!(!serialized.contains(&canary));
        assert!(!serialized.contains("raw provider body"));
    }

    #[test]
    fn strict_environment_url_matches_existing_responses_contract() {
        assert!(is_strict_responses_url(
            "https://example.openai.azure.com/openai/v1/responses?api-version=preview"
        ));
        for invalid in [
            "http://example.openai.azure.com/openai/v1/responses",
            "https://user@example.openai.azure.com/openai/v1/responses",
            "https://example.openai.azure.com/openai/v1/responses#fragment",
            "https://example.openai.azure.com/openai/v1",
        ] {
            assert!(!is_strict_responses_url(invalid), "{invalid}");
        }
    }

    #[test]
    fn production_metadata_path_is_separate_from_other_app_files() {
        let path = FileMetadataStore::default_path();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(METADATA_FILE)
        );
        assert_ne!(
            path.file_name().and_then(|name| name.to_str()),
            Some("auth.json")
        );
        assert_ne!(
            path.file_name().and_then(|name| name.to_str()),
            Some("gg-app.json")
        );
    }

    #[test]
    fn path_parent_is_required_for_atomic_store() {
        let store = FileMetadataStore::new(Path::new("").to_path_buf());
        assert!(store
            .write(&metadata("https://x.openai.azure.com", "x"))
            .is_err());
    }
}
