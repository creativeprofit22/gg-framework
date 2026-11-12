# Slash Command Steroids Migration Audit

Audit date: 2026-09-03.

## Final status

The slash-command migration is complete at `bd863399bac81d77708bfe84590f9acefa4b1f35`.

- Ten canonical command assets now use Steroids: `/contract`, `/flow`, `/parity`, `/research`, `/setup-sweep`, `/ship`, standalone `/sweep`, `/trace`, `/ux-audit`, and `/ux-plan`.
- The ten installed global copies are byte-identical to those assets.
- The `/setup-sweep` asset also contains the Steroids-migrated template used to generate a project-local `/sweep`.
- This repository has no generated `.gg/commands/sweep.md`; the installed standalone `/sweep` is therefore the active fallback here.
- The deprecated command-tool pattern has zero matches in the canonical command assets and the complete installed global command directory.
- The executable research benchmark variant was migrated in the final cleanup commit.
- Remaining repository matches are classified fixtures, historical documentation, or unrelated compatibility identities. They are not production defects in these command migrations.

No implementation was revisited during closeout. This document is the only worktree addition.

## Verified Git history

`git log --reverse --format='%H%x09%s' b909328f^..bd863399` reports this contiguous migration sequence:

| Commit                                     | Migration                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `b909328fac22d6c3640c5f2b8cc6e55fb4d067f9` | Make canonical `/research` and its Chat specialist Steroids-first; update their tests.                                          |
| `95e2e6ec1413694c663f3b53c4a5f561f8e8c078` | Add canonical `/contract`, its installer, package script, and tests.                                                            |
| `cf6dd1f3d7e7b4f45ab6dd068c7decd69350a458` | Add canonical `/flow`, its installer, package script, and tests.                                                                |
| `29a28532cbc838497de3d3b7baf2f1554df19dbe` | Add canonical `/parity`, its installer, package script, and tests.                                                              |
| `fc788eda8d0fd20d76076961a67c52848f784db2` | Add canonical `/setup-sweep`, including the generated project-template migration, installer, package script, and tests.         |
| `9db51dd3131e0f2fcb186fc65f74c960592b1c71` | Add canonical standalone `/sweep`, its installer, package script, and tests.                                                    |
| `1294e54814dba8be2f293a7a0afcad4f792b04c4` | Add canonical `/ship`, its installer, package script, and tests.                                                                |
| `b88bf8121fb5c49e670c6bf9dd0cc52f3057ff48` | Add canonical `/trace`, its installer, package script, and tests.                                                               |
| `51fb17bff88499da3ff123570742ad6c6e10b1fe` | Add canonical `/ux-audit`, its installer, package script, and tests.                                                            |
| `bf4d26cc2e682c471a303d9069f14e6d66241f88` | Add canonical `/ux-plan`, its installer, package script, and tests.                                                             |
| `bd863399bac81d77708bfe84590f9acefa4b1f35` | Replace the executable benchmark's old research sequence with `search` → `show`, gap-only `discover`, and approval-gated `add`. |

At closeout, `HEAD` is the benchmark cleanup commit. No migration commit is missing from the range.

## Source, installation, and runtime topology

### Canonical and installed copies

Every migrated command now has the same topology:

```text
packages/ggcoder/assets/commands/<name>.md       canonical tracked source
packages/ggcoder/scripts/install-<name>-command.mjs
package.json: commands:install:<name>            explicit installer entry
<agentDir>/commands/<name>.md                    installed global copy
```

`<agentDir>` is an absolute `GG_AGENT_DIR` when supplied, otherwise `~/.gg`. The installers read canonical bytes, reject a relative override or symlink command directory, write a private unique temporary file, atomically rename it, apply mode `0600`, and report SHA-256. Installation is explicit: there is no `postinstall` or `prepare` hook.

Global discovery checks the configured agent directory before home and platform fallback directories. Duplicate global names keep the first result. A project-local `<cwd>/.gg/commands/<name>.md` then overrides a global command of the same name. Built-in prompt commands still precede custom Markdown commands, and registered actions follow them.

