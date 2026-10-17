---
argument-hint: <audit-doc-path> <area-or-step-number>
description: Convert one prioritised area from a /ux-audit doc into a focused implementation plan. File-pinned, hard-constrained, defensive — the output is a plan-mode contract ready to execute.
allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user
---

# UX Plan

Take an existing `/ux-audit` doc plus a chosen area or step number, and produce a focused implementation plan for _that one piece_. The output is a markdown plan doc in `.gg/plans/NN-<slug>.md` shaped for plan-mode execution — single flat `## Steps` list at the bottom, every change pinned to `file:line`, defensive "do not touch" list non-optional.

Pairs with `/ux-audit`. `/ux-plan` does not do its own audit. If no audit doc exists, it bails — the audit-before-plan discipline is the point.

## Step 0: Audit doc & area gate

Before anything else, validate inputs.

**0a. Audit doc must exist and parse.** Read the first argument as the audit doc path (relative to repo root, or absolute). If the file doesn't exist, STOP and tell the user:

> Audit doc not found: `<path>`. Run `/ux-audit` first to produce the audit, then re-run this command with the doc path.

Do not proceed. Do not invent an audit.

**0b. Audit doc must have the canonical section order.** The doc must contain `## Cross-cutting findings`, `## Per-area audit`, `## Recommended rebuild order` (or equivalent). If those sections are missing, the doc isn't a `/ux-audit` output. Tell the user:

> `<path>` doesn't look like a /ux-audit doc — missing the canonical sections. Either re-run `/ux-audit` to produce one, or point me at a different file.

Do not proceed.

**0c. Area number must resolve.** The second argument is one of:

- A numbered area heading from the audit (e.g. `2` → `### 2. Find athletes (\`/sweep\`)`)
- A step number from "Recommended rebuild order" (e.g. `step-1` or `1` if no per-area numbering exists)
- An exact area slug (e.g. `find-athletes`)

Parse the audit doc's per-area headings. If the requested number/slug doesn't resolve, list the valid options:

> Area not found. Valid areas in this audit:
>
> 1. Dashboard (`/`)
> 2. Find athletes (`/sweep`)
> 3. Review queue (`/review`)
>    ...
>    Pick one by number or slug.

Do not proceed.

**0d. Auto-increment the output filename.** List `.gg/plans/NN-*.md` and pick the next NN. Slug = kebab-case of the area name. Examples: `01-find-athletes-wizard.md`, `02-athlete-detail-rebuild.md`. State the chosen path before writing.

Only after 0a–0d succeed, continue.

## Step 1: Read the audit context

Pull the following from the audit doc — quote it where useful, don't paraphrase loosely:

- **Audience paragraph** (top of audit). This is the persona the plan must serve.
- **Form-factor stance.** Desktop-primary / mobile-first / equal — drives every "mobile note" decision in the plan.
- **The four-shapes table.** The plan must classify its target screen against this same table.
- **Cross-cutting findings that touch this area.** A vocabulary leak flagged in `C1` that appears on this screen is in scope; one that doesn't is not.
- **The chosen area's full section.** Job-to-be-done, current shape, what works, full "what to fix" list (Critical/High/Medium/Low with file pins), mobile note, rebuild priority.

If any of these are missing from the audit (e.g. no form-factor stance stated, no file pins on findings), STOP and tell the user:

> Audit doc is incomplete for planning — missing: `<list>`. Re-run `/ux-audit` to fill these in.

A plan composed on a half-formed audit is worse than no plan.

## Step 2: Read the implementation

For every finding in the chosen area, locate the actual code and pin every change to `file:line`. No plan section may say "modify the form" — must say "modify `apps/web/src/app/(admin)/sweep/new/page.tsx` lines 23–31."

Read at minimum:

