//! Per-session agent proxy commands forwarded to the sidecar daemon.

use crate::*;

#[tauri::command]
pub(crate) fn agent_pane_status(
    webview: WebviewWindow,
    pane_id: String,
) -> Result<PaneStartupStatus, String> {
    let mut status = {
        let windows: State<Windows> = webview.state();
        let registry = windows.map.lock_or_recover();
        pane_startup_status(&registry, webview.label(), &pane_id)?
    };
    status.ready &= port_for(&webview).is_some();
    Ok(status)
}

/// Proxy: current agent/session state.
#[tauri::command]
pub(crate) async fn agent_state(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/state", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: shared durable chat memories.
#[tauri::command]
pub(crate) async fn agent_memories(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/memories", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to load memories")
            .to_string());
    }
    Ok(body)
}

/// Proxy: delete exactly one shared durable chat memory.
#[tauri::command]
pub(crate) async fn agent_delete_memory(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .delete(format!(
            "{}/memories/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to delete memory")
            .to_string());
    }
    Ok(body)
}

/// Proxy: shared chat behavior instructions (Jiwa).
#[tauri::command]
pub(crate) async fn agent_jiwa(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/jiwa", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to load Jiwa")
            .to_string());
    }
    Ok(body)
}

/// Proxy: delete exactly one shared Jiwa instruction.
#[tauri::command]
pub(crate) async fn agent_delete_jiwa(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .delete(format!("{}/jiwa/{}", sidecar_base(port), urlencoding(&id)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("failed to delete Jiwa entry")
            .to_string());
    }
    Ok(body)
}

// Decode separately so HTTP failures can never become successful progress data.
pub(crate) fn decode_progress_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
) -> Result<serde_json::Value, String> {
    let body = serde_json::from_slice::<serde_json::Value>(bytes);
    if !status.is_success() {
        let detail = body
            .as_ref()
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .or_else(|| value.get("error").and_then(|v| v.as_str()))
            })
            .unwrap_or_else(|| {
                status
                    .canonical_reason()
                    .unwrap_or("sidecar request failed")
            });
        return Err(format!(
            "Progress request failed (HTTP {}): {}. Try again after restarting the app.",
            status.as_u16(),
            detail
        ));
    }
    body.map_err(|_| "Progress is unavailable: the daemon returned invalid JSON. Try again after restarting the app.".to_string())
}

#[cfg(test)]
pub(crate) mod progress_response_tests {
    use super::decode_progress_response;
    use reqwest::StatusCode;

    #[test]
    fn progress_response_rejects_http_errors() {
        for (code, detail) in [
            (401, "unauthorized"),
            (403, "forbidden"),
            (500, "internal error"),
        ] {
            let body = serde_json::json!({"error": detail}).to_string();
            let error =
                decode_progress_response(StatusCode::from_u16(code).unwrap(), body.as_bytes())
                    .unwrap_err();
            assert!(error.contains(&format!("HTTP {}", code)));
            assert!(error.contains(detail));
            assert!(error.contains("restarting the app"));
        }
    }

    #[test]
    fn progress_response_prefers_message_and_retains_status_for_non_json_errors() {
        let error = decode_progress_response(
            StatusCode::FORBIDDEN,
            br#"{"message":"access denied","error":"fallback"}"#,
        )
        .unwrap_err();
        assert!(error.contains("access denied"));
        assert!(!error.contains("fallback"));
        let error =
            decode_progress_response(StatusCode::INTERNAL_SERVER_ERROR, b"not json").unwrap_err();
        assert!(error.contains("HTTP 500"));
        assert!(error.contains("Internal Server Error"));
    }

    #[test]
    fn progress_response_rejects_invalid_json_and_recovers() {
        assert!(decode_progress_response(StatusCode::OK, b"not json")
            .unwrap_err()
            .contains("invalid JSON"));
        // Shape validation is owned by the shared frontend contract, not duplicated in Rust.
        let body = serde_json::json!({"level": 1, "streak": {"current": 0, "best": 0}});
        assert_eq!(
            decode_progress_response(StatusCode::OK, body.to_string().as_bytes()).unwrap(),
            body
        );
    }
}

/// Proxy: daemon-global progress; Home must work without a project session.
#[tauri::command]
pub(crate) async fn agent_progress(
    webview: WebviewWindow,
    _pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/progress", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    decode_progress_response(status, &bytes)
}

/// Proxy: the app-wide "keep computer awake while the agent works" setting.
/// Daemon-level (one OS assertion for every window), so no session header.
#[tauri::command]
pub(crate) async fn agent_keep_awake_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/keep-awake", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: turn keep-awake on/off; applies live to in-flight runs.
#[tauri::command]
pub(crate) async fn agent_keep_awake_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/keep-awake", sidecar_base(port)))
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the active provider's subscription quota snapshot. Account-wide, so
/// no per-window session header is needed.
#[tauri::command]
pub(crate) async fn agent_usage(
    webview: WebviewWindow,
    _pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    if provider != "anthropic" && provider != "openai" && provider != "moonshot" {
        return Err("unsupported usage provider".into());
    }
    let res = client
        .get(format!(
            "{}/usage?provider={}",
            sidecar_base(port),
            provider
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("usage request failed")
            .to_string());
    }
    Ok(body)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptSubmissionResult {
    pub(crate) queued: bool,
    pub(crate) count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) queue_id: Option<String>,
    /// Queued prompts only: whether the sidecar hands it to the run in flight
    /// (true) or holds it in the visible, cancellable queue (false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) steers: Option<bool>,
}

// Only allowlisted pre-execution failures carry a definite rejection receipt.
// Legacy failures remain strings for ordinary prompt callers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum PromptSubmissionFailure {
    Rejected {
        category: &'static str,
        code: String,
        message: String,
    },
    Unknown(String),
}

impl From<String> for PromptSubmissionFailure {
    fn from(message: String) -> Self {
        Self::Unknown(message)
    }
}

impl From<&str> for PromptSubmissionFailure {
    fn from(message: &str) -> Self {
        Self::Unknown(message.to_string())
    }
}

pub(crate) fn parse_prompt_submission_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<PromptSubmissionResult, PromptSubmissionFailure> {
    if !status.is_success() {
        if body.len() <= 4096 {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
                let code = value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let known = matches!(
                    (status.as_u16(), code),
                    (400, "invalid_programmatic_selection")
                        | (400, "command_input_not_allowed")
                        | (409, "programmatic_execution_busy")
                        | (403, "programmatic_execution_plan_mode")
                        | (409, "session_mutation_in_progress")
                        | (409, "workflow_busy")
                );
                if known {
                    let fallback = match code {
                        "command_input_not_allowed" => "Command input rejected before execution. Check the command’s allowed text, references and attachments before sending again.",
                        "session_mutation_in_progress" => "Another change to this session was still finishing, so this message wasn't sent. Send it again.",
                        "workflow_busy" => "Wait for the current work to finish, then try again. This request was not added to a waiting list.",
                        _ => "Opportunity run rejected before execution. Refresh the report before retrying.",
                    };
                    let message = value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .filter(|s| {
                            !s.trim().is_empty()
                                && s.len() <= 256
                                && !s.chars().any(char::is_control)
                        })
                        .unwrap_or(fallback);
                    return Err(PromptSubmissionFailure::Rejected {
                        category: "rejected",
                        code: code.to_string(),
                        message: message.to_string(),
                    });
                }
            }
        }
        return Err(sidecar_error_text(status, body).into());
    }
    let result: PromptSubmissionResult =
        serde_json::from_str(body).map_err(|_| "invalid prompt submission response".to_string())?;
    let raw = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid prompt submission response".to_string())?;
    let has_queue_id = raw.get("queueId").is_some();
    let has_steers = raw.get("steers").is_some();
    let valid_queue_id = result.queue_id.as_deref().is_some_and(|id| {
        let bytes = id.as_bytes();
        bytes.len() >= 2
            && bytes[0] == b'q'
            && (b'1'..=b'9').contains(&bytes[1])
            && bytes[2..].iter().all(u8::is_ascii_digit)
    });
    if (result.queued && (result.count == 0 || !valid_queue_id || result.steers.is_none()))
        || (!result.queued && (result.count != 0 || has_queue_id || has_steers))
    {
        return Err("invalid prompt submission response".into());
    }
    Ok(result)
}

