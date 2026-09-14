# Programmatic workflow

Programmatic setup finds supported repeatable work in a local code project. It does not turn repository scripts or instructions into executable scanners. Start with `/setup-programmatic`, review what GG proposes, and approve saving it separately. Then `/programmatic` scans the saved profile. Neither setup approval nor scanning approves a specialist task.

## Commands and ownership

Both commands are built-in, code-mode workflows. They are not general chat prompts or shell launchers. Discovery advertises `/setup-programmatic` first and withholds `/programmatic` until the saved setup is approved and current. Direct calls without current setup return setup or repair guidance rather than starting the model. `/programmatic-run` is an internal selection/approval path, not an advertised executable command.

`/programmatic` accepts optional advisory focus, for example `/programmatic check packaging risks`. Focus is trimmed, limited to 4,000 characters, and accepts multiline or non-ASCII text but not prohibited control characters or attachments. Empty focus requests a general assessment. Focus is carried to the model as untrusted advisory context: it does not filter the deterministic scan, change settings, select opportunities or approve execution.

The model receives a bounded command-metadata page rather than every command body. `command_information` can read further pages or one exact discovered prompt body. Metadata and bodies are information, not evidence of suitability or permission to execute. Workspace actions have no specialist prompt body, and unavailable, changed, unsafe or oversized bodies are refused. This context wiring is not a completed semantic recommendation engine and does not expand the fixed specialist registry below.

The desktop **Opportunities** view exposes the same bounded setup, report, scan, selection and approval operations. Non-code sessions cannot use this workflow; plan mode does not authorize writes or task execution.

The CLI/daemon package owns discovery, profile persistence, lifecycle storage, route resolution and isolated execution. Shared desktop wire contracts live in `gg-core`; the React view renders those contracts and sends actions through the native Tauri bridge. The webview does not receive daemon bootstrap credentials or call the daemon directly.

The fixed specialist registry permits only:

| Specialist | Required owner | Availability and authority |
| --- | --- | --- |
| `/setup-tauri-package` | Built-in | Bundled, for supported Tauri package structure; mutating actions require their own approvals. |
| `/research` | Global custom command | Machine-local, not guaranteed to exist elsewhere; physically read-only tool list. |
| `/setup-sweep` | Global custom command | Machine-local, not guaranteed to exist elsewhere; can mutate after separate approval. |

A name in a profile does not make that specialist available. GG checks the current owner, command body and route before execution and again after approval. Missing commands, project-level shadows, changed bodies and unsupported routes fail closed. The current deterministic detector recognizes Tauri packaging structure; the registry is not a promise of discovery for every possible research or sweep task.

## Command discovery and refresh

The catalog is derived from GG's existing definitions, Markdown loader and host-owned actions, not another store or parser. Readiness uses the existing profile assessment: fresh projects avoid inventory, concurrent session checks share work, and later requests recheck rather than caching readiness indefinitely. Look-ahead checks do not assemble model command context.

Advisory pages contain at most 100 entries and 32,000 UTF-16 code units including JSON, with explicit continuation and limited coverage. Oversized metadata is summarized without changing command identity. Body responses have the same text limit and refuse oversized bodies rather than returning partial executable templates. Cancellation returns an unavailable result. The existing loader still parses command bodies locally; this is not a new lazy filesystem index.

Desktop and terminal refresh when the command menu reopens. Desktop also refreshes on window focus and run completion, including cancellation/failure; ACP republishes after turns. Setup saves use existing lifecycle callbacks. Successful empty results clear stale entries; failed responses preserve the previous catalog. Old pane/client/mode/generation responses cannot replace the current desktop list. Historical invocations use complete definitions and omit appended advisory metadata from their displayed command text.

## Review, save, scan, select, approve

