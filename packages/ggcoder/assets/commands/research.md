---
argument-hint: [question, technology, decision, or scope — optional]
description: Hardcore evidence-led technical and design research with Ken-first discovery, saturation, immutable citations, strict verdicts, and roadmap-ready references.
allowed-tools: Read, Grep, Glob, Bash, mcp__kencode-search__referenceSources, mcp__kencode-search__discoverRepos, mcp__kencode-search__searchCode, source_path, tool_search, web_search, web_fetch
---

# Research

Perform deep, adversarial research for the decision implied by `$ARGUMENTS` and the current conversation. Produce an evidence report only. Never enter plan mode, edit project source, install dependencies, change Git state, create tasks, call roadmap tools, or implement recommendations.

## 1. Resolve the real research question from context

Treat the current conversation as first-class scope, not disposable background.

1. Read `$ARGUMENTS` as a refinement or explicit override.
2. Recover the user's goal, constraints, rejected approaches, current implementation, unresolved questions, and intended decision from the current conversation.
3. Inspect the local project only where needed to establish the actual baseline.
4. If `$ARGUMENTS` is empty, research the most recent concrete unresolved decision in the conversation.
5. Ask one clarifying question only when multiple materially different research targets remain and choosing one would make the report misleading. Otherwise proceed.

State the resolved question before researching. Conversation context proves user intent; it does not prove technical or design facts.

## 2. Establish the local baseline

Before external discovery, identify what the project really uses:

- relevant package versions from manifests and lockfiles
- active framework, runtime, provider, styling system, and deployment target
- existing implementation, types, tests, configuration, components, tokens, and constraints
- exact local evidence as `path/to/file.ext:Lx-Ly`
- recent diff or commits only when relevant to the question

Use real imports, callers, tests, config, and rendered behavior. Do not infer behavior from filenames or dependency names alone. Local inspection establishes the baseline; it must not change files or Git state.

## 3. Use Ken's kencode-search MCP first

Ken's kencode-search MCP is the mandatory first-priority external discovery system. Local baseline inspection may happen first, but no other external discovery tool may precede it.

1. First call `mcp__kencode-search__referenceSources` with domain, category, stack, style, query, and result-count filters matched to the actual question. Do not use generic defaults when narrower filters are supported.
2. Next call `mcp__kencode-search__discoverRepos` for documented coverage gaps, current or obscure candidates, regional ecosystems, and alternatives beyond popular defaults. Use it before generic external discovery whenever those needs exist.
3. Use `mcp__kencode-search__searchCode` only when that capability is actually exposed. Search varied literal code anchors, imports, API names, configuration keys, and filenames; paginate with increasing `offset` values where more results exist. Do not submit semantic questions as literal code searches.
4. Never invent, rename, or simulate a missing Ken tool. If a Ken capability is unavailable or fails, disclose that prominently near the start of the report and name the exact fallback used for that capability.
5. Only after the applicable Ken MCP calls may you use `tool_search`, `web_search`, `web_fetch`, `source_path`, or further local inspection for official contracts, current versions, installed-version source, canonical-source verification, immutable citations, adversarial checks, or a documented gap Ken's MCP could not resolve.

`tool_search` is a fallback capability lookup, not permission to pretend Ken's `searchCode` exists. Search hits and repository metadata are discovery leads, never final evidence.

## 4. Branch the research to the question

### Technical research

Prioritize:

- official contracts, specifications, release notes, migrations, and advisories
- source matching the installed version, maintainer tests, and canonical examples
- production integrations and compatibility with the local runtime and platforms
- maintenance activity, dependency weight, transitive risk, and simpler local alternatives
- security boundaries, failure modes, accessibility, and operational cost

For installed dependency APIs or internals, resolve the installed version with `source_path` after Ken-first discovery and inspect that source rather than relying on memory.

### Design research

Research production-quality evidence for:

- styling systems, composition, hierarchy, spacing, typography, and component silhouettes
- interaction models, restrained motion, responsive recomposition, and conversion patterns
- reduced-motion behavior, keyboard and screen-reader accessibility, contrast, and focus
- implementation quality, maintainability, asset provenance, and fit with the local stack

When design or ecosystem practice matters, deliberately diversify discovery across Western, Asian, and other non-obvious regional sources, terminology, stacks, popularity levels, established projects, and current obscure projects. Record how the queries diversified. Do not apply geographic quotas when geography is irrelevant to the question.

## 5. Run a saturation-based discovery pass

Do not stop at an arbitrary query count.

1. Inspect at least eight serious candidates and three materially different pattern families when available evidence supports that breadth.
2. A serious candidate requires repository-level inspection, not a search card, screenshot, landing page, or README claim.
3. Run diversified discovery rounds that vary filters, terminology, literal anchors, stacks, regions when relevant, popularity levels, and established versus obscure projects.
4. Continue until three consecutive rounds produce only repeats or candidates that are stale, tutorial-only, generic, inaccessible, unlicensed, incompatible, or materially weaker.
5. If the evidence pool cannot support eight candidates or three families, state the shortfall and the exact searches performed; never pad the set with weak candidates.

