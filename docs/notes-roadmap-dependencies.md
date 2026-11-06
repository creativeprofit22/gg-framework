# Roadmap phase dependencies

A phase can record which other phases must be Done before it. This page is the single home for the dependency rules; other docs link here instead of repeating them. Rules are implemented once in `packages/gg-core/src/roadmap-phase-dependencies.ts` (subpath `@kenkaiiii/gg-core/roadmap-phase-dependencies`).

The agent's Roadmap tools and the approval cards use the same module; see [Agent behaviour](#agent-behaviour).

## The field

- `dependsOn?: string[]` on a Roadmap phase: the ids of phases this phase depends on.
- Absent means no dependencies. When present it must be a **non-empty** list of non-empty strings; an empty list is rejected ("omit dependsOn instead"), so "no links" has one stored form.
- Documents without the field load and save unchanged.

## Rules

The rules are checked when Notes load, on every save, and on every repository write that can add links or remove phases (runtime-only writes such as launches and status changes cannot change dependency links):

| Rejected                               | Notes                                                     |
| -------------------------------------- | --------------------------------------------------------- |
| Link to an id not in the document      | Missing phase.                                            |
| Present phase linking to a deleted one | Deleted phases cannot be prerequisites of visible phases. |
| Phase linking to itself                |                                                           |
| Same id twice in one list              |                                                           |
| Circular chain of any length           | The error shows the chain, for example `A → B → C → A`.   |

- Links to **archived** phases are allowed.
- A deleted phase keeps its links frozen, and they may point at other deleted phases. Cycle detection still covers every phase, deleted or not.
- Errors name phases as `"Title" (id)` with titles shortened, and point at `phases[i].dependsOn[j]`.

## Finished prerequisites

A prerequisite is finished only when it is present (not deleted) and its status is **Done**. Archived-but-not-Done and deleted prerequisites count as unfinished. `listUnfinishedPrerequisites` returns them in `dependsOn` order (empty when there are no links, `null` for an unknown phase).

## Delete and recover

- **Delete is refused** (reason `dependency-links`) while any present phase depends on the target. The message names those phases. Links are never stripped silently, so no history entry is needed: delete the dependents first, or remove their links.
- **Recover is refused** while the deleted phase links to a phase that is still deleted ("Recover X first"). Recovering prerequisites first always works, so recovery never brings back a broken link.

## Storage compatibility

Phase records are checked against a fixed list of allowed fields, so older app builds cannot read the new field. Following the deletion upgrade (v1 → v2, see [Roadmap phase deletion](notes-roadmap-deletion.md)), the storage envelope moves to **`storeVersion: 3`** the first time a document holds any link:

- That write stores both the backup (the previous document, relabelled) and the new primary as v3.
- Stores never downgrade, including after every link is removed. Deleting in a v3 store keeps v3.
- An interruption that leaves a v3 backup next to an older primary keeps the upgrade on later writes.
- v1/v2 envelopes containing `dependsOn` are rejected and not overwritten. Reads never migrate files. Browser-fallback migration refuses documents with links.
- Builds from 2026-09-07 on (commit `5160dbb1`) refuse a v3 store as "Unsupported Project Notes format" and write nothing. Older builds may report it as corrupt; **zero data loss is not promised** for them.

## Agent behaviour

The agent has nobody to ask, so its checks are strict. The tools only call this module and the existing repository paths.

- **Inspect.** `roadmap_inspect` adds `dependsOn` and `unfinishedPrerequisites` (`{id, title, status}`) to a phase only when it has links, so unlinked phases look the same as before.
- **Draft and edit.** `roadmap_phase_draft` takes `depends_on_phase_ids` (existing phases) and `depends_on_draft_phases` (0-based indexes of other phases in the same draft). `roadmap_phase_edit` takes `depends_on`; `[]` clears the links. Bad links are rejected when proposed, with the same errors as saving, and the check runs again on approval.
- **Move.** `roadmap_phase_move` still drafts the move but adds `dependencyWarnings` when the moved phase would sit above a prerequisite or below a phase that depends on it.
- **Start refusal.** When the agent tries to attach to a phase (`roadmap_bind` `bind-current`, `rebind-current`, `acquire`, `takeover`) or set it in progress (`roadmap_status`), and a prerequisite isn't finished, it gets `prerequisites-unfinished` with: "Can't start "X" (id): these prerequisite phases aren't Done: …. The user can start it from the app." Inspect, renew and release are not gated, and neither are the user's own starts. A phase that is already active (planning, in progress or blocked) and bound to the agent's own session is not refused, including after compaction moves the phase's link to the new session: re-attaching or continuing it is not a new start.
- **User override.** When the user starts a phase from the app while prerequisites are unfinished, a `dependency-override` roadmap event is recorded (`actor: "user"`, `origin: "app"`). The agent may then attach, but only if that override is current: it was made for the phase's bound session (and the agent's own), and the phase has not since been reopened from Done or Cancelled, rebound, or deleted and recovered. Overrides by ken or autopilot never count.
- **Autopilot.** Automatic advancement into a phase with unfinished prerequisites is refused as `stale` / `target-ineligible` and writes nothing.
- **Approval cards.** Draft and edit cards show a "Depends on" list. A phase in the same draft is tagged "New", an archived phase shows "(archived)", and an unknown id shows "Missing phase" with a short id. Edit cards tag changes "Added" and "Removed".

## Ownership

| Concern                                          | Owner                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Field shape, link rules, cycles, finished check  | `gg-core/src/roadmap-phase-dependencies.ts`                                                                                         |
| Calling the rules during document validation     | `gg-core/src/project-notes.ts`                                                                                                      |
| Store version, delete/recover refusal, migration | `ggcoder/src/project-notes-repository.ts`                                                                                           |
| Agent override, start refusal, move warnings     | `gg-core/src/roadmap-phase-dependencies.ts`                                                                                         |
| Agent tool fields and draft checks               | `ggcoder/src/tools/roadmap-*.ts`, `ggcoder/src/app-sidecar-roadmap-drafts.ts`                                                       |
| Agent start gate                                 | `ggcoder/src/app-sidecar-agent-phase-start-gate.ts`                                                                                 |
| Approval card lists                              | `gg-app/src/RoadmapDependencyList.tsx`                                                                                              |
| Tests                                            | `roadmap-phase-dependencies.test.ts`, `project-notes-dependencies-repository.test.ts`, `app-sidecar-agent-phase-start-gate.test.ts` |
