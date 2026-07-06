# Preserving Local Fixes Across App Updates

Official GG App updates install the released app binary and resources. They cannot preserve local source-code fixes that only exist in your checkout.

Local-patched builds solve the safe path differently:

- They still check the official release feed and show when an update is available.
- They do **not** install the official updater binary directly.
- When an update appears, update your source tree, reapply your local fixes, run checks, and build a new local-patched installer.

## Fork auto-detection

This fork auto-enables local-patched mode for normal dev/build commands when the checkout looks like `creativeprofit22/gg-framework` or the current branch is `custom/local-customizations`. That means plain `pnpm --filter gg-app build` and Tauri dev builds visibly identify as a custom fork and route installs through the safe source-update workflow.

The safe update workflow targets the branch configured in git by default. In this checkout, `custom/local-customizations` tracks `origin/custom/local-customizations`, so that is the default source update target unless you pass explicit overrides.

## Safe update command

From the repository root, run:

```bash
pnpm --filter gg-app update:local-fixes
```

That workflow:

1. Saves a backup patch and git status under `.gg/local-fixes/backups/`.
2. Stashes local tracked and untracked work.
3. Fetches the selected remote and branch.
4. Fast-forwards when possible, or creates a backup branch and merge-commits the update when committed local fixes are ahead.
5. Pops the stash to reapply your local fixes.
6. Refreshes platform-specific dependencies so Windows/WSL optional packages don't block the build.
7. Runs app and sidecar checks.
8. Builds a new local-patched installer.

Useful options:

```bash
pnpm --filter gg-app update:local-fixes -- --remote origin --branch main
pnpm --filter gg-app update:local-fixes -- --no-install --no-build
pnpm --filter gg-app update:local-fixes -- --dry-run --no-build
```

## If conflicts happen

Conflicts mean the official update touched the same files as your local fixes. Resolve them manually, then run:

```bash
pnpm install --frozen-lockfile
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app build:local-patched
```

If you need to recover your previous local edits, use the backup patch path printed by the script.

## Building local-patched installers

Use:

```bash
pnpm --filter gg-app build:local-patched
```

### Windows installers

Run the build from Windows PowerShell or Command Prompt when you need `.msi` / `.exe` installers:

```powershell
pnpm install --frozen-lockfile
pnpm --filter gg-app build:local-patched
```

WSL builds as Linux, not Windows. If WSL reports a missing Linux Rollup optional package such as `@rollup/rollup-linux-x64-gnu`, that only means the current WSL `node_modules` are not installed for Linux; it is not a blocker for a Windows build run from Windows.

The old command still works as an alias:

```bash
pnpm --filter gg-app build:local-hotfix
```
