# Preserving Local Fixes Across App Updates

Official GG App updates replace the installed binary and cannot preserve source-only fixes from this checkout. A local-patched build never contacts the official release feed; updates are started explicitly and routed through this repository.

## Protected checkout

Local-patched mode auto-detects the canonical `custom/local-customizations` branch, the temporary `custom/local-customizations-v2` cutover branch, and the configured fork origin. Detection fails closed when Git metadata is unavailable. For detached builds with accessible Git metadata, set `VITE_GG_LOCAL_PATCHED=1` and `VITE_GG_SOURCE_ROOT=<repo>` explicitly; the full 40-character commit SHA is derived automatically. For exported builds without Git metadata, also set `VITE_GG_GIT_SHA=<full-40-character-source-commit-sha>`; the Vite build fails rather than producing a Local Fork whose update status cannot be determined.

The updater accepts `custom/local-customizations` by default and temporarily accepts `custom/local-customizations-v2` during the cutover. `custom/local-customizations-safety` is a read-only reference and is never an update target. Use `--allow-other-branch` only for an intentional branch override.

## Update local fixes

From the repository root:

```bash
git switch custom/local-customizations
pnpm --filter gg-app update:local-fixes -- --check
```

The workflow defaults to `upstream/main` and:

1. Rejects unresolved conflicts and in-progress Git operations.
2. Records the source/fork OIDs, merge base, local commit range, tracked patch, and dirty status in a timestamped manifest under `.gg/local-fixes/backups/`.
3. Fetches `upstream/main` and `origin/custom/local-customizations`.
4. Creates `gg-local-before-update-*` at the old `HEAD` before merging.
5. Stashes tracked and untracked work and records the stash OID.
6. Merges upstream with `--no-ff --no-commit`, stopping before a merge commit when semantic conflict review is required.
7. Commits a clean merge while keeping the recorded dirty-work stash active.
8. Verifies identity and runs required checks against only committed source bytes.
9. Builds a fresh Windows NSIS installer, then restores dirty work byte-for-byte.
10. Retains the backup branch. The app never pushes; CLI push requires an explicit normal fast-forward push.

Preview the exact plan without mutation:

```bash
pnpm --filter gg-app update:local-fixes -- --dry-run --no-install --no-build
```

Useful overrides:

```bash
pnpm --filter gg-app update:local-fixes -- --remote upstream --branch main
pnpm --filter gg-app update:local-fixes -- --no-install --no-build --no-check
pnpm --filter gg-app update:local-fixes -- --allow-other-branch --no-build --no-check
```

To sync only a reviewed revision, add `--source-commit <full-40-character-SHA>` to the same workflow:

```bash
pnpm --filter gg-app update:local-fixes -- --remote upstream --branch main --source-commit d3786e388e15f6b26f984a9b1cc42eb79ff43d96 --no-install --no-build
```

The pin must be an existing commit reachable from the fetched source branch. Invalid, missing, non-commit, or unrelated pins fail before backup creation, stashing, or merging. Fetching may download newer commits, but only the pinned OID is merged and recorded as the source. Without a pin, the workflow merges the immutable OID resolved from that fetch. Dry runs do not fetch or validate remote ancestry; they only print those steps. Pins do not bypass checks, identity validation, dirty-work recovery, installer requirements for push, or normal-push restrictions. `--no-build` leaves the installed application unchanged.

## Conflict recovery

A merge conflict, dirty-work restore conflict, identity drift, changed merge result, failed check, or failed build stops before push. Dirty bytes stay stashed through checks and packaging. After either success or a check/build failure, the workflow reapplies them and verifies both Git status and captured file bytes. If automatic restoration itself conflicts, the backup branch, stash, patch, and byte snapshots remain available. Follow the printed manifest instructions, then:

```bash
git status
git add <resolved-files>
git commit # complete the merge only after semantic review
# Apply the printed stash OID only when the updater says dirty work was not applied.
git stash apply --index <printed-stash-oid>
pnpm --filter gg-app check
pnpm --filter @kenkaiiii/ggcoder check
pnpm --filter gg-app build:local-patched
```

Follow the manifest's `phase` and `dirtyWorkApplied` fields before touching the stash. To abandon a conflicted merge, run `git merge --abort`, switch or reset to the printed backup branch, and recover dirty work from the recorded stash OID, manifest, byte-for-byte worktree backup, or patch path. The automated flow drops the stash only after successful verification and restoration.

## Build a local-patched installer

The current user-facing release entry lives in `src/local-release-notes.json`. Keep schema version 1, use only `date`, `label`, and bounded `sections` with `title` and `items`, and commit the file before building. `src/local-changelog.ts` validates and prepends that object to the immutable Local Fork history.

```bash
pnpm --filter gg-app build:local-patched
```

`build:local-hotfix` remains an alias. Direct builds require a completely clean worktree, including no untracked files, and require the note bytes to be tracked and identical to `HEAD`. The protected updater satisfies this while dirty user files remain in its stash.

The generated `.gg/local-fixes/latest-installer.json` uses schema 2. One record binds the full `sourceRevision`, installer SHA-256, patched executable SHA-256, and `releaseNotes` envelope size, SHA-256, and canonical base64 bytes. The decoded envelope uses schema 1 and contains that same revision plus the strictly validated note object.

After updating source, native code resolves the checkout's full `git rev-parse HEAD` and invokes `launch-local-patched.ps1` with `-MetadataPath <schema-2-manifest> -ExpectedVersion <numeric-version> -ExpectedSourceRevision <full-40-character-HEAD>`. The launcher propagates the same revision to `install-local-patched.ps1`. Both scripts reject missing fields, legacy schemas, malformed or oversized notes, invalid base64, byte-size or digest changes, and any revision mismatch before scheduling, app shutdown, or installer execution.

The installer built at `16bf3d94` with SHA-256 `e535852c162c637131e67b241b9e1bf08e62b70b4197924107927b7eb1e4dcdb` predates this contract and contains no compiled current release note. It cannot be upgraded in place and is intentionally rejected as notes-missing. Build a replacement only from a later clean commit containing this contract and note source; its `sourceRevision` must be that replacement commit, not `16bf3d94`.

## Verified fork push

App-triggered updates never push. After reviewing the backup manifest, checks, and installer hash, an operator may rerun the CLI flow with `--push`. The updater uses only a normal fast-forward push:

```bash
git push origin HEAD:refs/heads/custom/local-customizations
```

A concurrent or diverged fork update makes the push fail. Force pushes, pushes to `upstream`, noncanonical branches, skipped checks, and skipped builds are rejected.