pub(crate) async fn post_sidecar_prompt(
    client: &reqwest::Client,
    endpoint: &str,
    gg_sid: &str,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<PromptSubmissionResult, PromptSubmissionFailure> {
    let response = client
        .post(endpoint)
        .header("x-gg-session", gg_sid)
        .json(&serde_json::json!({
            "text": text,
            "attachments": attachments.unwrap_or(serde_json::Value::Array(vec![])),
            "meta": meta.unwrap_or(serde_json::Value::Null),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_prompt_submission_response(status, &body)
}

/// Proxy: submit a prompt (optionally with attachments). The reply streams back
/// via the `agent-event` event. `attachments` is passed through opaquely.
#[tauri::command]
pub(crate) async fn agent_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
    attachments: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<PromptSubmissionResult, PromptSubmissionFailure> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_sidecar_prompt(
        &client,
        &format!("{}/prompt", sidecar_base(port)),
        &gg_sid,
        text,
        attachments,
        meta,
    )
    .await
}

pub(crate) async fn sidecar_get_json(
    webview: &WebviewWindow,
    pane_id: &str,
    client: &reqwest::Client,
    path: &str,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(webview, pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}{}", sidecar_base(port), path))
        .header("x-gg-session", &gg_sid)
        // Local reads (history, export): bounded so a wedged daemon surfaces
        // an error instead of an endless spinner.
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Decode a sidecar response: the JSON body on 2xx, otherwise an error taken
/// from the body's `message`, then `error`, then the HTTP status reason. A
/// non-JSON error body falls back to the status reason.
pub(crate) async fn sidecar_json(res: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = res.status();
    if status.is_success() {
        return res
            .json::<serde_json::Value>()
            .await
            .map_err(|e| e.to_string());
    }
    let body = res.json::<serde_json::Value>().await.ok();
    Err(sidecar_error_message(status, body.as_ref()))
}

/// Pick the user-facing error for a non-2xx sidecar response.
pub(crate) fn sidecar_error_message(
    status: reqwest::StatusCode,
    body: Option<&serde_json::Value>,
) -> String {
    body.and_then(|b| b.get("message").or_else(|| b.get("error")))
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| {
            status
                .canonical_reason()
                .unwrap_or("sidecar request failed")
        })
        .to_string()
}

/// Proxy: resumed conversation history (user + assistant text) for hydration.
#[tauri::command]
pub(crate) async fn agent_history(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    sidecar_get_json(&webview, &pane_id, &client, "/history").await
}

/// Proxy: export this window's session as Markdown.
#[tauri::command]
pub(crate) async fn agent_export_transcript(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let Some(path) = path else {
        return sidecar_get_json(&webview, pane_id, &client, "/export?name=1").await;
    };
    let body = sidecar_get_json(&webview, pane_id, &client, "/export").await?;
    let markdown = body
        .get("markdown")
        .and_then(|value| value.as_str())
        .ok_or("sidecar returned no transcript")?;
    std::fs::write(&path, markdown)
        .map_err(|error| format!("could not save transcript: {error}"))?;
    Ok(serde_json::json!({ "path": path, "bytes": markdown.len() }))
}

pub(crate) fn sidecar_error_text(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = json
            .get("message")
            .or_else(|| json.get("error"))
            .and_then(|value| value.as_str())
        {
            return message.to_string();
        }
        return json.to_string();
    }
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    format!("sidecar request failed with HTTP {status}")
}

pub(crate) fn parse_sidecar_json_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if !status.is_success() {
        return Err(sidecar_error_text(status, body));
    }
    serde_json::from_str(body).map_err(|error| error.to_string())
}

/// Marks MCP management errors whose text the daemon wrote for the user
/// (validation, duplicate names, unknown servers). The webview surfaces only
/// marked messages; everything else stays behind its generic fallback.
pub(crate) const MCP_CLIENT_ERROR_PREFIX: &str = "mcp-client-error: ";

pub(crate) fn parse_mcp_management_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if status.is_client_error()
        && status != reqwest::StatusCode::UNAUTHORIZED
        && status != reqwest::StatusCode::FORBIDDEN
    {
        // The daemon's catch-all route 404 ("not found") is not an MCP outcome.
        let route_missing = |m: &str| status == reqwest::StatusCode::NOT_FOUND && m == "not found";
        let message = serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .and_then(|json| json.get("error")?.as_str().map(|m| m.trim().to_string()))
            .filter(|m| !m.is_empty() && !route_missing(m));
        if let Some(message) = message {
            return Err(format!("{MCP_CLIENT_ERROR_PREFIX}{message}"));
        }
    }
    parse_sidecar_json_response(status, body)
}

pub(crate) async fn post_session_json(
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    route: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(format!("{base_url}{route}"))
        .header("x-gg-session", session_id)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    parse_sidecar_json_response(status, &body)
}

/// Plan mutations return recovery state in expected 400/409 JSON bodies.
/// Preserve those bodies instead of collapsing them to one message.
pub(crate) fn parse_plan_mutation_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::CONFLICT {
        return match serde_json::from_str::<serde_json::Value>(body) {
            Ok(payload) => Err(payload.to_string()),
            Err(_) => Err(sidecar_error_text(status, body)),
        };
    }
    parse_sidecar_json_response(status, body)
}

pub(crate) const CONTINUATION_HANDOFF_PROMPT_MAX_CHARS: usize = 24_000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ContinuationSourceRevision {
    pub(crate) conversation_id: String,
    pub(crate) session_id: String,
    pub(crate) leaf_id: Option<String>,
    pub(crate) fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ContinuationHandoffResponse {
    pub(crate) version: u8,
    pub(crate) prompt: String,
    pub(crate) prepared_id: String,
    pub(crate) source: ContinuationSourceRevision,
    pub(crate) expires_at: u64,
}

pub(crate) fn parse_continuation_handoff_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<ContinuationHandoffResponse, String> {
    if !status.is_success() {
        return Err(sidecar_error_text(status, body));
    }
    let response: ContinuationHandoffResponse = serde_json::from_str(body)
        .map_err(|_| "invalid continuation-handoff response".to_string())?;
    if response.version != 1
        || response.prepared_id.is_empty()
        || response.source.conversation_id.is_empty()
        || response.source.session_id.is_empty()
        || response.source.fingerprint.is_empty()
        || response.expires_at == 0
        || response.prompt.trim().is_empty()
        || response.prompt.chars().count() > CONTINUATION_HANDOFF_PROMPT_MAX_CHARS
    {
        return Err("invalid continuation-handoff response".to_string());
    }
    Ok(response)
}

/// Narrow authenticated programmatic actions; credentials never enter the webview.
#[tauri::command]
pub(crate) async fn agent_programmatic(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    request: serde_json::Value,
    expected_generation: u64,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = {
        let windows: State<Windows> = webview.state();
        let registry = windows.map.lock_or_recover();
        let pane =
            resolve_owned_pane(&registry, webview.label(), &pane_id).ok_or("session not ready")?;
        if pane.generation != expected_generation {
            return Err("project pane changed".to_string());
        }
        pane.session_id.clone().ok_or("session not ready")?
    };
    if request.to_string().len() > 2048 {
        return Err("programmatic request exceeds bounds".to_string());
    }
    let response = client
        .post(format!("{}/programmatic", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&request)
        .send()
        .await
        .map_err(|_| {
            "programmatic acknowledgement unknown; read the report before retrying".to_string()
        })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "programmatic response unavailable".to_string())?;
    if pane_session_for(&webview, &pane_id).as_deref() != Some(gg_sid.as_str()) {
        return Err("project pane changed; discard this response".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "invalid programmatic response".to_string())?;
    // Keep typed rejection/reconciliation receipts, including non-success HTTP responses.
    if !status.is_success() && value.get("ok").and_then(|v| v.as_bool()) != Some(false) {
        return Err(sidecar_error_text(status, &body));
    }
    Ok(value)
}

/// Proxy: synthesize a bounded continuation prompt for the authenticated pane.
#[tauri::command]
pub(crate) async fn agent_continuation_handoff(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    next_instruction: String,
) -> Result<ContinuationHandoffResponse, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/continuation-handoff", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "nextInstruction": next_instruction }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_continuation_handoff_response(status, &body)
}

/// Preserve typed conflict/partial receipts instead of reducing them to error strings.
pub(crate) fn parse_continuation_commit_response(body: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "invalid continuation-commit response; outcome unknown".to_string())?;
    let outcome = value.get("outcome").and_then(|v| v.as_str());
    if !matches!(
        outcome,
        Some("accepted" | "rejected" | "partial" | "outcome-unknown")
    ) || value.get("operationId").and_then(|v| v.as_str()).is_none()
        || value.get("preparedId").and_then(|v| v.as_str()).is_none()
    {
        return Err("invalid continuation-commit response; outcome unknown".to_string());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn agent_commit_continuation(
    webview: WebviewWindow,
    client: tauri::State<'_, reqwest::Client>,
    pane_id: Option<String>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/continuation-commit", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            format!("continuation outcome unknown; inspect the session before retry: {error}")
        })?;
    let body = response
        .text()
        .await
        .map_err(|error| format!("continuation outcome unknown: {error}"))?;
    parse_continuation_commit_response(&body)
}