1. **Review setup** inspects local file structure and configuration. It returns the exact declarative profile, fingerprint, routes, exclusions and any configuration changes. Inspection writes nothing and dispatches no specialist.
2. **Approve and save setup** saves the reviewed profile. A configuration fingerprint and prior-file digest guard against concurrent changes; neither digest is user approval. A stale proposal must be inspected and approved again.
3. **Check for opportunities** explicitly scans using the approved fixed profile and reconciles persisted results. It does not start tasks. A scan with no changes leaves lifecycle bytes unchanged.
4. Select one result to inspect its evidence, route, risks and success condition. Selection and **Refresh results** are reads, not execution permission. **Dismiss this item** records a snapshot-guarded soft dismissal.
5. **Review task approval** asks separately before an isolated specialist starts. It names whether the task is read-only or may mutate. A mutating specialist's scope is task context, not a filesystem sandbox: later tool actions and plans require their own approval.
6. Review the result and explicitly rescan when appropriate. Rescans retain terminal history and stable opportunity identity rather than rerunning completed work.

Execution uses a transient child session with the selected provider/model and necessary project context, not the parent's conversation. It does not persist a child transcript. Research lacks write, edit, shell, installation, corpus-addition and MCP capabilities. This restriction does not mean research has no network access: allowlisted read-only web/corpus tools may be available. Completion must match the selected success condition and cite observed successful tool calls; that is attributed specialist evidence, not independent host certification. Failure, cancellation, deadline and cleanup outcomes remain distinct.

## Files and lifecycle meanings

The programmatic workflow owns these fixed project-relative files:

- `.gg/programmatic/profile.json`: versioned approved declarative scanner profile and configuration baseline. It contains no executable scanner bodies or arbitrary command lines.
- `.gg/programmatic/state.json`: current bounded opportunity and lifecycle records.
- `.gg/programmatic/state.previous.json`: the previous validated lifecycle snapshot, when available. It is not an off-machine backup or a guarantee against disk loss.

Writes use validated, guarded temporary-file replacement and serialization. Temporary/lock artifacts are implementation details, not additional user-configurable routes. A specialist can create its own separately approved outputs; these are not automatic setup outputs.

| State | Meaning |
| --- | --- |
| `discovered` | Observed opportunity, not permission to run it. |
| `queued` | Accepted lifecycle transition toward execution; not a background scheduler. |
| `running` | An execution owns the record. Conflicting actions are unavailable until valid settlement. |
| `completed` | Execution completion was accepted after its evidence and cleanup checks. Rescan preserves this history. |
| `dismissed` | Soft-dismissed by the user; retained during reconciliation. |

Report status is separate from a record's state. A report can be stale or recovered while still showing a completed or dismissed record. A disappearing terminal opportunity remains in history. Failures are not silently promoted to completed.

## Configuration drift and legacy setup

GG compares the saved configuration baseline with current configuration inputs and policy. Manifest/configuration changes can require setup refresh; ordinary source or lifecycle changes do not by themselves require a new profile.

When configuration drifts, inspection shows exact added, removed and modified inputs and policy/schema/exclusion changes. Old results remain inspectable, but task execution and scanning are blocked until required setup approval is current. **Review setup refresh** does not write. **Approve and save refresh** changes the profile only; it does not scan or reset lifecycle records. A subsequent **Check for opportunities** reconciles the new configuration while preserving identity and terminal history.

A current setup needs no regeneration. A supported legacy profile can require explicit upgrade approval. Legacy data without a per-file baseline cannot explain historical file-level differences: GG reports that limitation rather than inventing changes. Unreadable or unsupported setup is not permission to overwrite it.

## Recovery and interrupted ownership

Use **Refresh results** (or **Retry loading results** after an error) to inspect saved data without repairing it. If the primary lifecycle file is invalid and a previous validated snapshot exists, the report can show older saved results. Reads preserve both files byte-for-byte. **Check for opportunities** explicitly reconciles and writes a valid primary when the current profile and ownership checks permit it; invalid primary bytes must not replace the valid previous snapshot.

If no validated state is available, stop and preserve the files and diagnostics. There is no automatic destructive reset or guarantee that lost history can be reconstructed. Do not delete lifecycle files to clear a warning.

