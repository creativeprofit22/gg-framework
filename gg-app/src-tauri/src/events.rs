//! Agent-event broadcasting and the SSE bridge from the daemon to windows.

use crate::*;

pub(crate) fn trusted_event_envelope(
    pane_id: &str,
    session_id: &str,
    value: &serde_json::Value,
) -> Option<serde_json::Value> {
    if value.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return None;
    }
    let event_type = value.get("type")?.as_str()?;
    let data = value.get("data")?.clone();
    Some(serde_json::json!({
        "paneId": pane_id,
        "sessionId": session_id,
        "type": event_type,
        "data": data,
    }))
}

/// Log-safe event type: daemon types are short identifiers, so anything else is
/// reported as "unknown" rather than echoing arbitrary payload text into logs.
pub(crate) fn loggable_event_type(value: &serde_json::Value) -> &str {
    value
        .get("type")
        .and_then(|kind| kind.as_str())
        .filter(|kind| {
            !kind.is_empty()
                && kind.len() <= 64
                && kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
        .unwrap_or("unknown")
}

/// Why `trusted_event_envelope` rejected a frame, for drop diagnostics only.
pub(crate) fn envelope_rejection_reason(
    session_id: &str,
    value: &serde_json::Value,
) -> &'static str {
    match value.get("sessionId").and_then(|v| v.as_str()) {
        None => "missing-session",
        Some(id) if id != session_id => "session-mismatch",
        Some(_) if value.get("type").and_then(|v| v.as_str()).is_none() => "missing-type",
        Some(_) if value.get("data").is_none() => "missing-data",
        Some(_) => "unknown",
    }
}

/// The bridge's own notice that a pane's event stream dropped, scoped like a
/// daemon event so the webview can show a reconnecting state.
pub(crate) fn connection_lost_envelope(
    pane_id: &str,
    session_id: &str,
) -> Option<serde_json::Value> {
    let value = serde_json::json!({
        "sessionId": session_id,
        "type": "connection_lost",
        "data": {},
    });
    trusted_event_envelope(pane_id, session_id, &value)
}

/// Emit one `agent-event` frame to EVERY window, matching the shape the SSE
/// bridge produces. For global state changed natively, outside any session.
pub(crate) fn broadcast_agent_event(
    app: &tauri::AppHandle,
    event_type: &str,
    data: serde_json::Value,
) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "agent-event",
            serde_json::json!({ "type": event_type, "data": data }),
        );
    }
}

/// Current unix time in milliseconds (wall clock; fine for an expiry stamp).
pub(crate) fn current_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Drain every complete SSE frame (frames are separated by a blank line) from a
/// rolling BYTE buffer, returning each frame's decoded text and leaving any
/// trailing partial frame in `buf`.
///
/// Why a byte buffer instead of decoding each network chunk: `bytes_stream()`
/// splits on arbitrary TCP boundaries, so a multibyte UTF-8 codepoint (emoji,
/// ✓, box-drawing, CJK, accented chars — all common in agent output) can
/// straddle two chunks. Decoding a chunk that ends mid-codepoint replaces the
/// partial bytes with U+FFFD and corrupts the stream for good. A complete frame
/// always ends at an ASCII `\n`, so its bytes never split a codepoint — decoding
/// per-frame is lossless, and any partial tail stays buffered until its rest
/// arrives.
pub(crate) fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        let drained: Vec<u8> = buf.drain(..pos + 2).collect();
        // Bytes before the `\n\n` are the complete frame (whole codepoints).
        frames.push(String::from_utf8_lossy(&drained[..pos]).into_owned());
    }
    frames
}

