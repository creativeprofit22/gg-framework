//! Project Notes / Roadmap / phase command proxies to the sidecar.

use crate::*;

pub(crate) fn normalize_notes_response(
    status: reqwest::StatusCode,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let typed_outcome = body
        .get("status")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| {
            matches!(
                value,
                "ok" | "missing"
                    | "corrupt"
                    | "conflict"
                    | "invalid"
                    | "committed"
                    | "duplicate"
                    | "already-resolved"
                    | "duplicate-id-conflict"
                    | "stale-revision"
                    | "stale-session"
                    | "phase-not-found"
                    | "phase-archived"
                    | "blocker-not-found"
            )
        });
    if status.is_success() || typed_outcome {
        return Ok(body);
    }
    Err(body
        .get("message")
        .or_else(|| body.get("error"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("notes request failed")
        .to_string())
}

pub(crate) async fn notes_response(
    response: reqwest::Response,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    normalize_notes_response(status, body)
}

pub(crate) const NOTES_DIAGNOSTICS_PATH: &str = "/notes/diagnostics";

pub(crate) const NOTES_PHASE_BINDING_PATH: &str = "/notes/roadmap/phase-binding";

/// Proxy: load the authenticated pane's canonical Notes storage diagnostics.
#[tauri::command]
pub(crate) async fn agent_notes_diagnostics(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!("{}{NOTES_DIAGNOSTICS_PATH}", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

/// Proxy: bind or explicitly rebind a Roadmap phase to the authenticated pane.
#[tauri::command]
pub(crate) async fn agent_notes_phase_binding(
    webview: WebviewWindow,
    pane_id: String,
    request: serde_json::Value,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    validate_public_phase_binding_request(&request)?;
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let kind = match request.get("version").and_then(serde_json::Value::as_u64) {
        Some(2) => RoadmapTypedResponseKind::PhaseLease,
        Some(3) => RoadmapTypedResponseKind::PhaseExecutionReconciliation,
        _ => RoadmapTypedResponseKind::PhaseBinding,
    };
    roadmap_typed_request(
        client
            .post(format!("{}{NOTES_PHASE_BINDING_PATH}", sidecar_base(port)))
            .header("x-gg-session", &gg_sid)
            .json(&request),
        kind,
    )
    .await
}

pub(crate) const ROADMAP_TYPED_RESPONSE_MAX_BYTES: usize = 256 * 1024;

pub(crate) const ROADMAP_TYPED_RESPONSE_ERROR: &str = "invalid Roadmap response from daemon";

pub(crate) const PHASE_LEASE_PREDECESSOR_PROOF_ERROR: &str =
    "phase lease predecessor proof is native supervisor-only";

pub(crate) const PHASE_EXECUTION_RECONCILIATION_REQUEST_ERROR: &str =
    "invalid phase execution reconciliation request";

pub(crate) fn validate_public_phase_binding_request(
    request: &serde_json::Value,
) -> Result<(), String> {
    match request.get("version").and_then(serde_json::Value::as_u64) {
        Some(2)
            if request
                .get("predecessorProof")
                .is_some_and(|proof| !proof.is_null()) =>
        {
            Err(PHASE_LEASE_PREDECESSOR_PROOF_ERROR.to_string())
        }
        Some(3) if !is_phase_execution_reconciliation_request(request) => {
            Err(PHASE_EXECUTION_RECONCILIATION_REQUEST_ERROR.to_string())
        }
        _ => Ok(()),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum RoadmapTypedResponseKind {
    PhaseBinding,
    PhaseLease,
    PhaseExecutionReconciliation,
}

pub(crate) async fn roadmap_typed_request(
    request: reqwest::RequestBuilder,
    kind: RoadmapTypedResponseKind,
) -> Result<serde_json::Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| ROADMAP_TYPED_RESPONSE_ERROR.to_string())?;
    roadmap_typed_response(response, kind).await
}

pub(crate) async fn roadmap_typed_response(
    response: reqwest::Response,
    kind: RoadmapTypedResponseKind,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    if !matches!(status.as_u16(), 200 | 404 | 409 | 410 | 500) {
        return Err(ROADMAP_TYPED_RESPONSE_ERROR.to_string());
    }
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    if !is_json
        || response
            .content_length()
            .is_some_and(|length| length > ROADMAP_TYPED_RESPONSE_MAX_BYTES as u64)
    {
        return Err(ROADMAP_TYPED_RESPONSE_ERROR.to_string());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ROADMAP_TYPED_RESPONSE_ERROR.to_string())?;
        if body.len().saturating_add(chunk.len()) > ROADMAP_TYPED_RESPONSE_MAX_BYTES {
            return Err(ROADMAP_TYPED_RESPONSE_ERROR.to_string());
        }
        body.extend_from_slice(&chunk);
    }

    let outcome: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| ROADMAP_TYPED_RESPONSE_ERROR.to_string())?;
    if !is_roadmap_typed_outcome(kind, status.as_u16(), &outcome) {
        return Err(ROADMAP_TYPED_RESPONSE_ERROR.to_string());
    }
    Ok(outcome)
}

pub(crate) fn is_roadmap_typed_outcome(
    kind: RoadmapTypedResponseKind,
    http_status: u16,
    value: &serde_json::Value,
) -> bool {
    let Some(status) = value.get("status").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let status_matches = match kind {
        RoadmapTypedResponseKind::PhaseBinding => match status {
            "committed" | "duplicate" | "already-bound" => http_status == 200,
            "phase-not-found" | "missing" => http_status == 404,
            "duplicate-id-conflict"
            | "stale-revision"
            | "stale-previous-session"
            | "project-mismatch"
            | "phase-archived"
            | "phase-terminal"
            | "missing-session-path" => http_status == 409,
            _ => false,
        },
        RoadmapTypedResponseKind::PhaseLease => match status {
            "inspected" | "acquired" | "renewed" | "released" | "duplicate" => http_status == 200,
            "phase-not-found" | "missing" => http_status == 404,
            "corrupt" => http_status == 500,
            "phase-lease-held"
            | "phase-lease-lost"
            | "lease-owner-unreachable"
            | "operation-conflict"
            | "stale-revision"
            | "project-mismatch"
            | "phase-archived"
            | "phase-terminal"
            | "plan-mismatch" => http_status == 409,
            _ => false,
        },
        RoadmapTypedResponseKind::PhaseExecutionReconciliation => match status {
            "reconciled" | "duplicate" => http_status == 200,
            "phase-not-found" | "missing" => http_status == 404,
            "corrupt" | "lease-corrupt" => http_status == 500,
            "stale-revision"
            | "operation-conflict"
            | "project-mismatch"
            | "phase-archived"
            | "phase-terminal"
            | "execution-missing"
            | "reconciliation-not-required"
            | "repository-mismatch"
            | "plan-mismatch"
            | "plan-hash-mismatch"
            | "workspace-mismatch"
            | "phase-lease-lost"
            | "missing-session-path" => http_status == 409,
            _ => false,
        },
    };
    status_matches
        && match kind {
            RoadmapTypedResponseKind::PhaseBinding => is_phase_binding_outcome(value),
            RoadmapTypedResponseKind::PhaseLease => is_phase_lease_outcome(value),
            RoadmapTypedResponseKind::PhaseExecutionReconciliation => {
                is_phase_execution_reconciliation_outcome(value)
            }
        }
}

pub(crate) fn exact_roadmap_object<'a>(
    value: &'a serde_json::Value,
    expected: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    has_exact_keys(object, expected).then_some(object)
}

pub(crate) fn is_roadmap_revision(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|revision| revision <= 9_007_199_254_740_991)
}

pub(crate) fn is_roadmap_bounded_string(
    value: Option<&serde_json::Value>,
    max_length: usize,
) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| {
            !candidate.trim().is_empty() && candidate.encode_utf16().count() <= max_length
        })
}

pub(crate) fn is_roadmap_lower_hex(value: Option<&serde_json::Value>, length: usize) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| {
            candidate.len() == length
                && candidate
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

pub(crate) fn is_roadmap_timestamp(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| chrono::DateTime::parse_from_rfc3339(candidate).is_ok())
}

pub(crate) fn is_roadmap_safe_relative_path(value: Option<&serde_json::Value>) -> bool {
    let Some(candidate) = value.and_then(serde_json::Value::as_str) else {
        return false;
    };
    if !is_roadmap_bounded_string(value, 4096)
        || candidate.contains('\0')
        || candidate.starts_with('/')
        || candidate.starts_with('\\')
        || candidate.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    candidate
        .split(['/', '\\'])
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

pub(crate) fn is_notes_repository_identity(value: Option<&serde_json::Value>) -> bool {
    let Some(object) = value
        .and_then(serde_json::Value::as_object)
        .filter(|object| has_exact_keys(object, &["projectKey", "identityHash", "rootCommit"]))
    else {
        return false;
    };
    is_roadmap_bounded_string(object.get("projectKey"), 4096)
        && is_roadmap_lower_hex(object.get("identityHash"), 64)
        && object
            .get("rootCommit")
            .is_some_and(|commit| commit.is_null() || is_roadmap_lower_hex(Some(commit), 40))
}

pub(crate) fn is_phase_execution_reconciliation_request(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object().filter(|object| {
        has_exact_keys(
            object,
            &[
                "version",
                "action",
                "phaseId",
                "expectedProjectKey",
                "expectedRevision",
                "operationId",
                "repository",
                "plan",
                "workspace",
            ],
        )
    }) else {
        return false;
    };
    let Some(plan) = object
        .get("plan")
        .and_then(serde_json::Value::as_object)
        .filter(|plan| {
            has_exact_keys(
                plan,
                &[
                    "planId",
                    "contentHash",
                    "snapshotPath",
                    "approvedAt",
                    "approvedRevision",
                    "baseCommit",
                ],
            )
        })
    else {
        return false;
    };
    let Some(workspace) = object
        .get("workspace")
        .and_then(serde_json::Value::as_object)
        .filter(|workspace| {
            has_exact_keys(
                workspace,
                &[
                    "version",
                    "repository",
                    "headCommit",
                    "worktreeDigest",
                    "clean",
                ],
            )
        })
    else {
        return false;
    };
    object.get("version").and_then(serde_json::Value::as_u64) == Some(3)
        && object.get("action").and_then(serde_json::Value::as_str) == Some("reconcile-execution")
        && is_roadmap_bounded_string(object.get("phaseId"), 256)
        && is_roadmap_bounded_string(object.get("expectedProjectKey"), 4096)
        && is_roadmap_revision(object.get("expectedRevision"))
        && is_roadmap_bounded_string(object.get("operationId"), 256)
        && is_notes_repository_identity(object.get("repository"))
        && is_roadmap_bounded_string(plan.get("planId"), 256)
        && is_roadmap_lower_hex(plan.get("contentHash"), 64)
        && is_roadmap_safe_relative_path(plan.get("snapshotPath"))
        && is_roadmap_timestamp(plan.get("approvedAt"))
        && is_roadmap_revision(plan.get("approvedRevision"))
        && plan
            .get("baseCommit")
            .is_some_and(|commit| commit.is_null() || is_roadmap_lower_hex(Some(commit), 40))
        && workspace.get("version").and_then(serde_json::Value::as_u64) == Some(1)
        && is_notes_repository_identity(workspace.get("repository"))
        && workspace.get("repository") == object.get("repository")
        && is_roadmap_lower_hex(workspace.get("headCommit"), 40)
        && is_roadmap_lower_hex(workspace.get("worktreeDigest"), 64)
        && workspace
            .get("clean")
            .and_then(serde_json::Value::as_bool)
            .is_some()
}

pub(crate) fn is_roadmap_bounded_string_array(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.len() <= 10_000
                && items
                    .iter()
                    .all(|item| is_roadmap_bounded_string(Some(item), 256))
        })
}

pub(crate) fn is_project_notes_corrupt_reason(value: &serde_json::Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|reason| {
            matches!(
                reason,
                "malformed-json" | "invalid-envelope" | "project-key-mismatch"
            )
        })
}

