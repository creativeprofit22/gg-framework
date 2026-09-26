# Programmatic architecture

[Workflow index](programmatic-workflow.md) · [Evidence](programmatic-evidence.md) · [User flow](programmatic-user-flow.md)

The CLI/daemon owns discovery, profile persistence, lifecycle storage, route resolution and isolated execution. Shared desktop wire contracts live in `gg-core`; React renders those contracts and sends actions through the native Tauri bridge. The webview receives no daemon bootstrap credentials and never calls the daemon directly. These are integrations of existing owners, not a second agent engine, catalog or runner.

## Assessment module/dependency map

Domain filenames below live under `packages/ggcoder/src/core/programmatic/`; session/discovery files live in its parent `core/`, tools under `src/tools/`, sidecar files under `src/`, and display files under `gg-app/src/`.

| Responsibility | Owner and dependency boundary |
| --- | --- |
| Evidence vs strict inventory | `assessment-evidence.ts` uses `inventory.ts` traversal/containment helpers for bounded samples and authorization; strict `buildProgrammaticInventory` alone supplies fingerprint inventory. `advisory-context.ts` combines samples with existing bounded command metadata. |
| Exact settings | `profile.ts`, `setup-review.ts`, `tools/programmatic-profile.ts` retain proposal/persistence and separate exact owner/configuration/prior-byte approval. Model conclusions never supply settings authority. |
| Needs and coordination | `assessment.ts: ProgrammaticAssessmentCoordinator` wraps one injected existing session turn and projects independent outcomes. `agent-session.ts: assessProgrammatic` owns provider/session entry, host facts, temporary tools and finally restoration; `setup-inspection.ts` enforces inspect-only setup. No new provider, loop or policy registry. |
| Capability matching | `advisory-policy.ts` shares needs-first guidance between setup and configured prompts. Existing `command-discovery.ts` and `tools/command-information.ts` supply bounded metadata and selected bodies for the five-way decision; no second recommender. Fixed specialist execution routes are unchanged. |
| Candidate/receipt validation | `advisory.ts`, `advisory-tools.ts`, `tools/programmatic-advisory-result.ts` retain delivered receipt provenance, post-cap acceptance, exact snapshots, freshness and host-selected setup/configured scan policy. Samples and model mode claims cannot grant authority. |
| Discovery projection/review | `discovery-projection.ts` projects bounded browser-safe candidates; `discovery-review.ts` prepares read-only reviews. `agent-session.ts` owns current assessment/candidate authority. `app-sidecar-programmatic-chat.ts` delegates discovery/review and history actions under its existing session claim. |
| Deterministic history | `lifecycle.ts: runProgrammaticScan/reconcileProgrammaticLifecycle` remains the sole scan/reconciliation owner. Advice, omitted candidates, partial inventory and catalog truncation never erase completed/dismissed history. |
| Native/run ownership | `app-sidecar-programmatic-chat.ts` delegates to injected current-session assessment; `app-sidecar.ts` uses existing `runAgent` lifecycle/cancellation under the adapter's single claim, not a second claim. Release preserves guarded `runStrandedQueue` settlement; project/session/epoch checks reject stale responses. Existing Tauri invoke/events carry results. |
| Display contracts/state | `gg-core` assessment/chat/discovery/recommendation contracts carry validated bounded summaries, candidate projections and inert history, not executable approvals or reusable receipts. `ProgrammaticAssessment.tsx`, `ProgrammaticChat.tsx`, `ProgrammaticDiscovery.tsx`, `programmatic-chat-state.ts`, `programmatic-discovery-state.ts` and `AgentPane.tsx` render them with generation, request, owner, sequence and selection guards. Run-end refresh cannot overwrite in-flight setup review. Detailed advice also remains in the ordinary transcript. |

Recommendation persistence and exact identity/decision owners are documented in [Recommendation history lifecycle](programmatic-recommendation-lifecycle.md), separately from scanner storage below.

## Command discovery and refresh

The catalog derives from existing definitions, Markdown loader and host-owned actions, not another store or parser. Readiness uses existing profile assessment: fresh projects avoid inventory, concurrent session checks share work, and later requests recheck rather than caching readiness indefinitely. Look-ahead checks do not assemble model command context.

The model receives a bounded command-metadata page, not every body. `command_information` reads further pages or one exact discovered prompt body. Metadata and bodies are information, not suitability or execution permission. Workspace actions have no specialist prompt body; unavailable, changed, unsafe or oversized bodies are refused. This wiring is not a completed semantic recommendation engine and does not expand the fixed registry.

Advisory pages contain at most 100 entries and 32,000 UTF-16 code units including JSON, with explicit continuation and limited coverage. Oversized metadata is summarized without changing identity. Body responses have the same text limit and refuse oversized bodies rather than returning partial executable templates. Cancellation returns unavailable. The existing loader still parses bodies locally; this is not a new lazy filesystem index.

Desktop and terminal refresh when the command menu reopens. Desktop also refreshes on window focus and run completion, including cancellation/failure; ACP republishes after turns. Setup saves use existing lifecycle callbacks. Successful empty results clear stale entries; failed responses preserve the previous catalog. Old pane/client/mode/generation responses cannot replace the current desktop list. Historical invocations use complete definitions and omit appended advisory metadata from displayed command text.

## Fixed deterministic specialist routes