/// Connect to exactly one pane identity's SSE stream. The bridge remains valid
/// only while `(owner label, pane id, generation, session id)` still matches the
/// registry. Sidecar payload identity is untrusted: frames for any other session
/// are dropped, and only the expected identity plus `{type, data}` is emitted.
pub(crate) fn start_event_bridge(
    app: tauri::AppHandle,
    label: String,
    pane_id: String,
    generation: u64,
    port: u16,
    session_id: String,
) {
    // Reuse the app's shared HTTP client (cheap Arc clone) so the SSE connect
    // shares the connection pool with the proxy commands. Reconnects back off
    // while the daemon stays unreachable.
    let client = app.state::<reqwest::Client>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut retry_delay = SSE_RETRY_MIN;
        loop {
            let identity_is_current = {
                let state: State<Windows> = app.state();
                let registry = state.map.lock_or_recover();
                pane_identity_is_current(&registry, &label, &pane_id, generation, &session_id)
            };
            if !identity_is_current {
                log::debug!(
                    "event bridge retired for {label}/{pane_id} generation {generation} session {session_id}"
                );
                return;
            }

            let url = format!(
                "{}/events?session={}",
                sidecar_base(port),
                urlencoding(&session_id)
            );
            match client.get(&url).send().await {
                Ok(res) if !res.status().is_success() => {
                    log::warn!("agent event stream refused: {}", res.status());
                }
                Ok(res) => {
                    // Connected: the next drop is a fresh outage, retried fast.
                    retry_delay = SSE_RETRY_MIN;
                    let mut stream = res.bytes_stream();
                    let mut buf: Vec<u8> = Vec::new();
                    let mut stream_error: Option<String> = None;
                    while let Some(chunk) = stream.next().await {
                        let identity_is_current = {
                            let state: State<Windows> = app.state();
                            let registry = state.map.lock_or_recover();
                            resolve_owned_pane(&registry, &label, &pane_id).is_some_and(|pane| {
                                pane.generation == generation
                                    && pane.session_id.as_deref() == Some(&session_id)
                            })
                        };
                        if !identity_is_current {
                            log::debug!(
                                "event bridge retired for {label}/{pane_id} generation {generation} session {session_id}"
                            );
                            return;
                        }
                        let bytes = match chunk {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                // without_url: the URL carries the session id query.
                                stream_error = Some(error.without_url().to_string());
                                break;
                            }
                        };
                        buf.extend_from_slice(&bytes);
                        for frame in drain_sse_frames(&mut buf) {
                            for line in frame.lines() {
                                let Some(payload) = line.strip_prefix("data: ") else {
                                    continue;
                                };
                                let value = match serde_json::from_str::<serde_json::Value>(payload)
                                {
                                    Ok(value) => value,
                                    Err(error) => {
                                        log::warn!(
                                            "agent event dropped for {label}/{pane_id}: reason=invalid-json type=unknown bytes={} error={error}",
                                            payload.len()
                                        );
                                        continue;
                                    }
                                };
                                let Some(trusted) =
                                    trusted_event_envelope(&pane_id, &session_id, &value)
                                else {
                                    log::warn!(
                                        "agent event dropped for {label}/{pane_id}: reason={} type={} bytes={}",
                                        envelope_rejection_reason(&session_id, &value),
                                        loggable_event_type(&value),
                                        payload.len()
                                    );
                                    continue;
                                };
                                let event_type = loggable_event_type(&trusted).to_owned();
                                if let Err(error) = app.emit_to(
                                    EventTarget::webview_window(label.clone()),
                                    "agent-event",
                                    trusted,
                                ) {
                                    log::warn!(
                                        "agent event delivery failed for {label}/{pane_id}: type={event_type} bytes={} error={error}",
                                        payload.len()
                                    );
                                }
                            }
                        }
                    }
                    // Unterminated buffered bytes are a partial frame lost with the stream.
                    match stream_error {
                        Some(error) => log::warn!(
                            "agent event stream failed for {label}/{pane_id}: error={error} unterminated_bytes={}, reconnecting",
                            buf.len()
                        ),
                        None => log::warn!(
                            "agent event stream closed by daemon for {label}/{pane_id}: unterminated_bytes={}, reconnecting",
                            buf.len()
                        ),
                    }
                }
                Err(e) => {
                    log::error!("failed to connect to event stream for {label}/{pane_id}: {e}");
                }
            }
            // Do not leave a stale working/success label while the stream is down,
            // and never deliver an old session's disconnect to its replacement.
            {
                let state: State<Windows> = app.state();
                let registry = state.map.lock_or_recover();
                if !resolve_owned_pane(&registry, &label, &pane_id).is_some_and(|pane| {
                    pane.generation == generation && pane.session_id.as_deref() == Some(&session_id)
                }) {
                    return;
                }
                if let Some(trusted) = connection_lost_envelope(&pane_id, &session_id) {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "agent-event",
                        trusted,
                    );
                }
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = next_sse_retry_delay(retry_delay);
        }
    });
}

/// First reconnect after a dropped event stream: quick, so a blip is invisible.
pub(crate) const SSE_RETRY_MIN: std::time::Duration = std::time::Duration::from_secs(1);

