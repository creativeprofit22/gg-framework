---
argument-hint: [area, route, or scope — optional]
description: UX audit grounded in code and pixels. Classify each screen as wizard / workbench / worklist / config, find leaks, dead ends, and shape mismatches, then create one prioritised task per gap. Output is a durable audit doc in .gg/plans/.
allowed-tools: tasks, Bash, Read, Write, Edit, Grep, Glob, steroids, ask_user
---

# UX Audit

Audit user-facing screens against the job they're meant to do. Find vocabulary leaks, dead ends, shape mismatches, mobile breakage, and engineer-organised IA. This is UX grounded in code and pixels — not opinions, not "best practices." Produce a durable audit doc at `.gg/plans/ux-rebuild-audit.md` and create one task per unambiguous fix. Do not edit source files.

Pairs with `/ux-plan`. This command produces the audit doc; `/ux-plan` turns one prioritised area from it into an implementation plan. Don't try to do both in one command — the audit-before-plan separation is the whole point.

## The four shapes

Every user-facing screen is one of:

| Shape         | When                                 | Allowed density                                            |
| ------------- | ------------------------------------ | ---------------------------------------------------------- |
| **Wizard**    | Creating something with >2 decisions | Sparse — one decision per step, narrow centered column     |
| **Workbench** | Acting on one subject                | Medium — lead with "what should I do next?", details below |
| **Worklist**  | Finding/triaging across many rows    | Medium — ≤3 visible filters, ≤8 columns, faceted overflow  |
| **Config**    | Rarely-touched setup                 | Allowed dense                                              |

If a screen mixes two shapes, it's confusing — pick one. This lens drives most of the findings.

## Step 0: Feasibility & scope gate

Before anything else, decide if `/ux-audit` can run on this project. Do not skip.

**0a. Classify the project.** Read `package.json`, framework files, and directory structure. Classify into ONE of:

| Class                  | Signals                                              | Audit applicable   |
| ---------------------- | ---------------------------------------------------- | ------------------ |
| **Web SPA / SSR**      | React/Vue/Svelte/Solid/Next/Nuxt/Remix/Astro; routes | Yes                |
| **Electron**           | `electron` dep; main + renderer                      | Yes                |
| **React Native**       | `react-native`; `ios/` `android/` dirs               | Yes                |
| **Server / CLI / lib** | No UI; only API/CLI/library code                     | **Not applicable** |
| **Unknown**            | Mixed signals or nothing matches                     | **Ask user**       |

**0b. Bail loud if not applicable.** If the project has no UI surface, STOP and tell the user:

> This project has no UI surface — `/ux-audit` isn't applicable. Use **`/flow`** for journey/mechanic audits, **`/contract`** for interface gaps, or **`/audit`** for project hygiene.

Do not proceed. Do not install anything.

**0c. Persona discovery.** Read `CLAUDE.md`, `AGENTS.md`, `README.md`, and any top-of-repo product docs. Infer who this app is for in one paragraph (role, technical comfort, primary job). Show it to the user and ask:

> Inferred audience: **[one paragraph]**. Correct? [y to proceed / paste correction]

Persona is the lens for every "is this engineer English?" call later. Do not proceed on a guessed persona.

**0d. Form-factor stance.** Decide and state explicitly: **desktop-primary**, **mobile-first**, or **equal**. Default to desktop-primary for B2B tools, mobile-first for consumer; if the README disagrees, the README wins. State the decision and one-sentence justification. This becomes the audit doc's banner and the rule that drives mobile-note severity later.

**0e. Eyes availability.** Check for `.gg/eyes/visual.sh`. If present and the project has a dev server / app entry, plan to capture screenshots desktop (1400×1800) + mobile (390×844) for every top-level route. Output goes to `.gg/eyes/out/audit/{desktop,mobile}/`.

If eyes is missing or no dev server is configured, drop to **static-only mode**. Warn the user:

> No `.gg/eyes/visual.sh` / dev server detected — running in static-only mode. Pixel-level findings (mobile breakage, density, focus order, visual hierarchy) will be missing.

Do not auto-install eyes. Static-only is a documented degradation, not a failure.

Only after 0a–0e succeed, continue to Step 1.

## Step 1: Determine scope

If `$ARGUMENTS` is provided, use it as the area or route (e.g. "dashboard", "settings", "auth flow", `/sweep`).

If `$ARGUMENTS` is empty, infer scope from context — in this order:

- **Git diff** — `git diff --name-only HEAD~1 HEAD` and `git status --short` for recently changed UI files.
- **Active plan** — most recently modified file in `.gg/plans/`.
- **Session context** — what was just discussed or implemented.
- **Default** — full UI surface audit (every top-level route).

