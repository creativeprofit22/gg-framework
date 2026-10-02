use tauri::WebviewWindow;

/// Native-only pane/session routing. Eligibility and persistence belong to the daemon.
#[tauri::command]
pub async fn agent_notes_phase_deletion(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = crate::port_for(&webview).ok_or("daemon not ready")?;
    let session = crate::pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = deletion_request(&client, port, &session, request)
        .send().await.map_err(|error| error.to_string())?;
    crate::notes_response(response).await
}

fn deletion_request(
    client: &reqwest::Client,
    port: u16,
    session: &str,
    request: serde_json::Value,
) -> reqwest::RequestBuilder {
    client.post(format!("{}/notes/phase-deletion", crate::sidecar_base(port)))
        .header("x-gg-session", session)
        .json(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_deletion_proxy_preserves_request_and_native_session() {
        let payload = serde_json::json!({"version": 1, "action": "recover", "operationId": "retry-1",
            "phaseId": "phase-1", "expectedProjectKey": "synthetic", "expectedRevision": 8,
            "expectedGeneration": 1});
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().build().unwrap();
        let request = deletion_request(&client, 1421, "native-session", payload.clone()).build().unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().path(), "/notes/phase-deletion");
        assert_eq!(request.headers()["x-gg-session"], "native-session");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(), payload);
    }
}