/// Ceiling while the daemon stays down. If it never returns (the crash circuit
/// breaker opened), every window would otherwise wake, log and re-render a
/// "Reconnecting" event once a second until the app quits.
pub(crate) const SSE_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) fn next_sse_retry_delay(current: std::time::Duration) -> std::time::Duration {
    (current * 2).min(SSE_RETRY_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_retry_backs_off_to_a_ceiling() {
        let mut delay = SSE_RETRY_MIN;
        let mut seen = vec![delay.as_secs()];
        for _ in 0..8 {
            delay = next_sse_retry_delay(delay);
            seen.push(delay.as_secs());
        }
        assert_eq!(seen, [1, 2, 4, 8, 16, 30, 30, 30, 30]);
    }

    // ── SSE frame decoding (drain_sse_frames) ────────────────────────────────

    #[test]
    fn drains_complete_frames_and_keeps_partial() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: one\n\ndata: two\n\ndata: par");
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec!["data: one".to_string(), "data: two".to_string()]
        );
        // The unterminated "data: par" stays buffered for the next chunk.
        assert_eq!(buf, b"data: par");
    }

    #[test]
    fn no_complete_frame_leaves_buffer_intact() {
        let mut buf: Vec<u8> = b"data: incomplete\n".to_vec();
        assert!(drain_sse_frames(&mut buf).is_empty());
        assert_eq!(buf, b"data: incomplete\n");
    }

    #[test]
    fn multibyte_codepoint_split_across_chunks_is_not_corrupted() {
        // "✓ 🚀 café" — ✓ (3 bytes), 🚀 (4 bytes), é (2 bytes). Feed the
        // frame one byte at a time so every codepoint straddles a chunk
        // boundary. The old per-chunk from_utf8_lossy would emit U+FFFD; the
        // byte-buffered drainer must reconstruct the exact text.
        let payload = "data: ✓ 🚀 café";
        let wire = format!("{payload}\n\n");
        let mut buf: Vec<u8> = Vec::new();
        let mut frames: Vec<String> = Vec::new();
        for &byte in wire.as_bytes() {
            buf.push(byte);
            frames.extend(drain_sse_frames(&mut buf));
        }
        assert_eq!(frames, vec![payload.to_string()]);
        assert!(
            !frames[0].contains('\u{FFFD}'),
            "no replacement chars: {:?}",
            frames[0]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let mut buf: Vec<u8> = b"data: a\n\ndata: b\n\ndata: c\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames, vec!["data: a", "data: b", "data: c"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn event_forwarding_requires_matching_generation_session_and_envelope() {
        let mut registry = PaneRegistry::default();
        let generation = add_pane(&mut registry, "main", "chat", "/chat");
        assert!(bind_pane_session(
            &mut registry,
            "main",
            "chat",
            generation,
            "sid".into()
        ));
        assert!(pane_identity_is_current(
            &registry, "main", "chat", generation, "sid"
        ));
        assert!(!pane_identity_is_current(
            &registry,
            "main",
            "chat",
            generation + 1,
            "sid"
        ));
        assert!(!pane_identity_is_current(
            &registry, "main", "chat", generation, "other"
        ));

        let event = serde_json::json!({"sessionId": "sid", "type": "delta", "data": {"text": "ok"}, "paneId": "spoofed"});
        let trusted = trusted_event_envelope("chat", "sid", &event).unwrap();
        assert_eq!(trusted["paneId"], "chat");
        assert_eq!(trusted["sessionId"], "sid");
        assert_eq!(trusted["type"], "delta");
        assert!(trusted_event_envelope("chat", "other", &event).is_none());
        assert!(
            trusted_event_envelope("chat", "sid", &serde_json::json!({"sessionId": "sid"}))
                .is_none()
        );

        // Drop diagnostics name the reason and never echo non-identifier text.
        assert_eq!(
            envelope_rejection_reason("other", &event),
            "session-mismatch"
        );
        assert_eq!(
            envelope_rejection_reason("sid", &serde_json::json!({"type": "delta"})),
            "missing-session"
        );
        assert_eq!(
            envelope_rejection_reason("sid", &serde_json::json!({"sessionId": "sid"})),
            "missing-type"
        );
        assert_eq!(
            envelope_rejection_reason(
                "sid",
                &serde_json::json!({"sessionId": "sid", "type": "delta"})
            ),
            "missing-data"
        );
        assert_eq!(loggable_event_type(&event), "delta");
        assert_eq!(
            loggable_event_type(&serde_json::json!({"type": "token=abc secret"})),
            "unknown"
        );
        assert_eq!(loggable_event_type(&serde_json::json!({})), "unknown");

        // The bridge's own disconnect notice must survive its session filter.
        let lost = connection_lost_envelope("chat", "sid").expect("connection_lost is delivered");
        assert_eq!(lost["paneId"], "chat");
        assert_eq!(lost["sessionId"], "sid");
        assert_eq!(lost["type"], "connection_lost");
    }
}
