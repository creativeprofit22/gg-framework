# GG App terminal removal outcome

## Outcome

GG App is agent-pane only. The embedded terminal UI, terminal workspace descriptors, Tauri terminal commands, and Rust-owned PTY runtime have been removed.

The separate `ggcoder` agent `bash` tool remains supported. It runs through ggcoder's persistent-shell path and is not part of the GG App workspace runtime.

## Current contract

- Workspace schema v9 persists only agent pane descriptors and ratio splits.
- Valid legacy layouts are migrated by pruning terminal leaves, collapsing empty split branches, and preserving surviving agent panes and ratios.
- A legacy terminal-only layout recovers to one unbound `primary` agent pane.
- GG App enforces the existing 12-agent-pane limit and keeps pane/window ownership isolation.
- GG App exposes no terminal controls, terminal IPC wrappers, PTY process state, or external-terminal launch command.
- GG App does not depend on xterm or `portable-pty`.
- Generic pane splitting, resizing, moving, drag/drop, persistence, native-window creation, and sidecar-backed agent sessions remain supported.
- Historical changelog entries remain unchanged because they describe released behavior at that time.

## Packaging and permissions

- Tauri opener permission remains because Markdown links, MCP, provider login, Telegram, project paths, and updater flows use it.
- Existing Node/JIT, camera, sidecar, updater, dialog, logging, and process-plugin configuration remains unrelated to terminal removal.
- `smoke-tauri-windows.mjs` remains a general packaged-window and process-isolation smoke; it has no terminal-interaction contract.

## Verification

Terminal-removal changes are verified with GG App tests, type checking, linting, formatting, frontend build, Cargo tests and formatting, targeted tests for the preserved ggcoder shell path, sidecar staging/bundling, and the sidecar smoke test. Targeted searches must distinguish legacy migration fixtures and historical release notes from active terminal runtime references.