The Markdown parser consumes `name` and `description` frontmatter but does not enforce `allowed-tools` or interpolate `$ARGUMENTS`; arguments are appended as user instructions. Those existing runtime rules were not changed by this migration.

Desktop Chat `/research` remains a special route that bypasses the Markdown asset and uses the bundled research specialist. Commit `b909328f` migrated that specialist to the native `steroids` tool and removed its Kencode-specific allowed-tool prefix. Code-mode `/research` uses normal custom-command expansion.

### Package-script coverage

The root package exposes one explicit installation script for every canonical command:

| Command        | Package script                 | Installer test                         |
| -------------- | ------------------------------ | -------------------------------------- |
| `/contract`    | `commands:install:contract`    | `install-contract-command.test.mjs`    |
| `/flow`        | `commands:install:flow`        | `install-flow-command.test.mjs`        |
| `/parity`      | `commands:install:parity`      | `install-parity-command.test.mjs`      |
| `/research`    | `commands:install:research`    | `install-research-command.test.mjs`    |
| `/setup-sweep` | `commands:install:setup-sweep` | `install-setup-sweep-command.test.mjs` |
| `/ship`        | `commands:install:ship`        | `install-ship-command.test.mjs`        |
| `/sweep`       | `commands:install:sweep`       | `install-sweep-command.test.mjs`       |
| `/trace`       | `commands:install:trace`       | `install-trace-command.test.mjs`       |
| `/ux-audit`    | `commands:install:ux-audit`    | `install-ux-audit-command.test.mjs`    |
| `/ux-plan`     | `commands:install:ux-plan`     | `install-ux-plan-command.test.mjs`     |

There is no implicit bulk install. Closeout ran all ten installer suites together and independently verified every installed target against its canonical asset.

### Installed-copy equality

The following SHA-256 values are shared by each canonical asset and installed global copy:

| Command        | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| `/contract`    | `a424e8028943f9ad84516c89cab523d30f0dc9625e1ab3a6a231a966b282d2da` |
| `/flow`        | `1572acde61a3397dfba18e9648f344e9dd246a1140d55a72f9393262e73dcdd1` |
| `/parity`      | `19fbc8c550cdb43435a916fcc3766dd134ca43b49f9f8af9083138bb8c0f0333` |
| `/research`    | `b0aeeec030a8c9a19e61dfd2280433e4ec2f95cb6f20790a49903453bc5bbb05` |
| `/setup-sweep` | `535f554d27ea3a66ebf178a1010abfe58f448de4fd3de48b2b22e43e804bbe7e` |
| `/ship`        | `b293f1237494141bf38a395625d1daa488042445d3b24b9dce80c995126c428b` |
| `/sweep`       | `1a4741dc27083e21d3ba2ad26195061cd24d4a28e51c3894d4c71892a8c10cd2` |
| `/trace`       | `ef56634b7df32c80a79d6a70961ff0bab651904274e5ce56bf961b59422af29b` |
| `/ux-audit`    | `8c7af8a7d344e0038f0c0e2c3f02439feba8da587cc1bbf9c505c933be81c6a2` |
| `/ux-plan`     | `8e6fda43c9a9adc8556fa94e3666fe2e5050a9c668bce72956c8fcfcbdbf2c49` |

Direct edits under `~/.gg/commands` are installed-copy edits and can be overwritten. Change the tracked asset, update its tests, and reinstall instead.

## Exact Steroids mapping and approval boundary

### Operation mapping