Reloading the application or a module does not prove an interrupted specialist has stopped. Persisted active ownership continues to block conflicting actions. GG does not silently clear a running owner on restart, and the inspection/recovery controls are not a force-unlock API. Preserve diagnostic evidence for investigation when ownership cannot be settled normally. Recovery from corrupt lifecycle state is distinct from daemon restart or Roadmap notification recovery.

## Developer verification and exclusions

Owning tests are under `packages/ggcoder/src/core/programmatic`, with tool and desktop-adapter tests next to their implementations. The connected execution fixture uses real discovery/profile/lifecycle/dispatch operations, an explicitly substituted detector route, and a harmless scripted provider. Its fresh-module recovery test is not a full operating-system restart test.

The Windows developer smoke supports `--integrated-recovery` for one minimized setup→execution→drift/refresh→persisted-state-recovery scenario. It records ordered native-window samples and exact owned-process cleanup evidence. Samples are not continuous monitoring. The fixture uses an isolated home/project and scripted provider, not production credentials. `--drift-only` and explicit `--visual` retain separate scenarios; neither may be combined with integrated recovery. A normal-window fallback cannot satisfy minimized verification.

This feature does not include arbitrary shell scanning, model-generated scanners, generic specialist fallback, global availability guarantees, multi-opportunity concurrency, background scheduling, cloud sync, telemetry or dashboards. The integrated verification excludes packaging, installer, updater, release and broad visual campaigns. Programmatic lifecycle recovery is not a backup service.

## Extension contracts — implemented inputs and deferred workflow

Setup-first discovery, optional focus validation and model context, and bounded command information are implemented as described above. The additive contracts below also define foundations for deferred recommendations, command creation, expanded execution and their approval integration; those workflows are not enabled. Deterministic execution still permits only the original three specialists, and command generation remains unavailable. These contracts introduce no new persistence format, catalog store, parser, runtime, approval system, database or dashboard.

### Reuse map and ownership

Paths in this table are relative to the repository root. The CLI domain directory is `packages/ggcoder/src/core/programmatic`.

| Existing owner | Reused foundation | Implemented integration / deferred responsibility |
| --- | --- | --- |
| `packages/ggcoder/src/core/custom-commands.ts`: `CustomCommand`, `loadCustomCommands` | Markdown parsing, project-over-global precedence, deterministic global directory selection | Implemented: shared discovery derives metadata from loaded commands; `command_information` resolves bounded bodies on demand without a second registry or exposing absolute global owner paths. |
| `packages/ggcoder/src/core/prompt-commands.ts`: `PROMPT_COMMANDS`, `getPromptCommand` | Built-in names, aliases, required tools and input policies | Implemented: shared discovery gates setup-first visibility; `/programmatic` accepts optional focus and supplies advisory context without changing scanner input. |
| `packages/ggcoder/src/app-sidecar-command-listing.ts`: `WORKSPACE_ACTIONS`, `appSidecarCodeCommandsResponse` | One listing; built-ins/actions exclude same-name customs | Implemented: shared discovery populates `origin` and `invocationKind` from owning definitions and loader metadata. Workspace actions are not transient prompt commands. |
| `packages/gg-core/src/slash-command-contract.ts` | Shared listing, input policies and usage | Only cross-process addition: optional built-in/project-custom/global-custom origin and prompt/workspace-action kind, with consistency and size validation. Old listings without these fields remain valid; absence never authorizes execution. |
| `packages/ggcoder/src/core/agent-session.ts`: command resolution, `expandResolvedPromptCommand`, `promptResolvedCommand` | Existing slash parser, appended `User Instructions` arguments, host-only pinned transient prompt entry | Implemented: validated assessment and bounded command metadata reach model context through this path. Deferred expanded execution must reuse it; no `$ARGUMENTS` or numbered-placeholder parser. |
| Domain `routes.ts`: `resolveSpecialistAvailability`, `resolveProgrammaticSpecialist`, `ResolvedSpecialist` | Three-name allowlist, ownership, ephemeral body and route/owner/body digest | Richer advisory content identity remains separate; broader names do not widen these executable routes. |
| Domain `execution.ts`: `executeProgrammaticOpportunity`, `SPECIALIST_CAPABILITIES`, research facade | Fresh AgentSession, host tool restrictions, no ambient MCP, approval callbacks, post-approval resolution, cancellation/deadline/cleanup | Future integration binds exact content/settings and re-resolves immediately before dispatch; no second runner or approval consumer. |
| Domain `contracts.ts`, `inventory.ts`, `lifecycle.ts`: fingerprints and `reconcileProgrammaticLifecycle` | Existing versioned profile, stable identities, deterministic reconciliation and history | Focus, research, ranking and advice are separate data. Never send advisory omissions or truncated catalogs to disappearance reconciliation. |
| `packages/ggcoder/src/tools/steroids.ts` and execution research facade | Existing corpus discovery/read tooling | Evidence attributes inspected references and uncertainty, not a background research service or permission to index/install. |
| `gg-app/src/AgentPane.tsx`, `ProgrammaticChat.tsx`, `agent.ts`; `packages/ggcoder/src/app-sidecar-programmatic-chat.ts` | Current in-thread controls, generation/epoch checks and `client.programmatic` → native `agent_programmatic` bridge | Deferred recommendation UI must reuse this transport, never webview loopback HTTP or a new dashboard. |