If multiple UI surfaces exist and none are obviously in scope, ask the user. Do not blanket-audit a monorepo without confirmation. A full-app audit is the right default when the user invokes `/ux-audit` with no argument and no recent UI changes.

## Step 2: Map the screens

Read the routing layer and build a flat list of every top-level user-facing route. Sources by framework:

| Framework            | Where to look                                           |
| -------------------- | ------------------------------------------------------- |
| Next.js App Router   | `app/**/page.tsx` (skip route groups in `(name)`)       |
| Next.js Pages Router | `pages/**/*.tsx` (skip `_app`, `_document`, API routes) |
| React Router         | the route config / `<Routes>` tree                      |
| Vue Router           | `router/index.ts` or equivalent                         |
| Electron             | renderer entry + its router                             |
| React Native         | navigator config (`@react-navigation/*`)                |

For each route, capture: path, page-component file, related filter-bar / detail subcomponents (one level deep). Skip auth/error/loading/not-found boilerplate unless they're real screens.

If the project has 20+ routes, group by sidebar/nav section and present the grouping to the user before deep-reading — confirm scope is the whole surface, not just one section.

## Step 3: Per-screen audit

For each route in scope:

**3a. Read the code.** Page component + any filter-bar / table / detail-sub-component files. Note: header pattern (heading size + subtitle), top-right CTA cluster, primary content shape, what the empty state says, any tabs / nested routes.

**3b. Screenshot (eyes mode only).** Run:

```bash
.gg/eyes/visual.sh <url> 1400x1800 --cookie "<session>" > .gg/eyes/out/audit/desktop/<slug>.png
.gg/eyes/visual.sh <url> 390x844  --cookie "<session>" > .gg/eyes/out/audit/mobile/<slug>.png
```

Authenticated routes need a session cookie — read the project's auth conventions (see `CLAUDE.md` if present) and reuse the documented pattern. Do not invent flows.

**3c. Identify the job-to-be-done.** One sentence in the user's language, not the schema's. Example: _"Get me a fresh list of athletes who might become clients."_ Not: _"Create a new SweepConfig row."_ If you can't phrase it without jargon, that's a finding — flag LEAKY-VOCABULARY at the screen level.

**3d. Classify the shape** (wizard / workbench / worklist / config). If the screen mixes two, that's a finding — WRONG-SHAPE.

**3e. Note what works.** Three bullets max. Honest — keep the parts that don't need touching so the rebuild doesn't accidentally destroy them.

**3f. List what to fix.** Use the finding-type table in Step 5. Pin every finding to `file:line`.

## Step 4: Cross-cutting findings

Some leaks repeat across screens and should be flagged once globally instead of N times per route. After Step 3, scan the per-screen notes for patterns:

| Cross-cutting class                     | What to look for                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Vocabulary**                          | Same engineering noun appears in ≥2 user-facing surfaces (e.g. "sweep", "enricher", "cron", "provenance") |
| **IA / sidebar**                        | Sidebar groups organised by data model instead of user job                                                |
| **Header pattern**                      | More than one heading-size / subtitle pattern coexists                                                    |
| **CTA copy**                            | Same primary CTA wording appears 4+ times across empty states                                             |
| **Power-user data on primary surfaces** | Score breakdowns, provenance, formulaVersion, internal IDs visible to non-engineers                       |
| **Mobile chrome**                       | Tables rendered as tables on mobile; modals with non-dismissable overlays; off-screen primary CTAs        |

Each cross-cutting finding gets a `C1`, `C2`, ... ID and lives in its own section of the audit doc. They are _not_ duplicated into per-screen sections.

## Step 5: Classify with the UX finding-type table

Use these finding types only:

| Type                      | What it means                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| **LEAKY-VOCABULARY**      | Engineering noun in user-facing UI ("sweep", "enricher", "cron", "provenance", "bucket") |
| **WRONG-SHAPE**           | Screen mixes two of {wizard / workbench / worklist / config} — pick one                  |
| **MISSING-NEXT-ACTION**   | Detail page doesn't lead with "what should the user do"                                  |
| **GLORIFIED-SPREADSHEET** | Worklist exposes >7 filters or >8 columns by default                                     |
| **CHATTY-WIZARD**         | Wizard has >5 steps, or one step asks >2 questions                                       |
| **DEAD-END**              | Flow succeeds but lands the user nowhere actionable                                      |
| **CONFIG-IN-PRIMARY**     | Configuration concern bleeds onto a primary user surface                                 |
| **DOC-ONLY**              | UI promises behaviour (label, button) that the code doesn't implement                    |
| **MOBILE-BROKEN**         | Page breaks below 390px (overflow, unreachable controls)                                 |
| **MOBILE-CRAMPED**        | Page renders but compresses content meant for desktop (table → squished table)           |
| **COULD-BE-SIMPLER**      | Subjective — works, but a calmer composition exists (opinion-laden)                      |

