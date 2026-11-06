# ADR 0007: One daemon serves every window, and the webview reaches it only through Rust

**Status:** Accepted. Written down on 2026-11-05 from the code and project
instructions; the original date and the alternatives weighed were not recorded.

## Context

The desktop app runs agent sessions in a Node daemon (`ggcoder`'s
`app-sidecar.ts`) that listens on loopback HTTP. The webview loads from a
secure Tauri origin, so a plain `http://127.0.0.1` request from it fails as
mixed content. The daemon also needs credentials that page code must never
see.

## Decision

- Rust spawns one daemon per app launch, and every window and pane shares it.
  Each pane is a logical session.
- The webview never calls the daemon's HTTP. It goes through Rust `invoke`;
  Rust adds the per-launch `x-gg-token` and the pane's `x-gg-session`, and
  forwards the daemon's server-sent events as `agent-event`.
- Rust emits events to one window at a time (`emit_to`), so the frontend
  listens with `getCurrentWebviewWindow().listen`.

## Consequences

- The token and session headers never reach webview code.
- Every new daemon route needs a matching Rust command; there is no shortcut
  from the page.
- One daemon means one process to start, sign in and update, but a daemon
  crash affects every window, and per-pane isolation must be kept in the
  daemon's session handling.
- Hard to reverse: the frontend, Rust commands and daemon routes are all built
  around this bridge.