pub(crate) fn is_phase_execution_reconciliation_outcome(value: &serde_json::Value) -> bool {
    let Some(status) = value.get("status").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match status {
        "reconciled" | "duplicate" => exact_roadmap_object(
            value,
            &[
                "status",
                "revision",
                "phaseId",
                "preservedStepIds",
                "revalidationStepIds",
                "revalidationEvidenceCount",
                "reconciledAt",
            ],
        )
        .is_some_and(|object| {
            is_roadmap_revision(object.get("revision"))
                && is_roadmap_bounded_string(object.get("phaseId"), 256)
                && is_roadmap_bounded_string_array(object.get("preservedStepIds"))
                && is_roadmap_bounded_string_array(object.get("revalidationStepIds"))
                && is_roadmap_revision(object.get("revalidationEvidenceCount"))
                && is_roadmap_timestamp(object.get("reconciledAt"))
        }),
        "stale-revision" | "operation-conflict" => {
            exact_roadmap_object(value, &["status", "revision"])
                .is_some_and(|object| is_roadmap_revision(object.get("revision")))
        }
        "project-mismatch" => {
            exact_roadmap_object(value, &["status", "revision", "currentProjectKey"]).is_some_and(
                |object| {
                    is_roadmap_revision(object.get("revision"))
                        && is_roadmap_bounded_string(object.get("currentProjectKey"), 4096)
                },
            )
        }
        "phase-not-found"
        | "phase-archived"
        | "phase-terminal"
        | "execution-missing"
        | "reconciliation-not-required"
        | "repository-mismatch"
        | "plan-mismatch"
        | "plan-hash-mismatch"
        | "workspace-mismatch"
        | "phase-lease-lost"
        | "lease-corrupt"
        | "missing-session-path"
        | "missing" => exact_roadmap_object(value, &["status"]).is_some(),
        "corrupt" => {
            exact_roadmap_object(value, &["status", "primary", "backup"]).is_some_and(|object| {
                object
                    .get("primary")
                    .is_some_and(is_project_notes_corrupt_reason)
                    && object
                        .get("backup")
                        .is_some_and(is_project_notes_corrupt_reason)
            })
        }
        _ => false,
    }
}

pub(crate) fn is_notes_session_link(value: Option<&serde_json::Value>) -> bool {
    let Some(object) = value
        .and_then(serde_json::Value::as_object)
        .filter(|object| has_exact_keys(object, &["sessionId", "sessionPath"]))
    else {
        return false;
    };
    is_roadmap_bounded_string(object.get("sessionId"), ROADMAP_TYPED_RESPONSE_MAX_BYTES)
        && object.get("sessionPath").is_some_and(|path| {
            path.is_null()
                || is_roadmap_bounded_string(Some(path), ROADMAP_TYPED_RESPONSE_MAX_BYTES)
        })
}

pub(crate) fn is_nullable_notes_session_link(value: Option<&serde_json::Value>) -> bool {
    value.is_some_and(|value| value.is_null() || is_notes_session_link(Some(value)))
}

pub(crate) fn is_phase_binding_outcome(value: &serde_json::Value) -> bool {
    let Some(status) = value.get("status").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match status {
        "committed" | "duplicate" => {
            let Some(object) = exact_roadmap_object(
                value,
                &[
                    "status",
                    "revision",
                    "phaseId",
                    "previousSession",
                    "session",
                ],
            ) else {
                return false;
            };
            is_roadmap_revision(object.get("revision"))
                && is_roadmap_bounded_string(object.get("phaseId"), 256)
                && is_nullable_notes_session_link(object.get("previousSession"))
                && is_notes_session_link(object.get("session"))
        }
        "already-bound" => {
            let Some(object) =
                exact_roadmap_object(value, &["status", "revision", "phaseId", "session"])
            else {
                return false;
            };
            is_roadmap_revision(object.get("revision"))
                && is_roadmap_bounded_string(object.get("phaseId"), 256)
                && is_notes_session_link(object.get("session"))
        }
        "duplicate-id-conflict" | "stale-revision" => {
            exact_roadmap_object(value, &["status", "revision"])
                .is_some_and(|object| is_roadmap_revision(object.get("revision")))
        }
        "stale-previous-session" => {
            let Some(object) =
                exact_roadmap_object(value, &["status", "revision", "currentSession"])
            else {
                return false;
            };
            is_roadmap_revision(object.get("revision"))
                && is_nullable_notes_session_link(object.get("currentSession"))
        }
        "project-mismatch" => {
            let Some(object) =
                exact_roadmap_object(value, &["status", "expectedProjectKey", "actualProjectKey"])
            else {
                return false;
            };
            is_roadmap_bounded_string(object.get("expectedProjectKey"), 4096)
                && is_roadmap_bounded_string(object.get("actualProjectKey"), 4096)
        }
        "phase-not-found"
        | "phase-archived"
        | "phase-terminal"
        | "missing-session-path"
        | "missing" => exact_roadmap_object(value, &["status"]).is_some(),
        _ => false,
    }
}

pub(crate) fn is_phase_lease_holder(value: Option<&serde_json::Value>) -> bool {
    let Some(object) = value
        .and_then(serde_json::Value::as_object)
        .filter(|object| {
            has_exact_keys(
                object,
                &["daemonInstanceId", "sessionId", "sessionPath", "processId"],
            )
        })
    else {
        return false;
    };
    is_roadmap_bounded_string(object.get("daemonInstanceId"), 256)
        && is_roadmap_bounded_string(object.get("sessionId"), 256)
        && object
            .get("sessionPath")
            .is_some_and(|path| path.is_null() || is_roadmap_bounded_string(Some(path), 4096))
        && object
            .get("processId")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991)
}

pub(crate) fn is_phase_lease(value: Option<&serde_json::Value>) -> bool {
    let Some(object) = value
        .and_then(serde_json::Value::as_object)
        .filter(|object| {
            has_exact_keys(
                object,
                &[
                    "version",
                    "projectKey",
                    "phaseId",
                    "planId",
                    "leaseId",
                    "fence",
                    "holder",
                    "runState",
                    "acquiredAt",
                    "renewedAt",
                    "expiresAt",
                    "operationId",
                ],
            )
        })
    else {
        return false;
    };
    let timestamps = ["acquiredAt", "renewedAt", "expiresAt"].map(|key| {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
    });
    object.get("version").and_then(serde_json::Value::as_u64) == Some(1)
        && is_roadmap_bounded_string(object.get("projectKey"), 4096)
        && is_roadmap_bounded_string(object.get("phaseId"), 256)
        && object
            .get("planId")
            .is_some_and(|plan| plan.is_null() || is_roadmap_bounded_string(Some(plan), 256))
        && is_roadmap_bounded_string(object.get("leaseId"), 256)
        && object
            .get("fence")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|fence| fence > 0 && fence <= 9_007_199_254_740_991)
        && is_phase_lease_holder(object.get("holder"))
        && object
            .get("runState")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|state| matches!(state, "idle" | "running"))
        && timestamps.iter().all(Option::is_some)
        && timestamps[0] <= timestamps[1]
        && timestamps[1] < timestamps[2]
        && is_roadmap_bounded_string(object.get("operationId"), 256)
}

pub(crate) fn is_phase_lease_outcome(value: &serde_json::Value) -> bool {
    let Some(status) = value.get("status").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match status {
        "inspected" | "acquired" | "renewed" | "released" | "duplicate" => {
            let Some(object) = exact_roadmap_object(
                value,
                &[
                    "status",
                    "roadmapRevision",
                    "leaseRevision",
                    "phaseId",
                    "lease",
                ],
            ) else {
                return false;
            };
            let lease_valid = object.get("lease").is_some_and(|lease| {
                lease.is_null()
                    || (is_phase_lease(Some(lease))
                        && lease.get("phaseId") == object.get("phaseId"))
            });
            is_roadmap_revision(object.get("roadmapRevision"))
                && is_roadmap_revision(object.get("leaseRevision"))
                && is_roadmap_bounded_string(object.get("phaseId"), 256)
                && lease_valid
                && (status != "released"
                    || object.get("lease").is_some_and(|lease| lease.is_null()))
        }
        "phase-lease-held" | "phase-lease-lost" | "lease-owner-unreachable" => {
            let Some(object) = exact_roadmap_object(
                value,
                &["status", "roadmapRevision", "leaseRevision", "currentLease"],
            ) else {
                return false;
            };
            is_roadmap_revision(object.get("roadmapRevision"))
                && is_roadmap_revision(object.get("leaseRevision"))
                && object
                    .get("currentLease")
                    .is_some_and(|lease| lease.is_null() || is_phase_lease(Some(lease)))
        }
        "operation-conflict" | "stale-revision" => {
            exact_roadmap_object(value, &["status", "roadmapRevision", "leaseRevision"])
                .is_some_and(|object| {
                    is_roadmap_revision(object.get("roadmapRevision"))
                        && is_roadmap_revision(object.get("leaseRevision"))
                })
        }
        "project-mismatch" => {
            exact_roadmap_object(value, &["status", "roadmapRevision", "currentProjectKey"])
                .is_some_and(|object| {
                    is_roadmap_revision(object.get("roadmapRevision"))
                        && is_roadmap_bounded_string(object.get("currentProjectKey"), 4096)
                })
        }
        "phase-not-found" | "phase-archived" | "phase-terminal" | "plan-mismatch" | "missing" => {
            exact_roadmap_object(value, &["status"]).is_some()
        }
        "corrupt" => {
            let Some(object) = exact_roadmap_object(value, &["status", "primary", "backup"]) else {
                return false;
            };
            ["primary", "backup"].iter().all(|key| {
                object
                    .get(*key)
                    .is_some_and(|reason| reason.is_null() || reason.is_string())
            })
        }
        _ => false,
    }
}

/// Proxy: load the authenticated pane's project Notes snapshot.
#[tauri::command]
pub(crate) async fn agent_notes_get(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!("{}/notes", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

pub(crate) fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub(crate) fn phase_start_path(phase_id: &str) -> String {
    format!("/phases/{}/start", encode_path_segment(phase_id))
}

pub(crate) fn phase_advancement_start_path(checkpoint_id: &str) -> String {
    format!(
        "/notes/roadmap/advancement/{}/start",
        encode_path_segment(checkpoint_id)
    )
}

pub(crate) fn phase_advancement_start_body(next_phase_id: &str) -> serde_json::Value {
    serde_json::json!({
        "action": "start-next-phase",
        "nextPhaseId": next_phase_id,
    })
}

pub(crate) fn phase_cancel_path(phase_id: &str) -> String {
    format!("/phases/{}/cancel", encode_path_segment(phase_id))
}

pub(crate) fn roadmap_phase_draft_approve_path(draft_id: &str) -> String {
    format!(
        "/roadmap/phase-drafts/{}/approve",
        encode_path_segment(draft_id)
    )
}

pub(crate) fn roadmap_phase_draft_reject_path(draft_id: &str) -> String {
    format!(
        "/roadmap/phase-drafts/{}/reject",
        encode_path_segment(draft_id)
    )
}

#[derive(Clone, Copy)]
pub(crate) enum RoadmapPhaseDraftResponseKind {
    Get,
    Approve,
    Reject,
}

pub(crate) fn is_non_negative_integer(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_u64).is_some()
}

pub(crate) fn is_non_empty_string(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| !candidate.is_empty())
}

pub(crate) const ROADMAP_PHASE_DRAFT_KEYS: [&str; 8] = [
    "id",
    "projectKey",
    "basedOnRevision",
    "createdAt",
    "createdBySessionId",
    "summary",
    "phases",
    "status",
];

// Mirrors gg-core DRAFT_OPTIONAL_KEYS; legacy drafts omit these.
pub(crate) const ROADMAP_PHASE_DRAFT_OPTIONAL_KEYS: [&str; 3] =
    ["references", "sourcesNotCited", "orderPreview"];

pub(crate) const ROADMAP_PHASE_DRAFT_SOURCES_NOT_CITED_MAX_LENGTH: usize = 1_024;

pub(crate) const ROADMAP_DRAFT_PHASE_KEYS: [&str; 5] =
    ["phaseId", "title", "goal", "doneWhen", "sourcePrompt"];

