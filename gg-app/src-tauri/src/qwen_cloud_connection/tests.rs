use super::*;

#[cfg(debug_assertions)]
#[test]
fn qwen_smoke_selector_rejects_incomplete_or_invalid_configuration() {
    use std::ffi::OsString;
    let valid = "0123456789abcdef0123456789abcdef";
    assert_eq!(dev_smoke::parse(None, None), Ok(None));
    for run in ["", "../production", "test-123", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0"] {
        assert!(dev_smoke::parse(Some(run.into()), Some("run".into())).is_err());
    }
    for action in [None, Some(OsString::from("")), Some("delete-all".into())] {
        assert!(dev_smoke::parse(Some(valid.into()), action).is_err());
    }
    assert!(dev_smoke::parse(None, Some("cleanup".into())).is_err());
    assert!(dev_smoke::parse_environment(None, None, true).is_err());
    assert_eq!(dev_smoke::parse_environment(None, None, false), Ok(None));
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        assert!(dev_smoke::parse(Some(OsString::from_wide(&[0xd800])), Some("run".into())).is_err());
    }
}

#[cfg(debug_assertions)]
#[test]
fn qwen_smoke_names_are_fixed_derived_and_cleanup_selects_the_same_entry() {
    let run = "0123456789abcdef0123456789abcdef";
    let selected = dev_smoke::parse(Some(run.into()), Some("run".into())).unwrap().unwrap();
    let cleanup = dev_smoke::parse(Some(run.into()), Some("cleanup".into())).unwrap().unwrap();
    assert_eq!(selected.names(), cleanup.names());
    assert_eq!(selected.names(), (
        format!("com.ggcoder.local-fork.qwen-smoke.{run}"),
        format!("qwen-smoke-{run}"),
    ));
    let other = dev_smoke::parse(Some("abcdef0123456789abcdef0123456789".into()), Some("run".into())).unwrap().unwrap();
    assert_ne!(selected.names().0, other.names().0);
    assert_ne!(selected.names().1, other.names().1);
    assert_ne!(selected.names().0, "com.ggcoder.local-fork.qwen-cloud-token-plan");
    assert_ne!(selected.names().1, "token-plan-key");
}

#[test]
fn qwen_smoke_release_selection_is_compile_time_excluded() {
    // Source tripwire complements cfg compilation; no vault is opened by this test.
    let storage = include_str!("storage.rs");
    assert!(storage.contains("#[cfg(debug_assertions)]\n        if let Some(entry) = super::dev_smoke::selected_entry()?"));
    assert!(storage.contains("OsVault::new(SERVICE, ACCOUNT)"));
    let module = include_str!("../qwen_cloud_connection.rs");
    assert!(module.contains("#[cfg(debug_assertions)]\npub(crate) mod dev_smoke;"));
    let native = include_str!("../lib.rs");
    assert!(native.contains("#[cfg(debug_assertions)]\n    match qwen_cloud_connection::dev_smoke::startup()"));
}

