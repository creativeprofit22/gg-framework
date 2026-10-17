use super::{
    preflight, storage::Vault, validate_key, ConnectionManager, ConnectionResult, ErrorCode,
    SaveConnection, Status,
};
use crate::azure_connection::{
    commands::AzureConnectionMutations,
    lifecycle::{DaemonReloadClient, NativeDaemonReloadClient},
};
use tauri::Manager;

// Reuse Azure's native-only reservation/restart/window notification mechanism, but
// never serialize its provider-specific messages across the Qwen command boundary.
fn preparation_error(error: crate::azure_connection::AzureConnectionError) -> ErrorCode {
    if error.code == "active_runs" {
        ErrorCode::ActiveRun
    } else {
        ErrorCode::PreparationFailed
    }
}

pub(super) async fn mutate<R: DaemonReloadClient, F: FnOnce() -> Result<Status, ErrorCode>>(
    reloader: &R,
    mutation: F,
) -> Result<Status, ErrorCode> {
    reloader.prepare().await.map_err(preparation_error)?;
    let status = match mutation() {
        Ok(status) => status,
        Err(error) => {
            let _ = reloader.cancel().await;
            return Err(error);
        }
    };
    if reloader.reload().await.is_err() {
        let _ = reloader.cancel().await;
        // The vault change succeeded; don't falsely claim it was rolled back.
        return Err(ErrorCode::ReloadFailed);
    }
    Ok(status)
}

pub(super) async fn mutate_and_notify<R, F, N>(
    reloader: &R,
    mutation: F,
    notify: N,
) -> Result<Status, ErrorCode>
where
    R: DaemonReloadClient,
    F: FnOnce() -> Result<Status, ErrorCode>,
    N: FnOnce(&str, serde_json::Value),
{
    let status = mutate(reloader, mutation).await?;
    // Auth is native global state, not pane readiness. Include windows with no
    // session, and send only an invalidation: never a key or vault record.
    notify(
        "auth_change",
        serde_json::json!({ "provider": "qwen-cloud" }),
    );
    Ok(status)
}

fn trusted(window: &tauri::WebviewWindow) -> Result<(), ErrorCode> {
    let url = window.url().map_err(|_| ErrorCode::NativeUnavailable)?;
    if trusted_origin(&url, cfg!(debug_assertions)) {
        Ok(())
    } else {
        Err(ErrorCode::NativeUnavailable)
    }
}

pub(super) fn trusted_origin(url: &reqwest::Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let origin = url.origin().ascii_serialization();
    matches!(
        origin.as_str(),
        "http://tauri.localhost" | "https://tauri.localhost"
    ) || (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
        || (development && origin == "http://localhost:1420")
}

#[tauri::command]
pub(crate) fn qwen_cloud_connection_status(window: tauri::WebviewWindow) -> ConnectionResult {
    trusted(&window)
        .map(|_| ConnectionManager(Vault).status())
        .into()
}

#[tauri::command]
pub(crate) async fn qwen_cloud_connection_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    connection: SaveConnection,
) -> ConnectionResult {
    if let Err(error) = trusted(&window) {
        return Err(error).into();
    }
    if let Err(error) = validate_key(&connection.api_key) {
        return Err(error).into();
    }
    // Same mutex as Azure: no overlapping reservations across providers/windows.
    let mutations = app.state::<AzureConnectionMutations>();
    let _guard = mutations.0.lock().await;
    mutate_and_notify(
        &NativeDaemonReloadClient::new(app.clone()),
        || ConnectionManager(Vault).save(&connection.api_key),
        |event, data| crate::broadcast_agent_event(&app, event, data),
    )
    .await
    .into()
}

#[tauri::command]
pub(crate) async fn qwen_cloud_connection_remove(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> ConnectionResult {
    if let Err(error) = trusted(&window) {
        return Err(error).into();
    }
    let mutations = app.state::<AzureConnectionMutations>();
    let _guard = mutations.0.lock().await;
    mutate_and_notify(
        &NativeDaemonReloadClient::new(app.clone()),
        || ConnectionManager(Vault).remove(),
        |event, data| crate::broadcast_agent_event(&app, event, data),
    )
    .await
    .into()
}

#[tauri::command]
pub(crate) async fn qwen_cloud_connection_test(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    connection: SaveConnection,
) -> ConnectionResult {
    if let Err(error) = trusted(&window) {
        return Err(error).into();
    }
    // Explicit, entered-key-only test. Never read back the saved key for the form.
    // Serialize with save/remove; verification applies to this test, not future status reads.
    let mutations = app.state::<AzureConnectionMutations>();
    let _guard = mutations.0.lock().await;
    let result = async {
        validate_key(&connection.api_key)?;
        let transport = preflight::NativeTransport::new()?;
        preflight::test(
            &transport,
            &connection.api_key,
            std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").as_deref() == Ok("0"),
        )
        .await?;
        let mut status = ConnectionManager(Vault).status();
        status.verification = "succeeded";
        Ok(status)
    }
    .await;
    result.into()
}