// Mirrors gg-core DRAFT_PHASE_OPTIONAL_KEYS; legacy draft phases omit these.
pub(crate) const ROADMAP_DRAFT_PHASE_OPTIONAL_KEYS: [&str; 2] =
    ["referenceIds", "insertBeforePhaseId"];

pub(crate) const ROADMAP_PROPOSED_PHASES_MAX_ITEMS: usize = 20;

pub(crate) const ROADMAP_DRAFT_REFERENCES_MAX_ITEMS: usize = 50;

pub(crate) const ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS: usize = ROADMAP_DRAFT_REFERENCES_MAX_ITEMS;

pub(crate) const ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS: usize = 20;

pub(crate) fn has_exact_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    expected: &[&str],
) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

/// Mirrors gg-core `normalizeRoadmapWorkflowText`: NFC, LF line endings, trimmed.
pub(crate) fn normalized_roadmap_text(value: Option<&serde_json::Value>) -> Option<String> {
    let normalized_nfc = value?.as_str()?.nfc().collect::<String>();
    let normalized_lines = normalized_nfc.replace("\r\n", "\n").replace('\r', "\n");
    Some(normalized_lines.trim().to_string())
}

/// Mirrors gg-core roadmap-workflow `normalizedBoundedString`, which bounds normalized text by
/// Unicode code points (`Array.from(value).length`), not UTF-16 units.
pub(crate) fn normalized_bounded_code_points(
    value: Option<&serde_json::Value>,
    max_length: usize,
) -> Option<String> {
    let normalized = normalized_roadmap_text(value)?;
    (1..=max_length)
        .contains(&normalized.chars().count())
        .then_some(normalized)
}

/// Draft reference metadata must also pass gg-core `validateNotesReferenceProjection`, whose
/// UTF-16 `.length` bound is stricter than the code-point bound checked before it.
pub(crate) fn normalized_bounded_utf16(
    value: Option<&serde_json::Value>,
    max_length: usize,
) -> Option<String> {
    let normalized = normalized_roadmap_text(value)?;
    (1..=max_length)
        .contains(&normalized.encode_utf16().count())
        .then_some(normalized)
}

// Mirrors gg-core isRecordWithKeys: every base key required, only listed optional extras.
pub(crate) fn has_required_and_optional_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    base: &[&str],
    optional: &[&str],
) -> bool {
    base.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| base.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

pub(crate) fn roadmap_reference_array(
    value: Option<&serde_json::Value>,
) -> Option<&[serde_json::Value]> {
    match value {
        None | Some(serde_json::Value::Null) => Some(&[]),
        Some(value) => value.as_array().map(Vec::as_slice),
    }
}

// Mirrors roadmap-workflow normalizeDraftReference and Project Notes reference coordinates.
pub(crate) fn roadmap_draft_reference(value: &serde_json::Value) -> Option<(String, String)> {
    let object = value.as_object()?;
    if !has_exact_keys(
        object,
        &[
            "id",
            "provider",
            "tool",
            "canonicalUrl",
            "owner",
            "repo",
            "revision",
            "path",
            "range",
            "issue",
            "pullRequest",
            "query",
            "anchor",
            "relevance",
        ],
    ) {
        return None;
    }
    let id = normalized_bounded_code_points(object.get("id"), 512)?;
    let provider = normalized_bounded_utf16(object.get("provider"), 4_096)?.to_lowercase();
    let owner = normalized_bounded_utf16(object.get("owner"), 4_096)?;
    let repo = normalized_bounded_utf16(object.get("repo"), 4_096)?;
    for field in ["tool", "revision", "path", "query", "anchor"] {
        if !object.get(field)?.is_null() {
            normalized_bounded_utf16(object.get(field), 4_096)?;
        }
    }
    let relevance = object.get("relevance")?.as_str()?.nfc().collect::<String>();
    if relevance
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .encode_utf16()
        .count()
        > 4_096
    {
        return None;
    }
    let canonical_url = normalized_bounded_utf16(object.get("canonicalUrl"), 2_048)?;
    let mut url = reqwest::Url::parse(&canonical_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    if url.as_str().trim_end_matches('/').encode_utf16().count() > 2_048 {
        return None;
    }
    let range = object.get("range")?;
    if !range.is_null() {
        let range = range.as_object()?;
        if !has_exact_keys(range, &["startLine", "endLine"]) {
            return None;
        }
        let start = range.get("startLine")?.as_u64()?;
        let end = range.get("endLine")?.as_u64()?;
        if start == 0 || end < start || object.get("path")?.is_null() {
            return None;
        }
    }
    for field in ["issue", "pullRequest"] {
        let number = object.get(field)?;
        if !number.is_null() && !number.as_u64().is_some_and(|number| number > 0) {
            return None;
        }
    }
    if !object.get("issue")?.is_null() && !object.get("pullRequest")?.is_null() {
        return None;
    }
    if provider == "github" {
        let segments: Vec<_> = url
            .path()
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        let normalized_repo = repo.to_lowercase();
        let url_repo = segments.get(1).copied().unwrap_or_default().to_lowercase();
        if url.host_str() != Some("github.com")
            || segments.len() < 2
            || segments[0].to_lowercase() != owner.to_lowercase()
            || url_repo.strip_suffix(".git").unwrap_or(&url_repo)
                != normalized_repo
                    .strip_suffix(".git")
                    .unwrap_or(&normalized_repo)
        {
            return None;
        }
        if let Some(number) = segments
            .get(3)
            .filter(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
        {
            let field = match segments[2] {
                "issues" => Some("issue"),
                "pull" => Some("pullRequest"),
                _ => None,
            };
            if let Some(field) = field {
                if object.get(field)?.as_u64() != Some(number.parse::<u64>().ok()?) {
                    return None;
                }
            }
        }
    }
    Some((
        id,
        format!("{}\n{}", provider, url.as_str().trim_end_matches('/')),
    ))
}

/// Returns the phase ID and its optional `insertBeforePhaseId` target.
pub(crate) fn is_roadmap_draft_phase(
    value: &serde_json::Value,
) -> Option<(String, Option<String>)> {
    let object = value.as_object()?;
    if !has_required_and_optional_keys(
        object,
        &ROADMAP_DRAFT_PHASE_KEYS,
        &ROADMAP_DRAFT_PHASE_OPTIONAL_KEYS,
    ) {
        return None;
    }

    let phase_id = normalized_bounded_code_points(object.get("phaseId"), 512)?;
    let insert_before = match object.get("insertBeforePhaseId") {
        None => None,
        value => Some(normalized_bounded_code_points(value, 512)?),
    };
    normalized_bounded_code_points(object.get("title"), 200)?;
    normalized_bounded_code_points(object.get("goal"), 4_096)?;
    normalized_bounded_code_points(object.get("sourcePrompt"), 16_384)?;

    let done_when = object.get("doneWhen")?.as_array()?;
    if !(1..=ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS).contains(&done_when.len()) {
        return None;
    }
    let mut criteria = HashSet::new();
    for criterion in done_when {
        let normalized = normalized_bounded_code_points(Some(criterion), 1_024)?;
        if !criteria.insert(normalized) {
            return None;
        }
    }

    Some((phase_id, insert_before))
}

pub(crate) const ROADMAP_PHASE_EDIT_DRAFT_KEYS: [&str; 12] = [
    "kind",
    "id",
    "projectKey",
    "basedOnRevision",
    "createdAt",
    "createdBySessionId",
    "summary",
    "phaseId",
    "phaseTitle",
    "basedOnUpdatedAt",
    "changes",
    "status",
];

/// Canonical field order shared with gg-core `ROADMAP_PHASE_EDIT_FIELDS`.
pub(crate) const ROADMAP_PHASE_EDIT_FIELDS: [&str; 4] =
    ["title", "goal", "doneWhen", "sourcePrompt"];

pub(crate) const ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH: usize = 65_536;

pub(crate) const ROADMAP_PHASE_EDIT_BEFORE_DONE_WHEN_MAX_ITEMS: usize = 200;

/// `before` values are copied verbatim from Notes: bounded by code points, may be empty.
pub(crate) fn roadmap_edit_before_string(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|candidate| candidate.chars().count() <= ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH)
}

pub(crate) fn roadmap_edit_before_list(value: Option<&serde_json::Value>) -> Option<Vec<&str>> {
    let items = value?.as_array()?;
    if items.len() > ROADMAP_PHASE_EDIT_BEFORE_DONE_WHEN_MAX_ITEMS {
        return None;
    }
    items
        .iter()
        .map(|item| roadmap_edit_before_string(Some(item)))
        .collect()
}

/// Validates the proposed `doneWhen` list with the same bounds as add drafts.
pub(crate) fn roadmap_edit_done_when(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    if !(1..=ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS).contains(&items.len()) {
        return None;
    }
    let mut seen = HashSet::new();
    let mut criteria = Vec::with_capacity(items.len());
    for item in items {
        let normalized = normalized_bounded_code_points(Some(item), 1_024)?;
        if !seen.insert(normalized.clone()) {
            return None;
        }
        criteria.push(normalized);
    }
    Some(criteria)
}

/// Returns the canonical index of a valid field change, mirroring gg-core `validateFieldChange`.
pub(crate) fn roadmap_edit_field_change(value: &serde_json::Value) -> Option<usize> {
    let object = value.as_object()?;
    if !has_exact_keys(object, &["field", "before", "after"]) {
        return None;
    }
    let field = object.get("field")?.as_str()?;
    let index = ROADMAP_PHASE_EDIT_FIELDS
        .iter()
        .position(|candidate| *candidate == field)?;
    if field == "doneWhen" {
        let before = roadmap_edit_before_list(object.get("before"))?;
        let after = roadmap_edit_done_when(object.get("after"))?;
        let unchanged = before.len() == after.len()
            && before
                .iter()
                .zip(after.iter())
                .all(|(left, right)| *left == right);
        return (!unchanged).then_some(index);
    }
    let before = roadmap_edit_before_string(object.get("before"))?;
    let max_length = match field {
        "title" => 200,
        "goal" => 4_096,
        _ => 16_384,
    };
    let after = normalized_bounded_code_points(object.get("after"), max_length)?;
    (before != after).then_some(index)
}

pub(crate) fn is_roadmap_phase_edit_draft(
    object: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    if !has_exact_keys(object, &ROADMAP_PHASE_EDIT_DRAFT_KEYS)
        || object.get("kind").and_then(serde_json::Value::as_str) != Some("edit")
        || !matches!(
            object.get("status").and_then(serde_json::Value::as_str),
            Some("pending" | "stale")
        )
        || normalized_bounded_code_points(object.get("id"), 512).is_none()
        || normalized_bounded_code_points(object.get("projectKey"), 4_096).is_none()
        || !is_non_negative_integer(object.get("basedOnRevision"))
        || !is_roadmap_timestamp(object.get("createdAt"))
        || normalized_bounded_code_points(object.get("createdBySessionId"), 512).is_none()
        || normalized_bounded_code_points(object.get("summary"), 4_096).is_none()
        || normalized_bounded_code_points(object.get("phaseId"), 512).is_none()
        || roadmap_edit_before_string(object.get("phaseTitle")).is_none()
        || !is_roadmap_timestamp(object.get("basedOnUpdatedAt"))
    {
        return false;
    }
    let Some(changes) = object.get("changes").and_then(serde_json::Value::as_array) else {
        return false;
    };
    if !(1..=ROADMAP_PHASE_EDIT_FIELDS.len()).contains(&changes.len()) {
        return false;
    }
    let mut previous: Option<usize> = None;
    for change in changes {
        let Some(index) = roadmap_edit_field_change(change) else {
            return false;
        };
        if previous.is_some_and(|previous| index <= previous) {
            return false;
        }
        previous = Some(index);
    }
    true
}

pub(crate) fn is_roadmap_phase_draft(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.contains_key("kind") {
        return match object.get("kind").and_then(serde_json::Value::as_str) {
            Some("move") => is_roadmap_phase_move_draft(object),
            _ => is_roadmap_phase_edit_draft(object),
        };
    }
    if !has_required_and_optional_keys(
        object,
        &ROADMAP_PHASE_DRAFT_KEYS,
        &ROADMAP_PHASE_DRAFT_OPTIONAL_KEYS,
    ) || !matches!(
        object.get("status").and_then(serde_json::Value::as_str),
        Some("pending" | "stale")
    ) || normalized_bounded_code_points(object.get("id"), 512).is_none()
        || normalized_bounded_code_points(object.get("projectKey"), 4_096).is_none()
        || !is_non_negative_integer(object.get("basedOnRevision"))
        || !object
            .get("createdAt")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).is_ok())
        || normalized_bounded_code_points(object.get("createdBySessionId"), 512).is_none()
        || normalized_bounded_code_points(object.get("summary"), 4_096).is_none()
    {
        return false;
    }
    match object.get("sourcesNotCited") {
        None | Some(serde_json::Value::Null) => {}
        value => {
            if normalized_bounded_code_points(
                value,
                ROADMAP_PHASE_DRAFT_SOURCES_NOT_CITED_MAX_LENGTH,
            )
            .is_none()
            {
                return false;
            }
        }
    }

    let Some(phases) = object.get("phases").and_then(serde_json::Value::as_array) else {
        return false;
    };
    if !(1..=ROADMAP_PROPOSED_PHASES_MAX_ITEMS).contains(&phases.len()) {
        return false;
    }

    let Some(references) = roadmap_reference_array(object.get("references")) else {
        return false;
    };
    if references.len() > ROADMAP_DRAFT_REFERENCES_MAX_ITEMS {
        return false;
    }
    let mut reference_ids = HashSet::new();
    let mut identities = HashSet::new();
    for reference in references {
        let Some((id, identity)) = roadmap_draft_reference(reference) else {
            return false;
        };
        if !reference_ids.insert(id) || !identities.insert(identity) {
            return false;
        }
    }
    let mut phase_ids = HashSet::new();
    let mut linked_ids = HashSet::new();
    let mut placements: Vec<(String, Option<String>)> = Vec::with_capacity(phases.len());
    for phase in phases {
        let Some((phase_id, insert_before)) = is_roadmap_draft_phase(phase) else {
            return false;
        };
        if !phase_ids.insert(phase_id.clone()) {
            return false;
        }
        placements.push((phase_id, insert_before));
        let Some(links) = roadmap_reference_array(phase.get("referenceIds")) else {
            return false;
        };
        if links.len() > ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS {
            return false;
        }
        let mut seen = HashSet::new();
        for link in links {
            let Some(id) = normalized_bounded_code_points(Some(link), 128) else {
                return false;
            };
            if !reference_ids.contains(&id) || !seen.insert(id.clone()) {
                return false;
            }
            linked_ids.insert(id);
        }
    }
    linked_ids == reference_ids
        && is_roadmap_insertion_preview(object.get("orderPreview"), &placements)
}