/// Explicit opt-in: real Windows credential storage, fake keys, no native app or network.
#[cfg(target_os = "windows")]
#[test]
#[ignore = "writes fake keys to a unique test-only Windows vault entry"]
fn qwen_windows_vault_smoke() {
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Cleanup(storage::OsVault);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            // Never panic during unwinding; report a denied cleanup without raw OS errors.
            if self.0.delete().is_err() {
                eprintln!("Qwen isolated vault cleanup failed: vault-unavailable");
            }
        }
    }

    let namespace = format!(
        "test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    println!("Qwen Windows vault smoke: isolated service/account {namespace}");
    let vault = storage::OsVault::isolated_test(&namespace).unwrap();
    // Refuse a collision before arming cleanup: never remove a pre-existing entry.
    assert!(vault.get().expect("initial vault read denied").is_none());
    let cleanup = Cleanup(vault);
    let manager = ConnectionManager(storage::OsVault::isolated_test(&namespace).unwrap());
    assert_eq!(manager.status(), Status::new("absent"));

    tauri::async_runtime::block_on(async {
        for key in [
            "sk-sp-FAKE-WINDOWS-SMOKE-FIRST",
            "sk-sp-FAKE-WINDOWS-SMOKE-REPLACEMENT",
        ] {
            let reloader = FakeReload::default();
            let status = commands::mutate(&reloader, || manager.save(key))
                .await
                .unwrap();
            assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "reload"]);
            assert!(manager.0.get().unwrap().as_deref() == Some(key));
            let expected = serde_json::json!({
                "provider": "qwen-cloud", "credential": "saved",
                "verification": "not-tested", "allowance": "unavailable-with-inference-key"
            });
            assert_eq!(serde_json::to_value(status).unwrap(), expected);
            assert_eq!(serde_json::to_value(manager.status()).unwrap(), expected);
        }
        let reloader = FakeReload::default();
        assert_eq!(
            commands::mutate(&reloader, || manager.remove())
                .await
                .unwrap(),
            Status::new("absent")
        );
        assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "reload"]);
    });
    assert!(manager.0.get().unwrap().is_none());
    assert_eq!(manager.status(), Status::new("absent"));
    drop(cleanup);
    assert!(manager.0.get().unwrap().is_none());
    println!("PASS: initially absent, save, sanitized status, replace, fake idle/reload, remove, cleanup confirmed");
}
use crate::azure_connection::{
    commands::AzureConnectionMutations,
    lifecycle::{DaemonReloadClient, ReloadFuture},
    AzureConnectionError,
};
use std::sync::Mutex;

const OLD: &str = "sk-sp-fake-prior-native-test";
const NEW: &str = "sk-sp-fake-replacement-native-test";
#[derive(Default)]
struct FakeVault {
    value: Mutex<Option<String>>,
    fail: bool,
}
impl FakeVault {
    fn prior(fail: bool) -> Self {
        Self {
            value: Mutex::new(Some(OLD.into())),
            fail,
        }
    }
}
impl SecretStore for FakeVault {
    fn get(&self) -> Result<Option<String>, ErrorCode> {
        if self.fail {
            return Err(ErrorCode::VaultUnavailable);
        }
        Ok(self.value.lock().unwrap().clone())
    }
    fn set(&self, key: &str) -> Result<(), ErrorCode> {
        if self.fail {
            return Err(ErrorCode::VaultUnavailable);
        }
        *self.value.lock().unwrap() = Some(key.into());
        Ok(())
    }
    fn delete(&self) -> Result<(), ErrorCode> {
        if self.fail {
            return Err(ErrorCode::VaultUnavailable);
        }
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[test]
fn successful_save_and_remove_notify_auth_after_reload_without_secrets() {
    tauri::async_runtime::block_on(async {
        let manager = ConnectionManager(FakeVault::default());
        for save in [true, false] {
            let reloader = FakeReload::default();
            let mut notifications = Vec::new();
            let result = commands::mutate_and_notify(
                &reloader,
                || {
                    if save {
                        manager.save(NEW)
                    } else {
                        manager.remove()
                    }
                },
                |event, data| {
                    assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "reload"]);
                    notifications.push((event.to_owned(), data));
                },
            )
            .await;
            assert!(result.is_ok());
            assert_eq!(manager.0.get().unwrap().is_some(), save);
            assert_eq!(
                notifications,
                vec![(
                    "auth_change".into(),
                    serde_json::json!({"provider": "qwen-cloud"})
                )]
            );
        }
        let reloader = FakeReload::default();
        let result = commands::mutate_and_notify(
            &reloader,
            || Err(ErrorCode::VaultUnavailable),
            |_, _| panic!("failed mutation must not announce success"),
        )
        .await;
        assert_eq!(result, Err(ErrorCode::VaultUnavailable));
    });
}

