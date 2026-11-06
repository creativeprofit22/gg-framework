//! Roadmap reminder notifications and platform notification availability.

use crate::*;

pub(crate) const ROADMAP_REMINDER_NOTIFICATION_TITLE: &str = "Roadmap reminder due";

pub(crate) const ROADMAP_REMINDER_NOTIFICATION_BODY: &str = "Open Supah Coder to review it.";

#[derive(Debug, PartialEq)]
pub(crate) struct RoadmapReminderNotificationSpec {
    pub(crate) title: &'static str,
    pub(crate) body: &'static str,
    pub(crate) sound: Option<&'static str>,
}

pub(crate) fn roadmap_reminder_sound() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "Submarine";
    }
    #[cfg(target_os = "windows")]
    {
        return "Mail";
    }
    #[cfg(target_os = "linux")]
    {
        return "message-new-instant";
    }
    #[allow(unreachable_code)]
    "default"
}

pub(crate) fn roadmap_reminder_notification_spec(
    sound_enabled: bool,
) -> RoadmapReminderNotificationSpec {
    RoadmapReminderNotificationSpec {
        title: ROADMAP_REMINDER_NOTIFICATION_TITLE,
        body: ROADMAP_REMINDER_NOTIFICATION_BODY,
        sound: sound_enabled.then(roadmap_reminder_sound),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationAvailabilitySignal {
    Enabled,
    Disabled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RoadmapReminderNotificationPermission {
    Granted,
    Denied,
    Unavailable,
}

pub(crate) fn notification_permission_from_signal(
    signal: NotificationAvailabilitySignal,
) -> RoadmapReminderNotificationPermission {
    match signal {
        NotificationAvailabilitySignal::Enabled => RoadmapReminderNotificationPermission::Granted,
        NotificationAvailabilitySignal::Disabled => RoadmapReminderNotificationPermission::Denied,
        NotificationAvailabilitySignal::Unknown => {
            RoadmapReminderNotificationPermission::Unavailable
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_notification_signal(
    setting: Option<::windows::UI::Notifications::NotificationSetting>,
) -> NotificationAvailabilitySignal {
    use ::windows::UI::Notifications::NotificationSetting;

    match setting {
        Some(NotificationSetting::Enabled) => NotificationAvailabilitySignal::Enabled,
        Some(
            NotificationSetting::DisabledForApplication
            | NotificationSetting::DisabledForUser
            | NotificationSetting::DisabledByGroupPolicy
            | NotificationSetting::DisabledByManifest,
        ) => NotificationAvailabilitySignal::Disabled,
        Some(_) | None => NotificationAvailabilitySignal::Unknown,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn platform_notification_signal(app_id: &str) -> NotificationAvailabilitySignal {
    use ::windows::core::HSTRING;
    use ::windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    use ::windows::UI::Notifications::ToastNotificationManager;

    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
    let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .and_then(|notifier| notifier.Setting());
    if initialized {
        unsafe { RoUninitialize() };
    }
    match setting {
        Ok(setting) => windows_notification_signal(Some(setting)),
        Err(error) => {
            log::warn!("Windows notification availability probe failed: {error}");
            windows_notification_signal(None)
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MacosNotificationState {
    Enabled,
    Disabled,
    NotDetermined,
    Unknown,
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_notification_state(
    authorization: objc2_user_notifications::UNAuthorizationStatus,
    alert: objc2_user_notifications::UNNotificationSetting,
) -> MacosNotificationState {
    use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSetting};

    match authorization {
        UNAuthorizationStatus::Denied => MacosNotificationState::Disabled,
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral
            if alert == UNNotificationSetting::Enabled =>
        {
            MacosNotificationState::Enabled
        }
        UNAuthorizationStatus::Authorized
        | UNAuthorizationStatus::Provisional
        | UNAuthorizationStatus::Ephemeral => MacosNotificationState::Disabled,
        UNAuthorizationStatus::NotDetermined => MacosNotificationState::NotDetermined,
        _ => MacosNotificationState::Unknown,
    }
}

#[cfg(all(target_os = "macos", test))]
pub(crate) fn macos_notification_signal(
    authorization: objc2_user_notifications::UNAuthorizationStatus,
    alert: objc2_user_notifications::UNNotificationSetting,
) -> NotificationAvailabilitySignal {
    match macos_notification_state(authorization, alert) {
        MacosNotificationState::Enabled => NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::NotDetermined | MacosNotificationState::Unknown => {
            NotificationAvailabilitySignal::Unknown
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_current_notification_state() -> MacosNotificationState {
    use block2::RcBlock;
    use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};
    use std::ptr::NonNull;
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::sync_channel(1);
    let callback = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let settings = unsafe { settings.as_ref() };
        let _ = sender.send(macos_notification_state(
            settings.authorizationStatus(),
            settings.alertSetting(),
        ));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&callback);
    receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or(MacosNotificationState::Unknown)
}

#[cfg(target_os = "macos")]
pub(crate) fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    use std::sync::mpsc;

    match macos_current_notification_state() {
        MacosNotificationState::Enabled => return NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => return NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::Unknown => return NotificationAvailabilitySignal::Unknown,
        MacosNotificationState::NotDetermined => {}
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let callback = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let _ = sender.send(if !error.is_null() {
            NotificationAvailabilitySignal::Unknown
        } else if granted.as_bool() {
            NotificationAvailabilitySignal::Enabled
        } else {
            NotificationAvailabilitySignal::Disabled
        });
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &callback,
        );
    let requested = receiver
        .recv_timeout(Duration::from_secs(30))
        .unwrap_or(NotificationAvailabilitySignal::Unknown);
    if requested != NotificationAvailabilitySignal::Enabled {
        return requested;
    }

    match macos_current_notification_state() {
        MacosNotificationState::Enabled => NotificationAvailabilitySignal::Enabled,
        MacosNotificationState::Disabled => NotificationAvailabilitySignal::Disabled,
        MacosNotificationState::NotDetermined | MacosNotificationState::Unknown => {
            NotificationAvailabilitySignal::Unknown
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    // Freedesktop notification services expose delivery, not a reliable per-app
    // authorization state. Linux therefore uses the visible in-app fallback and
    // records `unavailable` instead of manufacturing a `granted` audit result.
    NotificationAvailabilitySignal::Unknown
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(crate) fn platform_notification_signal(_app_id: &str) -> NotificationAvailabilitySignal {
    NotificationAvailabilitySignal::Unknown
}

#[tauri::command]
pub(crate) async fn roadmap_reminder_notification_permission(
    app: tauri::AppHandle,
) -> RoadmapReminderNotificationPermission {
    let app_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || platform_notification_signal(&app_id))
        .await
        .map(notification_permission_from_signal)
        .unwrap_or(RoadmapReminderNotificationPermission::Unavailable)
}

/// Scoped identity for one reminder occurrence dispatched to the OS.
///
/// Ordering against deletion is explicit: the webview host owns the deletion gate and
/// rechecks the adopted authoritative snapshot immediately before invoking this command.
/// This native boundary only enforces complete scoped identity plus at-most-once dispatch
/// per occurrence for the life of the app process. A notification already handed to the
/// OS is never retracted here.
pub(crate) fn scoped_reminder_dispatch_key(
    project_key: &str,
    phase_id: &str,
    occurrence_key: &str,
) -> Result<String, String> {
    let project = project_key.trim();
    let phase = phase_id.trim();
    let occurrence = occurrence_key.trim();
    if project.is_empty() || phase.is_empty() || occurrence.is_empty() {
        return Err("reminder dispatch identity is incomplete".to_string());
    }
    Ok(format!("{project}\u{1f}{phase}\u{1f}{occurrence}"))
}

pub(crate) fn dispatched_reminder_occurrences() -> &'static Mutex<HashSet<String>> {
    static DISPATCHED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    DISPATCHED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn admit_scoped_reminder_dispatch(key: String) -> Result<(), String> {
    let mut dispatched = dispatched_reminder_occurrences()
        .lock()
        .map_err(|_| "reminder dispatch state unavailable".to_string())?;
    if !dispatched.insert(key) {
        return Err("reminder occurrence already dispatched".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn show_roadmap_reminder_notification(
    app: tauri::AppHandle,
    sound_enabled: bool,
    project_key: String,
    phase_id: String,
    occurrence_key: String,
) -> Result<(), String> {
    let key = scoped_reminder_dispatch_key(&project_key, &phase_id, &occurrence_key)?;
    admit_scoped_reminder_dispatch(key)?;
    let spec = roadmap_reminder_notification_spec(sound_enabled);
    let mut notification = app
        .notification()
        .builder()
        .title(spec.title)
        .body(spec.body);
    if let Some(sound) = spec.sound {
        notification = notification.sound(sound);
    }
    notification.show().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roadmap_reminder_notification_is_fixed_private_and_uses_at_most_one_platform_sound() {
        let muted = roadmap_reminder_notification_spec(false);
        assert_eq!(muted.title, "Roadmap reminder due");
        assert_eq!(muted.body, "Open Supah Coder to review it.");
        assert_eq!(muted.sound, None);

        let audible = roadmap_reminder_notification_spec(true);
        assert_eq!(audible.title, muted.title);
        assert_eq!(audible.body, muted.body);
        assert_eq!(audible.sound, Some(roadmap_reminder_sound()));
        #[cfg(target_os = "windows")]
        assert_eq!(audible.sound, Some("Mail"));
        #[cfg(target_os = "macos")]
        assert_eq!(audible.sound, Some("Submarine"));
        #[cfg(target_os = "linux")]
        assert_eq!(audible.sound, Some("message-new-instant"));
    }

    #[test]
    fn scoped_reminder_dispatch_requires_complete_identity_and_admits_each_occurrence_once() {
        assert!(scoped_reminder_dispatch_key("  ", "phase-1", "occurrence-1").is_err());
        assert!(scoped_reminder_dispatch_key("/work", "", "occurrence-1").is_err());
        assert!(scoped_reminder_dispatch_key("/work", "phase-1", " ").is_err());

        let first =
            scoped_reminder_dispatch_key("/work/scoped", "phase-scoped", "occurrence-scoped")
                .unwrap();
        let repeat =
            scoped_reminder_dispatch_key(" /work/scoped ", "phase-scoped", "occurrence-scoped")
                .unwrap();
        assert_eq!(first, repeat);
        let other = scoped_reminder_dispatch_key("/work/scoped", "phase-scoped", "occurrence-next")
            .unwrap();
        assert_ne!(first, other);

        assert!(admit_scoped_reminder_dispatch(first.clone()).is_ok());
        assert_eq!(
            admit_scoped_reminder_dispatch(repeat).unwrap_err(),
            "reminder occurrence already dispatched"
        );
        assert!(admit_scoped_reminder_dispatch(other).is_ok());
    }

    #[test]
    fn notification_availability_maps_enabled_disabled_and_unknown_without_drift() {
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Enabled),
            RoadmapReminderNotificationPermission::Granted
        );
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Disabled),
            RoadmapReminderNotificationPermission::Denied
        );
        assert_eq!(
            notification_permission_from_signal(NotificationAvailabilitySignal::Unknown),
            RoadmapReminderNotificationPermission::Unavailable
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Granted).unwrap(),
            serde_json::json!("granted")
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Denied).unwrap(),
            serde_json::json!("denied")
        );
        assert_eq!(
            serde_json::to_value(RoadmapReminderNotificationPermission::Unavailable).unwrap(),
            serde_json::json!("unavailable")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_toast_setting_maps_enabled_disabled_and_unknown() {
        use ::windows::UI::Notifications::NotificationSetting;

        assert_eq!(
            windows_notification_signal(Some(NotificationSetting::Enabled)),
            NotificationAvailabilitySignal::Enabled
        );
        for setting in [
            NotificationSetting::DisabledForApplication,
            NotificationSetting::DisabledForUser,
            NotificationSetting::DisabledByGroupPolicy,
            NotificationSetting::DisabledByManifest,
        ] {
            assert_eq!(
                windows_notification_signal(Some(setting)),
                NotificationAvailabilitySignal::Disabled
            );
        }
        assert_eq!(
            windows_notification_signal(None),
            NotificationAvailabilitySignal::Unknown
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_authorization_maps_enabled_disabled_and_unknown() {
        use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSetting};

        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::Authorized,
                UNNotificationSetting::Enabled,
            ),
            NotificationAvailabilitySignal::Enabled
        );
        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::Denied,
                UNNotificationSetting::Disabled,
            ),
            NotificationAvailabilitySignal::Disabled
        );
        assert_eq!(
            macos_notification_state(
                UNAuthorizationStatus::NotDetermined,
                UNNotificationSetting::NotSupported,
            ),
            MacosNotificationState::NotDetermined
        );
        assert_eq!(
            macos_notification_signal(
                UNAuthorizationStatus::NotDetermined,
                UNNotificationSetting::NotSupported,
            ),
            NotificationAvailabilitySignal::Unknown
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_policy_reports_unavailable_instead_of_granted() {
        assert_eq!(
            platform_notification_signal("com.ggcoder.app"),
            NotificationAvailabilitySignal::Unknown
        );
    }
}