For each finding, record:

- **WHERE**: `file:line` for the offending element (and the route it appears on).
- **WHAT**: what's wrong, in plain English the persona would understand.
- **WHY IT MATTERS**: what the user actually experiences.
- **PROPOSED RULE / FIX**: concrete — actual replacement copy, component shape, file pin. Not "improve the layout".

Do NOT report:

- Pure code-style / refactor preferences.
- Performance suggestions.
- Theoretical issues that can't be triggered.
- Accessibility — that's `/wcag-audit`'s job.
- Things that work end-to-end and match the persona.

## Step 6: Severity

- **Critical** — DEAD-END / MOBILE-BROKEN / DOC-ONLY where the user literally cannot complete the job they came for.
- **High** — LEAKY-VOCABULARY, WRONG-SHAPE, MISSING-NEXT-ACTION, GLORIFIED-SPREADSHEET, CHATTY-WIZARD, CONFIG-IN-PRIMARY where the user can complete the job but the path is confused.
- **Medium** — MOBILE-CRAMPED, isolated LEAKY-VOCABULARY in a secondary surface, single misplaced setting.
- **Low** — COULD-BE-SIMPLER. Always opinion-laden. Never auto-tasked.

Form-factor stance modulates mobile severity: a desktop-primary B2B tool can downgrade MOBILE-CRAMPED on wizards/worklists to Low; a mobile-first consumer app upgrades any MOBILE-BROKEN to Critical. State the modulation explicitly in the audit doc.

## Step 7: Ground unfamiliar patterns with Steroids

Every High/Critical finding must reference an exact `file:line` in the audited project. When the proposed rebuild shape is unfamiliar (king-style wizard, Linear-style faceted filter, HubSpot-style record-with-mode), search the curated Steroids corpus first to pull at least one _concrete public-repo pattern_. Call Steroids with `action: "search"` using literal component, route, state, or layout anchors and `perRepo: 1`; diversify candidates with separate short queries rather than style or category filters. Then call `action: "show"` for at least one accepted source and relevant line range.

If Steroids reports a real corpus gap, automatically call `discover` with a short topic or language query. If discovery finds repositories, use `ask_user` for approval before `add`; never call `add` or `discover` with `add: true` before approval. After approval, add only the selected repositories, repeat `search`, and confirm accepted evidence with `show`.

Cite accepted evidence by `owner/name`, file path, lines, and the immutable URL retained from `search`. Not "best practices." Not vague "industry standard." If no concrete public example exists after the Steroids sequence, say so and downgrade the finding to "needs reference" rather than inventing one. Sources earn their cited spot.

Use external references for two reasons:

1. **Avoid false positives.** What looks WRONG-SHAPE may be a legitimate hybrid pattern (e.g. inline-edit workbench-inside-worklist) supported by real examples in the curated Steroids corpus.
2. **Pre-bake the fix recipe.** Once Steroids `search` and `show` confirm the pattern, the audit doc references the accepted source (repo + file) and `/ux-plan` can reuse that same reference when composing the implementation plan.

Local code and locally rendered evidence remain authoritative for this project's behavior. External references cannot prove local UI behavior, usability, responsiveness, accessibility, or product requirements.

Skip this step for purely project-internal patterns where the local convention is obvious from a sibling screen.

## Step 8: Write the audit doc

Write to `.gg/plans/ux-rebuild-audit.md` (or `.gg/plans/ux-audit-<area>.md` if a sub-area was named in `$ARGUMENTS`). Use this exact section order — variance allowed within sections, not across them:

```
# UX Rebuild Audit — <project>

**Audience:** <persona paragraph from Step 0c>
**Method:** <how the audit was run — files read + screenshots captured + which Steroids refs were pulled>
**Form-factor stance:** <decision from Step 0d + one-sentence justification>
**The four shapes:** wizard / workbench / worklist / config — table

[Static-only banner here if eyes was unavailable:
 ⚠ Static-only audit — no pixel-level findings. Set up
 .gg/eyes/visual.sh for full coverage.]

## Cross-cutting findings (C1..CN)
Each: title, what's wrong, where it appears (route list), proposed rule, file pins.

## Per-area audit
For each route in scope:
  ### N. <Area name> (`<route>`)
  **Screenshot:** path to .png (desktop + mobile) — omit in static-only mode
  **Job-to-be-done:** one sentence in user language
  **Shape:** wizard / workbench / worklist / config
  **What works:** ≤3 bullets
  **What to fix:** prioritised H/M/L bullets, each pinned to file:line
  **Mobile note:** polish target / must-not-break / desktop-only
  **Rebuild priority:** High / Medium / Low

## Recommended rebuild order
Numbered, with one-line "why now" each. Ordered for momentum — ship the visible win first.

## What I'm not recommending
Explicit non-goals so the user can disagree.

## Open questions
Things that need a user decision before any rebuild step can start. One sentence per question.
```