#[test]
fn vault_replacement_removal_failures_preserve_prior_and_status_is_secret_free() {
    let manager = ConnectionManager(FakeVault::prior(false));
    assert_eq!(
        manager.save("sk-wrong-type"),
        Err(ErrorCode::InvalidKeyFormat)
    );
    assert_eq!(manager.0.get().unwrap().as_deref(), Some(OLD));
    let status = manager.save(NEW).unwrap();
    assert_eq!(manager.0.get().unwrap().as_deref(), Some(NEW));
    assert_eq!(
        serde_json::to_value(ConnectionResult::from(Ok(status))).unwrap(),
        serde_json::json!({
            "ok": true, "status": {"provider": "qwen-cloud", "credential": "saved", "verification": "not-tested", "allowance": "unavailable-with-inference-key"}
        })
    );
    assert_eq!(manager.remove().unwrap(), Status::new("absent"));
    assert_eq!(manager.remove().unwrap(), Status::new("absent"));
    assert_eq!(manager.0.get().unwrap(), None);
    let manager = ConnectionManager(FakeVault::prior(true));
    assert_eq!(manager.save(NEW), Err(ErrorCode::VaultUnavailable));
    assert_eq!(manager.remove(), Err(ErrorCode::VaultUnavailable));
    assert_eq!(manager.0.value.lock().unwrap().as_deref(), Some(OLD));
    assert_eq!(manager.status(), Status::new("unavailable"));
    let serialized =
        serde_json::to_string(&ConnectionResult::from(Err(ErrorCode::VaultUnavailable))).unwrap();
    assert_eq!(serialized, "{\"ok\":false,\"code\":\"vault-unavailable\"}");
    assert!(!serialized.contains(OLD));
}

#[test]
fn connection_results_serialize_only_reachable_public_shapes() {
    let code_name = |code| match code {
        ErrorCode::InvalidKeyFormat => "invalid-key-format",
        ErrorCode::NativeUnavailable => "native-unavailable",
        ErrorCode::VaultUnavailable => "vault-unavailable",
        ErrorCode::ActiveRun => "active-run",
        ErrorCode::PreparationFailed => "preparation-failed",
        ErrorCode::ReloadFailed => "reload-failed",
        ErrorCode::AuthenticationFailed => "authentication-failed",
        ErrorCode::AllowanceExhausted => "allowance-exhausted",
        ErrorCode::RateLimited => "rate-limited",
        ErrorCode::NetworkFailed => "network-failed",
        ErrorCode::RequestRejected => "request-rejected",
        ErrorCode::TimedOut => "timed-out",
    };
    for code in [
        ErrorCode::InvalidKeyFormat,
        ErrorCode::NativeUnavailable,
        ErrorCode::VaultUnavailable,
        ErrorCode::ActiveRun,
        ErrorCode::PreparationFailed,
        ErrorCode::ReloadFailed,
        ErrorCode::AuthenticationFailed,
        ErrorCode::AllowanceExhausted,
        ErrorCode::RateLimited,
        ErrorCode::NetworkFailed,
        ErrorCode::RequestRejected,
        ErrorCode::TimedOut,
    ] {
        assert_eq!(
            serde_json::to_value(ConnectionResult::from(Err(code))).unwrap(),
            serde_json::json!({"ok": false, "code": code_name(code)})
        );
    }
    let manager = ConnectionManager(FakeVault::prior(false));
    for verification in ["not-tested", "succeeded"] {
        let mut status = manager.status();
        status.verification = verification;
        assert_eq!(
            serde_json::to_value(ConnectionResult::from(Ok(status))).unwrap(),
            serde_json::json!({"ok": true, "status": {
                "provider": "qwen-cloud", "credential": "saved",
                "verification": verification, "allowance": "unavailable-with-inference-key"
            }})
        );
    }
    assert_eq!(manager.status().verification, "not-tested");
}

