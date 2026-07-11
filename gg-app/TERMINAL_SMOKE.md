# Native terminal cleanup smoke

The Windows Job Object cleanup path is covered by the native Rust unit test in `src-tauri/src/terminal.rs`.

The repo-local Tauri smoke was **attempted but not completed**. The dev process exposed only a blank 16×16 `Tao Thread Event Target` window to Windows UI Automation, so terminal controls could not be selected deterministically. No result is claimed for closing a real terminal panel in the Tauri webview.