The doc is the contract between this command and `/ux-plan`. Do not invent sections. Do not skip sections. If a section has no content, write a one-line "N/A — none found" rather than omitting it.

## Step 9: Create tasks

For every Critical / High / Medium finding, add one task to the task pane using the `tasks` tool (action: `add`). One task per finding.

**For Low findings (COULD-BE-SIMPLER): do NOT auto-create tasks.** These are opinion calls. List them inline in the audit doc under "Open questions" and ask the user which to convert.

Each task must be self-contained — a fix agent in a separate chat must execute it with no extra context. Include:

- Severity label (Critical / High / Medium).
- Finding type (LEAKY-VOCABULARY / WRONG-SHAPE / etc.).
- The route / area being fixed.
- Exact `file:line` for the offending element.
- The persona one-liner from Step 0c (so the fix agent knows whose language to use).
- A concrete fix — actual replacement copy, component shape, props. Not "make it friendlier".
- If a public reference was pulled in Step 7, the `owner/name` + file path so the fix agent can read the same pattern.
- Any related files the fix agent should read first (shared layout, tokens, sibling screens).
- **Fallback grounding clause**: if the recipe is ambiguous or no public reference was found, tell the fix agent to search the curated Steroids corpus for the specific pattern and confirm accepted source lines with `show` _before_ writing code. On a real corpus gap, it must automatically `discover`, obtain approval before `add`, then repeat `search` and `show`. Otherwise omit — don't pad every task.

Order: Critical → High → Medium.

If a finding is too ambiguous to write a concrete fix for, mark it Skipped with a reason. Do not silently drop it. Do not create vague tasks.

## Step 10: Report

Reply inline with:

```
Audited: <scope>
Mode: <eyes / static-only>
Routes mapped: <N>
Findings: <N> (<N> Critical, <N> High, <N> Medium, <N> Low)
Cross-cutting: <N>
Tasks created: <N> (Critical/High/Medium auto-tasked)
Needs decision: <N> (Low — COULD-BE-SIMPLER, listed below)
Audit doc: .gg/plans/<filename>.md
Screenshots: .gg/eyes/out/audit/{desktop,mobile}/ (<N> images)  [omit in static-only mode]
Skipped: <N>
```

Then one line per task:

```
[Critical] [DEAD-END]         /route — one sentence
[High]     [LEAKY-VOCABULARY] file:line — one sentence
[High]     [WRONG-SHAPE]      /route — one sentence
[Medium]   [MOBILE-CRAMPED]   /route — one sentence
...
```

Then any Low findings awaiting decision:

```
Needs decision:
  [COULD-BE-SIMPLER] /route — current shape / proposed shape
```

Then any skipped:

```
Skipped: file:line — reason a concrete fix couldn't be written
```

After the report, ask:

> Convert any of the `Needs decision` items into tasks? List the IDs or say `none`.
>
> Ready to plan a rebuild? Run `/ux-plan .gg/plans/<filename>.md <area-number>` for the area you want to start with — the audit's recommended order is in the doc.

## Rules

- Read code before classifying. Do not flag from screenshots alone.
- Every High/Critical finding cites `file:line` in the audited project. Generic "consider improving the layout" bullets are banned.
- One task per gap. Do not bundle.
- Vocabulary findings name both sides: today's noun AND the persona-correct replacement.
- Shape classification is mandatory per screen. "Mixed" is a finding (WRONG-SHAPE), not a classification.
- Persona drives every "is this engineer English?" call. Do not flag jargon as a leak if the audience is engineers.
- Form-factor stance is stated once at the top and applied consistently. Do not flag a desktop-primary B2B tool for "not optimised for mobile."
- Static-only mode emits the banner in the audit doc itself so future readers know what's missing.
- Cite real public references when grounding unfamiliar shapes. Repo + file path, not "best practices."
- Audit doc structure is fixed. Per-area content varies; section order doesn't.
- Do not edit source files. The audit doc + task creation are the only writes.