#[test]
fn key_validation_matches_typescript_without_trimming() {
    for key in [
        "",
        "sk-sp-",
        "sk-fake",
        " sk-sp-fake",
        "sk-sp-fake ",
        "sk-sp-fake\n",
        "sk-sp-é",
        "sk-sp-fake/",
        "sk-sp-a.b",
    ] {
        assert_eq!(validate_key(key), Err(ErrorCode::InvalidKeyFormat));
    }
    assert!(validate_key("sk-sp-a_A-0").is_ok());
    assert!(validate_key(&format!("sk-sp-{}", "a".repeat(250))).is_ok());
    assert!(validate_key(&format!("sk-sp-{}", "a".repeat(251))).is_err());
    assert!(serde_json::from_value::<SaveConnection>(
        serde_json::json!({"apiKey":NEW,"endpoint":"https://example.com"})
    )
    .is_err());
}

#[test]
fn daemon_inherited_key_is_suppressed_without_valid_vault_value() {
    for key in [None, Some("wrong-kind")] {
        let mut command = std::process::Command::new("node");
        command.env(KEY_ENV, OLD).env("UNRELATED", "preserved");
        inject_environment(&mut command, key);
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(env[std::ffi::OsStr::new(KEY_ENV)], None);
        assert_eq!(
            env[std::ffi::OsStr::new("UNRELATED")],
            Some(std::ffi::OsStr::new("preserved"))
        );
    }
    let mut command = std::process::Command::new("node");
    inject_environment(&mut command, Some(NEW));
    assert_eq!(
        command
            .get_envs()
            .find(|(key, _)| *key == KEY_ENV)
            .unwrap()
            .1,
        Some(std::ffi::OsStr::new(NEW))
    );
}

#[derive(Default)]
struct FakeReload {
    events: Mutex<Vec<&'static str>>,
    active: bool,
    fail_prepare: bool,
    fail_reload: bool,
}
impl DaemonReloadClient for FakeReload {
    fn prepare(&self) -> ReloadFuture<'_> {
        Box::pin(async {
            self.events.lock().unwrap().push("prepare");
            if self.active {
                Err(AzureConnectionError::general(
                    "active_runs",
                    "Azure-only message",
                ))
            } else if self.fail_prepare {
                Err(AzureConnectionError::general("prepare_failed", NEW))
            } else {
                Ok(())
            }
        })
    }
    fn cancel(&self) -> ReloadFuture<'_> {
        Box::pin(async {
            self.events.lock().unwrap().push("cancel");
            Ok(())
        })
    }
    fn reload(&self) -> ReloadFuture<'_> {
        Box::pin(async {
            self.events.lock().unwrap().push("reload");
            if self.fail_reload {
                Err(AzureConnectionError::general(
                    "models_refresh_failed",
                    "Azure-only message",
                ))
            } else {
                Ok(())
            }
        })
    }
}

#[test]
fn prepare_failure_preserves_prior_key_for_save_and_remove() {
    tauri::async_runtime::block_on(async {
        for remove in [false, true] {
            let manager = ConnectionManager(FakeVault::prior(false));
            let reloader = FakeReload {
                fail_prepare: true,
                ..Default::default()
            };
            let called = std::cell::Cell::new(false);
            let result = commands::mutate(&reloader, || {
                called.set(true);
                if remove {
                    manager.remove()
                } else {
                    manager.save(NEW)
                }
            })
            .await;
            assert_eq!(result, Err(ErrorCode::PreparationFailed));
            assert!(!called.get());
            assert_eq!(manager.0.get().unwrap().as_deref(), Some(OLD));
            assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare"]);
            let serialized = serde_json::to_string(&ConnectionResult::from(result)).unwrap();
            assert_eq!(serialized, r#"{"ok":false,"code":"preparation-failed"}"#);
            assert!(!serialized.contains(OLD));
            assert!(!serialized.contains(NEW));
        }
    });
}

#[test]
fn idle_reservation_failure_and_reload_failure_have_honest_qwen_results() {
    tauri::async_runtime::block_on(async {
        let manager = ConnectionManager(FakeVault::prior(false));
        let active = FakeReload {
            active: true,
            ..Default::default()
        };
        assert_eq!(
            commands::mutate(&active, || manager.save(NEW)).await,
            Err(ErrorCode::ActiveRun)
        );
        assert_eq!(manager.0.get().unwrap().as_deref(), Some(OLD));
        assert_eq!(*active.events.lock().unwrap(), vec!["prepare"]);
        let reloader = FakeReload::default();
        assert!(commands::mutate(&reloader, || manager.save(NEW))
            .await
            .is_ok());
        assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "reload"]);
        let reloader = FakeReload::default();
        assert_eq!(
            commands::mutate(&reloader, || Err(ErrorCode::VaultUnavailable)).await,
            Err(ErrorCode::VaultUnavailable)
        );
        assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "cancel"]);
        let reloader = FakeReload {
            fail_reload: true,
            ..Default::default()
        };
        let result = commands::mutate(&reloader, || manager.remove()).await;
        assert_eq!(result, Err(ErrorCode::ReloadFailed));
        assert_eq!(manager.0.get().unwrap(), None);
        assert_eq!(
            *reloader.events.lock().unwrap(),
            vec!["prepare", "reload", "cancel"]
        );
        assert!(!serde_json::to_string(&ConnectionResult::from(result))
            .unwrap()
            .contains("Azure"));
    });
}

