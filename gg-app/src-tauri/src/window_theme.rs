//! Startup theme hint for native windows. The chosen theme lives in the webview's
//! storage, which Rust cannot read before a window exists; the frontend mirrors it
//! here so new windows open with the matching native background and chrome instead
//! of flashing dark while the page loads. The file is a cosmetic hint: anything
//! missing or unrecognized falls back to Dark.
//!
//! Even with the right background, WebView2 paints a neutral near-black surface
//! for a moment before it applies that colour. New windows therefore stay hidden
//! until their page has loaded (or a short fallback elapses) and are revealed once.
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

const HINT_FILE: &str = "gg-app-window-theme";

/// Longest a new window stays hidden waiting for its first page load, so a slow
/// or failed load can never leave a window invisible.
pub const REVEAL_FALLBACK: Duration = Duration::from_millis(2000);

/// Shows a deferred window exactly once, whichever of page-load or fallback wins.
#[derive(Clone, Default)]
pub struct RevealOnce(Arc<AtomicBool>);

impl RevealOnce {
    /// True only for the first caller; later calls (reloads, the fallback) do nothing,
    /// so a window the user minimized is never pulled back up.
    pub fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }

    pub fn reveal<R: tauri::Runtime>(&self, window: &tauri::WebviewWindow<R>) {
        if self.claim() {
            if let Err(error) = window.show() {
                log::warn!(
                    "window reveal failed: label={} error={error}",
                    window.label()
                );
            }
            let _ = window.set_focus();
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowTheme {
    Dark,
    Light,
}

impl WindowTheme {
    fn as_str(self) -> &'static str {
        match self {
            WindowTheme::Dark => "dark",
            WindowTheme::Light => "light",
        }
    }

    fn parse(raw: &str) -> WindowTheme {
        match raw.trim() {
            "light" => WindowTheme::Light,
            _ => WindowTheme::Dark,
        }
    }

    /// Must match NATIVE_APPEARANCE_BACKGROUNDS in src/appearance-native.ts;
    /// enforced by src/window-theme-colors.test.ts.
    pub fn background(self) -> tauri::window::Color {
        match self {
            WindowTheme::Dark => tauri::window::Color(15, 17, 21, 255),
            WindowTheme::Light => tauri::window::Color(252, 251, 253, 255),
        }
    }

    pub fn tauri_theme(self) -> tauri::Theme {
        match self {
            WindowTheme::Dark => tauri::Theme::Dark,
            WindowTheme::Light => tauri::Theme::Light,
        }
    }
}

pub fn read_hint(root: &Path) -> WindowTheme {
    std::fs::read_to_string(root.join(HINT_FILE))
        .map(|raw| WindowTheme::parse(&raw))
        .unwrap_or(WindowTheme::Dark)
}

fn write_hint(root: &Path, theme: WindowTheme) -> Result<(), String> {
    if std::fs::read_to_string(root.join(HINT_FILE)).is_ok_and(|raw| raw == theme.as_str()) {
        return Ok(());
    }
    std::fs::create_dir_all(root)
        .map_err(|error| format!("failed to create {}: {error}", root.display()))?;
    let dir = cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())
        .map_err(|error| format!("failed to open {}: {error}", root.display()))?;
    super::atomic_write_identity_file(&dir, root, HINT_FILE, theme.as_str().as_bytes())
}

/// Remember the selected theme for the next native window this identity opens.
#[tauri::command]
pub fn set_window_theme_hint(app: tauri::AppHandle, theme: WindowTheme) -> Result<(), String> {
    write_hint(&super::agent_data_root(&app.config().identifier), theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("gg-window-theme-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn missing_or_unknown_hint_falls_back_to_dark() {
        let root = temp_root("fallback");
        assert_eq!(read_hint(&root), WindowTheme::Dark);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(HINT_FILE), "purple").unwrap();
        assert_eq!(read_hint(&root), WindowTheme::Dark);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reveal_is_claimed_exactly_once() {
        let reveal = RevealOnce::default();
        let fallback = reveal.clone();
        assert!(reveal.claim());
        assert!(!fallback.claim());
        assert!(!reveal.claim());
    }

    #[test]
    fn written_hint_round_trips() {
        let root = temp_root("round-trip");
        write_hint(&root, WindowTheme::Light).unwrap();
        assert_eq!(read_hint(&root), WindowTheme::Light);
        write_hint(&root, WindowTheme::Dark).unwrap();
        assert_eq!(read_hint(&root), WindowTheme::Dark);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