pub(crate) const ROADMAP_PHASE_ORDER_PREVIEW_MAX_ITEMS: usize = 1_000;

/// Mirrors gg-core `validateOrderEntries`: exact keys, unique bounded IDs, loose display titles.
pub(crate) fn roadmap_order_entry_ids(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let entries = value?.as_array()?;
    if entries.len() > ROADMAP_PHASE_ORDER_PREVIEW_MAX_ITEMS {
        return None;
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry.as_object()?;
        if !has_exact_keys(object, &["phaseId", "title"]) {
            return None;
        }
        let id = normalized_bounded_code_points(object.get("phaseId"), 512)?;
        roadmap_edit_before_string(object.get("title"))?;
        if !seen.insert(id.clone()) {
            return None;
        }
        ids.push(id);
    }
    Some(ids)
}

pub(crate) fn roadmap_order_preview_ids(
    value: Option<&serde_json::Value>,
) -> Option<(Vec<String>, Vec<String>)> {
    let object = value?.as_object()?;
    if !has_exact_keys(object, &["before", "after"]) {
        return None;
    }
    Some((
        roadmap_order_entry_ids(object.get("before"))?,
        roadmap_order_entry_ids(object.get("after"))?,
    ))
}

/// Mirrors gg-core create-draft validation: a preview exists exactly when a phase is inserted,
/// and `after` is `before` with each new phase placed before its target (or appended).
pub(crate) fn is_roadmap_insertion_preview(
    value: Option<&serde_json::Value>,
    placements: &[(String, Option<String>)],
) -> bool {
    let inserts = placements.iter().any(|(_, target)| target.is_some());
    let Some(value) = value else {
        return !inserts;
    };
    if !inserts {
        return false;
    }
    let Some((before, after)) = roadmap_order_preview_ids(Some(value)) else {
        return false;
    };
    if placements.iter().any(|(id, target)| {
        before.contains(id)
            || target
                .as_ref()
                .is_some_and(|target| !before.contains(target))
    }) {
        return false;
    }
    let mut expected = Vec::with_capacity(before.len() + placements.len());
    for existing in &before {
        expected.extend(
            placements
                .iter()
                .filter(|(_, target)| target.as_ref() == Some(existing))
                .map(|(id, _)| id.clone()),
        );
        expected.push(existing.clone());
    }
    expected.extend(
        placements
            .iter()
            .filter(|(_, target)| target.is_none())
            .map(|(id, _)| id.clone()),
    );
    expected == after
}

pub(crate) const ROADMAP_PHASE_MOVE_DRAFT_KEYS: [&str; 14] = [
    "kind",
    "id",
    "projectKey",
    "basedOnRevision",
    "createdAt",
    "createdBySessionId",
    "summary",
    "phaseId",
    "phaseTitle",
    "position",
    "targetPhaseId",
    "targetPhaseTitle",
    "orderPreview",
    "status",
];

/// Mirrors gg-core `validateRoadmapPhaseMoveDraft`.
pub(crate) fn is_roadmap_phase_move_draft(
    object: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    if !has_exact_keys(object, &ROADMAP_PHASE_MOVE_DRAFT_KEYS)
        || object.get("kind").and_then(serde_json::Value::as_str) != Some("move")
        || !matches!(
            object.get("status").and_then(serde_json::Value::as_str),
            Some("pending" | "stale")
        )
        || normalized_bounded_code_points(object.get("id"), 512).is_none()
        || normalized_bounded_code_points(object.get("projectKey"), 4_096).is_none()
        || !is_non_negative_integer(object.get("basedOnRevision"))
        || !is_roadmap_timestamp(object.get("createdAt"))
        || normalized_bounded_code_points(object.get("createdBySessionId"), 512).is_none()
        || normalized_bounded_code_points(object.get("summary"), 4_096).is_none()
        || roadmap_edit_before_string(object.get("phaseTitle")).is_none()
        || roadmap_edit_before_string(object.get("targetPhaseTitle")).is_none()
    {
        return false;
    }
    let Some(position) = object
        .get("position")
        .and_then(serde_json::Value::as_str)
        .filter(|position| matches!(*position, "before" | "after"))
    else {
        return false;
    };
    let (Some(phase_id), Some(target_id)) = (
        normalized_bounded_code_points(object.get("phaseId"), 512),
        normalized_bounded_code_points(object.get("targetPhaseId"), 512),
    ) else {
        return false;
    };
    if phase_id == target_id {
        return false;
    }
    let Some((before, after)) = roadmap_order_preview_ids(object.get("orderPreview")) else {
        return false;
    };
    let mut expected: Vec<String> = before
        .iter()
        .filter(|id| **id != phase_id)
        .cloned()
        .collect();
    if expected.len() + 1 != before.len() {
        return false;
    }
    let Some(target_index) = expected.iter().position(|id| *id == target_id) else {
        return false;
    };
    let insert_at = if position == "before" {
        target_index
    } else {
        target_index + 1
    };
    expected.insert(insert_at, phase_id);
    expected == after && after != before
}

pub(crate) fn is_roadmap_phase_draft_get_outcome(value: &serde_json::Value, outcome: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    outcome == "ok"
        && has_exact_keys(object, &["status", "draft"])
        && object.get("status").and_then(serde_json::Value::as_str) == Some("ok")
        && object
            .get("draft")
            .is_some_and(|draft| draft.is_null() || is_roadmap_phase_draft(draft))
}

pub(crate) fn has_decision(value: &serde_json::Value) -> bool {
    matches!(
        value.get("decision").and_then(serde_json::Value::as_str),
        Some("approved" | "rejected")
    )
}

pub(crate) fn is_roadmap_phase_draft_approval_outcome(
    value: &serde_json::Value,
    outcome: &str,
) -> bool {
    match outcome {
        "created" => {
            is_non_negative_integer(value.get("revision"))
                && value
                    .get("phaseIds")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|ids| {
                        !ids.is_empty()
                            && ids
                                .iter()
                                .all(|id| id.as_str().is_some_and(|id| !id.is_empty()))
                    })
        }
        "edited" | "moved" => {
            is_non_negative_integer(value.get("revision"))
                && is_non_empty_string(value.get("phaseId"))
        }
        "phase-changed" => is_non_empty_string(value.get("phaseId")),
        "phase-not-editable" => {
            is_non_empty_string(value.get("phaseId"))
                && matches!(
                    value.get("reason").and_then(serde_json::Value::as_str),
                    Some("missing" | "deleted" | "done" | "archived")
                )
        }
        "already-decided" => has_decision(value),
        "stale-revision" => {
            is_non_negative_integer(value.get("expectedRevision"))
                && is_non_negative_integer(value.get("currentRevision"))
        }
        "invalid-proposal" | "storage-failed" => is_non_empty_string(value.get("message")),
        "proposal-not-found"
        | "proposal-project-mismatch"
        | "reconciliation-in-progress"
        | "notes-missing"
        | "notes-corrupt" => true,
        _ => false,
    }
}

pub(crate) fn is_roadmap_phase_draft_rejection_outcome(
    value: &serde_json::Value,
    outcome: &str,
) -> bool {
    match outcome {
        "rejected" | "proposal-not-found" | "proposal-project-mismatch" => true,
        "already-decided" => has_decision(value),
        _ => false,
    }
}

pub(crate) fn normalize_roadmap_phase_draft_response(
    status: reqwest::StatusCode,
    body: &str,
    kind: RoadmapPhaseDraftResponseKind,
) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid roadmap phase-draft response".to_string())?;
    let outcome = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let typed = match kind {
        RoadmapPhaseDraftResponseKind::Get => is_roadmap_phase_draft_get_outcome(&value, outcome),
        RoadmapPhaseDraftResponseKind::Approve => {
            is_roadmap_phase_draft_approval_outcome(&value, outcome)
        }
        RoadmapPhaseDraftResponseKind::Reject => {
            is_roadmap_phase_draft_rejection_outcome(&value, outcome)
        }
    };
    if typed {
        Ok(value)
    } else if status.is_success() {
        Err("invalid roadmap phase-draft response".to_string())
    } else {
        Err(sidecar_error_text(status, body))
    }
}

pub(crate) const ROADMAP_DRAFT_FEEDBACK_MAX_CHARS: usize = 4_096;

pub(crate) const ROADMAP_DRAFT_AUDIT_FIELD_MAX_CHARS: usize = 128;

pub(crate) fn normalize_roadmap_draft_feedback(
    feedback: Option<String>,
) -> Result<Option<String>, String> {
    let Some(feedback) = feedback else {
        return Ok(None);
    };
    let normalized = feedback.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim().to_string();
    let length = normalized.chars().count();
    if length == 0 {
        return Ok(None);
    }
    if length > ROADMAP_DRAFT_FEEDBACK_MAX_CHARS {
        return Err(format!(
            "feedback must contain at most {ROADMAP_DRAFT_FEEDBACK_MAX_CHARS} normalized characters"
        ));
    }
    Ok(Some(normalized))
}

pub(crate) fn bounded_roadmap_draft_audit_field(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{FFFD}'
            } else {
                character
            }
        })
        .take(ROADMAP_DRAFT_AUDIT_FIELD_MAX_CHARS)
        .collect()
}