| Specialist | Required owner | Availability and authority |
| --- | --- | --- |
| `/setup-tauri-package` | Built-in | Bundled, for supported Tauri package structure; mutating actions require their own approvals. |
| `/research` | Global custom command | Machine-local, not guaranteed elsewhere; physically read-only tool list. |
| `/setup-sweep` | Global custom command | Machine-local, not guaranteed elsewhere; can mutate after separate approval. |

A name in a profile does not make a specialist available. GG checks current owner, body and route before execution and again after approval. Missing commands, project shadows, changed bodies and unsupported routes fail closed. The current deterministic detector recognizes Tauri packaging structure; the registry is not a promise of discovery for every research or sweep task. Broader advice and [direct reviewed prompt runs](programmatic-capability-extension.md#direct-reviewed-execution) do not widen these routes.

## Files and lifecycle meanings

Fixed project-relative scanner files:

- `.gg/programmatic/profile.json`: versioned approved declarative scanner profile/configuration baseline; no executable scanner bodies or arbitrary command lines.
- `.gg/programmatic/state.json`: current bounded opportunity/lifecycle records.
- `.gg/programmatic/state.previous.json`: previous validated lifecycle snapshot when available; not an off-machine backup or guarantee against disk loss.

Writes use validated, guarded temporary-file replacement and serialization. Temporary/lock artifacts are implementation details, not user-configurable routes. Specialists may create separately approved outputs; those are not automatic setup outputs.

| State | Meaning |
| --- | --- |
| `discovered` | Observed opportunity, not permission to run. |
| `queued` | Accepted transition toward execution; not a background scheduler. |
| `running` | Execution owns the record; conflicting actions unavailable until valid settlement. |
| `completed` | Completion accepted after evidence/cleanup checks; rescan preserves history. |
| `dismissed` | User soft dismissal retained during reconciliation. |

Report status is separate from record state. A stale or recovered report may still show completed/dismissed records. Disappearing terminal opportunities remain in history; failures are not silently completed. [Recovery and interrupted ownership](programmatic-user-flow.md#recovery-and-interrupted-ownership) owns recovery behavior.

## Reuse map and ownership

Paths are repository-relative; domain means `packages/ggcoder/src/core/programmatic`.

| Existing owner | Reused foundation | Integration / boundary |
| --- | --- | --- |
| `packages/ggcoder/src/core/custom-commands.ts`: `CustomCommand`, `loadCustomCommands` | Markdown parsing, project-over-global precedence, deterministic global directory | Shared discovery derives metadata from loaded commands; `command_information` resolves bounded bodies without a second registry or exposing absolute global owner paths. |
| `packages/ggcoder/src/core/prompt-commands.ts`: `PROMPT_COMMANDS`, `getPromptCommand` | Built-in names, aliases, required tools/input policies | Setup-first slash visibility; optional focus/advisory context without changing scanner input. |
| `packages/ggcoder/src/app-sidecar-command-listing.ts`: `WORKSPACE_ACTIONS`, `appSidecarCodeCommandsResponse` | One listing; built-ins/actions exclude same-name customs | Shared discovery populates origin/invocation kind from owning definitions/loader metadata. Workspace actions are not transient prompts. |
| `packages/gg-core/src/slash-command-contract.ts` | Shared listing/input policies/usage | Optional built-in/project-custom/global-custom origin and prompt/workspace-action kind, with consistency/size validation. Old listings without fields remain valid; absence never authorizes execution. |
| `packages/ggcoder/src/core/agent-session.ts`: command resolution, `expandResolvedPromptCommand`, `promptResolvedCommand` | Slash parser, appended `User Instructions`, host-only pinned transient prompt entry | Assessment/context and direct reviewed execution reuse this path; no `$ARGUMENTS` or numbered-placeholder parser. |
| Domain `routes.ts`: `resolveSpecialistAvailability`, `resolveProgrammaticSpecialist`, `ResolvedSpecialist` | Three-name allowlist, ownership, ephemeral body and route/owner/body digest | Richer advisory identity remains separate; broader names do not widen routes. |
| Domain `execution.ts`: `executeProgrammaticOpportunity`, `SPECIALIST_CAPABILITIES`, research facade | Fresh AgentSession, host restrictions, no ambient MCP, approval callbacks, post-approval resolution, cancellation/deadline/cleanup | Direct execution binds exact content/settings and re-resolves immediately before dispatch through the shared runner; no second approval consumer. |
| Domain `contracts.ts`, `inventory.ts`, `lifecycle.ts`: fingerprints, `reconcileProgrammaticLifecycle` | Versioned profile, stable identities, deterministic reconciliation/history | Focus/research/ranking/advice are separate data, never disappearance input. |
| `packages/ggcoder/src/tools/steroids.ts`, execution research facade | Corpus discovery/read tooling | Attributed references/uncertainty, not background research or indexing/install permission. |
| `gg-app/src/AgentPane.tsx`, `ProgrammaticChat.tsx`, `ProgrammaticDiscovery.tsx`, `agent.ts`; `packages/ggcoder/src/app-sidecar-programmatic-chat.ts` | In-thread controls and epoch checks; `client.programmatic` → native `agent_programmatic` | Transcript advice plus typed Opportunities candidates/history; distinct creation/execution question cards. Catalog refresh retains command-list transport, never loopback HTTP or a new dashboard. |

## Exclusions

This feature does not include arbitrary shell scanning, model-generated scanners, generic specialist fallback, global availability guarantees, multi-opportunity concurrency, background scheduling, cloud sync, telemetry or dashboards. Programmatic lifecycle recovery is not a backup service. Verification scope is recorded separately in [Evidence](programmatic-evidence.md#developer-verification-and-exclusions).
