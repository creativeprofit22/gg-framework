---
name: cleanup
description: Report audited generated artifacts without changing the working tree
---

1. Run `node scripts/audit-generated.mjs <target>` to report the audited generated-artifact paths.
   This command is **read-only** and never changes files.
2. Use one audited target at a time:
   - `tauri` — `gg-app/src-tauri/target/debug` and `gg-app/src-tauri/target/release`.
   - `sidecar-deps` — `gg-app/src-tauri/sidecar/node_modules`.
3. The audit always reports these protected paths, which are never selected:
   - `.gg/phase3a-cdp`
   - `.gg/evidence`
   - `.gg/screenshots`
   - `node_modules` at the repository root
   - `gg-app/src-tauri/binaries`
4. Other audited generated-artifact targets are `web`, `tauri-schemas`, `cache`, and `packages`.
5. Confirm the result with `git status --short` and report the audit output.