- The page component the area lives in.
- Filter-bar / detail / step subcomponents the findings reference.
- The shared layout / sidebar / header file (for cross-cutting findings that touch this area).
- The router config or route file (if the area's URL semantics are in play).

Read sibling screens too — when this area's rebuild will introduce a pattern (wizard, faceted filter, "next action" card) that another area also needs, note it. Don't expand the plan to do both, but flag the reusability so the per-component notes can name the right primitive.

Note imports actually in use. If the plan will compose a new pattern, list the existing dependencies it will reuse (form library, state library, design tokens, icon set). **The plan adds no new dependencies** unless the audit explicitly identified a gap that requires one.

## Step 3: Pull the same external reference the audit cited

If the audit's chosen area pointed at a public-repo pattern (e.g. `KenKaiii/king/src/renderer/src/pages/CreateAdsPage.tsx` for wizards), search the curated Steroids corpus first. Call Steroids with `action: "search"`, scoped to the cited repository when known and using literal component, route, state, or layout anchors; retain its immutable URL, then call `action: "show"` for the accepted file and line range.

If Steroids reports a real corpus gap, automatically call `discover` with a short topic or language query. If discovery finds repositories, use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, repeat `search`, and confirm the accepted file with `show`.

The plan's "Reference" section names the repo + file + lines + the specific shape being borrowed (state machine, progress dots, fixed-height step body, etc.) — not "looks similar to king." The fix agent reading the plan must be able to open the same file and recognise what's being copied.

If the audit didn't cite a reference for this area but the rebuild introduces an unfamiliar shape, run the same curated-first Steroids `search` and `show` sequence before writing the plan. If no concrete public example exists after the corpus-gap flow, say so explicitly in the plan — never invent authority.

Local code and locally rendered evidence remain authoritative for this project's behavior. External references cannot prove local UI behavior, usability, responsiveness, accessibility, or product requirements.

Skip this step entirely for areas where the rebuild is pure copy/IA cleanup with no new component shape.

## Step 4: Compose the plan doc

Write to the path chosen in Step 0d. Use this exact structure — variance allowed within sections, not across them:

```
# Plan NN — <area name>

**Scope:** Step N of the UX rebuild from `<audit-doc-path>`. <One-sentence
what-this-covers.>

**Reference:** <repo/path file:lines> — <one-sentence what's borrowed>.
Read it once before reviewing the diff.

## Why this exists

One paragraph distilled from the audit's "what to fix" for this area —
plain English, persona-voiced, references the audit's resolved decisions
if any.

## What it becomes

Concrete description of the post-rebuild state. Tables, file shapes,
component boundaries. The fix agent should be able to picture the
finished screen from this section alone.

## Hard constraints

Numbered list. Especially: no backend changes, no new deps, shared
components untouched, existing routes still resolve, existing tests
still pass.

## File-level plan

### New files
Bullet list of paths + one-line purpose each.

### Changed files
For each file: path + a short comment explaining the diff intent. Pin
to file:line where the change lives.

### Files we DON'T touch (defensive list)
Non-optional. Every plan must enumerate the files that must stay
byte-identical to prevent regression in unrelated areas. Include the
shared form fields, the router, the domain layer, any sibling page
that uses the same primitives.

## <Per-component or per-section notes>

One subsection per new component or major change. Each names the
component, its props shape, the state it owns, and the exact behaviour
the audit's findings demand. Reference the external pattern by file
path where relevant.

## Tests

Vitest unit cases + Playwright e2e cases (or project equivalent), each
specific to a finding. No "add tests" placeholders.

## Verification gate

Exact commands the implementer runs before declaring done. Includes
typecheck, lint, unit tests, e2e tests, and an eyes screenshot probe.

## Risks & mitigations

R1..RN. One-line risk + one-line mitigation each. Pull from the audit's
"what to fix" list — every Medium/High finding that has a real downside
becomes a risk row.

## Out of scope (explicit)

Bulleted non-goals. Pulled from the audit's other areas plus anything
this area's findings could be confused with.

## Steps

Single flat numbered list — the plan-mode contract. This is the LAST
section. Nothing comes after it.
```

The plan doc is the contract for plan-mode execution. Section order is fixed. Empty sections get a one-line "N/A" rather than being omitted.

## Step 5: Plan discipline rules

These are non-negotiable rules the plan body must follow. Violating any one is a defect:

1. **Every change traces to a finding in the audit.** If the plan introduces work the audit didn't sign off on, that work is out of scope. State this rule near the top of the plan body: _"Any change not traceable to a finding in `<audit-path>` is out of scope."_
2. **Every change pins to `file:line`.** "Modify the form" is banned. "Modify `path/to/file.tsx` lines 23–31" is required.
3. **The defensive "do not touch" list is non-optional.** A plan with no `### Files we DON'T touch` section is incomplete. Even a tiny plan touching one file lists the sibling files that stay byte-identical.
4. **`## Steps` is the last section and is a single flat numbered list.** No nested sublists. No prose between steps. No sections after Steps. This matches the plan-mode output contract.
5. **No new dependencies.** Reuse what's already imported in the codebase. If the audit explicitly identified a need for a new dep, quote the audit's reasoning in `## Hard constraints`.
6. **No backend / domain / router changes** unless the audit explicitly flagged them. Most UX rebuilds are presentation-only. State this in `## Hard constraints` even when obvious.
7. **Tests are specific.** Each Vitest/Playwright case names the finding it covers and the exact assertion. No "add tests for the wizard."
8. **The plan ends with what the implementer runs.** `## Verification gate` lists concrete commands. The fix agent shouldn't have to guess.

## Step 6: Report

Reply inline with:

```
Audit:       <audit-doc-path>
Area:        <number>. <area name>
Plan:        .gg/plans/NN-<slug>.md (<wc -l> lines)
Reference:   <repo/path> [or "none — pure copy/IA cleanup"]
Findings covered: <N> (<N> Critical, <N> High, <N> Medium)
Files touched: <N> new, <N> changed, <N> on do-not-touch list
Tests planned: <N> unit, <N> e2e
```

Then one line each:

```
Plan written: .gg/plans/NN-<slug>.md
```

After the report, ask:

> Review the plan and approve to start execution, or call out anything to revise. The `## Steps` list at the bottom is what plan-mode will execute.

## Rules

- **No audit doc, no plan.** Bail loud in Step 0 if the audit is missing or malformed. Do not invent an audit.
- **One plan, one area.** This command produces a plan for _one_ prioritised area. Multiple plans = multiple invocations.
- **File pins everywhere.** No section of the plan body uses vague references. Every change is `file:line`.
- **Defensive list non-optional.** Every plan enumerates files that must stay byte-identical.
- **`## Steps` is the last section.** Plan-mode contract. Single flat numbered list. Nothing follows.
- **No new dependencies.** Unless the audit explicitly identified a gap requiring one.
- **No backend changes** unless the audit explicitly flagged them.
- **Cite the reference by repo + file path** when the rebuild copies an external pattern. Not "industry standard."
- **Persona from the audit drives every copy choice in the plan.** Don't second-guess the audit's audience paragraph — the audit is the source of truth.
- **Do not edit source files.** The plan doc is the only write.
