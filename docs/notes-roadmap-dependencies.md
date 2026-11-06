# Roadmap phase dependencies

A phase can record which other phases must be Done before it. This page is the single home for the dependency rules; other docs link here instead of repeating them. Rules are implemented once in `packages/gg-core/src/roadmap-phase-dependencies.ts` (subpath `@kenkaiiii/gg-core/roadmap-phase-dependencies`).

This feature changes only the stored contract. It does not change the UI, the agent tools, or how phases start.

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

## Ownership

| Concern                                          | Owner                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Field shape, link rules, cycles, finished check  | `gg-core/src/roadmap-phase-dependencies.ts`                                           |
| Calling the rules during document validation     | `gg-core/src/project-notes.ts`                                                        |
| Store version, delete/recover refusal, migration | `ggcoder/src/project-notes-repository.ts`                                             |
| Tests                                            | `roadmap-phase-dependencies.test.ts`, `project-notes-dependencies-repository.test.ts` |