Keep a compact query and rejection ledger during research. For every round record the tool, filters or literal query, offset when used, candidates surfaced, accepted or rejected status, rejection reason, and whether the round advanced coverage. Show the final three no-gain rounds as saturation evidence.

Never use stars as proof, search-result counts as evidence, mutable branch links as final citations, or inaccessible/minified output as transferable source code.

## 6. Inspect and reject candidates rigorously

Before recommending any external candidate or pattern, inspect its real repository files, tests, examples, dependency manifests, maintenance state, and license.

Reject candidates that are:

- deprecated, abandoned, tutorial-only, generated, copied, or legally unclear
- inaccessible, minified-only, or unsupported by inspectable canonical source
- accessibility-broken or reduced-motion-broken where those behaviors apply
- bloated relative to the local need, version-incompatible, or platform-incompatible
- weaker than a simpler existing local pattern or native capability

Treat proprietary or unlicensed visual references as read-only evidence. Extract only transferable principles; never transfer literal code, assets, copy, branding, class names, or identity.

For every accepted external pattern, record:

- canonical repository and clickable immutable revision URL
- exact path and line range containing the evidence
- license and provenance status
- version and local-stack fit
- what the evidence proves
- how the principle transfers without copying protected identity

## 7. Research from strongest evidence outward

Assume remembered APIs, defaults, recommendations, and version behavior are stale. Verify current sources.

Evidence priority:

1. official documentation, specifications, release notes, migration guides, and security advisories
2. maintainer canonical repository source, tests, examples, issues, and pull requests
3. current production implementations in reputable public repositories
4. maintainer discussions with concrete code or rationale
5. secondary articles only as discovery leads, never as sole proof

For each serious candidate approach:

- find the authoritative contract or documented behavior
- inspect canonical source or tests that implement it
- inspect at least one real integration when ecosystem practice matters
- search for counterexamples, deprecations, incompatibilities, and failure reports
- compare it directly with the local baseline

A search hit is a lead, not evidence. Read the source before citing it.

## 8. Canonical evidence rules

Every accepted external code or design-pattern claim must include all of:

- canonical repository URL: `https://github.com/<owner>/<repo>`
- immutable revision: preferably a full commit SHA, otherwise an exact release tag with the limitation stated
- repository path and exact line range
- clickable immutable URL: `https://github.com/<owner>/<repo>/blob/<revision>/<path>#L<start>-L<end>`
- license/provenance status and version fit
- one sentence explaining what those lines prove
- one sentence explaining how the pattern transfers to this project

Use the canonical owner and name after redirects or transfers. Never use a search-result URL, fork, mirror, mutable branch URL, package-registry page, generated snippet, or blog as canonical code evidence when upstream exists.

For issues and pull requests, include the canonical repo URL plus the issue/PR number and direct URL. For official docs outside a repository, cite the canonical docs URL and exact heading or anchor, but do not invent repository coordinates.

Line evidence must contain the claimed behavior. Cite the narrowest useful range. If exact immutable line evidence, provenance, or license cannot be verified, classify the claim `UNRESOLVED` or `REJECT` instead of laundering uncertainty through a weak citation.

## 9. Test each finding adversarially

Before accepting a finding, try to disprove it:

- Is the local implementation already equivalent under a different name?
- Is the pattern version-specific, deprecated, generated, copied, test-only, or platform-specific?
- Does a framework consume the value implicitly?
- Is the missing behavior intentionally handled by a lower layer?
- Would it violate local architecture, package boundaries, security, accessibility, licensing, or supported platforms?
- Is the repository demonstrating a workaround for an obsolete version?
- Is there a simpler local, standard-library, native, or already-installed alternative?
- Does reduced-motion, responsive, keyboard, or screen-reader behavior fail under inspection?

For `CHANGE` or `ADD`, require one authoritative source and one independent production implementation when practical. If one primary source is decisive, state why a second source is unnecessary. Never turn popularity into correctness.

## 10. Classify every candidate

Use exactly one verdict per finding:

- `KEEP` — the current local approach is correct, current, and supported; no roadmap work.
- `CHANGE` — an existing local behavior or design should change; state the delta and migration risk.
- `ADD` — a missing capability, guard, test, contract, or integration should be introduced; prove relevance.
- `REJECT` — a considered pattern should not be adopted; state the incompatibility or weaker tradeoff.
- `UNRESOLVED` — evidence is conflicting, incomplete, inaccessible, legally unclear, version-mismatched, or insufficient; state what resolves it.

Do not force a recommendation. `KEEP`, `REJECT`, and `UNRESOLVED` are successful outcomes.

Each finding must include:

- stable ID such as `CHANGE-01`
- verdict and confidence: high / medium / low
- concise decision
- local evidence with exact file/line ranges, or `No local implementation` with the search performed
- external evidence with canonical repo and immutable file/line links
- license/provenance and compatibility/version notes
- tradeoff or failure mode
- consequence for this project

Deduplicate overlapping findings. Separate facts from interpretation.

## 11. Report format

Return one Markdown report with these sections.

### Research target