pub(crate) fn audit_roadmap_phase_draft_proxy(
    action: &str,
    pane_id: &str,
    draft_id: Option<&str>,
    http_status: reqwest::StatusCode,
    result: &Result<serde_json::Value, String>,
) {
    let outcome = result
        .as_ref()
        .ok()
        .and_then(|value| value.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("invalid-response");
    log::info!(
        "roadmap_phase_draft_proxy action={} pane_id={} draft_id={} http_status={} authenticated=true outcome={}",
        bounded_roadmap_draft_audit_field(action),
        bounded_roadmap_draft_audit_field(pane_id),
        bounded_roadmap_draft_audit_field(draft_id.unwrap_or("-")),
        http_status.as_u16(),
        bounded_roadmap_draft_audit_field(outcome),
    );
}

pub(crate) async fn roadmap_phase_draft_response(
    response: reqwest::Response,
    kind: RoadmapPhaseDraftResponseKind,
) -> (reqwest::StatusCode, Result<serde_json::Value, String>) {
    let status = response.status();
    let result = match response.text().await {
        Ok(body) => normalize_roadmap_phase_draft_response(status, &body, kind),
        Err(_) => Err("invalid roadmap phase-draft response".to_string()),
    };
    (status, result)
}

pub(crate) fn normalize_phase_start_response(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid phase-start response".to_string())?;
    let typed = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|candidate| matches!(candidate, "accepted" | "already-bound" | "failed"));
    if status.is_success() || typed {
        Ok(value)
    } else {
        Err(sidecar_error_text(status, body))
    }
}

#[cfg(feature = "native-smoke")]
pub(crate) fn audit_native_phase_start(
    pane_id: &str,
    phase_id: &str,
    status: reqwest::StatusCode,
    result: &Result<serde_json::Value, String>,
) {
    use std::io::Write as _;

    let Ok(path) = std::env::var("GG_PHASE21_NATIVE_SMOKE_AUDIT_FILE") else {
        return;
    };
    let outcome = match result {
        Ok(value) => serde_json::json!({ "response": value }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    let entry = serde_json::json!({
        "route": "agent_phase_start",
        "paneId": pane_id,
        "phaseId": phase_id,
        "httpStatus": status.as_u16(),
        "authenticated": true,
        "outcome": outcome,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{entry}");
    }
}

/// Proxy: atomically bind and start one Roadmap phase for the authenticated pane.
#[tauri::command]
pub(crate) async fn agent_phase_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    phase_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            phase_start_path(&phase_id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let result = normalize_phase_start_response(status, &body);
    #[cfg(feature = "native-smoke")]
    audit_native_phase_start(&pane_id, &phase_id, status, &result);
    result
}

/// Proxy: consume a durable human-confirmed Roadmap advancement checkpoint.
#[tauri::command]
pub(crate) async fn agent_phase_advancement_start(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    daemon: tauri::State<'_, Daemon>,
    checkpoint_id: String,
    next_phase_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let auth_token = daemon
        .auth_token
        .lock_or_recover()
        .clone()
        .ok_or("agent daemon authentication is not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            phase_advancement_start_path(&checkpoint_id)
        ))
        .header("x-gg-session", &gg_sid)
        .header("x-gg-daemon-token", auth_token)
        .json(&phase_advancement_start_body(&next_phase_id))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    normalize_phase_start_response(status, &body)
}

/// Proxy: resolve a Roadmap phase's bound live session, stop its operation, then update Notes.
#[tauri::command]
pub(crate) async fn agent_phase_cancel(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    phase_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            phase_cancel_path(&phase_id)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_sidecar_json_response(status, &body)
}

/// Proxy: load the authenticated pane's current pending Roadmap phase draft.
#[tauri::command]
pub(crate) async fn agent_roadmap_phase_draft_get(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .get(format!(
            "{}/roadmap/phase-drafts/pending",
            sidecar_base(port)
        ))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let (status, result) =
        roadmap_phase_draft_response(response, RoadmapPhaseDraftResponseKind::Get).await;
    audit_roadmap_phase_draft_proxy("get", &pane_id, None, status, &result);
    result
}

/// Proxy: approve exactly the stored Roadmap phase draft, without accepting phase content.
#[tauri::command]
pub(crate) async fn agent_roadmap_phase_draft_approve(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    draft_id: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            roadmap_phase_draft_approve_path(&draft_id)
        ))
        .header("x-gg-session", &gg_sid)
        // Deliberately no JSON body: approval can only identify an existing draft.
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let (status, result) =
        roadmap_phase_draft_response(response, RoadmapPhaseDraftResponseKind::Approve).await;
    audit_roadmap_phase_draft_proxy("approve", &pane_id, Some(&draft_id), status, &result);
    result
}

/// Proxy: reject exactly the stored Roadmap phase draft with optional bounded feedback.
#[tauri::command]
pub(crate) async fn agent_roadmap_phase_draft_reject(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    draft_id: String,
    feedback: Option<String>,
) -> Result<serde_json::Value, String> {
    let feedback = normalize_roadmap_draft_feedback(feedback)?;
    let body = match feedback {
        Some(feedback) => serde_json::json!({ "feedback": feedback }),
        None => serde_json::json!({}),
    };
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}{}",
            sidecar_base(port),
            roadmap_phase_draft_reject_path(&draft_id)
        ))
        .header("x-gg-session", &gg_sid)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let (status, result) =
        roadmap_phase_draft_response(response, RoadmapPhaseDraftResponseKind::Reject).await;
    audit_roadmap_phase_draft_proxy("reject", &pane_id, Some(&draft_id), status, &result);
    result
}

/// Proxy: create the pane's project Notes repository only when absent.
#[tauri::command]
pub(crate) async fn agent_notes_migrate(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/notes/migrate", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "document": document }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

/// Proxy: persist a typed resolution for one Roadmap blocker report.
#[tauri::command]
pub(crate) async fn agent_notes_resolve_roadmap_blocker(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    resolution_id: String,
    phase_id: String,
    blocker_update_id: String,
    expected_revision: u64,
    expected_session: serde_json::Value,
    resolver: String,
    timestamp: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!(
            "{}/notes/roadmap/blocker-resolution",
            sidecar_base(port)
        ))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "resolutionId": resolution_id,
            "phaseId": phase_id,
            "blockerUpdateId": blocker_update_id,
            "expectedRevision": expected_revision,
            "expectedSession": expected_session,
            "resolver": resolver,
            "timestamp": timestamp,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

/// Proxy: compare-and-swap the pane's project Notes document.
#[tauri::command]
pub(crate) async fn agent_notes_save(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    expected_revision: u64,
    document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .put(format!("{}/notes", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "expectedRevision": expected_revision,
            "document": document,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    notes_response(response).await
}

pub(crate) fn normalize_reminder_response(
    status: reqwest::StatusCode,
    body: &str,
    allowed_statuses: &[&str],
) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|_| "invalid reminder response".to_string())?;
    let typed_status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .filter(|candidate| allowed_statuses.contains(candidate));
    if typed_status.is_some() {
        return Ok(value);
    }
    Err(if status.is_success() {
        "invalid reminder response".to_string()
    } else {
        sidecar_error_text(status, body)
    })
}

pub(crate) async fn reminder_response(
    response: reqwest::Response,
    allowed_statuses: &[&str],
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    normalize_reminder_response(status, &body, allowed_statuses)
}

#[tauri::command]
pub(crate) async fn agent_reminder_reserve(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    focused: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/reserve", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "focused": focused }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "reserved",
            "deferred",
            "leased",
            "none",
            "already-delivered",
            "missing",
            "corrupt",
        ],
    )
    .await
}

#[tauri::command]
pub(crate) async fn agent_reminder_claim(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    lease_token: String,
    channel: String,
    permission: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/claim", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "leaseToken": lease_token,
            "channel": channel,
            "permission": permission,
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "ok",
            "phase-not-found",
            "phase-inactive",
            "phase-archived",
            "reminder-not-found",
            "stale-occurrence",
            "not-due",
            "already-delivered",
            "invalid-lease",
            "expired-lease",
            "wrong-session",
            "invalid",
            "missing",
            "corrupt",
        ],
    )
    .await
}