#[test]
fn reload_failure_commits_save_and_remove_with_secret_free_status() {
    tauri::async_runtime::block_on(async {
        let manager = ConnectionManager(FakeVault::default());
        for save in [true, false] {
            let reloader = FakeReload {
                fail_reload: true,
                ..Default::default()
            };
            let result = commands::mutate_and_notify(
                &reloader,
                || if save { manager.save(NEW) } else { manager.remove() },
                |_, _| panic!("failed reload must not announce daemon success"),
            ).await;
            assert_eq!(result, Err(ErrorCode::ReloadFailed));
            assert_eq!(manager.0.get().unwrap().as_deref(), if save { Some(NEW) } else { None });
            assert_eq!(*reloader.events.lock().unwrap(), vec!["prepare", "reload", "cancel"]);
            assert_eq!(
                serde_json::to_value(ConnectionResult::from(result)).unwrap(),
                serde_json::json!({"ok": false, "code": "reload-failed"})
            );
            assert_eq!(
                serde_json::to_value(ConnectionResult::from(Ok(manager.status()))).unwrap(),
                serde_json::json!({"ok": true, "status": {
                    "provider": "qwen-cloud",
                    "credential": if save { "saved" } else { "absent" },
                    "verification": "not-tested",
                    "allowance": "unavailable-with-inference-key"
                }})
            );
        }
    });
}

#[test]
fn mutations_share_azure_lock_and_hold_it_through_reload() {
    tauri::async_runtime::block_on(async {
        let mutations = AzureConnectionMutations::default();
        let manager = ConnectionManager(FakeVault::prior(false));
        let reloader = FakeReload::default();
        let guard = mutations.0.lock().await;
        assert!(mutations.0.try_lock().is_err());
        commands::mutate(&reloader, || {
            assert!(mutations.0.try_lock().is_err());
            manager.save(NEW)
        })
        .await
        .unwrap();
        assert!(mutations.0.try_lock().is_err());
        drop(guard);
        assert!(mutations.0.try_lock().is_ok());
    });
}

#[test]
fn only_local_app_origins_can_access_commands() {
    for url in [
        "https://tauri.localhost/",
        "http://tauri.localhost/",
        "tauri://localhost/",
    ] {
        assert!(commands::trusted_origin(&url.parse().unwrap(), false));
    }
    for url in [
        "https://example.com/",
        "https://tauri.localhost.evil.test/",
        "https://user@tauri.localhost/",
        "https://tauri.localhost:444/",
        "http://localhost:1420/",
    ] {
        assert!(!commands::trusted_origin(&url.parse().unwrap(), false));
    }
    assert!(commands::trusted_origin(
        &"http://localhost:1420/".parse().unwrap(),
        true
    ));
}