| Former behavior                         | Final Steroids behavior                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__kencode-search__searchCode`       | `action: "search"` with literal code tokens and narrow filters, then `action: "show"` for every selected file.                                                                   |
| `mcp__kencode-search__discoverRepos`    | `action: "discover"` only for a real corpus gap; present suitable results; obtain explicit approval; `action: "add"` only for selected repositories; repeat `search` and `show`. |
| `mcp__kencode-search__referenceSources` | No exact catalogue equivalent. Use `repos` for indexed coverage and filtered, breadth-oriented `search`; use `discover` only for a documented gap.                               |
| Named definition lookup                 | `define`, followed by `show` for evidence.                                                                                                                                       |
| Repository path inventory               | `files`.                                                                                                                                                                         |
| Bounded upstream-change lookup          | `recent(hours=...)`; it is not a popularity or general maintenance ranking.                                                                                                      |
| Offset pagination                       | No equivalent. Narrow by repository, path, language, tag, or literal pattern and honor `more_available` and `omitted`.                                                           |
| Immutable citation                      | Retain the SHA-pinned URL returned by `search` while using `show` for the relied-upon lines.                                                                                     |

`search` is literal/regex corpus search, not semantic search. `perRepo: 1` is used when repository diversity matters. `define` is corpus-wide and cannot be repository-filtered.

### Approval boundary

Commands may automatically call `discover` only after Steroids reports a real corpus gap. Discovery itself must not use `add: true`. Before any corpus mutation, the command must present suitable repositories through `ask_user` and receive explicit user approval. It may then add only the selected repositories and must repeat `search` and `show`. A declined addition or unsuccessful discovery falls back to primary sources with the missing real-code comparison disclosed.

This is the only state-change exception in read-only `/research`. External source evidence can ground public APIs and patterns, but cannot prove local reachability, deadness, correctness, or business behavior.

### Per-command mapping

| Command        | Migrated use                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/contract`    | Search literal public interface, option, import, method, or configuration tokens; show 2–3 accepted implementations; use local declarations and consumers as authority.                   |
| `/flow`        | Search literal architecture anchors with `perRepo: 1`; show 2–3 implementations; inspect indexed activity with `repos`; reserve `recent` for bounded freshness questions.                 |
| `/parity`      | Search literal imports, APIs, generated names, decorators, cache keys, or configuration keys; show the accepted implementation; preserve local requirements as authority.                 |
| `/research`    | Use `repos`, breadth `search`, `show`, `define`, `files`, and narrowly scoped `recent`; narrow rather than paginate; stop when evidence is sufficient; preserve immutable provenance.     |
| `/setup-sweep` | The generator and embedded project template search/show only unfamiliar external refactor patterns; use the approval-gated gap flow; never use external evidence to prove local deadness. |
| `/ship`        | Search/show uncertain build, framework, generated-client, migration, authentication, or deployment conventions; local build, test, and runtime evidence decides release status.           |
| `/sweep`       | Search/show unfamiliar external refactor patterns; use the approval-gated gap flow; local imports and references alone determine deletion findings.                                       |
| `/trace`       | Search/show unfamiliar routing, server-action, cache, IPC, decorator, ORM, plugin, or environment conventions; local callers and runtime wiring remain authoritative.                     |
| `/ux-audit`    | Inspect UI corpus coverage with `repos`; breadth-search literal component, route, state, or layout anchors; show accepted evidence and retain repository, path, lines, and immutable URL. |
| `/ux-plan`     | Reopen a cited repository/path with `repos` and `show`; use repository-scoped `search` when incomplete; use breadth search only when the audit lacks a reference.                         |

`KenKaiii/king` in `/ux-plan` is an owner/repository coordinate, not legacy tool branding, and remains intentionally unchanged.

## `/setup-sweep` and standalone `/sweep`

These tracked assets are intentionally different and must not be collapsed:

- `/setup-sweep` inventories the project, offers setup modes, optionally recommends tools with approval, writes `.gg/sweep.config.json`, and generates a project-local `.gg/commands/sweep.md` from its embedded template.
- The generated template requires valid project configuration, substitutes project-specific globs and analyzer commands, and stops with a `/setup-sweep` instruction when configuration is absent or malformed.
- Standalone `/sweep` is a globally installed fallback. It prefers project configuration but, when none exists, recommends `/setup-sweep` and can continue only after confirmation in a no-install baseline mode.
- Baseline mode is limited to Git, file/find/grep and import reading, plus clearly safe existing package scripts. It cannot install, download, generate, migrate, or otherwise mutate the project.
- Both forms keep the same Prune, Refactor, and Drift lanes, local-evidence authority, Steroids approval boundary, task schema, dedupe rules, and severity model.
- Existing generated project-local copies elsewhere do not update automatically when `/setup-sweep` changes.

The two canonical assets have different hashes, proving the installed standalone fallback is not a copy of the embedded generated template. This repository's absent `.gg/commands/sweep.md` confirms the global fallback is active here.

## Executable benchmark cleanup

Commit `bd863399bac81d77708bfe84590f9acefa4b1f35` changed `experiments/prompt-bench/variants.ts` by one insertion and one deletion. The executable `research.aggressive` variant now requires exact-anchor Steroids `search`, selected-file `show`, gap-only `discover`, and explicit approval before `add`. This removes the final old command-research sequence from executable benchmark configuration rather than treating it as harmless historical prose.

## Classified legacy-name inventory

The closeout inventory used this case-insensitive pattern across tracked files plus the sole untracked audit:

```text
mcp__kencode-search|kencode-search|ken-mcp|Ken-first|Ken MCP|Ken capabilities
```

Canonical command assets and installed global commands have zero matches. The complete tracked-plus-untracked repository inventory has 68 matching lines across 25 files:

| Classification                             | Lines | Files | Why retained                                                                                                                                                   |
| ------------------------------------------ | ----: | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negative or compatibility fixtures         |    49 |    19 | Installer tests assert forbidden terms are absent; routing/tool tests exercise rejection, filtering, formatting, and backward-compatible persisted identities. |
| Historical documentation                   |    10 |     3 | Changelog entries preserve release history; this final audit quotes former names solely to record and classify the migration.                                  |
| Unrelated runtime compatibility identities |     9 |     3 | Generic MCP pooling and tool-result formatting still recognize an independently named legacy server identity; slash-command sourcing does not use it.          |

The first class includes `fixtures/project-notes-v3.json` and tracked test files. The second is this audit, `packages/ggcoder/CHANGELOG.md`, and `gg-app/src/changelog.ts`. The third is `gg-app/src/tool-format.ts`, `packages/ggcoder/src/app-sidecar.ts`, and `packages/ggcoder/src/core/mcp/shared-client-pool.ts`.

These matches are outside the migrated command assets and benchmark variant. They are deliberate negative fixtures, historical records, or unrelated compatibility identities—not evidence that any migrated production command still uses the legacy research path.

## Closeout validation

Each validation was run as a separate command from repository root on 2026-09-03.

| Validation                                                                                                       | Result                                         |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| All ten installer/command migration suites via `node --test packages/ggcoder/scripts/install-*-command.test.mjs` | Passed: 81/81 tests.                           |
| Command routing, parsing, listing, Chat research, and specialist suites via one focused Vitest invocation        | Passed: 12 files, 115/115 tests.               |
| Unchanged Steroids contract and adapter suites                                                                   | Passed: 2 files, 22/22 tests.                  |
| `pnpm --filter @kenkaiiii/ggcoder check`                                                                         | Passed: `tsc --noEmit`.                        |
| `node --test scripts/audit-generated.test.mjs`                                                                   | Passed: 12/12 tests.                           |
| Canonical/installed `cmp -s` loop and SHA-256 inventory                                                          | Passed: 10/10 byte-identical.                  |
| Installed/canonical deprecated-command pattern scan                                                              | Passed: zero matches.                          |
| Repo-wide classified legacy inventory                                                                            | Passed: every retained match classified above. |
| Markdown formatting validation                                                                                   | Passed: Prettier check.                        |
| Whitespace-error validation                                                                                      | Passed: no whitespace errors.                  |

No validation exposed an implementation defect. The document remains unstaged for final review.