### Domain representations and limits

`contracts.ts` owns the independent version-1 extension records and pure validation. Existing contract/profile/lifecycle versions are unchanged.

- **Assessment:** omitted focus means general assessment. The implemented advisory-context adapter trims input, omits empty focus and validates the assessment before supplying model context. Supplied focus must contain nonempty text, at most 4,000 characters, with no controls except normal whitespace. Focus does not change scanner configuration or identity.
- **Advice:** recommendations explicitly have `kind: advisory`, outcome, rationale, uncertainty and evidence. A discriminated choice contains either command availability, a missing-capability requirement, or manual steps—never unrelated branch fields or lifecycle state. Results cap recommendations at 50 and require complete scoped coverage or a limited scope with a reason. Truncation must be reported as limited by the producer; validation cannot independently establish catalog completeness.
- **Evidence:** reuse observed/inferred/assumed meanings and bounded local locations. Up to 50 items per recommendation; external attribution adds an inspected HTTP(S) URL, optional revision/location and supported claim. Credential-bearing URLs, query strings/fragments and invalid line ranges are rejected. No fetched/source-body fields or absolute local paths. Attribution is not proof, permission or a network request; hosts must not copy secrets into free text or URLs.
- **Identity and availability:** the exact command token, source and invocation kind are metadata, not shell text. Reference names preserve case, underscores, dots and hyphens (for example, `check_project`, `CheckProject`, `check.project`); they are never trimmed, lowercased or renamed. The reference-only token subset is 1–100 ASCII characters, starting with a letter or digit and followed only by letters, digits, `.`, `_` or `-`. Deliberately excluded even if the existing slash parser accepts them: leading punctuation, non-ASCII names and other punctuation. Slash prefixes/path separators, whitespace, controls and interpreter-like text are rejected. These limits do not change the existing loader/parser, scanner or policy IDs, or the executable three-specialist allowlist. Content snapshots bind a SHA-256 of private resolved owner identity, body SHA-256 and up to 32 sorted unique repository-relative helper path/digest pairs. Script-backed snapshots require helpers; prompt-only snapshots reject them. Workspace actions are host-owned/app-backed and cannot be executed by the review contract. Available/unavailable is separate from permission. Source or resolved-owner changes invalidate identity even with an unchanged name/body; the resolver remains responsible for precedence and private owner identity.
- **Creation:** project-only ephemeral proposals bind desired outcome, capability kind, inputs/outputs, prerequisites, risks, verification expectations, exact command/helper digests, destinations, and prior digests or explicit absence. Command destinations must be Markdown files directly under the existing `.gg/commands` loader directory. No files are written here. Later creation must recheck collisions/prerequisites, show exact content, contain real paths/refuse symlink escapes, preserve user files and provide atomic multi-file behavior. A digest alone does not establish those filesystem properties.
- **Verification:** records bind a content snapshot, model/provider/environment, normal/incomplete/out-of-scope cases, evidence and explicit limits. Loading, behavior and side effects are distinct categories. Passed readiness requires deterministic loading and behavioral cases; scripts additionally require deterministic error/incomplete and side-effect coverage. Model judgments cannot replace those assertions. Failed/unavailable records remain representable. Evidence claims are not independently executed or certified by parsing.
- **Execution review:** a separate purpose/proposal binds source/body/helpers, exact argument text, configuration fingerprint, success condition and host-selected settings. Settings contain policy ID/revision, provider/model, positive bounded turns/deadline and a recognized capability profile—not API keys, arbitrary tools or MCP servers. The represented limits are ceilings, not changed runtime defaults. Research-read-only rejects script-backed execution; app-backed execution remains unsupported.