pub(crate) fn parse_new_session_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if !status.is_success() {
        let kind = if status.is_client_error() {
            "creation-rejected"
        } else {
            "outcome-unknown"
        };
        return Err(serde_json::json!({
            "kind": kind,
            "status": status.as_u16(),
            "message": sidecar_error_text(status, body),
        })
        .to_string());
    }
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid new-session response".to_string())?;
    let operation_id = value
        .get("operationId")
        .and_then(|candidate| candidate.as_str())
        .filter(|candidate| !candidate.is_empty())
        .ok_or_else(|| "invalid new-session response: missing operationId".to_string())?;
    Ok(serde_json::json!({ "operationId": operation_id }))
}

/// Proxy: start a fresh session (clears history) for this window's project.
#[tauri::command]
pub(crate) async fn agent_new_session(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/new-session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    parse_new_session_response(status, &body)
}

/// Proxy: begin an OAuth login. Progress streams back via `agent-event`
/// (`auth_url`, `auth_status`, `auth_need_code`, `auth_done`, `auth_error`).
#[tauri::command]
pub(crate) async fn agent_auth_oauth_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/start", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "provider": provider }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: submit a pasted OAuth code to an in-flight login.
#[tauri::command]
pub(crate) async fn agent_auth_oauth_code(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    code: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/auth/oauth/code", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: answer an MCP server's mid-tool-call request for user input.
///
/// `action` is `accept` | `decline` | `cancel`; `content` carries the filled
/// form and is only meaningful for `accept`.
#[tauri::command]
pub(crate) async fn agent_mcp_elicit(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
    action: String,
    content: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!(
            "{}/mcp/elicit/{}",
            sidecar_base(port),
            urlencoding(&id)
        ))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "action": action, "content": content }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

pub(crate) fn parse_ask_user_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    let value = parse_sidecar_json_response(status, body)?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
        || value.get("error").is_some()
    {
        return Err("The question answer was not acknowledged.".to_string());
    }
    Ok(value)
}

pub(crate) async fn ask_user_response(res: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    parse_ask_user_response(status, &body)
}

/// Proxy: answer an `ask_user` question band.
///
/// `action` is `answer` | `cancel`; `answers` maps each question id to the
/// picked value (or values, for a multi-select). The turn is blocked on this,
/// so the webview must call it on every dismissal path too.
#[tauri::command]
pub(crate) async fn agent_ask_user(
    webview: WebviewWindow,
    pane_id: String,
    client: State<'_, reqwest::Client>,
    id: String,
    action: String,
    answers: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/ask/{}", sidecar_base(port), urlencoding(&id)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "action": action, "answers": answers }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    ask_user_response(res).await
}

