# Preserving Local Fixes Across App Updates

Official GG App updates install the released app binary and resources. They cannot preserve local source-code fixes that only exist in your checkout.

Local-patched builds solve the safe path differently:

- They still check the official release feed and show when an update is available.
- They do **not** install the official updater binary directly.
- When an update appears, rebase your local source branch on upstream, reapply work, run checks, and build a new local-patched installer.

## Fork auto-detection

This fork auto-enables local-patched mode for normal dev/build commands when the checkout looks like `creativeprofit22/gg-framework` or the current branch is `custom/local-customizations`. That means plain `pnpm --filter gg-app build` and Tauri dev builds visibly identify as a custom fork and route installs through the safe source-update workflow.

The safe update workflow is intentionally tied to `custom/local-customizations` by default. Use `--allow-other-branch` only when you intentionally want the same rebase workflow on another branch.

## Safe update command

From the repository root, run:

```bash
git fetch --multiple upstream origin --tags --prune
git switch custom/local-customizations
pnpm --filter gg-app update:local-fixes -- --check
```

That workflow rebases `custom/local-customizations` on `upstream/main` by default and refuses automatic merge commits.

It:

1. Refuses to start during unresolved conflicts, rebase, merge, or cherry-pick operations.
2. Saves a backup patch and git status under `.gg/local-fixes/backups/`.
3. Stashes local tracked and untracked work.
4. Fetches the selected remote and branch.
5. Creates a backup branch at the pre-update `HEAD`.
6. Rebases on the selected target and stops for manual conflict resolution when needed.
7. Pops the stash to reapply your local work after a successful rebase.
8. Refreshes platform-specific dependencies so Windows/WSL optional packages don't block the build.
9. Runs app and sidecar checks when `--check` is passed.
10. Builds a new local-patched installer unless `--no-build` is passed.

Useful options:

```bash
pnpm --filter gg-app update:local-fixes -- --remote upstream --branch main
pnpm --filter gg-app update:local-fixes -- --no-install --no-build
pnpm --filter gg-app update:local-fixes -- --dry-run --no-build
pnpm --filter gg-app update:local-fixes -- --allow-other-branch --check
```

## If conflicts happen

Conflicts mean the official update touched the same files as your local fixes. Resolve them manually, then continue the rebase:

```bash
git add <files>
git rebase --continue
git stash pop  # only if the script reported stashed local work
pnpm install --frozen-lockfile
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app build:local-patched
```

To abort and recover instead, run:

```bash
git rebase --abort
```

Then use the backup branch or backup patch path printed by the script.

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