- resolved question
- context used from the current conversation
- user constraints preserved
- local stack/version baseline
- research date
- research branch: technical, design, or both
- **Ken MCP status and fallback disclosure** — name every unavailable or failed Ken capability and the exact fallback used; write `All applicable Ken capabilities succeeded; no fallback used` otherwise

### Executive decision

A tight answer including counts:

`KEEP <N> · CHANGE <N> · ADD <N> · REJECT <N> · UNRESOLVED <N>`

### Local baseline

A short table of relevant local facts and exact `file:Lx-Ly` evidence.

### Candidate coverage

State serious-candidate and pattern-family counts. For regionally relevant work, summarize regional, terminology, stack, popularity, and project-age diversification without treating geography as a quota.

### Query and rejection ledger

| Round | Tool | Filters/query/offset | Candidates | Decision and rejection reason | New coverage? |
| ----- | ---- | -------------------- | ---------- | ----------------------------- | ------------- |

Include the three consecutive no-gain rounds that established saturation. Log every serious rejected candidate and its concrete rejection reason.

### Findings

For every finding:

```text
#### CHANGE-01 — <decision>
Confidence: high
Local evidence: path/file.ts:L10-L28 — <what it proves>
External evidence:
- https://github.com/owner/repo
- https://github.com/owner/repo/blob/<full-sha>/path/file.ts#L40-L66 — <what it proves>
License/provenance: <verified license and source status>
Version fit: <fit or mismatch>
Transfer: <principle that applies locally without copying protected identity>
Why: <reasoned comparison>
Project consequence: <specific impact>
```

Order findings: `CHANGE`, `ADD`, `KEEP`, `REJECT`, `UNRESOLVED`. Within a verdict, order by impact.

### Evidence ledger

One row per external source:

| Ref key | Canonical repo | Revision | Path/lines | Immutable evidence URL | License/provenance | Version fit | Used by | What it proves/transfers |
| ------- | -------------- | -------- | ---------- | ---------------------- | ------------------ | ----------- | ------- | ------------------------ |

Include official non-repository documentation separately with canonical URLs and exact anchors.

### Roadmap handoff — not submitted

Emit valid JSON that can be copied into a `roadmap_phase_draft` call after adding `expected_revision` and `summary`. Include only `CHANGE` and `ADD` work. Do not call `roadmap_inspect`, `roadmap_phase_draft`, `roadmap_status`, or any other roadmap tool.

```json
{
  "phases": [
    {
      "title": "Concrete outcome",
      "goal": "What changes and why",
      "doneWhen": ["Observable, testable completion criterion"],
      "sourcePrompt": "Self-contained implementation brief grounded in the research finding and local paths.",
      "reference_keys": ["owner-repo-purpose"]
    }
  ],
  "proposed_references": [
    {
      "reference_key": "owner-repo-purpose",
      "provider": "github",
      "tool": "actual discovery tool used",
      "canonical_url": "https://github.com/owner/repo",
      "owner": "owner",
      "repo": "repo",
      "revision": "full immutable commit SHA or exact tag",
      "path": "path/to/file.ts",
      "range": {
        "start_line": 40,
        "end_line": 66
      },
      "relevance": "What these exact lines prove and which recommendation they support."
    }
  ]
}
```

Roadmap handoff rules:

- use exact snake_case field names shown above
- use unique, stable `reference_key` values of at most 128 characters
- `canonical_url` is the canonical repository root, not a search URL
- include `revision`, `path`, and `range` whenever file evidence exists
- optionally include `issue`, `pull_request`, `query`, or `anchor` only when verified and relevant
- omit unknown optional fields; never use `null`, placeholders, ellipses, or invented coordinates
- every proposed reference must be linked by at least one phase's `reference_keys`
- every phase reference key must resolve to exactly one proposed reference
- deduplicate references by canonical repo/source identity
- make each phase flat, independently understandable, and implementation-ready
- do not create phases for `KEEP`, `REJECT`, or `UNRESOLVED`
- if there is no `CHANGE` or `ADD`, emit `{ "phases": [], "proposed_references": [] }`

### Unknowns

List only unresolved facts that could change the decision, with the exact next evidence needed. Omit when empty.

## Hard rules

- **Report only.** Never enter plan mode; edit project source; install dependencies; generate project code; run migrations; create tasks; call roadmap tools; implement recommendations; or commit, push, checkout, reset, or otherwise change Git state.
- Local inspection and read-only commands are allowed only to gather evidence and must leave the worktree unchanged.
- Ken's kencode-search MCP is the first external discovery system; disclose failures and exact fallbacks prominently.
- Use current conversation context and preserve explicit user constraints.
- Cite local claims with exact file/line evidence.
- Cite accepted external patterns with canonical repositories, immutable revisions, exact paths/lines, licenses, provenance, version fit, proof, and transfer guidance.
- Do not fabricate tools, URLs, revisions, paths, line numbers, versions, licenses, provenance, or consensus.
- Do not recommend broad rewrites when a narrow change satisfies the evidence.
- Do not hide contradictory evidence; use `REJECT` or `UNRESOLVED`.
- Keep the executive decision concise; put depth in findings and the ledgers.