#[tauri::command]
pub(crate) async fn agent_reminder_release(
    webview: WebviewWindow,
    pane_id: String,
    client: tauri::State<'_, reqwest::Client>,
    lease_token: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = pane_session_for(&webview, &pane_id).ok_or("session not ready")?;
    let response = client
        .post(format!("{}/reminders/release", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "leaseToken": lease_token }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    reminder_response(
        response,
        &[
            "released",
            "invalid-lease",
            "expired-lease",
            "wrong-session",
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roadmap_phase_binding_uses_current_pane_route_without_destination_fields() {
        let request = serde_json::json!({
            "version": 1,
            "action": "bind-current",
            "phaseId": "phase-1",
            "expectedProjectKey": "c:/work/project",
            "expectedRevision": 1,
            "expectedPreviousSession": null,
            "operationId": "operation-1",
            "confirmRebind": false
        });

        assert_eq!("/notes/roadmap/phase-binding", NOTES_PHASE_BINDING_PATH);
        assert!(request.get("destinationSession").is_none());
    }

    fn roadmap_proxy_result(
        status: reqwest::StatusCode,
        content_type: &str,
        body: &str,
        kind: RoadmapTypedResponseKind,
    ) -> Result<serde_json::Value, String> {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = body.to_string();
        let response_content_type = content_type.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).unwrap();
            let response = format!(
                "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                response_content_type,
                response_body.len(),
                response_body,
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = tauri::async_runtime::block_on(async {
            let response = http_client_builder()
                .build()
                .unwrap()
                .get(format!("http://{address}/roadmap"))
                .send()
                .await
                .unwrap();
            roadmap_typed_response(response, kind).await
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn roadmap_documented_typed_outcomes_cross_the_native_boundary() {
        let session = serde_json::json!({ "sessionId": "session-1", "sessionPath": null });
        let cases = [
            (
                reqwest::StatusCode::OK,
                serde_json::json!({
                    "status": "already-bound",
                    "revision": 7,
                    "phaseId": "phase-1",
                    "session": session
                }),
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                serde_json::json!({ "status": "phase-not-found" }),
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                serde_json::json!({ "status": "stale-revision", "revision": 8 }),
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::OK,
                serde_json::json!({
                    "status": "reconciled",
                    "revision": 8,
                    "phaseId": "phase-1",
                    "preservedStepIds": ["step-1"],
                    "revalidationStepIds": ["step-2"],
                    "revalidationEvidenceCount": 1,
                    "reconciledAt": "2026-08-31T10:05:00.000Z"
                }),
                RoadmapTypedResponseKind::PhaseExecutionReconciliation,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                serde_json::json!({ "status": "workspace-mismatch" }),
                RoadmapTypedResponseKind::PhaseExecutionReconciliation,
            ),
        ];

        for (status, body, kind) in cases {
            assert_eq!(
                roadmap_proxy_result(
                    status,
                    "application/json; charset=utf-8",
                    &body.to_string(),
                    kind
                ),
                Ok(body)
            );
        }
    }

    #[test]
    fn roadmap_auth_malformed_content_type_and_undocumented_responses_reject() {
        let cases = [
            (
                reqwest::StatusCode::UNAUTHORIZED,
                "application/json",
                r#"{"status":"stale-revision","revision":8}"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                "application/json",
                r#"{"status":"stale-revision"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                "text/plain",
                r#"{"status":"stale-revision","revision":8}"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                "application/json",
                r#"{"status":"stale-revision","revision":8,"extra":true}"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                "application/json",
                r#"{"status":"stale-revision","revision":8}"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                "application/json",
                r#"{"status":"corrupt","primary":"malformed-json","backup":null}"#,
                RoadmapTypedResponseKind::PhaseBinding,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                "application/json",
                r#"{"status":"workspace-mismatch","detail":"unexpected"}"#,
                RoadmapTypedResponseKind::PhaseExecutionReconciliation,
            ),
        ];

        for (status, content_type, body, kind) in cases {
            assert!(roadmap_proxy_result(status, content_type, body, kind).is_err());
        }
    }

    #[test]
    fn roadmap_oversized_responses_reject() {
        let body = "x".repeat(ROADMAP_TYPED_RESPONSE_MAX_BYTES + 1);
        assert!(roadmap_proxy_result(
            reqwest::StatusCode::OK,
            "application/json",
            &body,
            RoadmapTypedResponseKind::PhaseBinding,
        )
        .is_err());
    }

    #[test]
    fn roadmap_transport_failures_reject() {
        let result = tauri::async_runtime::block_on(roadmap_typed_request(
            http_client_builder()
                .build()
                .unwrap()
                .get("http://127.0.0.1:0/roadmap")
                .timeout(std::time::Duration::from_secs(1)),
            RoadmapTypedResponseKind::PhaseBinding,
        ));
        assert!(result.is_err());
    }

    #[test]
    fn phase_start_proxy_encodes_ids_and_preserves_typed_outcomes() {
        assert_eq!(
            phase_start_path("phase/21 review"),
            "/phases/phase%2F21%20review/start"
        );
        assert_eq!(
            phase_cancel_path("phase/21 review"),
            "/phases/phase%2F21%20review/cancel"
        );
        assert_eq!(
            phase_advancement_start_path("checkpoint/opaque?two"),
            "/notes/roadmap/advancement/checkpoint%2Fopaque%3Ftwo/start"
        );
        assert_eq!(
            phase_advancement_start_body("phase/next"),
            serde_json::json!({
                "action": "start-next-phase",
                "nextPhaseId": "phase/next",
            })
        );
        for (status, body) in [
            (
                reqwest::StatusCode::ACCEPTED,
                r#"{"status":"accepted","operationId":"op-1","session":{"sessionId":"s","sessionPath":"/s"},"packageTokenCount":42}"#,
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"status":"failed","code":"session-busy","operationId":null,"message":"Wait"}"#,
            ),
        ] {
            let parsed = normalize_phase_start_response(status, body).unwrap();
            assert!(matches!(
                parsed.get("status").and_then(serde_json::Value::as_str),
                Some("accepted" | "failed")
            ));
        }
    }

    #[test]
    fn phase_start_proxy_rejects_transport_ambiguity() {
        assert_eq!(
            normalize_phase_start_response(reqwest::StatusCode::BAD_GATEWAY, "not json"),
            Err("invalid phase-start response".to_string())
        );
        assert_eq!(
            normalize_phase_start_response(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":"unknown"}"#,
            ),
            Err("unknown".to_string())
        );
    }

    #[test]
    fn roadmap_phase_draft_proxy_encodes_opaque_draft_ids() {
        assert_eq!(
            roadmap_phase_draft_approve_path("draft/one review?雪"),
            "/roadmap/phase-drafts/draft%2Fone%20review%3F%E9%9B%AA/approve"
        );
        assert_eq!(
            roadmap_phase_draft_reject_path("draft/one review?雪"),
            "/roadmap/phase-drafts/draft%2Fone%20review%3F%E9%9B%AA/reject"
        );
    }

    #[test]
    fn roadmap_phase_draft_feedback_is_normalized_and_bounded() {
        assert_eq!(
            normalize_roadmap_draft_feedback(Some("  first\r\nsecond\r  ".to_string())),
            Ok(Some("first\nsecond".to_string()))
        );
        assert_eq!(normalize_roadmap_draft_feedback(None), Ok(None));
        assert_eq!(
            normalize_roadmap_draft_feedback(Some("  ".to_string())),
            Ok(None)
        );
        assert!(normalize_roadmap_draft_feedback(Some(
            "x".repeat(ROADMAP_DRAFT_FEEDBACK_MAX_CHARS + 1)
        ))
        .is_err());

        let audited = bounded_roadmap_draft_audit_field(&format!(
            "{}\nproposal content",
            "x".repeat(ROADMAP_DRAFT_AUDIT_FIELD_MAX_CHARS)
        ));
        assert_eq!(audited.chars().count(), ROADMAP_DRAFT_AUDIT_FIELD_MAX_CHARS);
        assert!(!audited.contains("proposal content"));
        assert!(!audited.contains('\n'));
    }

    #[test]
    fn roadmap_phase_draft_proxy_preserves_typed_http_outcomes() {
        let cases = [
            (
                reqwest::StatusCode::OK,
                r#"{"status":"created","revision":2,"phaseIds":["phase-1"]}"#,
                "created",
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                r#"{"status":"proposal-not-found"}"#,
                "proposal-not-found",
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"status":"stale-revision","expectedRevision":1,"currentRevision":2}"#,
                "stale-revision",
            ),
            (
                reqwest::StatusCode::UNPROCESSABLE_ENTITY,
                r#"{"status":"invalid-proposal","message":"invalid phase"}"#,
                "invalid-proposal",
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"status":"storage-failed","message":"write failed"}"#,
                "storage-failed",
            ),
        ];

        for (http_status, body, outcome) in cases {
            let value = normalize_roadmap_phase_draft_response(
                http_status,
                body,
                RoadmapPhaseDraftResponseKind::Approve,
            )
            .unwrap();
            assert_eq!(
                value.get("status").and_then(serde_json::Value::as_str),
                Some(outcome)
            );
        }

        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"status":"proposal-not-found"}"#,
            RoadmapPhaseDraftResponseKind::Get,
        )
        .is_err());

        let conflict = normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::CONFLICT,
            r#"{"status":"already-decided","decision":"approved"}"#,
            RoadmapPhaseDraftResponseKind::Reject,
        )
        .unwrap();
        assert_eq!(conflict["status"], "already-decided");
    }

    #[test]
    fn roadmap_phase_draft_proxy_validates_success_and_malformed_bodies() {
        let pending = serde_json::json!({
            "status": "ok",
            "draft": {
                "id": "draft-1",
                "projectKey": "/work/project",
                "basedOnRevision": 1,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "createdBySessionId": "session-1",
                "summary": "Two phases",
                "phases": [{
                    "phaseId": "phase-1",
                    "title": "Implement validation",
                    "goal": "Keep the native boundary aligned with the shared contract.",
                    "doneWhen": ["Complete drafts pass", "Malformed drafts fail"],
                    "sourcePrompt": "Validate pending Roadmap phase drafts.",
                }],
                "status": "pending",
            },
        });
        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            &pending.to_string(),
            RoadmapPhaseDraftResponseKind::Get,
        )
        .is_ok());
        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            r#"{"status":"ok","draft":null}"#,
            RoadmapPhaseDraftResponseKind::Get,
        )
        .is_ok());

        let mut incomplete_phase = pending.clone();
        incomplete_phase["draft"]["phases"][0] = serde_json::json!({ "phaseId": "phase-1" });

        let mut extra_envelope_field = pending.clone();
        extra_envelope_field["extra"] = serde_json::json!(true);

        let mut extra_draft_field = pending.clone();
        extra_draft_field["draft"]["extra"] = serde_json::json!(true);

        let mut extra_phase_field = pending.clone();
        extra_phase_field["draft"]["phases"][0]["extra"] = serde_json::json!(true);

        let mut invalid_timestamp = pending.clone();
        invalid_timestamp["draft"]["createdAt"] = serde_json::json!("not-a-timestamp");

        let mut duplicate_phase_ids = pending.clone();
        let duplicate_phase = duplicate_phase_ids["draft"]["phases"][0].clone();
        duplicate_phase_ids["draft"]["phases"]
            .as_array_mut()
            .unwrap()
            .push(duplicate_phase);

        let mut blank_normalized_text = pending.clone();
        blank_normalized_text["draft"]["phases"][0]["title"] = serde_json::json!(" \r\n ");

        let mut oversized_summary = pending.clone();
        oversized_summary["draft"]["summary"] = serde_json::json!("x".repeat(4_097));

        let mut duplicate_normalized_criteria = pending.clone();
        duplicate_normalized_criteria["draft"]["phases"][0]["doneWhen"] =
            serde_json::json!(["criterion", " criterion "]);

        let direct_draft = pending["draft"].clone();
        for malformed in [
            incomplete_phase,
            extra_envelope_field,
            extra_draft_field,
            extra_phase_field,
            invalid_timestamp,
            duplicate_phase_ids,
            blank_normalized_text,
            oversized_summary,
            duplicate_normalized_criteria,
            direct_draft,
        ] {
            assert_eq!(
                normalize_roadmap_phase_draft_response(
                    reqwest::StatusCode::OK,
                    &malformed.to_string(),
                    RoadmapPhaseDraftResponseKind::Get,
                ),
                Err("invalid roadmap phase-draft response".to_string())
            );
        }

        for (status, body) in [
            (reqwest::StatusCode::OK, "not json"),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                "<html>failed</html>",
            ),
            (reqwest::StatusCode::OK, r#"{"status":"created"}"#),
        ] {
            assert_eq!(
                normalize_roadmap_phase_draft_response(
                    status,
                    body,
                    RoadmapPhaseDraftResponseKind::Approve,
                ),
                Err("invalid roadmap phase-draft response".to_string())
            );
        }
    }

    fn pending_roadmap_edit_draft() -> serde_json::Value {
        serde_json::json!({
            "status": "ok",
            "draft": {
                "kind": "edit",
                "id": "draft-edit-1",
                "projectKey": "/work/project",
                "basedOnRevision": 4,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "createdBySessionId": "session-1",
                "summary": "Clarify the validation phase",
                "phaseId": "phase-1",
                "phaseTitle": "Implement validation",
                "basedOnUpdatedAt": "2025-12-31T00:00:00.000Z",
                "changes": [
                    { "field": "goal", "before": "", "after": "Keep the native boundary aligned." },
                    {
                        "field": "doneWhen",
                        "before": ["Complete drafts pass"],
                        "after": ["Complete drafts pass", "Edit drafts pass"],
                    },
                ],
                "status": "pending",
            },
        })
    }

    #[test]
    fn roadmap_phase_edit_draft_proxy_accepts_well_formed_edit_drafts() {
        let pending = pending_roadmap_edit_draft();
        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            &pending.to_string(),
            RoadmapPhaseDraftResponseKind::Get,
        )
        .is_ok());

        let mut stale = pending.clone();
        stale["draft"]["status"] = serde_json::json!("stale");
        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            &stale.to_string(),
            RoadmapPhaseDraftResponseKind::Get,
        )
        .is_ok());
    }

    #[test]
    fn roadmap_phase_edit_draft_proxy_rejects_malformed_edit_drafts() {
        let pending = pending_roadmap_edit_draft();
        let mutate = |apply: &dyn Fn(&mut serde_json::Value)| {
            let mut draft = pending.clone();
            apply(&mut draft["draft"]);
            draft
        };
        let malformed = [
            mutate(&|draft| draft["kind"] = serde_json::json!("create")),
            mutate(&|draft| draft["extra"] = serde_json::json!(true)),
            mutate(&|draft| {
                draft.as_object_mut().unwrap().remove("phaseTitle");
            }),
            mutate(&|draft| draft["phases"] = serde_json::json!([])),
            mutate(&|draft| draft["basedOnUpdatedAt"] = serde_json::json!("yesterday")),
            mutate(&|draft| draft["changes"] = serde_json::json!([])),
            mutate(&|draft| draft["changes"][0]["field"] = serde_json::json!("status")),
            mutate(&|draft| draft["changes"][0]["extra"] = serde_json::json!(true)),
            // `after` must change the field.
            mutate(&|draft| {
                draft["changes"][0] =
                    serde_json::json!({ "field": "goal", "before": "Same", "after": " Same " })
            }),
            mutate(&|draft| {
                draft["changes"][1]["after"] = serde_json::json!(["Complete drafts pass"])
            }),
            // `after` uses add-draft bounds.
            mutate(&|draft| draft["changes"][0]["after"] = serde_json::json!("x".repeat(4_097))),
            mutate(&|draft| draft["changes"][0]["after"] = serde_json::json!(" \n ")),
            mutate(&|draft| draft["changes"][1]["after"] = serde_json::json!([])),
            mutate(&|draft| draft["changes"][1]["after"] = serde_json::json!(["a", " a "])),
            // `before` is loose but bounded.
            mutate(&|draft| draft["changes"][0]["before"] = serde_json::json!("x".repeat(65_537))),
            mutate(&|draft| draft["changes"][1]["before"] = serde_json::json!("not a list")),
            // Fields are unique and canonically ordered.
            mutate(&|draft| {
                let changes = draft["changes"].as_array_mut().unwrap();
                changes.reverse();
            }),
            mutate(&|draft| {
                let first = draft["changes"][0].clone();
                draft["changes"][1] = first;
            }),
        ];
        for value in malformed {
            assert_eq!(
                normalize_roadmap_phase_draft_response(
                    reqwest::StatusCode::OK,
                    &value.to_string(),
                    RoadmapPhaseDraftResponseKind::Get,
                ),
                Err("invalid roadmap phase-draft response".to_string()),
                "accepted malformed edit draft: {value}"
            );
        }
    }

    #[test]
    fn roadmap_phase_draft_proxy_bounds_text_by_code_points_like_gg_core() {
        // Astral characters are one code point but two UTF-16 units; gg-core counts code points.
        let get = |value: &serde_json::Value| {
            normalize_roadmap_phase_draft_response(
                reqwest::StatusCode::OK,
                &value.to_string(),
                RoadmapPhaseDraftResponseKind::Get,
            )
        };
        let invalid = Err("invalid roadmap phase-draft response".to_string());

        let edit_with_title = |title: String| {
            let mut draft = pending_roadmap_edit_draft();
            draft["draft"]["changes"] = serde_json::json!([
                { "field": "title", "before": "Implement validation", "after": title },
            ]);
            draft
        };
        assert!(get(&edit_with_title("😀".repeat(200))).is_ok());
        assert_eq!(get(&edit_with_title("😀".repeat(201))), invalid);

        let create_with_title = |title: String| {
            serde_json::json!({
                "status": "ok",
                "draft": {
                    "id": "draft-1",
                    "projectKey": "/work/project",
                    "basedOnRevision": 1,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "createdBySessionId": "session-1",
                    "summary": "One phase",
                    "phases": [{
                        "phaseId": "phase-1",
                        "title": title,
                        "goal": "Keep the native boundary aligned with the shared contract.",
                        "doneWhen": ["Astral titles hydrate"],
                        "sourcePrompt": "Validate pending Roadmap phase drafts.",
                    }],
                    "status": "pending",
                },
            })
        };
        assert!(get(&create_with_title("😀".repeat(200))).is_ok());
        assert_eq!(get(&create_with_title("😀".repeat(201))), invalid);
    }

    #[test]
    fn roadmap_phase_edit_draft_proxy_preserves_typed_edit_outcomes() {
        let cases = [
            (
                reqwest::StatusCode::OK,
                r#"{"status":"edited","revision":5,"phaseId":"phase-1"}"#,
                "edited",
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"status":"phase-changed","phaseId":"phase-1"}"#,
                "phase-changed",
            ),
            (
                reqwest::StatusCode::CONFLICT,
                r#"{"status":"phase-not-editable","phaseId":"phase-1","reason":"done"}"#,
                "phase-not-editable",
            ),
        ];
        for (http_status, body, outcome) in cases {
            let value = normalize_roadmap_phase_draft_response(
                http_status,
                body,
                RoadmapPhaseDraftResponseKind::Approve,
            )
            .unwrap();
            assert_eq!(value["status"], outcome);
        }

        for body in [
            r#"{"status":"edited","revision":5}"#,
            r#"{"status":"edited","revision":-1,"phaseId":"phase-1"}"#,
            r#"{"status":"phase-changed","phaseId":""}"#,
            r#"{"status":"phase-not-editable","phaseId":"phase-1","reason":"locked"}"#,
            r#"{"status":"phase-not-editable","phaseId":"phase-1"}"#,
        ] {
            assert_eq!(
                normalize_roadmap_phase_draft_response(
                    reqwest::StatusCode::OK,
                    body,
                    RoadmapPhaseDraftResponseKind::Approve,
                ),
                Err("invalid roadmap phase-draft response".to_string()),
                "accepted malformed outcome: {body}"
            );
        }
    }

    fn order_entries(ids: &[&str]) -> serde_json::Value {
        serde_json::Value::Array(
            ids.iter()
                .map(|id| serde_json::json!({ "phaseId": id, "title": format!("Phase {id}") }))
                .collect(),
        )
    }

    fn pending_roadmap_move_draft() -> serde_json::Value {
        serde_json::json!({
            "status": "ok",
            "draft": {
                "kind": "move",
                "id": "draft-move",
                "projectKey": "project-1",
                "basedOnRevision": 4,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "createdBySessionId": "session-1",
                "summary": "Do C before B",
                "phaseId": "c",
                "phaseTitle": "Phase c",
                "position": "before",
                "targetPhaseId": "b",
                "targetPhaseTitle": "Phase b",
                "orderPreview": {
                    "before": order_entries(&["a", "b", "c"]),
                    "after": order_entries(&["a", "c", "b"]),
                },
                "status": "pending",
            },
        })
    }

    fn get_draft(value: &serde_json::Value) -> Result<serde_json::Value, String> {
        normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            &value.to_string(),
            RoadmapPhaseDraftResponseKind::Get,
        )
    }

    #[test]
    fn roadmap_phase_move_draft_proxy_accepts_well_formed_and_rejects_malformed_moves() {
        let pending = pending_roadmap_move_draft();
        assert!(get_draft(&pending).is_ok());
        let mut after = pending.clone();
        after["draft"]["position"] = serde_json::json!("after");
        after["draft"]["phaseId"] = serde_json::json!("a");
        after["draft"]["targetPhaseId"] = serde_json::json!("b");
        after["draft"]["orderPreview"]["after"] = order_entries(&["b", "a", "c"]);
        assert!(get_draft(&after).is_ok());

        let mutate = |apply: &dyn Fn(&mut serde_json::Value)| {
            let mut draft = pending.clone();
            apply(&mut draft["draft"]);
            draft
        };
        for malformed in [
            mutate(&|draft| draft["extra"] = serde_json::json!(true)),
            mutate(&|draft| draft["position"] = serde_json::json!("above")),
            // Next to itself.
            mutate(&|draft| draft["targetPhaseId"] = serde_json::json!("c")),
            // `after` must be the before order with the phase moved.
            mutate(&|draft| draft["orderPreview"]["after"] = order_entries(&["c", "a", "b"])),
            mutate(&|draft| draft["orderPreview"]["after"] = order_entries(&["a", "b", "c"])),
            mutate(&|draft| draft["orderPreview"]["before"] = order_entries(&["a", "b", "b"])),
            mutate(&|draft| draft["targetPhaseId"] = serde_json::json!("missing")),
            mutate(&|draft| {
                draft.as_object_mut().unwrap().remove("orderPreview");
            }),
        ] {
            assert!(
                get_draft(&malformed).is_err(),
                "accepted malformed move: {malformed}"
            );
        }

        let moved = normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            r#"{"status":"moved","revision":5,"phaseId":"c"}"#,
            RoadmapPhaseDraftResponseKind::Approve,
        )
        .unwrap();
        assert_eq!(moved["status"], "moved");
        assert!(normalize_roadmap_phase_draft_response(
            reqwest::StatusCode::OK,
            r#"{"status":"moved","revision":5}"#,
            RoadmapPhaseDraftResponseKind::Approve,
        )
        .is_err());
    }

    #[test]
    fn roadmap_phase_create_draft_proxy_validates_inserted_phase_positions() {
        let phase = |id: &str, target: Option<&str>| {
            let mut phase = serde_json::json!({
                "phaseId": id, "title": format!("Phase {id}"), "goal": "Goal",
                "doneWhen": ["Done"], "sourcePrompt": "Prompt", "referenceIds": [],
            });
            if let Some(target) = target {
                phase["insertBeforePhaseId"] = serde_json::json!(target);
            }
            phase
        };
        let draft = |phases: serde_json::Value, preview: Option<serde_json::Value>| {
            let mut value = serde_json::json!({
                "status": "ok",
                "draft": {
                    "id": "draft-1", "projectKey": "project-1", "basedOnRevision": 1,
                    "createdAt": "2026-01-01T00:00:00.000Z", "createdBySessionId": "session-1",
                    "summary": "Insert", "references": [], "phases": phases,
                    "sourcesNotCited": null, "status": "pending",
                },
            });
            if let Some(preview) = preview {
                value["draft"]["orderPreview"] = preview;
            }
            value
        };
        let preview = |before: &[&str], after: &[&str]| serde_json::json!({ "before": order_entries(before), "after": order_entries(after) });
        // Legacy appends carry no preview.
        assert!(get_draft(&draft(serde_json::json!([phase("n", None)]), None)).is_ok());
        assert!(get_draft(&draft(
            serde_json::json!([
                phase("n1", Some("b")),
                phase("n2", Some("b")),
                phase("n3", None)
            ]),
            Some(preview(&["a", "b"], &["a", "n1", "n2", "b", "n3"])),
        ))
        .is_ok());
        for malformed in [
            draft(serde_json::json!([phase("n", Some("b"))]), None),
            draft(
                serde_json::json!([phase("n", None)]),
                Some(preview(&["a"], &["a", "n"])),
            ),
            draft(
                serde_json::json!([phase("n", Some("b"))]),
                Some(preview(&["a", "b"], &["n", "a", "b"])),
            ),
            draft(
                serde_json::json!([phase("n", Some("missing"))]),
                Some(preview(&["a", "b"], &["a", "b", "n"])),
            ),
            draft(
                serde_json::json!([phase("n", Some(""))]),
                Some(preview(&["a", "b"], &["a", "b", "n"])),
            ),
        ] {
            assert!(
                get_draft(&malformed).is_err(),
                "accepted malformed insert: {malformed}"
            );
        }
    }

    #[test]
    fn roadmap_phase_draft_proxy_validates_reference_bearing_daemon_payloads() {
        let pending = serde_json::json!({
            "status": "ok", "draft": {
                "id": "draft-1", "projectKey": "project-1", "basedOnRevision": 1,
                "createdAt": "2026-01-01T00:00:00.000Z", "createdBySessionId": "session-1",
                "summary": "Implement the referenced issue", "status": "pending",
                "references": [{
                    "id": "ref-1", "provider": "github", "tool": "get_issue",
                    "canonicalUrl": "https://github.com/example/project/issues/42",
                    "owner": "example", "repo": "project", "revision": null,
                    "path": null, "range": null, "issue": 42, "pullRequest": null,
                    "query": null, "anchor": null, "relevance": "Acceptance criteria"
                }],
                "phases": [{
                    "phaseId": "phase-1", "title": "Implement", "goal": "Resolve issue 42",
                    "doneWhen": ["Acceptance criteria pass"], "sourcePrompt": "Implement issue 42",
                    "referenceIds": ["ref-1"]
                }]
            }
        });
        let validate = |value: &serde_json::Value| {
            normalize_roadmap_phase_draft_response(
                reqwest::StatusCode::OK,
                &value.to_string(),
                RoadmapPhaseDraftResponseKind::Get,
            )
        };
        assert_eq!(validate(&pending).unwrap(), pending);
        let mut empty = pending.clone();
        empty["draft"]["references"] = serde_json::json!([]);
        empty["draft"]["phases"][0]["referenceIds"] = serde_json::json!([]);
        assert_eq!(validate(&empty).unwrap(), empty);
        empty["draft"].as_object_mut().unwrap().remove("references");
        empty["draft"]["phases"][0]
            .as_object_mut()
            .unwrap()
            .remove("referenceIds");
        assert!(validate(&empty).is_ok());
        let mut uncited = pending.clone();
        uncited["draft"]["sourcesNotCited"] = serde_json::Value::Null;
        assert_eq!(validate(&uncited).unwrap(), uncited);
        uncited["draft"]["sourcesNotCited"] = serde_json::json!("No external sources apply");
        assert_eq!(validate(&uncited).unwrap(), uncited);
        uncited["draft"]["sourcesNotCited"] = serde_json::json!("x".repeat(1_024));
        assert!(validate(&uncited).is_ok());
        let mut legacy_uncited = empty.clone();
        legacy_uncited["draft"]["sourcesNotCited"] = serde_json::Value::Null;
        assert!(validate(&legacy_uncited).is_ok());
        let with_references = |count: usize| {
            let mut draft = pending.clone();
            let template = pending["draft"]["references"][0].clone();
            let references: Vec<serde_json::Value> = (0..count)
                .map(|index| {
                    let mut reference = template.clone();
                    reference["id"] = serde_json::json!(format!("ref-{index}"));
                    reference["issue"] = serde_json::json!(index + 1);
                    reference["canonicalUrl"] = serde_json::json!(format!(
                        "https://github.com/example/project/issues/{}",
                        index + 1
                    ));
                    reference
                })
                .collect();
            draft["draft"]["phases"][0]["referenceIds"] =
                references.iter().map(|r| r["id"].clone()).collect();
            draft["draft"]["references"] = serde_json::Value::Array(references);
            draft
        };
        assert_eq!(ROADMAP_DRAFT_REFERENCES_MAX_ITEMS, 50);
        assert_eq!(ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS, 50);
        assert!(validate(&with_references(ROADMAP_DRAFT_REFERENCES_MAX_ITEMS)).is_ok());
        assert!(validate(&with_references(ROADMAP_DRAFT_REFERENCES_MAX_ITEMS + 1)).is_err());
        for replacement in [
            serde_json::json!(7),
            serde_json::json!(""),
            serde_json::json!("  \n "),
            serde_json::json!("x".repeat(1_025)),
        ] {
            uncited["draft"]["sourcesNotCited"] = replacement.clone();
            assert!(
                validate(&uncited).is_err(),
                "accepted sourcesNotCited {replacement}"
            );
        }
        uncited["draft"]["sourcesNotCited"] = serde_json::Value::Null;
        uncited["draft"]["unknown"] = serde_json::json!(true);
        assert!(
            validate(&uncited).is_err(),
            "accepted unknown field beside sourcesNotCited"
        );
        for (pointer, replacement) in [
            ("/draft/references", serde_json::json!({})),
            (
                "/draft/references",
                serde_json::json!(vec![pending["draft"]["references"][0].clone(); 21]),
            ),
            ("/draft/references/0/provider", serde_json::json!(" ")),
            ("/draft/references/0/tool", serde_json::json!(false)),
            (
                "/draft/references/0/relevance",
                serde_json::json!("😀".repeat(2_049)),
            ),
            ("/draft/references/0/owner", serde_json::json!("other")),
            ("/draft/references/0/repo", serde_json::json!("other")),
            (
                "/draft/references/0/repo",
                serde_json::json!("project.git.git"),
            ),
            (
                "/draft/references/0/path",
                serde_json::json!("x".repeat(4_097)),
            ),
            (
                "/draft/references/0/canonicalUrl",
                serde_json::json!("file:///etc/passwd"),
            ),
            (
                "/draft/references/0/canonicalUrl",
                serde_json::json!("https://user:secret@github.com/example/project/issues/42"),
            ),
            (
                "/draft/references/0/canonicalUrl",
                serde_json::json!("https://example.com/example/project/issues/42"),
            ),
            ("/draft/references/0/issue", serde_json::json!(43)),
            ("/draft/references/0/issue", serde_json::json!(0)),
            ("/draft/references/0/pullRequest", serde_json::json!(42)),
            (
                "/draft/references/0/range",
                serde_json::json!({"startLine": 1, "endLine": 2}),
            ),
            (
                "/draft/phases/0/referenceIds",
                serde_json::json!(["missing"]),
            ),
            (
                "/draft/phases/0/referenceIds",
                serde_json::json!(["ref-1", " ref-1 "]),
            ),
            (
                "/draft/phases/0/referenceIds",
                serde_json::json!(vec!["ref-1"; 21]),
            ),
            (
                "/draft/phases/0/referenceIds",
                serde_json::json!(["x".repeat(129)]),
            ),
            ("/draft/phases/0/referenceIds", serde_json::json!([])),
            ("/draft/phases/0/referenceIds", serde_json::json!({})),
        ] {
            let mut invalid = pending.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(validate(&invalid).is_err(), "accepted malformed {pointer}");
        }
        for pointer in ["/draft", "/draft/phases/0", "/draft/references/0"] {
            let mut invalid = pending.clone();
            invalid.pointer_mut(pointer).unwrap()["unknown"] = serde_json::json!(true);
            assert!(
                validate(&invalid).is_err(),
                "accepted unknown field at {pointer}"
            );
        }
        for duplicate_id in [true, false] {
            let mut invalid = pending.clone();
            let mut duplicate = invalid["draft"]["references"][0].clone();
            if !duplicate_id {
                duplicate["id"] = serde_json::json!("ref-2");
                duplicate["canonicalUrl"] =
                    serde_json::json!("https://GITHUB.com:443/example/project/issues/42/");
                invalid["draft"]["phases"][0]["referenceIds"] =
                    serde_json::json!(["ref-1", "ref-2"]);
            }
            invalid["draft"]["references"]
                .as_array_mut()
                .unwrap()
                .push(duplicate);
            assert!(validate(&invalid).is_err());
        }
        let mut ranged = pending.clone();
        ranged["draft"]["references"][0]["path"] = serde_json::json!("src/main.ts");
        ranged["draft"]["references"][0]["range"] =
            serde_json::json!({"startLine": 1, "endLine": 2});
        assert!(validate(&ranged).is_ok());
        for range in [
            serde_json::json!({"startLine": 2, "endLine": 1}),
            serde_json::json!({"startLine": 0, "endLine": 2}),
            serde_json::json!({"startLine": 1.5, "endLine": 2}),
            serde_json::json!({"startLine": 1, "endLine": 2, "unknown": true}),
        ] {
            ranged["draft"]["references"][0]["range"] = range;
            assert!(validate(&ranged).is_err());
        }
    }

    #[test]
    fn normalize_notes_response_preserves_expected_non_success_outcomes() {
        for (status, body) in [
            (
                reqwest::StatusCode::CONFLICT,
                serde_json::json!({ "status": "conflict", "snapshot": { "revision": 2 } }),
            ),
            (
                reqwest::StatusCode::NOT_FOUND,
                serde_json::json!({ "status": "missing" }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": { "path": "$", "message": "invalid request body" }
                }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": { "path": "$", "message": "malformed JSON request body" }
                }),
            ),
            (
                reqwest::StatusCode::BAD_REQUEST,
                serde_json::json!({
                    "status": "invalid",
                    "error": {
                        "path": "phases[0].roadmapEvents[0].type",
                        "message": "privileged roadmap events require their dedicated authority path"
                    }
                }),
            ),
            (
                reqwest::StatusCode::PAYLOAD_TOO_LARGE,
                serde_json::json!({
                    "status": "invalid",
                    "error": {
                        "path": "$",
                        "message": "notes request body exceeds 1048576 bytes"
                    }
                }),
            ),
        ] {
            assert_eq!(
                normalize_notes_response(status, body.clone()).unwrap(),
                body
            );
        }
    }

    #[test]
    fn normalize_notes_response_rejects_untyped_server_failures() {
        let error = normalize_notes_response(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "status": "error", "message": "notes request failed" }),
        )
        .unwrap_err();
        assert_eq!(error, "notes request failed");
    }

    #[test]
    fn reminder_proxy_preserves_only_route_typed_outcomes() {
        let reserved = r#"{"status":"reserved","leaseToken":"lease-1"}"#;
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                reserved,
                &["reserved", "deferred", "none"],
            )
            .unwrap(),
            serde_json::from_str::<serde_json::Value>(reserved).unwrap()
        );
        let denied = r#"{"status":"wrong-session"}"#;
        assert_eq!(
            normalize_reminder_response(reqwest::StatusCode::OK, denied, &["ok", "wrong-session"],)
                .unwrap(),
            serde_json::json!({ "status": "wrong-session" })
        );
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                r#"{"status":"released"}"#,
                &["reserved", "deferred", "none"],
            ),
            Err("invalid reminder response".to_string())
        );
    }

    #[test]
    fn reminder_proxy_rejects_malformed_and_ambiguous_responses() {
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::BAD_GATEWAY,
                "not json",
                &["reserved"],
            ),
            Err("invalid reminder response".to_string())
        );
        assert_eq!(
            normalize_reminder_response(
                reqwest::StatusCode::OK,
                r#"{"status":"maybe"}"#,
                &["reserved"],
            ),
            Err("invalid reminder response".to_string())
        );
    }

    #[test]
    fn phase_reconciliation_native_boundary_rejects_malformed_requests() {
        let repository = serde_json::json!({
            "projectKey": "c:/project",
            "identityHash": "a".repeat(64),
            "rootCommit": "b".repeat(40)
        });
        let request = serde_json::json!({
            "version": 3,
            "action": "reconcile-execution",
            "phaseId": "phase-1",
            "expectedProjectKey": "c:/project",
            "expectedRevision": 4,
            "operationId": "reconcile-1",
            "repository": repository.clone(),
            "plan": {
                "planId": "plan-1",
                "contentHash": "c".repeat(64),
                "snapshotPath": ".gg/plans/plan-1.md",
                "approvedAt": "2026-08-31T10:00:00.000Z",
                "approvedRevision": 3,
                "baseCommit": "b".repeat(40)
            },
            "workspace": {
                "version": 1,
                "repository": repository.clone(),
                "headCommit": "d".repeat(40),
                "worktreeDigest": "e".repeat(64),
                "clean": true
            }
        });
        assert_eq!(validate_public_phase_binding_request(&request), Ok(()));

        let mut malformed = request.clone();
        malformed["workspace"]["clean"] = serde_json::json!("yes");
        assert_eq!(
            validate_public_phase_binding_request(&malformed),
            Err(PHASE_EXECUTION_RECONCILIATION_REQUEST_ERROR.to_string())
        );
        let mut extra = request;
        extra["unexpected"] = serde_json::json!(true);
        assert_eq!(
            validate_public_phase_binding_request(&extra),
            Err(PHASE_EXECUTION_RECONCILIATION_REQUEST_ERROR.to_string())
        );
    }

    #[test]
    fn phase_lease_native_boundary_rejects_caller_predecessor_proof() {
        let mut request = serde_json::json!({
            "version": 2,
            "predecessorProof": null
        });
        assert_eq!(validate_public_phase_binding_request(&request), Ok(()));

        request["predecessorProof"] = serde_json::json!({
            "daemonInstanceId": "daemon-a",
            "processId": 42,
            "processStartToken": "start-a",
            "terminatedAt": "2026-08-30T10:00:00.000Z"
        });
        assert_eq!(
            validate_public_phase_binding_request(&request),
            Err(PHASE_LEASE_PREDECESSOR_PROOF_ERROR.to_string())
        );
    }

    #[test]
    fn phase_lease_native_boundary_rejects_cross_phase_and_extra_fields() {
        let lease = serde_json::json!({
            "version": 1,
            "projectKey": "c:/project",
            "phaseId": "phase-1",
            "planId": null,
            "leaseId": "lease-1",
            "fence": 1,
            "holder": {
                "daemonInstanceId": "daemon-a",
                "sessionId": "session-a",
                "sessionPath": null,
                "processId": 42
            },
            "runState": "idle",
            "acquiredAt": "2026-08-30T10:00:00.000Z",
            "renewedAt": "2026-08-30T10:00:30.000Z",
            "expiresAt": "2026-08-30T10:02:30.000Z",
            "operationId": "acquire-1"
        });
        let mut private_lease = lease.clone();
        private_lease["holder"]["processStartToken"] = serde_json::json!("start-a");
        assert!(!is_phase_lease(Some(&private_lease)));

        let outcome = serde_json::json!({
            "status": "inspected",
            "roadmapRevision": 7,
            "leaseRevision": 1,
            "phaseId": "phase-1",
            "lease": lease
        });
        assert!(is_roadmap_typed_outcome(
            RoadmapTypedResponseKind::PhaseLease,
            200,
            &outcome,
        ));

        let mut mismatch = outcome.clone();
        mismatch["phaseId"] = serde_json::json!("phase-2");
        assert!(!is_phase_lease_outcome(&mismatch));
        let mut extra = outcome;
        extra["unexpected"] = serde_json::json!(true);
        assert!(!is_phase_lease_outcome(&extra));
    }
}
