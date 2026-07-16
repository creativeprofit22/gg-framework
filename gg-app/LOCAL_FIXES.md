# Preserving Local Fixes Across App Updates

Official GG App updates replace the installed binary and cannot preserve source-only fixes from this checkout. A local-patched build still checks the official release feed, but routes installation through this repository instead of installing the official binary directly.

## Protected checkout

Local-patched mode auto-detects the canonical `custom/local-customizations` branch, the temporary `custom/local-customizations-v2` cutover branch, and the configured fork origin. Detection fails closed when Git metadata is unavailable; set `VITE_GG_LOCAL_PATCHED=1` and `VITE_GG_SOURCE_ROOT=<repo>` explicitly for detached or exported builds.

The updater accepts `custom/local-customizations` by default and temporarily accepts `custom/local-customizations-v2` during the cutover. `custom/local-customizations-safety` is a read-only reference and is never an update target. Use `--allow-other-branch` only for an intentional branch override.

## Update local fixes

From the repository root:

```bash
git switch custom/local-customizations
pnpm --filter gg-app update:local-fixes -- --check
```

The workflow defaults to `upstream/main` and:

1. Rejects unresolved conflicts and in-progress Git operations.
2. Saves the tracked diff and status under `.gg/local-fixes/backups/`.
3. Stashes tracked and untracked work.
4. Fetches `upstream/main`.
5. Creates a `gg-local-before-update-*` safety ref at the old `HEAD`.
6. Rebases onto `upstream/main` without creating a merge commit.
7. Restores stashed work and normalizes the Rust bridge's line endings.
8. Optionally refreshes dependencies, checks TypeScript, and builds a patched installer.

Preview the exact plan without mutation:

```bash
pnpm --filter gg-app update:local-fixes -- --dry-run --no-install --no-build --check
```

Useful overrides:

```bash
pnpm --filter gg-app update:local-fixes -- --remote upstream --branch main
pnpm --filter gg-app update:local-fixes -- --no-install --no-build
pnpm --filter gg-app update:local-fixes -- --allow-other-branch --check
```

## Conflict recovery

If rebase conflicts occur, follow the backup/stash instructions printed by the script, then:

```bash
git add <files>
git rebase --continue
git stash pop  # only when the script says local work remains stashed
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app build:local-patched
```

To recover instead, run `git rebase --abort` and use the printed safety ref or patch path.

## Build a local-patched installer

```bash
pnpm --filter gg-app build:local-patched
```

`build:local-hotfix` remains an alias. Build on the target OS: Windows produces `.msi`/`.exe`, macOS produces `.dmg`, and Linux produces `.AppImage`.