`isProgrammaticReviewCurrent` compares parsed reviewed/current data against a host-only pending proposal ID, expected creation/execution purpose and an explicit accepted decision. Missing/denied decisions, wrong purpose/proposal and content/argument/configuration/settings changes fail closed. Parsing and matching are **not user approval**, single-use consumption or replay prevention. Never construct the host context from model output. The existing callback owner must consume approval once and re-resolve current content immediately before a later dispatch. Prior verification does not approve creation or execution.

### Compatibility obligations for later phases

1. Preserve implemented setup-first discovery: only setup is advertised from this feature until approved current settings exist, then shared `/programmatic` with optional focus becomes available. Direct calls validate prerequisites; do not generate a duplicate project entry command or rewrite existing profiles broadly.
2. Keep broader advice separate from deterministic findings and the current fixed-three runner. Unsupported commands/actions remain unavailable for execution rather than falling back to a generic prompt.
3. Creation approval, content-specific verification and execution approval are three separate events. No schema, repository Markdown, helper declaration, reference, matching fingerprint or model output grants host tools.
4. Preserve code/chat and plan-mode boundaries, old profiles and dismissed/completed history. Advice omissions, research changes and focus/ranking/catalog limits never mark scanner findings disappeared or auto-refresh setup.
5. Session isolation is not operating-system/filesystem containment. General shell work is not a path sandbox; later enforcement must reject unsupported containment requirements rather than imply guarantees.

### Narrow reference applicability

GG's owning code and focused tests are primary. Both pinned files below were inspected during planning and re-read during final reference review.

| Reference | Demonstrated pattern used | Explicit limits |
| --- | --- | --- |
| [OpenCode command catalog](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/opencode/src/command/index.ts#L22-L169) | `Info` metadata, source tags, hints, and list/get composition inform metadata-first access and selective body lookup. | No Effect services, persistent catalog cache, MCP/skill expansion, placeholder parser or foreign precedence was adopted. GG retains its input policies, usage and append-arguments expansion. |
| [Gemini CLI command loader](https://github.com/google-gemini/gemini-cli/blob/8c1ff9ca2055d7e9c68f0dfef92887ee72d99a25/packages/cli/src/services/FileCommandLoader.ts#L84-L149) | Explicit sources, conflict ownership and cancellation inform source-aware discovery. | GG retains Markdown, its first-winning global directory and project overrides, and its owner-path checks. TOML, extension renaming, `follow: true` and Gemini precedence were not adopted. |

Neither reference demonstrates setup-first gating, approval correctness or a complete adviser. GG tests establish those implemented boundaries, actual scripted-provider wiring and deterministic scan/lifecycle separation. Scripted providers prove wiring and tool execution, not live-model recommendation quality. Broader recommendations, command creation and expanded execution remain later phases; no native certification, packaging, installation or production-data claim is made.
