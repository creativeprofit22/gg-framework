# ADR 0006: The Local Fork installs under its own app identity with the updater off

**Status:** Accepted, 2026-08-09 (commit `8854e1c4`, "isolate local fork
installation"). Written down on 2026-11-05 from the code and project
instructions; the alternatives weighed at the time were not recorded.

## Context

This checkout is a fork of GG Coder that carries its own changes and is
installed on the same machines as the official app. Tauri keys the app's data
folder to the bundle identifier. Shipped as `com.ggcoder.app`, the fork would
share the official app's data and land on the official install, and the
official updater would then replace it with an upstream release, dropping the
fork's changes.

## Decision

- The base `gg-app/src-tauri/tauri.conf.json` stays exactly as upstream ships it
  (`com.ggcoder.app`, updater on), so upstream syncs merge cleanly.
- The fork's identity, `com.ggcoder.local-fork`, lives only in
  `tauri.local.conf.json` and the `build-local-hotfix.mjs` overlay, with the
  updater off. Fork updates come from rebuilding this checkout instead.
- Installed smoke tests use a third identity,
  `com.ggcoder.local-fork.installed-smoke`, so tests never touch a real install.
- `assertIsolatedIdentities` fails the build if any identity leaks into another
  build's configuration.

## Consequences

- The fork and the official app can be installed side by side, each with its
  own data.
- Hard to reverse: changing the fork's identifier later strands the existing
  install's data and leaves a second app installed.
- Fork users get changes only when someone rebuilds and installs the fork.
