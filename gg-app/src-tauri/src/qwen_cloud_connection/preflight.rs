use super::{validate_key, ErrorCode};
use std::{future::Future, pin::Pin, time::Duration};

pub(super) const ENDPOINT: &str =
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
const MODEL: &str = "qwen3.8-flash";
const TIMEOUT: Duration = Duration::from_secs(20);

type ResponseFuture<'a> = Pin<Box<dyn Future<Output = Result<u16, ErrorCode>> + Send + 'a>>;
pub(super) trait Transport {
    fn execute(&self, request: reqwest::Request) -> ResponseFuture<'_>;
}

pub(super) struct NativeTransport(reqwest::Client);
impl NativeTransport {
    pub(super) fn new() -> Result<Self, ErrorCode> {
        crate::install_rustls_provider();
        // OS trust roots/network configuration remain trusted. No proxy/base URL input.
        reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(TIMEOUT)
            .build()
            .map(Self)
            .map_err(|_| ErrorCode::NetworkFailed)
    }
}
impl Transport for NativeTransport {
    fn execute(&self, request: reqwest::Request) -> ResponseFuture<'_> {
        Box::pin(async move {
            // No body decoding, logging, retries or redirects. Even isolated error echoes
            // cannot escape: only the HTTP status crosses this boundary.
            self.0
                .execute(request)
                .await
                .map(|response| response.status().as_u16())
                .map_err(|error| {
                    if error.is_timeout() {
                        ErrorCode::TimedOut
                    } else {
                        ErrorCode::NetworkFailed
                    }
                })
        })
    }
}

fn request(
    method: reqwest::Method,
    destination: &str,
    key: &str,
    tls_disabled: bool,
) -> Result<reqwest::Request, ErrorCode> {
    validate_key(key)?;
    // Compare before URL normalization or attaching Authorization. No aliases or overrides.
    if tls_disabled || method != reqwest::Method::POST || destination != ENDPOINT {
        return Err(ErrorCode::RequestRejected);
    }
    let mut request = reqwest::Request::new(
        method,
        ENDPOINT.parse().map_err(|_| ErrorCode::RequestRejected)?,
    );
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| ErrorCode::InvalidKeyFormat)?;
    authorization.set_sensitive(true);
    request
        .headers_mut()
        .insert(reqwest::header::AUTHORIZATION, authorization);
    request.headers_mut().insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    *request.timeout_mut() = Some(TIMEOUT);
    *request.body_mut() = Some(
        serde_json::json!({
            "model": MODEL,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "enable_thinking": false,
            "max_completion_tokens": 8,
            "stream": false
        })
        .to_string()
        .into(),
    );
    Ok(request)
}

pub(super) async fn test<T: Transport>(
    transport: &T,
    key: &str,
    tls_disabled: bool,
) -> Result<(), ErrorCode> {
    let request = request(reqwest::Method::POST, ENDPOINT, key, tls_disabled)?;
    let status = tokio::time::timeout(TIMEOUT, transport.execute(request))
        .await
        .map_err(|_| ErrorCode::TimedOut)??;
    match status {
        200 => Ok(()),
        401 | 403 => Err(ErrorCode::AuthenticationFailed),
        402 => Err(ErrorCode::AllowanceExhausted),
        429 => Err(ErrorCode::RateLimited),
        _ => Err(ErrorCode::RequestRejected),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    const KEY: &str = "sk-sp-fake-native-preflight-test";
    struct FakeTransport {
        status: u16,
        calls: Mutex<Vec<reqwest::Request>>,
    }
    impl Transport for FakeTransport {
        fn execute(&self, request: reqwest::Request) -> ResponseFuture<'_> {
            self.calls.lock().unwrap().push(request);
            Box::pin(async { Ok(self.status) })
        }
    }
    #[test]
    fn exact_route_and_fixed_minimal_request() {
        let request = request(reqwest::Method::POST, ENDPOINT, KEY, false).unwrap();
        assert_eq!(request.url().as_str(), ENDPOINT);
        assert_eq!(request.method(), reqwest::Method::POST);
        assert!(request.headers()[reqwest::header::AUTHORIZATION].is_sensitive());
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"model": "qwen3.8-flash", "messages": [{"role":"user", "content":"Reply with OK."}], "enable_thinking":false, "max_completion_tokens":8, "stream":false})
        );
    }
    #[test]
    fn rejects_every_other_destination_method_and_tls_disable() {
        for destination in [
            "https://tokenplan-intl.qwencloud.com/compatible-mode/v1/chat/completions",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            "https://example.com/compatible-mode/v1/chat/completions",
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com.evil.test/compatible-mode/v1/chat/completions",
            "http://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com:444/compatible-mode/v1/chat/completions",
            "https://user@token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
        ].into_iter().map(str::to_owned).chain([format!("{ENDPOINT}?a=b"), format!("{ENDPOINT}#fragment"), format!("{ENDPOINT}/extra"), ENDPOINT.replace("chat/completions", "responses")]) {
            assert_eq!(request(reqwest::Method::POST, &destination, KEY, false).unwrap_err(), ErrorCode::RequestRejected);
        }
        assert_eq!(
            request(reqwest::Method::GET, ENDPOINT, KEY, false).unwrap_err(),
            ErrorCode::RequestRejected
        );
        assert_eq!(
            request(reqwest::Method::POST, ENDPOINT, KEY, true).unwrap_err(),
            ErrorCode::RequestRejected
        );
    }
    #[test]
    fn redirects_auth_quota_never_retry_or_fallback() {
        tauri::async_runtime::block_on(async {
            for (status, error) in [
                (301, ErrorCode::RequestRejected),
                (302, ErrorCode::RequestRejected),
                (303, ErrorCode::RequestRejected),
                (307, ErrorCode::RequestRejected),
                (308, ErrorCode::RequestRejected),
                (401, ErrorCode::AuthenticationFailed),
                (403, ErrorCode::AuthenticationFailed),
                (402, ErrorCode::AllowanceExhausted),
                (429, ErrorCode::RateLimited),
            ] {
                let transport = FakeTransport {
                    status,
                    calls: Mutex::new(Vec::new()),
                };
                assert_eq!(test(&transport, KEY, false).await, Err(error));
                assert_eq!(transport.calls.lock().unwrap().len(), 1);
            }
            let transport = FakeTransport {
                status: 200,
                calls: Mutex::new(Vec::new()),
            };
            assert_eq!(
                test(&transport, "sk-fake-wrong-type", false).await,
                Err(ErrorCode::InvalidKeyFormat)
            );
            assert!(transport.calls.lock().unwrap().is_empty());
            assert!(test(&transport, KEY, false).await.is_ok());
        });
    }
}