/// Proxy: cancel one pending queued message by id. Returns
/// `{ cancelled, queued }`. A queued prompt waits until its own run starts and
/// can be cancelled until then; `cancelled: false` means that run already
/// started between render and click, which is a normal race, not an error.
#[tauri::command]
pub(crate) async fn agent_cancel_queued(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    pane_id: Option<String>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let gg_sid = pane_session_for(&webview, pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/queued/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: stop a background task by id. Returns `{ message }`.
#[tauri::command]
pub(crate) async fn agent_kill_task(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/kill", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: import a Claude Code / Codex / Cursor transcript into a resumable
/// GG Coder session. Returns the importer's typed result (`{ ok, ... }`),
/// including the failure case, so the webview can show the reason verbatim.
#[tauri::command]
pub(crate) async fn agent_import_transcript(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    path: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/import-transcript", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "path": path, "cwd": cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: app-wide radio state — `{ stations, current, volume }`.
/// All windows share the daemon's single player, preventing duplicate audio.
#[tauri::command]
pub(crate) async fn agent_radio_state(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: play a station by id, or stop with `station = "off"`. Returns
/// `{ current }` on success, an error message (e.g. no player installed) on 4xx.
#[tauri::command]
pub(crate) async fn agent_radio_set(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    station: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/radio", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "station": station }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("radio request failed")
            .to_string();
        return Err(msg);
    }
    Ok(body)
}

/// Proxy: set app-wide radio volume from 0 to 100.
#[tauri::command]
pub(crate) async fn agent_radio_volume(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    volume: f64,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/radio/volume", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "volume": volume }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("radio volume request failed")
            .to_string());
    }
    Ok(body)
}

/// Proxy: list this project's task list (the ~/.gg-tasks store for its cwd).
#[tauri::command]
pub(crate) async fn agent_tasks(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!("{}/tasks", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: the Git panel's data. Open issues and PRs on the project's GitHub
/// repo (null when `gh` can't answer), and the changed files with line counts.
#[tauri::command]
pub(crate) async fn agent_git_overview(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/git/overview", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: the project health checklist (`.gg-checklist.json` joined with the
/// built-in items and their current status). A corrupt record surfaces as Err.
#[tauri::command]
pub(crate) async fn agent_checklist(
    webview: WebviewWindow,
    pane_id: String,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!("{}/checklist", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: run one task (`id`) or run-all (`all = true`, starting from the next
/// pending task). Progress streams back via `agent-event` (session_reset,
/// task_start, run_start/run_end, tasks_list, tasks_run_done).
#[tauri::command]
pub(crate) async fn agent_run_tasks(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: Option<String>,
    all: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/tasks/run", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id, "all": all }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: delete a task by id. Returns the remaining `{ tasks }`.
#[tauri::command]
pub(crate) async fn agent_delete_task(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/tasks/delete", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "id": id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: accept the exact server-issued persisted plan checkpoint.
#[tauri::command]
pub(crate) async fn agent_accept_plan(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    daemon: tauri::State<'_, Daemon>,
    checkpoint_id: String,
    generation: u64,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let auth_token = daemon
        .auth_token
        .lock_or_recover()
        .clone()
        .ok_or("agent daemon authentication is not ready")?;
    let response = client
        .post(format!("{}/plan/accept", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .header("x-gg-daemon-token", auth_token)
        .json(&serde_json::json!({
            "checkpointId": checkpoint_id,
            "generation": generation,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_plan_mutation_response(status, &body)
}

/// Proxy: request revision of the exact persisted plan generation.
#[tauri::command]
pub(crate) async fn agent_revise_plan(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    daemon: tauri::State<'_, Daemon>,
    checkpoint_id: String,
    generation: u64,
    feedback: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let auth_token = daemon
        .auth_token
        .lock_or_recover()
        .clone()
        .ok_or("agent daemon authentication is not ready")?;
    let response = client
        .post(format!("{}/plan/revise", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .header("x-gg-daemon-token", auth_token)
        .json(&serde_json::json!({
            "checkpointId": checkpoint_id,
            "generation": generation,
            "feedback": feedback,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_plan_mutation_response(status, &body)
}

pub(crate) fn parse_cancel_response(
    status: reqwest::StatusCode,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if status.is_success() {
        return Ok(body);
    }
    // Preserve the typed sidecar payload (cancel_failed, reason, runState) so
    // the webview can recover honestly instead of seeing only an HTTP code.
    Err(body.to_string())
}

/// Proxy: cancel the in-flight run and reject non-2xx acknowledgements.
#[tauri::command]
pub(crate) async fn agent_cancel(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/cancel", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    parse_cancel_response(status, body)
}

/// Proxy: retry only the Project Notes write for an already acknowledged cancellation.
#[tauri::command]
pub(crate) async fn agent_cancel_roadmap_status_retry(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}/cancel/roadmap-status/retry",
            sidecar_base(port)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    parse_cancel_response(status, body)
}

/// Proxy: ask Ken Kai (the read-only mentor agent). Reply streams back via the
/// `agent-event` event with `ken_`-prefixed types. Lazily boots Ken's session.
#[tauri::command]
pub(crate) async fn agent_ken_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
    target: serde_json::Value,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_session_json(
        &client,
        &sidecar_base(port),
        &gg_sid,
        "/ken/prompt",
        &serde_json::json!({ "text": text, "target": target }),
    )
    .await
    .map(|_| ())
}

/// Proxy: cancel Ken's in-flight run (leaves GG Coder's run untouched).
#[tauri::command]
pub(crate) async fn agent_ken_cancel(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    ken: serde_json::Value,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_session_json(
        &client,
        &sidecar_base(port),
        &gg_sid,
        "/ken/cancel",
        &serde_json::json!({ "ken": ken }),
    )
    .await
    .map(|_| ())
}

pub(crate) async fn post_autopilot(
    client: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let response = post_session_json(
        client,
        base_url,
        session_id,
        "/autopilot",
        &serde_json::json!({ "enabled": enabled }),
    )
    .await?;
    if response
        .get("autopilot")
        .and_then(|value| value.as_bool())
        .is_none()
        || response.get("error").is_some()
    {
        return Err("Invalid Autopilot response".to_string());
    }
    Ok(response)
}

/// Proxy: toggle autopilot (auto-review) for THIS window's project. Persisted
/// server-side in ~/.gg/gg-app.json keyed by cwd; returns `{ autopilot }`.
#[tauri::command]
pub(crate) async fn agent_autopilot_set(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_autopilot(&client, &sidecar_base(port), &gg_sid, enabled).await
}

/// Proxy: list workflow (prompt-template) slash commands.
#[tauri::command]
pub(crate) async fn agent_commands(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/commands", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: list models available to the logged-in providers.
#[tauri::command]
pub(crate) async fn agent_models(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/models", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: switch the active model. Returns the new provider/model + thinking state.
/// `confirm_paid` carries the user's explicit "yes, spend real money" for a
/// model that bills usage credits; the sidecar refuses such a switch without it.
#[tauri::command]
pub(crate) async fn agent_switch_model(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    model: String,
    confirm_paid: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "model": model,
            "confirmPaid": confirm_paid.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: select GPT-6 Astra's OpenAI Codex context profile.
#[tauri::command]
pub(crate) async fn agent_set_context_profile(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    profile: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_session_json(
        &client,
        &sidecar_base(port),
        &gg_sid,
        "/context-profile",
        &serde_json::json!({ "profile": profile }),
    )
    .await
}

/// Proxy: pin Ken (mentor + autopilot) to a model, or clear the pin so he
/// follows GG Coder's model again. `model: None` clears. Returns
/// `{ kenProvider, kenModel, kenModelOverride }`.
#[tauri::command]
pub(crate) async fn agent_switch_ken_model(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    post_session_json(
        &client,
        &sidecar_base(port),
        &gg_sid,
        "/ken/model",
        &serde_json::json!({ "model": model }),
    )
    .await
}

/// Proxy: rewrite a draft prompt into a tighter, terminology-correct version
/// using the active model. Returns `{ enhanced, segments }`.
#[tauri::command]
pub(crate) async fn agent_enhance_prompt(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    text: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/enhance", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Couldn't enhance the prompt. Your original draft has been kept.")
            .to_owned());
    }
    Ok(body)
}

/// Proxy: best-effort Anthropic prompt-cache prewarm (fire-and-forget; 202).
#[tauri::command]
pub(crate) async fn agent_prewarm(
    webview: WebviewWindow,
    pane_id: String,
    client: State<'_, reqwest::Client>,
) -> Result<(), String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    client
        .post(format!("{}/prewarm", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Proxy: cycle the reasoning/thinking level to the next supported value.
/// Returns the new `{ thinkingLevel, supportedThinkingLevels }`.
#[tauri::command]
pub(crate) async fn agent_cycle_thinking(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

/// Proxy: set the reasoning level directly. `level: None` turns thinking off.
/// The sidecar refuses a level the current model doesn't support (400).
#[tauri::command]
pub(crate) async fn agent_set_thinking(
    webview: WebviewWindow,
    pane_id: String,
    client: State<'_, reqwest::Client>,
    level: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    // Pane-scoped like agent_cycle_thinking: a split pane must change its own session.
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/thinking", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "level": level }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_json(res).await
}

#[tauri::command]
pub(crate) async fn agent_plugins(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/plugins", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn agent_install_plugin(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    bundle_path: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/plugins/install", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "bundlePath": bundle_path }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn agent_remove_plugin(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut endpoint = reqwest::Url::parse(&format!("{}/plugins/", sidecar_base(port)))
        .map_err(|e| e.to_string())?;
    endpoint
        .path_segments_mut()
        .map_err(|_| "invalid sidecar URL".to_string())?
        .push(&plugin_id);
    let res = client
        .delete(endpoint)
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.error_for_status()
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn copy_window_label(copy_id: &str) -> String {
    format!("copy-{copy_id}")
}

pub(crate) fn clone_pane_session_file(source: &Path, copy_id: &str) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("the pane session is not available to copy".into());
    }
    let parent = source
        .parent()
        .ok_or("the pane session has no parent directory")?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session");
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jsonl");
    let destination = parent.join(format!("{stem}-copy-{copy_id}.{extension}"));
    if destination.exists() {
        return Ok(destination);
    }

    // Copy to a sibling temporary file, validate complete JSONL, assign the
    // duplicate a fresh durable session identity, then publish by atomic rename.
    // The caller only allows idle panes, so no session writer is active.
    let temporary = parent.join(format!(".{stem}-copy-{copy_id}.tmp"));
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    let contents = std::fs::read_to_string(&temporary).map_err(|error| error.to_string())?;
    let parsed = (|| -> Option<String> {
        if !contents.ends_with('\n') {
            return None;
        }
        let first_newline = contents.find('\n')?;
        let mut header =
            serde_json::from_str::<serde_json::Value>(&contents[..first_newline]).ok()?;
        if header.get("type").and_then(|value| value.as_str()) != Some("session") {
            return None;
        }
        if !contents[first_newline + 1..]
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        {
            return None;
        }
        header["id"] = serde_json::Value::String(copy_id.to_string());
        Some(format!("{}{}", header, &contents[first_newline..]))
    })();
    let Some(rewritten) = parsed else {
        let _ = std::fs::remove_file(&temporary);
        return Err("the pane session changed while it was being copied".into());
    };
    if let Err(error) = std::fs::write(&temporary, rewritten) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    std::fs::rename(&temporary, &destination).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })?;
    Ok(destination)
}

/// Prepare an owner-scoped copy. The source pane stays registered and running;
/// only its durable session file is snapshotted to a new path for the destination.
#[tauri::command]
pub(crate) async fn agent_pane_copy(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    client: tauri::State<'_, reqwest::Client>,
    pane_id: String,
    copy_id: String,
) -> Result<PreparedPaneCopy, String> {
    validate_pane_id(&pane_id)?;
    validate_pane_id(&copy_id)?;
    let owner = webview.label().to_string();

    if let Some(existing) = app
        .state::<PaneCopies>()
        .map
        .lock_or_recover()
        .operations
        .get(&(owner.clone(), copy_id.clone()))
        .cloned()
    {
        return Ok(PreparedPaneCopy {
            copy_id,
            window_label: existing.target_label,
            reused_window: true,
        });
    }

    let source = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock_or_recover();
        resolve_owned_pane(&registry, &owner, &pane_id)
            .cloned()
            .ok_or_else(|| format!("pane '{pane_id}' does not exist in this window"))?
    };
    let session_id = source
        .session_id
        .clone()
        .ok_or("pane session is not ready")?;
    let state = sidecar_get_json(&webview, &pane_id, &client, "/state").await?;
    if state.get("running").and_then(|value| value.as_bool()) == Some(true)
        || state.get("runState").and_then(|value| value.as_str()) != Some("idle")
    {
        return Err("wait for the pane to finish before copying it".into());
    }
    let live_session_path = state
        .get("sessionPath")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| source.session_path.as_ref().map(PathBuf::from))
        .ok_or("pane session has not been persisted yet")?;

    {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock_or_recover();
        if !pane_identity_is_current(&registry, &owner, &pane_id, source.generation, &session_id) {
            return Err("pane changed while the copy was being prepared".into());
        }
    }

    let cloned_path = clone_pane_session_file(&live_session_path, &copy_id)?;
    let cwd = source.cwd.ok_or("pane has no project target")?;
    let restore = RestoreEntry {
        mode: source.mode,
        chat_agent: source.chat_agent,
        cwd: cwd.to_string_lossy().to_string(),
        session_path: Some(cloned_path.to_string_lossy().to_string()),
    };
    let target_label = {
        let copies: State<PaneCopies> = app.state();
        let mut registry = copies.map.lock_or_recover();
        let key = (owner.clone(), copy_id.clone());
        if let Some(existing) = registry.operations.get(&key) {
            return Ok(PreparedPaneCopy {
                copy_id,
                window_label: existing.target_label.clone(),
                reused_window: true,
            });
        }
        let label = copy_window_label(&copy_id);
        if app.get_webview_window(&label).is_some() || registry.target_owners.contains_key(&label) {
            let _ = std::fs::remove_file(&cloned_path);
            return Err("copy destination label is already in use".into());
        }
        registry.target_owners.insert(label.clone(), key.clone());
        registry.operations.insert(
            key,
            PaneCopyOperation {
                source_owner: owner,
                target_label: label.clone(),
                restore,
                cloned_session_path: Some(cloned_path),
                started: false,
            },
        );
        label
    };
    Ok(PreparedPaneCopy {
        copy_id,
        window_label: target_label,
        reused_window: false,
    })
}

pub(crate) async fn rollback_pane_copy(app: &tauri::AppHandle, operation: PaneCopyOperation) {
    remove_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        &operation.target_label,
    );
    let panes = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock_or_recover();
        take_window_panes(&mut registry, &operation.target_label)
    };
    let daemon_port = *app.state::<Daemon>().port.lock_or_recover();
    if let Some(port) = daemon_port {
        for pane in panes {
            if let Some(session_id) = pane.session_id {
                let _ = daemon_delete_session(app, port, &session_id).await;
            }
        }
    }
    if let Some(path) = operation.cloned_session_path {
        let _ = std::fs::remove_file(path);
    }
    if let Some(window) = app.get_webview_window(&operation.target_label) {
        app.state::<PaneCopies>()
            .map
            .lock_or_recover()
            .rolling_back
            .insert(operation.target_label.clone());
        let _ = window.close();
    }
}

/// Build/start the reserved destination. Retries with the same copy id focus the
/// already-started window instead of creating another one.
#[tauri::command]
pub(crate) async fn agent_pane_copy_startup(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    copy_id: String,
) -> Result<PaneCopyResult, String> {
    validate_pane_id(&copy_id)?;
    let owner = webview.label().to_string();
    let operation = app
        .state::<PaneCopies>()
        .map
        .lock_or_recover()
        .operations
        .get(&(owner.clone(), copy_id.clone()))
        .cloned()
        .ok_or("pane copy reservation does not exist")?;
    if operation.source_owner != owner {
        return Err("pane copy reservation belongs to another window".into());
    }
    if operation.started {
        if let Some(window) = app.get_webview_window(&operation.target_label) {
            let _ = window.set_focus();
            return Ok(PaneCopyResult {
                window_label: operation.target_label,
                reused_window: true,
            });
        }
        return Err("the copied window closed before startup completed".into());
    }

    register_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        operation.target_label.clone(),
        operation.restore.clone(),
    );
    let window = match build_hidden_app_window(&app, &operation.target_label) {
        Ok(window) => window,
        Err(error) => {
            let removed = remove_copy_operation(
                &mut app.state::<PaneCopies>().map.lock_or_recover(),
                &owner,
                &copy_id,
            );
            if let Some(removed) = removed {
                rollback_pane_copy(&app, removed).await;
            }
            return Err(error);
        }
    };
    start_window_session(
        app.clone(),
        operation.target_label.clone(),
        operation.restore.mode,
        operation.restore.chat_agent,
        PathBuf::from(&operation.restore.cwd),
        operation.restore.session_path.clone(),
    );

    let mut startup_error = None;
    for _ in 0..600 {
        if app.get_webview_window(&operation.target_label).is_none() {
            startup_error = Some("copied window closed during startup".into());
            break;
        }
        let status = {
            let windows: State<Windows> = app.state();
            let registry = windows.map.lock_or_recover();
            pane_startup_status(&registry, &operation.target_label, PRIMARY_PANE_ID).ok()
        };
        if let Some(status) = status {
            if let Some(error) = status.error {
                startup_error = Some(error);
                break;
            }
            if status.ready && port_for(&webview).is_some() {
                let marked_started = app
                    .state::<PaneCopies>()
                    .map
                    .lock_or_recover()
                    .operations
                    .get_mut(&(owner.clone(), copy_id.clone()))
                    .map(|operation| operation.started = true)
                    .is_some();
                if !marked_started {
                    startup_error = Some("copy was closed during startup".into());
                    break;
                }
                let _ = window.show();
                let _ = window.set_focus();
                snapshot_workspace(&app);
                broadcast_window_order(&app);
                return Ok(PaneCopyResult {
                    window_label: operation.target_label,
                    reused_window: false,
                });
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let removed = remove_copy_operation(
        &mut app.state::<PaneCopies>().map.lock_or_recover(),
        &owner,
        &copy_id,
    );
    if let Some(removed) = removed {
        rollback_pane_copy(&app, removed).await;
    }
    Err(startup_error.unwrap_or_else(|| "copied pane did not start in time".into()))
}

/// Consume-once destination hydration. A source or unrelated window cannot read
/// the target because ownership is looked up from the calling webview label.
#[tauri::command]
pub(crate) fn agent_pane_copy_restore(webview: WebviewWindow) -> Option<RestoreEntry> {
    let copies: State<PaneCopies> = webview.state();
    let targets: State<RestoreTargets> = webview.state();
    let copies = copies.map.lock_or_recover();
    let mut targets = targets.map.lock_or_recover();
    consume_copy_restore_target(&copies, &mut targets, webview.label())
}

#[tauri::command]
pub(crate) async fn agent_pane_copy_rollback(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    copy_id: String,
) -> Result<(), String> {
    validate_pane_id(&copy_id)?;
    let operation = remove_copy_operation(
        &mut app.state::<PaneCopies>().map.lock_or_recover(),
        webview.label(),
        &copy_id,
    );
    if let Some(operation) = operation {
        rollback_pane_copy(&app, operation).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn agent_pane_create(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<u64, String> {
    let label = webview.label().to_string();
    let generation = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock_or_recover();
        create_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            PathBuf::from(&cwd),
            session_path.clone(),
        )?
    };
    let _ = launch_pane_session(
        app,
        label,
        pane_id,
        mode,
        chat_agent,
        PathBuf::from(cwd),
        session_path,
        generation,
    );
    Ok(generation)
}

#[tauri::command]
pub(crate) fn agent_pane_restore(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<u64, String> {
    let label = webview.label().to_string();
    let (generation, created, replaced_session_id) = {
        let windows: State<Windows> = app.state();
        let mut registry = windows.map.lock_or_recover();
        restore_pane_target(
            &mut registry,
            &label,
            &pane_id,
            mode,
            chat_agent,
            PathBuf::from(&cwd),
            session_path.clone(),
        )?
    };
    if let (Some(port), Some(session_id)) = (port_for(&webview), replaced_session_id) {
        let app_for_dispose = app.clone();
        // The replacement generation is already authoritative. Disposal is best-effort so a
        // stale daemon runtime cannot block launching or hydrating the selected saved session.
        tauri::async_runtime::spawn(async move {
            let _ = daemon_delete_session(&app_for_dispose, port, &session_id).await;
        });
    }
    if created {
        let _ = launch_pane_session(
            app,
            label,
            pane_id,
            mode,
            chat_agent,
            PathBuf::from(cwd),
            session_path,
            generation,
        );
    }
    Ok(generation)
}

#[tauri::command]
pub(crate) async fn agent_pane_dispose(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    pane_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let pane = {
        let windows: State<Windows> = app.state();
        let registry = windows.map.lock_or_recover();
        pane_disposal_target(&registry, webview.label(), &pane_id, false, generation)?
    };
    let deletion_result = match (port_for(&webview), pane.session_id.as_deref()) {
        (Some(port), Some(id)) => daemon_delete_session(&app, port, id).await,
        (None, Some(_)) => Err("agent daemon is unavailable; pane session was not disposed".into()),
        (_, None) => Ok(()),
    };
    let windows: State<Windows> = app.state();
    let mut registry = windows.map.lock_or_recover();
    complete_pane_disposal(
        &mut registry,
        webview.label(),
        &pane_id,
        pane.generation,
        deletion_result,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Local Fork: upstream's accept_plan_error_surfaces_sidecar_message_or_status is replaced by the
    // plan_mutation_response_* tests below. The fork returns a structured PlanMutationError and the
    // frontend turns it into the message (covered by gg-app/src/agent-pane-client.test.ts).

    fn context_profile_proxy_result(
        status: reqwest::StatusCode,
        response_body: &str,
    ) -> Result<serde_json::Value, String> {
        session_json_proxy_result(
            status,
            response_body,
            "/context-profile",
            serde_json::json!({ "profile": "experimental" }),
        )
    }

    fn session_json_proxy_result(
        status: reqwest::StatusCode,
        response_body: &str,
        route: &'static str,
        request_body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use std::io::{Read, Write};
        let expected_body = request_body.to_string();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = response_body.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 4096];
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                let Some(header_end) = text.find("\r\n\r\n") else {
                    continue;
                };
                let content_length = text[..header_end]
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request);
            let request_lower = request.to_ascii_lowercase();
            assert!(request.starts_with(&format!("POST {route} HTTP/1.1")));
            assert!(request_lower.contains("x-gg-session: pane-session"));
            assert!(request_lower.contains("x-gg-token: daemon-token"));
            assert!(request.contains(&expected_body));

            let response = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                response_body.len(),
                response_body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-gg-token", "daemon-token".parse().unwrap());
        let client = http_client_builder()
            .default_headers(headers)
            .build()
            .unwrap();
        let result = if route == "/autopilot" {
            tauri::async_runtime::block_on(post_autopilot(
                &client,
                &format!("http://{address}"),
                "pane-session",
                request_body["enabled"].as_bool().unwrap(),
            ))
        } else {
            tauri::async_runtime::block_on(post_session_json(
                &client,
                &format!("http://{address}"),
                "pane-session",
                route,
                &request_body,
            ))
        };
        server.join().unwrap();
        result
    }

    #[test]
    fn agent_autopilot_set_validates_confirmations_and_errors() {
        for enabled in [true, false] {
            let response = serde_json::json!({ "autopilot": enabled });
            assert_eq!(
                session_json_proxy_result(
                    reqwest::StatusCode::OK,
                    &response.to_string(),
                    "/autopilot",
                    serde_json::json!({ "enabled": true })
                ),
                Ok(response)
            );
        }
        assert_eq!(
            session_json_proxy_result(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"configuration refresh in progress"}"#,
                "/autopilot",
                serde_json::json!({ "enabled": true })
            ),
            Err("configuration refresh in progress".into())
        );
        for body in [
            "{}",
            "null",
            r#"{"autopilot":"true"}"#,
            r#"{"autopilot":1}"#,
        ] {
            assert_eq!(
                session_json_proxy_result(
                    reqwest::StatusCode::OK,
                    body,
                    "/autopilot",
                    serde_json::json!({ "enabled": true })
                ),
                Err("Invalid Autopilot response".into())
            );
        }
    }

    #[test]
    fn agent_autopilot_set_propagates_transport_rejection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            drop(listener.accept().unwrap());
        });
        let client = http_client_builder().build().unwrap();
        let result = tauri::async_runtime::block_on(post_autopilot(
            &client,
            &format!("http://{address}"),
            "pane-session",
            true,
        ));
        server.join().unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn agent_switch_ken_model_propagates_http_errors() {
        for (status, message) in [
            (
                reqwest::StatusCode::CONFLICT,
                "cannot switch Ken's model while running",
            ),
            (reqwest::StatusCode::NOT_FOUND, "unknown model: missing"),
        ] {
            assert_eq!(
                session_json_proxy_result(
                    status,
                    &serde_json::json!({ "error": message }).to_string(),
                    "/ken/model",
                    serde_json::json!({ "model": "missing" })
                ),
                Err(message.to_string())
            );
        }
    }

    #[test]
    fn agent_switch_ken_model_posts_pin_and_clear() {
        for model in [Some("gpt"), None] {
            let result = serde_json::json!({ "kenProvider": "openai", "kenModel": "gpt", "kenModelOverride": model.is_some() });
            assert_eq!(
                session_json_proxy_result(
                    reqwest::StatusCode::OK,
                    &result.to_string(),
                    "/ken/model",
                    serde_json::json!({ "model": model })
                ),
                Ok(result)
            );
        }
    }

    #[test]
    fn agent_set_context_profile_posts_authenticated_pane_request() {
        assert_eq!(
            context_profile_proxy_result(
                reqwest::StatusCode::OK,
                r#"{"openAICodexContextProfile":"experimental"}"#,
            ),
            Ok(serde_json::json!({ "openAICodexContextProfile": "experimental" }))
        );
    }

    #[test]
    fn agent_set_context_profile_propagates_sidecar_conflict() {
        assert_eq!(
            context_profile_proxy_result(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"Cannot change context mode while the agent is running."}"#,
            ),
            Err("Cannot change context mode while the agent is running.".to_string())
        );
    }

    fn prompt_proxy_result(
        status: reqwest::StatusCode,
        body: &str,
    ) -> Result<PromptSubmissionResult, PromptSubmissionFailure> {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("POST /prompt HTTP/1.1"));
            assert!(request.contains("x-gg-session: test-session"));

            let response = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                response_body.len(),
                response_body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let client = http_client_builder().build().unwrap();
        let endpoint = format!("http://{address}/prompt");
        let result = tauri::async_runtime::block_on(post_sidecar_prompt(
            &client,
            &endpoint,
            "test-session",
            "Ship the fix".to_string(),
            Some(serde_json::json!([])),
            Some(serde_json::json!({ "kenSent": true })),
        ));
        server.join().unwrap();
        result
    }

    #[test]
    fn prompt_proxy_preserves_direct_and_queued_sidecar_202_results() {
        assert_eq!(
            prompt_proxy_result(
                reqwest::StatusCode::ACCEPTED,
                r#"{"queued":false,"count":0}"#,
            ),
            Ok(PromptSubmissionResult {
                queued: false,
                count: 0,
                queue_id: None,
                steers: None,
            })
        );
        for steers in [false, true] {
            let result = prompt_proxy_result(
                reqwest::StatusCode::ACCEPTED,
                &format!(r#"{{"queued":true,"count":2,"queueId":"q19","steers":{steers}}}"#),
            );
            assert_eq!(
                result,
                Ok(PromptSubmissionResult {
                    queued: true,
                    count: 2,
                    queue_id: Some("q19".to_string()),
                    steers: Some(steers),
                })
            );
            assert_eq!(
                serde_json::to_value(result.unwrap()).unwrap(),
                serde_json::json!({ "queued": true, "count": 2, "queueId": "q19", "steers": steers })
            );
        }
    }

    #[test]
    fn prompt_proxy_preserves_only_known_pre_execution_rejections() {
        for (status, code) in [
            (400, "invalid_programmatic_selection"),
            (400, "command_input_not_allowed"),
            (409, "programmatic_execution_busy"),
            (403, "programmatic_execution_plan_mode"),
        ] {
            let body = serde_json::json!({"error": code, "message": "Wait for the current run.", "history": "private", "token": "private"}).to_string();
            let failure =
                prompt_proxy_result(reqwest::StatusCode::from_u16(status).unwrap(), &body)
                    .unwrap_err();
            assert_eq!(
                serde_json::to_value(failure).unwrap(),
                serde_json::json!({
                    "category": "rejected", "code": code, "message": "Wait for the current run."
                })
            );
        }
        let body =
            serde_json::json!({"error": "programmatic_execution_busy", "message": "x".repeat(257)})
                .to_string();
        let failure =
            parse_prompt_submission_response(reqwest::StatusCode::CONFLICT, &body).unwrap_err();
        assert_eq!(
            serde_json::to_value(failure).unwrap()["message"],
            "Opportunity run rejected before execution. Refresh the report before retrying."
        );
        assert!(matches!(
            parse_prompt_submission_response(reqwest::StatusCode::OK, "not json"),
            Err(PromptSubmissionFailure::Unknown(_))
        ));
        assert!(matches!(
            parse_prompt_submission_response(reqwest::StatusCode::CONFLICT, "not json"),
            Err(PromptSubmissionFailure::Unknown(_))
        ));
        assert!(matches!(
            parse_prompt_submission_response(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"programmatic_execution_busy","message":"Wait"}"#
            ),
            Err(PromptSubmissionFailure::Unknown(_))
        ));
    }

    #[test]
    fn parse_prompt_submission_maps_session_and_workflow_busy_conflicts_to_rejected() {
        // The mutation-lock conflict carries only an owner, never a user message.
        let body = r#"{"error":"session_mutation_in_progress","owner":{"operationId":"op-1","kind":"prompt-start"}}"#;
        let failure =
            parse_prompt_submission_response(reqwest::StatusCode::CONFLICT, body).unwrap_err();
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            serde_json::json!({
                "category": "rejected", "code": "session_mutation_in_progress",
                "message": "Another change to this session was still finishing, so this message wasn't sent. Send it again."
            })
        );
        let body = r#"{"error":"workflow_busy","message":"Wait for the current work to finish, then try again. This request was not added to a waiting list."}"#;
        let failure =
            parse_prompt_submission_response(reqwest::StatusCode::CONFLICT, body).unwrap_err();
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            serde_json::json!({
                "category": "rejected", "code": "workflow_busy",
                "message": "Wait for the current work to finish, then try again. This request was not added to a waiting list."
            })
        );
        // Only the 409 pairing is definitive.
        for status in [
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            for code in ["session_mutation_in_progress", "workflow_busy"] {
                let body = serde_json::json!({"error": code, "message": "Wait."}).to_string();
                assert!(matches!(
                    parse_prompt_submission_response(status, &body),
                    Err(PromptSubmissionFailure::Unknown(_))
                ));
            }
        }
    }

    #[test]
    fn prompt_proxy_bounds_input_policy_rejection_and_requires_pre_start_status() {
        for message in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("x".repeat(257)),
            serde_json::json!("private\nhistory"),
        ] {
            let body =
                serde_json::json!({"error": "command_input_not_allowed", "message": message})
                    .to_string();
            let failure = parse_prompt_submission_response(reqwest::StatusCode::BAD_REQUEST, &body)
                .unwrap_err();
            assert_eq!(
                serde_json::to_value(failure).unwrap(),
                serde_json::json!({
                    "category": "rejected", "code": "command_input_not_allowed",
                    "message": "Command input rejected before execution. Check the command’s allowed text, references and attachments before sending again."
                })
            );
        }
        for status in [
            reqwest::StatusCode::OK,
            reqwest::StatusCode::CONFLICT,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(matches!(
                parse_prompt_submission_response(
                    status,
                    r#"{"error":"command_input_not_allowed","message":"Remove attachments."}"#
                ),
                Err(PromptSubmissionFailure::Unknown(_))
            ));
        }
        let oversized = serde_json::json!({"error": "command_input_not_allowed", "message": "Remove attachments.", "extra": "x".repeat(4096)}).to_string();
        assert!(matches!(
            parse_prompt_submission_response(reqwest::StatusCode::BAD_REQUEST, &oversized),
            Err(PromptSubmissionFailure::Unknown(_))
        ));
    }

    #[test]
    fn prompt_proxy_keeps_lost_and_truncated_responses_unknown_without_retry() {
        use std::io::{Read, Write};

        for truncated in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).unwrap();
                assert!(
                    String::from_utf8_lossy(&request[..read]).starts_with("POST /prompt HTTP/1.1")
                );
                if truncated {
                    // Even a known rejection code is uncertain if reading its body fails.
                    stream.write_all(b"HTTP/1.1 409 Conflict\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n{\"error\":\"programmatic_execution_busy\"}").unwrap();
                }
                drop(stream);
                listener
            });
            let client = http_client_builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap();
            let result = tauri::async_runtime::block_on(post_sidecar_prompt(
                &client,
                &format!("http://{address}/prompt"),
                "test-session",
                "Run selected opportunity".to_string(),
                None,
                None,
            ));
            assert!(matches!(result, Err(PromptSubmissionFailure::Unknown(_))));
            let listener = server.join().unwrap();
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn prompt_proxy_rejects_malformed_success_shapes() {
        for body in [
            r#"{"accepted":true}"#,
            r#"{"queued":true,"count":0}"#,
            r#"{"queued":false,"count":1}"#,
            r#"{"queued":true,"count":1}"#,
            r#"{"queued":true,"count":1,"queueId":""}"#,
            r#"{"queued":true,"count":1,"queueId":"q0"}"#,
            r#"{"queued":true,"count":1,"queueId":"q1\n"}"#,
            r#"{"queued":true,"count":1,"queueId":1}"#,
            r#"{"queued":true,"count":1,"queueId":null}"#,
            r#"{"queued":true,"count":0,"queueId":"q1"}"#,
            r#"{"queued":true,"count":1.5,"queueId":"q1"}"#,
            r#"{"queued":false,"count":0,"queueId":"q1"}"#,
            r#"{"queued":false,"count":0,"queueId":null}"#,
            r#"{"queued":true,"count":1,"queueId":"q1","steers":"yes"}"#,
            r#"{"queued":true,"count":1,"queueId":"q1","steers":null}"#,
            r#"{"queued":false,"count":0,"steers":false}"#,
        ] {
            assert_eq!(
                prompt_proxy_result(reqwest::StatusCode::ACCEPTED, body),
                Err(PromptSubmissionFailure::Unknown(
                    "invalid prompt submission response".to_string()
                ))
            );
        }
    }

    #[test]
    fn prompt_proxy_rejects_sidecar_400_409_and_500_with_backend_text() {
        for (status, body, expected) in [
            (
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"error":"empty prompt"}"#,
                "empty prompt",
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"configuration refresh in progress"}"#,
                "configuration refresh in progress",
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"provider exploded"}"#,
                "provider exploded",
            ),
        ] {
            assert_eq!(
                prompt_proxy_result(status, body),
                Err(PromptSubmissionFailure::Unknown(expected.to_string()))
            );
        }
    }

    #[test]
    fn ask_user_response_rejects_mocked_http_409() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..read]).starts_with("POST /ask/expired HTTP/1.1")
            );
            let body = r#"{"error":"no question is awaiting an answer"}"#;
            write!(stream, "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let result = tauri::async_runtime::block_on(async {
            let response = http_client_builder()
                .build()
                .unwrap()
                .post(format!("http://{address}/ask/expired"))
                .send()
                .await
                .unwrap();
            ask_user_response(response).await
        });
        server.join().unwrap();
        assert_eq!(result, Err("no question is awaiting an answer".to_string()));
    }

    #[test]
    fn ask_user_response_requires_successful_acknowledgement() {
        assert_eq!(
            parse_ask_user_response(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"no question is awaiting an answer"}"#
            ),
            Err("no question is awaiting an answer".to_string())
        );
        for body in [
            "{}",
            "null",
            r#"{"ok":false}"#,
            r#"{"ok":true,"error":"refused"}"#,
        ] {
            assert!(parse_ask_user_response(reqwest::StatusCode::OK, body).is_err());
        }
        assert_eq!(
            parse_ask_user_response(reqwest::StatusCode::OK, r#"{"ok":true}"#),
            Ok(serde_json::json!({ "ok": true }))
        );
    }

    #[test]
    fn sidecar_json_response_rejects_non_success_statuses() {
        assert_eq!(
            parse_sidecar_json_response(
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"session mutation in progress"}"#,
            ),
            Err("session mutation in progress".to_string())
        );
        assert_eq!(
            parse_sidecar_json_response(
                reqwest::StatusCode::ACCEPTED,
                r#"{"accepted":true,"operationId":"operation-1"}"#,
            ),
            Ok(serde_json::json!({
                "accepted": true,
                "operationId": "operation-1"
            }))
        );
    }

    #[test]
    fn mcp_management_response_marks_only_daemon_client_errors() {
        let duplicate = r#"{"error":"A \"docs\" server already exists in global scope. Remove it first or use a different name."}"#;
        assert_eq!(
            parse_mcp_management_response(reqwest::StatusCode::BAD_REQUEST, duplicate),
            Err("mcp-client-error: A \"docs\" server already exists in global scope. Remove it first or use a different name.".to_string())
        );
        assert_eq!(
            parse_mcp_management_response(
                reqwest::StatusCode::NOT_FOUND,
                r#"{"error":"No \"docs\" server found."}"#,
            ),
            Err("mcp-client-error: No \"docs\" server found.".to_string())
        );
        // Unmarked: server failures, auth rejections, route-level 404s, non-JSON bodies.
        for (status, body, expected) in [
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"Could not add the MCP server. Check the command and try again."}"#,
                "Could not add the MCP server. Check the command and try again.",
            ),
            (
                reqwest::StatusCode::UNAUTHORIZED,
                r#"{"error":"unauthorized"}"#,
                "unauthorized",
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                r#"{"error":"not found"}"#,
                "not found",
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                "bad gateway text",
                "bad gateway text",
            ),
        ] {
            assert_eq!(
                parse_mcp_management_response(status, body),
                Err(expected.to_string())
            );
        }
        assert_eq!(
            parse_mcp_management_response(reqwest::StatusCode::ACCEPTED, r#"{"accepted":true}"#),
            Ok(serde_json::json!({ "accepted": true }))
        );
    }

    #[test]
    fn task_proxies_reject_non_success_list_and_delete_responses() {
        for (status, body, expected) in [
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"error":"task plan changed"}"#,
                "task plan changed",
            ),
            (
                reqwest::StatusCode::SERVICE_UNAVAILABLE,
                r#"{"message":"task store unavailable"}"#,
                "task store unavailable",
            ),
        ] {
            assert_eq!(
                parse_sidecar_json_response(status, body),
                Err(expected.to_string())
            );
        }
    }

    #[test]
    fn plan_mutation_response_preserves_structured_recovery_conflicts() {
        let stale = parse_plan_mutation_response(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"stale-plan-checkpoint","pendingPlanReview":{"checkpointId":"checkpoint-2","generation":2,"planPath":"/plans/latest.md","content":"latest","contentHash":"hash","state":"pending-review","reviewStatus":"ready","feedback":null}}"#,
        )
        .unwrap_err();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stale).unwrap(),
            serde_json::json!({
                "error": "stale-plan-checkpoint",
                "pendingPlanReview": {
                    "checkpointId": "checkpoint-2",
                    "generation": 2,
                    "planPath": "/plans/latest.md",
                    "content": "latest",
                    "contentHash": "hash",
                    "state": "pending-review",
                    "reviewStatus": "ready",
                    "feedback": null
                }
            })
        );

        let checkpoint_failure = parse_plan_mutation_response(
            reqwest::StatusCode::CONFLICT,
            r#"{"status":"failed","operationId":"operation-7","code":"checkpoint-write-failed","message":"Could not persist the phase checkpoint.","guidance":"Fix Project Notes permissions, then retry.","retryable":true,"phaseId":"phase-1"}"#,
        )
        .unwrap_err();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&checkpoint_failure).unwrap(),
            serde_json::json!({
                "status": "failed",
                "operationId": "operation-7",
                "code": "checkpoint-write-failed",
                "message": "Could not persist the phase checkpoint.",
                "guidance": "Fix Project Notes permissions, then retry.",
                "retryable": true,
                "phaseId": "phase-1"
            })
        );
    }

    #[test]
    fn plan_mutation_response_preserves_structured_bad_requests() {
        assert_eq!(
            parse_plan_mutation_response(
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"error":"invalid plan revision body"}"#,
            ),
            Err(r#"{"error":"invalid plan revision body"}"#.to_string())
        );
    }

    #[test]
    fn continuation_handoff_response_is_strict_and_preserves_errors() {
        let valid = parse_continuation_handoff_response(
            reqwest::StatusCode::OK,
            r###"{"version":1,"prompt":"## Objective\nContinue","preparedId":"prepared-1","source":{"conversationId":"conversation-1","sessionId":"session-1","leafId":null,"fingerprint":"revision"},"expiresAt":1234}"###,
        )
        .unwrap();
        assert_eq!(valid.version, 1);
        assert_eq!(valid.prompt, "## Objective\nContinue");

        for malformed in [
            r#"{"version":2,"prompt":"Continue"}"#,
            r#"{"version":1,"prompt":""}"#,
            r#"{"version":1,"prompt":"Continue","extra":true}"#,
            r#"{"version":1}"#,
            "not-json",
        ] {
            assert_eq!(
                parse_continuation_handoff_response(reqwest::StatusCode::OK, malformed),
                Err("invalid continuation-handoff response".to_string())
            );
        }

        assert_eq!(
            parse_continuation_handoff_response(
                reqwest::StatusCode::BAD_GATEWAY,
                r#"{"error":"provider unavailable"}"#,
            ),
            Err("provider unavailable".to_string())
        );
    }

    #[test]
    fn new_session_response_forwards_operation_identity() {
        assert_eq!(
            parse_new_session_response(
                reqwest::StatusCode::OK,
                r#"{"ok":true,"operationId":"operation-42"}"#,
            ),
            Ok(serde_json::json!({ "operationId": "operation-42" }))
        );
        assert_eq!(
            parse_new_session_response(reqwest::StatusCode::OK, r#"{"ok":true}"#),
            Err("invalid new-session response: missing operationId".to_string())
        );
        let rejected = parse_new_session_response(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":"session is already resetting"}"#,
        )
        .unwrap_err();
        let rejected: serde_json::Value = serde_json::from_str(&rejected).unwrap();
        assert_eq!(
            rejected,
            serde_json::json!({
                "kind": "creation-rejected",
                "status": 409,
                "message": "session is already resetting",
            })
        );
        let unknown = parse_new_session_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"storage failed after reset"}"#,
        )
        .unwrap_err();
        let unknown: serde_json::Value = serde_json::from_str(&unknown).unwrap();
        assert_eq!(
            unknown,
            serde_json::json!({
                "kind": "outcome-unknown",
                "status": 500,
                "message": "storage failed after reset",
            })
        );
    }

    #[test]
    fn new_session_error_preserves_json_error_text() {
        assert_eq!(
            sidecar_error_text(
                reqwest::StatusCode::CONFLICT,
                r#"{"message":"session is already resetting"}"#,
            ),
            "session is already resetting"
        );
        assert_eq!(
            sidecar_error_text(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"code":"reset_failed","retryable":true}}"#,
            ),
            r#"{"error":{"code":"reset_failed","retryable":true}}"#
        );
    }

    #[test]
    fn cancel_response_accepts_acknowledged_success() {
        let body = serde_json::json!({ "cancelled": true, "runState": "idle" });
        assert_eq!(
            parse_cancel_response(reqwest::StatusCode::OK, body.clone()).unwrap(),
            body
        );
    }

    #[test]
    fn cancel_response_rejects_typed_non_success_body() {
        let body = serde_json::json!({
            "error": "cancel_failed",
            "reason": "timeout",
            "runState": "running"
        });
        let error = parse_cancel_response(reqwest::StatusCode::GATEWAY_TIMEOUT, body).unwrap_err();
        assert!(error.contains("cancel_failed"));
        assert!(error.contains("runState"));
        assert!(error.contains("running"));
    }

    #[test]
    fn repeated_copy_id_reuses_the_reserved_window() {
        let key = ("main".to_string(), "copy-id".to_string());
        let mut copies = PaneCopyRegistry::default();
        copies
            .operations
            .insert(key.clone(), copy_operation("main", "copy-copy-id"));
        copies
            .target_owners
            .insert("copy-copy-id".into(), key.clone());

        let first = copies.operations.get(&key).unwrap().target_label.clone();
        let second = copies.operations.get(&key).unwrap().target_label.clone();
        assert_eq!(first, second);
        assert_eq!(copy_window_label("copy-id"), "copy-copy-id");
    }

    #[test]
    fn session_clone_validates_complete_jsonl_before_publish() {
        let dir = std::env::temp_dir().join(format!("gg-copy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.jsonl");
        std::fs::write(
            &source,
            "{\"type\":\"session\",\"id\":\"source\"}\n{\"type\":\"message\"}\n",
        )
        .unwrap();
        let copied = clone_pane_session_file(&source, "valid").unwrap();
        assert!(copied.is_file());
        let copied_contents = std::fs::read_to_string(&copied).unwrap();
        let copied_header: serde_json::Value =
            serde_json::from_str(copied_contents.lines().next().unwrap()).unwrap();
        assert_eq!(copied_header["id"], "valid");
        assert!(!dir.join(".source-copy-valid.tmp").exists());

        std::fs::write(&source, "{\"type\":\"session\"}\n{\"partial\":").unwrap();
        assert!(clone_pane_session_file(&source, "partial").is_err());
        assert!(!dir.join("source-copy-partial.jsonl").exists());
        assert!(!dir.join(".source-copy-partial.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sidecar_error_prefers_message_then_error_then_status() {
        let both = serde_json::json!({ "message": "m", "error": "e" });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::CONFLICT, Some(&both)),
            "m"
        );
        let err = serde_json::json!({ "error": "a login is already in progress" });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::CONFLICT, Some(&err)),
            "a login is already in progress"
        );
        let other = serde_json::json!({ "ok": false });
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::BAD_REQUEST, Some(&other)),
            "Bad Request"
        );
        assert_eq!(
            sidecar_error_message(reqwest::StatusCode::INTERNAL_SERVER_ERROR, None),
            "Internal Server Error"
        );
    }
}
