/**
 * Prompt-template commands — slash commands that inject detailed prompts
 * into the agent loop. Each command maps to a full prompt the agent executes.
 */

import { isGgApp } from "./runtime-mode.js";

export interface PromptCommand {
  name: string;
  aliases: string[];
  description: string;
  prompt: string;
}

const IS_GG_APP = isGgApp();

const TASKS_ADDED_NOTICE = IS_GG_APP
  ? 'Tasks added. Click the "Tasks" button to open the task list and run them.'
  : "Tasks added. Press Ctrl+T to open the task list and run them.";

// The context file is whichever name won CONTEXT_FILES priority for this repo
// (AGENTS.override.md > AGENTS.md > CLAUDE.md > …), so the notice stays
// filename-agnostic — /init picks the winner at run time.
const CLAUDE_MD_RESTART_NOTICE = IS_GG_APP
  ? '> ⚠️ The project context file was created/updated. GG App loads it fresh per session, so start a **New Session** (click "+ New") before continuing. Without a new session, I won\'t see the new context.'
  : "> ⚠️ The project context file was created/updated. ggcoder loads it at startup, so **exit and restart ggcoder** (`/quit` then run `ggcoder` again) before continuing. Without a restart, I won't see the new context.";

/**
 * Shared sub-agent fan-out phrasing. One home so the "call the tool N times
 * in a single response" wording can't drift between command prompts.
 */
const spawnParallel = (count: string | number): string =>
  `in parallel using the subagent tool (call the subagent tool ${count} times in a single response)`;

/**
 * Kencode-search ships behind deferred MCP loading (`deferredMcpTools` defaults
 * to true), so its tools sit in the `tool_search` catalog until promoted. Any
 * command that names an `mcp__kencode-search__*` tool must say how to unlock it,
 * or the call fails on a default install.
 */
const KENCODE_UNLOCK_NOTE =
  'If the `mcp__kencode-search__*` tools aren\'t active yet, call `tool_search` (e.g. "search public code") first to unlock them.';

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "expand",
    aliases: [],
    description: "Find exciting new features to add",
    prompt: `# Expand: Exciting Feature Discovery

Find the most exciting new features this project should add by comparing it to similar, adjacent, and best-in-class repositories/tools/products/services. This command is project-agnostic: infer what THIS project is before choosing comparisons. This command is report-first and feature-first — the only deliverable is a single ranked table of exciting, user-facing features. Do not edit, install, or implement anything until the user chooses an option at the end.

Focus on what users actually get excited about: the new, killer, user-facing capabilities that make a product stand out. Security audits, refactors, code-quality cleanups, tests, CI, and ops/DX hygiene are OUT OF SCOPE here — exclude them unless a specific item is itself an exciting user-facing feature.

## Phase 0: Profile this project first

Before external research, inspect the local project and write a private working profile:

- What the project does, who its users are, and how they use it.
- Core user-facing surfaces, workflows, commands/routes/screens, and the features that already exist.
- The feature categories most relevant to THIS project. Do not assume a stack or product type.

Use this profile to decide which features are relevant and genuinely missing. If the user passed arguments to /expand, treat them as a focus area and prioritize that lens while still validating relevance.

## Phase 1: Parallel feature research

Spawn exactly 5 sub-agents ${spawnParallel(5)}. Give each sub-agent the project profile and a different feature-hunting lens:

**Agent 1 - Direct competitor killer features**: The standout, most-loved user-facing features in the closest peer projects/tools/products that this project lacks.

**Agent 2 - Adjacent & emerging tools**: Exciting user-facing features from adjacent products that would translate well to this project.

**Agent 3 - User demand signals**: Highly requested or trending features — top-voted issues, roadmap items, community asks, reviews, discussions — that point at what users want next.

**Agent 4 - Platform & ecosystem trends**: New user-facing capabilities unlocked by recent framework/API/model/platform releases that this project has not adopted yet.

**Agent 5 - Differentiators & wow-factor**: Novel or innovative features that would make this project stand out, even if no single peer has shipped them yet.

Each sub-agent must:

1. Use current sources: prefer repos/releases/changelogs/docs/articles updated within the last 6 months. Drop old or stale sources unless they are canonical and still actively maintained.
2. Return only user-facing FEATURES that appear absent in this project — not refactors, hardening, tooling, tests, or internal cleanup.
3. Include source names/URLs, freshness date (commit/release/article/doc date), and the local search anchors they used or recommend to verify the feature is absent.
4. Rank its own candidates by how exciting and valuable they would be to users, and state why each is exciting.
5. Avoid generic wishlist items. Every feature must be grounded in an external comparison or a real user-demand signal and relevant to this project profile.

## Phase 2: Main-agent validation against this repo

For every candidate from the sub-agents, validate it yourself before reporting:

1. Confirm the external source is relevant to this project and fresh enough (normally within 6 months).
2. Search this repo with grep/find and language-aware anchors to confirm the feature is not already present under another name.
3. Check routes, CLI commands, UI surfaces, package exports, config, docs, and examples before calling a feature missing.
4. Use mcp__kencode-search__searchCode when a code-level look clarifies how peers actually ship the feature. Use literal imports, functions, config keys, CLI flags, route names, or package names — not conceptual phrases. ${KENCODE_UNLOCK_NOTE}
5. Drop anything already present, irrelevant, too vague, too stale, or that is not a real user-facing feature.
6. Merge duplicates and keep only the most exciting 5–10 features.

## Final output

Output ONLY a single table, ranked most exciting (rank 1) to least exciting. No prose before or after the table except the options below. Include 5–10 rows. The table must have exactly 3 columns:

| Rank | Feature | Why it's exciting + evidence |
|---|---|---|
| 1 | concise feature name + what it does | why users would love it, which peers/tools have it, source + fresh date, and local proof it is missing |

Rules:

- 5–10 rows, ordered most exciting first (rank 1 = most exciting).
- Only user-facing features. No security, refactor, ops, tooling, or test rows.
- The table must have exactly 3 columns. Put source URL/date/evidence and local absence proof inside the cells, not extra columns.
- Keep each cell concise but specific enough to be actionable.
- If no exciting validated features are found, output one row saying no fresh validated features were found.

After the table, ask exactly:

What should I do?
A) Build all of these features in plan mode
B) Build only the top priority ones in plan mode
C) Other

Do not start implementing until the user chooses.

If the user chooses A or B, do not implement directly. First call the enter_plan tool, then research and design an implementation plan for the selected features (all of them for A; the top 3 most exciting — ranks 1-3 — for B). The plan must cover, per feature: the user-facing behavior, the local files/anchors it touches, the implementation approach (compared against real-world examples via kencode search using literal code tokens), and how it will be verified. Write the plan to .gg/plans/<name>.md, then call exit_plan with the plan path so the user can review and approve it. Do not begin implementing until the user approves the plan.

If the user chooses C, ask what they would like — pick specific features by rank, refine or re-scope the list, or skip — and do not implement anything until they say so.`,
  },
  {
    name: "bullet-proof",
    aliases: ["bp"],
    description: "Audit exploitable weaknesses",
    prompt: `# Bullet-Proof: Defensive Security Review

This is an **authorized defensive security review** of this repository, requested by its owner so weaknesses can be found and patched before they ship. This is standard defensive security work — the same review a security engineer performs before a release. The entire flow is **read-only reporting**: no code changes, no exploit development, and nothing is fixed until the user explicitly chooses at the end.

Defensive ground rules (apply to every phase and every subagent):
- Never produce working exploit code, weaponized payloads, or attack tooling.
- Describe each risk at the **data-flow level** — where untrusted data enters, what it can reach, and why that is fixable — so every finding maps directly to a patch.
- The deliverable is a remediation report for the maintainers, nothing else.

Goal: harden this project. **Report only HIGH CONFIDENCE findings (≥0.8) with a concrete data-flow path that demonstrates exposure.** Better to miss theoretical issues than flood the report with noise.

This command is **dynamic and project-agnostic**. Recon drives everything. Do not assume the stack, the language, the deploy target, or that there is an LLM/agent layer. Read first, decide second.

## Phase 1: Recon — Understand THIS project before auditing anything

Spawn **FOUR recon subagents** ${spawnParallel(4)}. Each has a narrow, independent slice so they can all run at once. **No vulnerabilities flagged in this phase.**

**Recon Agent A — Stack & Deployment.** Read manifests, lockfiles, CI/CD configs, Dockerfile/Helm/Terraform, deploy scripts. Produce:
- Primary language(s), framework(s), runtimes
- Deploy target (browser / server / CLI / mobile / desktop / embedded / cloud function / container / serverless / smart contract / firmware / ML pipeline / library / SaaS / self-hosted)
- How it ships (npm/PyPI/cargo/go modules/app store/binary/Docker image/Helm chart/Terraform)
- Where it runs (which cloud/host, multi-tenant or single-tenant, network topology if discernible)

**Recon Agent B — Trust Boundaries & Sources.** Walk entry-point code (route handlers, CLI argparse, queue consumers, WebSocket handlers, IPC receivers, MCP server handlers, file/env readers, deserialization entry, plugin loaders). Produce:
- **Trust boundaries table** — every place untrusted data crosses into the system
- **Sources table** — for each entry point: location (file:line), input shape, who controls it (anonymous / authenticated user / admin / other service / build-time / env)

**Recon Agent C — Sinks.** Walk dangerous-operation code. Produce a **Sinks table** with location (file:line) and sink type for: shell exec, SQL / NoSQL / LDAP / XPath queries, eval / Function / exec / pickle / yaml.load / Marshal / ObjectInputStream, file write, file include / require with dynamic path, network egress (fetch / requests / http.Get), auth decisions, secret reads, native deserializers, dynamic code load, smart-contract external calls, child_process spawns.

**Recon Agent D — Assets.** Scan for what this project must protect. Produce an **Assets table** with location and asset type for: credentials / tokens (config files, env files, KMS, OAuth flows, ~/.{app}/auth.json-style stores), customer/PII data stores, source code with IP value, build/CI secrets, signing keys, model API tokens, on-chain funds / wallets, session state, MCP config files, license keys.

**After all four return, the main agent synthesizes:**
1. Assemble the four tables (Stack/Deploy, Sources, Sinks, Assets) into the recon report
2. Add the **Threat model** — concrete to THIS project, derived from the four agents' outputs. Who would realistically target it and what for? (Examples: supply-chain risks affecting downstream users of a library; multi-tenant abuse on a SaaS; untrusted user input on a CLI/mobile app; insider risk with repo access; phishing-based account takeover; coding-agent risks from injected web content; on-chain reentrancy risks for a smart contract.) Be specific.
3. Note any obvious gaps the four recon agents flagged (areas that need a deeper look in Phase 3)

## Phase 2: Plan the audit — recon drives this

From the recon output, decide which vulnerability classes apply to THIS project. **Skip audits with no entry surface.** A static documentation site does not get a SQLi audit. A Rust embedded firmware project does not get a prompt-injection audit. A Python ML pipeline does get pickle/yaml audits. A library that ships to others gets supply-chain weighted heavily.

Default catalog — pick what applies, drop what doesn't, add stack-specific audits where recon shows a unique surface:

| Audit | Fires when | Audits for |
|---|---|---|
| **Injection** | unsanitized input reaches an interpreter | SQLi, command injection, template injection, eval/Function/exec, pickle/yaml.load, NoSQL/LDAP/XPath injection, prompt injection |
| **AuthN/AuthZ/Session** | any auth, session, or access-control logic exists | broken access control (IDOR, BOLA), JWT alg confusion / alg:none, OAuth state/PKCE/redirect-uri abuse, session fixation, missing rate limit on credential checks, MFA bypass, TOCTOU races |
| **Secrets & exposure paths** | any secret/credential/token exists | hardcoded keys, logs/errors/debug-file leakage, source maps in published artifacts, telemetry leakage, prototype pollution exposing secrets, \`JSON.stringify(err)\` shapes, env dump in error pages, exposed \`.git\`/\`.env\`/\`.map\` |
| **Supply chain** | any dependency manager or external code | unpinned deps/actions, postinstall scripts, typosquats, **slopsquats (AI-hallucinated package names registered by malicious parties)**, dependency confusion, lockfile drift, install-time \`curl \\| sh\`, unsigned releases, unverified maintainer takeovers, self-spreading worms (Shai-Hulud family) |
| **CI/CD & build integrity** | any CI workflow, release pipeline | \`pull_request_target\` + checkout of PR HEAD (Pwn Request), Actions cache poisoning, OIDC token theft from \`/proc\`, self-hosted runner reuse, secret echoes, missing \`permissions:\` block |
| **SSRF, path traversal, file ops** | any URL/path/file built from input | SSRF to metadata endpoints (IMDSv1), path traversal, zip-slip, symlink races, unrestricted upload, archive extraction outside target dir |
| **Cloud/infra & misconfig** | any IaC, container, cloud SDK use | overpermissive IAM (\`Action:*\`, \`iam:PassRole:*\`), public buckets, IMDSv1, exposed K8s API/kubelet, presigned URLs without expiry, default creds, debug endpoints in prod, CORS \`origin:*\` + \`credentials:true\` |
| **Crypto** | any crypto/hashing/signing | weak algos (MD5/SHA1 for auth), missing IV, ECB mode, hardcoded keys, JWT \`alg:none\`, non-constant-time compare on secrets, predictable PRNG for tokens |
| **Agent surface** | only if recon detected LLM/AI/MCP/coding-agent/tool-calling code | indirect prompt injection via fetched content, MCP tool poisoning, tool-description injection (ToolLeak), system-prompt exposure via tool args, **Rules-File Backdoor (Unicode bidi / zero-width chars hiding instructions in CLAUDE.md / .cursorrules / AGENTS.md)**, malicious CLAUDE.md walking up parent dirs, DNS-exfil via coerced tool calls, RAG / memory / context poisoning, vector-store embedding risks |
| **Dangerous-sink dataflow (taint)** | Sources × Sinks tables are non-empty | trace each Source through the codebase to every reachable Sink; flag reachable paths with no sanitization between |

**Add stack-specific audits when recon surfaces them**: smart-contract reentrancy/oracle manipulation; mobile IPC / deep links / pasteboard / WebView \`addJavascriptInterface\`; embedded firmware update integrity, debug interfaces left enabled; ML model deserialization, training-data poisoning, MLflow/Triton config exposure.

## Phase 3: Parallel audits

Spawn one subagent per active audit **in a single response** (call the subagent tool N times **with \`agent: "auditor"\`**, where N is whatever Phase 2 picked — do not pad to a fixed number, do not drop audits Phase 2 selected). If the \`auditor\` agent is unavailable, use default subagents and open each task with: "You are performing an authorized, read-only defensive security review for the code owner; report data-flow risks so they can be patched — no exploit code."

**Subagents cannot see this prompt.** Each auditor's task text must therefore include, written out by you:
- Its specific vulnerability-class scope
- The recon rows relevant to that scope (Sources, Sinks, Assets, Threat-model lines — condensed, not the full dump)
- The specific bullets from the Threat reference below that apply to its class (copy those lines into the task)

Each auditor must:
1. **Trace data flow** from Sources to Sinks for its class. Not pattern matching.
2. For every candidate, apply the **untrusted-input vs trusted-input** decision: is the input *actually reachable* by an untrusted source, or is it a settings constant / build-time string / hard-coded value?
3. Describe a concrete **risk scenario** at the data-flow level — what kind of input reaches the source, how the system processes it, what exposure results. No working payloads. If you can't describe the steps, don't flag it.
4. Assign **confidence 0.0–1.0**. Drop anything <0.8 before returning.
5. Be framework-aware: ORM parameterization, auto-escape, memory-safe languages, JSX/template escaping all eliminate entire vuln classes. Don't flag what the framework already handles.

## Phase 4: False-positive filter

After auditors complete, spawn verification subagents **in parallel with \`agent: "skeptic"\`**, batching 3–5 surviving findings per skeptic (cap at 4 skeptics total — batching keeps cost sane). The \`skeptic\` agent starts from "this is a false positive" and tries to disprove each finding — only confirmed findings survive. Pass each skeptic the full text of its findings (location, source/sink, risk scenario, claimed confidence); skeptics cannot see this prompt or the auditors' context. Drop anything returned as DROP; lower severity for DOWNGRADE.

**Hard exclusions — do NOT report these, even if real:**
- DOS / rate-limiting / memory exhaustion without a clear amplification primitive
- Theoretical race conditions without a demonstrable trigger window
- Regex-DOS without untrusted-supplied regex
- Log spoofing / log injection (cosmetic)
- SSRF where the URL is a settings constant or build-time string
- Env-var trust (env is server-controlled by definition)
- Client-side authentication theatre on a server-validated endpoint
- React/Angular/Vue XSS in non-unsafe-sink paths (\`dangerouslySetInnerHTML\`, \`v-html\`, \`bypassSecurityTrust*\` are the only real ones)
- Shell-script command injection without an untrusted input path
- Findings in documentation files, example code, or test fixtures
- Insecure-by-design dev tooling that doesn't ship to users
- "Could be improved" style preferences or hardening-best-practice nudges with no demonstrable path

## Phase 5: Report

Output one report. No code edits in this phase.

\`\`\`
# Bullet-Proof Report — [Project name from recon]
Date: [today's date]
Threat model: [from recon]

## Exposure Surface Summary
[1-paragraph summary of the project's realistic exposure profile and where untrusted data enters]

## Sources / Sinks / Assets
[Compact tables from recon]

## Risk Matrix
| Severity | Count | Definition |
|---|---|---|
| Critical | N | RCE, full auth bypass, credential theft, fund loss |
| High     | N | privilege escalation, data exposure with auth, supply-chain compromise |
| Medium   | N | limited-scope info disclosure, weakened crypto, partial bypass |

## Findings

### [BP-001] <title> — Critical
- Location: path:line
- Category: <slug>   CWE: CWE-XXX   Confidence: 0.95
- Exposure surface: <entry point from Sources>
- Source → Sink: <e.g. \`POST /api/foo body.userId\` → \`subprocess.run(..., shell=True)\`>
- Risk scenario (data-flow level, no payloads):
  1. Untrusted input of <shape/kind> reaches <source>
  2. The system processes it as <what>
  3. Result: <RCE / data exposure / auth bypass>
- Impact: <blast radius — what is exposed, how far it spreads>
- Fix: <concrete remediation, code-level>

[…repeat per finding, ordered Critical → High → Medium…]

## What was not flagged
[1-paragraph: which vulnerability classes returned zero findings, and how many findings the FP filter dropped — so the user sees the work, not just the survivors]
\`\`\`

## Phase 6: Ask before fixing

After the report, ask:

> Which (if any) should I fix? Options:
> - A) Add tasks for all Critical + High
> - B) Add tasks for specific findings (give IDs, e.g. "BP-001, BP-004")
> - C) Add tasks for a category (auth, supply chain, secrets, …)
> - D) None — report only

**Do not start fixing until the user picks.**

If the user chooses A, B, or C, do not fix directly. Instead, add one task per selected finding or tightly coupled finding group using the \`tasks\` tool (action=add), ordered by severity, exploitability, and dependency. Each task needs a short title and a standalone prompt that includes the finding ID, vulnerability scenario, affected local files/anchors, concrete remediation, instructions to compare security-sensitive implementation details with kencode search or authoritative docs before editing, project verification commands, and instructions to compare the final fix with kencode search or authoritative docs again before completing the task. After adding the tasks, tell the user exactly: "${TASKS_ADDED_NOTICE}" Do not begin executing them unless the user explicitly says so.

## Threat reference (May 2026)

Defensive reference material from public incident reports and OWASP — patterns to check for, not techniques to reproduce. Copy the relevant bullets into each auditor's task (Phase 3); do not dump them into the report.

**OWASP Top 10:2025** — A01 Broken Access Control (now includes SSRF), A02 Misconfig, **A03 Supply Chain Failures (new)**, A05 Injection (now includes prompt injection), **A10 Mishandling Exceptional Conditions (new — fail-open patterns)**.

**OWASP API Security Top 10 (2023)** — BOLA, Broken Auth, BOPLA, SSRF (API7).

**OWASP Top 10 for LLM Apps v2025** — LLM01 Prompt Injection (direct + indirect), LLM02 Sensitive Info Disclosure, LLM03 Supply Chain, LLM04 Data & Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, **LLM07 System Prompt Leakage (new)**, **LLM08 Vector & Embedding Weaknesses (new — RAG/embedding-store attacks)**, LLM09 Misinformation, LLM10 Unbounded Consumption.

**OWASP Top 10 for Agents 2026 (ASI01–10)** — Goal hijack, tool misuse, identity/privilege abuse, agentic supply chain, unexpected code exec, memory/context poisoning, inter-agent comms, cascading failures, human-trust exploit, rogue agents.

**Real 2024-2026 public incidents — patterns to grep for defensively:**
- tj-actions/changed-files (Mar 14-15 2025, CVE-2025-30066, 23k repos) → unpinned GH Actions, \`uses: foo/bar@main\` / mutable tags, runner-memory secret dumps
- TanStack Mini Shai-Hulud (May 11 2026, CVE-2026-45321, CVSS 9.6 — 84 versions across 42 \`@tanstack/*\` + UiPath/Mistral/Guardrails/OpenSearch, 169+ packages total, "TeamPCP") → self-spreading npm worm, \`pull_request_target\` + cache poisoning + OIDC token extraction from \`/proc/<pid>/mem\`, persistent \`gh-token-monitor\` daemon
- Slopsquatting (ongoing 2025-2026, \`react-codeshift\` Jan 2026) → AI coding assistants hallucinate ~20% non-existent package names (open-source models ~21.7%, GPT-4 ~5.2%); malicious parties register the hallucinated names on npm/PyPI. **Verify every package actually existed BEFORE the agent suggested it** — check registry age, download history, author identity
- XZ Utils (CVE-2024-3094) → unverified maintainer takeovers, multi-year backdoor injection in install scripts
- Invariant Labs MCP hijack (May 2025) → MCP server returns malicious tool descriptions / crafted issue content
- Claude Code source-map leak (Mar 2026, 513k LOC) → \`*.map\` files in \`npm pack\` / shipped artifacts
- Embrace The Red DNS-exfil (Aug 2025) → coding agent coerced into encoding secrets in DNS queries
- IMDSv1 → AWS creds via SSRF (Mar 2025 campaign) → Terraform missing \`http_tokens = "required"\`
- GitGuardian 2026 — 28.6M GitHub secret leaks in 2025, 24k inside MCP config files

**Language-specific hot zones — only apply to languages actually present:**
- **Node/TS**: \`child_process.exec\`/\`execSync\`, \`spawn(..., {shell:true})\`, \`eval\`/\`Function\`, \`vm.runIn*\`, prototype pollution via \`lodash.merge\`/\`Object.assign({}, userJson)\`, \`serialize-javascript\`/\`node-serialize\`, source maps in published packages
- **Python**: \`pickle.load\`, \`yaml.load\` without \`SafeLoader\`, \`eval\`/\`exec\`, \`subprocess.*(shell=True)\`, \`os.system\`, \`Jinja2(autoescape=False)\`, \`flask.render_template_string(user_input)\`, \`requests(verify=False)\`, \`xml.etree\`/\`lxml\` without \`defusedxml\`
- **Go**: \`exec.Command("sh", "-c", userInput)\`, \`html/template\` vs \`text/template\` confusion, unbounded \`io.ReadAll\`, race-prone \`map\` access without lock
- **Rust**: \`unsafe\` blocks with raw pointers, \`Command::new("sh").arg("-c")\`, deserializing untrusted \`bincode\`/\`serde_pickle\`/\`serde_json\` with \`#[serde(deny_unknown_fields)]\` missing
- **Java/JVM**: \`ObjectInputStream\` deserialization, JNDI lookup (Log4Shell-style), \`Runtime.exec(String)\`, XXE in default XML parsers
- **Ruby**: \`eval\`/\`instance_eval\`, \`Marshal.load\`, \`YAML.load\` (not \`safe_load\`), \`Kernel#system\` with interpolation, mass assignment
- **PHP**: \`unserialize\`, \`eval\`, \`assert(string)\`, \`include $userInput\`, \`preg_replace\` /e modifier
- **C/C++**: unsafe \`strcpy\`/\`sprintf\`/\`gets\`, integer overflows, format strings (\`printf(userInput)\`), use-after-free, double-free
- **Solidity / EVM**: reentrancy, unchecked external calls, integer over/underflow (pre-0.8), \`tx.origin\` for auth, delegatecall to untrusted, oracle manipulation
- **Mobile (iOS/Android)**: insecure IPC / deep links / pasteboard, WebView \`addJavascriptInterface\`, exported activities/intents without permission checks, insecure local storage

## Rules

- **Recon first, audits second.** No audit fires without a recon-identified entry surface to justify it.
- **No pattern-only findings.** Every flag must have a Sources → Sinks path traced through the code.
- **No "could be improved" recommendations.** Either it's exploitable or it's not in scope.
- **Strict confidence gate (≥0.8).** Drop everything else, even if it looks suspicious.
- **Adapt to the stack, always.** The audit catalog and threat reference above are guidance, not a checklist to apply uniformly.
- **Report only.** Wait for the user to pick what to fix in Phase 6.`,
  },
  {
    name: "init",
    aliases: [],
    description: "Generate or update CLAUDE.md for this project",
    prompt: `Generate or update the project context file with project-specific context only: what this project is, the non-obvious knowledge needed to change it safely, and the workflows that are unique to it.

This file is injected verbatim into the **cached prefix of every request in every future session**, alongside the system prompt. Every line costs tokens forever. A line that repeats something the agent already has is worse than absent: it dilutes the lines that matter. So the bar is not "is this true?" — it is **"would a competent agent get this wrong without being told?"**

## What is already in the agent's context — never restate any of it

Read this list once and apply it to every step below. These are already supplied by the system prompt, so writing them into the context file is pure duplication:

1. **Agent behavior** — Do NOT add generic agent behavior already covered by the system prompt: read before edit/write, re-read after formatters, ask before destructive actions, no fake verification, generic code-quality advice, how to use tools, or how to talk to the user.
2. **Language conventions** — a Language Style Packs section is auto-injected for every language detected in this repo. Do not duplicate language style packs, generic verification rules, or boilerplate quality gates such as "After editing ANY file" / "Code Quality — Zero Tolerance".
3. **Verify commands** — a Verification section is auto-generated from package scripts / manifests (lint, typecheck, format, test) with the correct runner already resolved from the lockfile. Only write a command down if it is NOT discoverable that way: an undocumented multi-step sequence, a required ordering, a non-obvious flag, or a command that lives outside the manifest. Never add guidance that requires running checks, builds, or the full quality suite after every edit or every file change, and never turn discovered commands into mandatory after-every-edit requirements unless local CI explicitly enforces that sequence.
4. **The file tree** — the agent can list and grep the repo in one call. Do NOT embed generated symbol maps, exhaustive file indexes, auto-generated directory listings, or large trees. Do not add symbol indexes or auto-generated project inventories; the context file must remain durable, agent-focused project context.

Include only project-specific overrides, stricter local requirements, or knowledge that cannot be derived by reading the code.

## Step 1: Pick the target filename

Context files are loaded **one per directory, first match wins**, in this priority order: \`AGENTS.override.md\` > \`AGENTS.md\` > \`CLAUDE.md\` > \`.cursorrules\` > \`CONVENTIONS.md\`.

List the repo root and write to **whichever of those already exists with the highest priority**. If the repo already has an \`AGENTS.md\`, update that file — creating a new CLAUDE.md next to it produces a file the agent will never load. If none exists, create \`CLAUDE.md\`. State which file you chose and why in one line.

## Step 2: Set up the regenerated block

\`/init\` is re-run over the project's lifetime, so the generated content must be **replaceable, not appendable** — otherwise each run grows the file forever.

All content you generate goes inside these exact fence markers:

\`\`\`
<!-- gg:init:start -->
…generated content…
<!-- gg:init:end -->
\`\`\`

- If the file exists and already has the fence: **replace everything between the markers wholesale**. Text outside the fence is user-owned — do not touch it, do not reformat it, do not move it.
- If the file exists without the fence: read it, decide which content is hand-written knowledge worth keeping, move that above the fence untouched, and put your generated content inside a new fence. Remove generic guidance that is already covered by the system prompt (see the list above) unless it is a deliberate project-specific override.
- If the file does not exist: create it with the fence.

## Step 3: Analyze the project (sub-agents in parallel)

Derive every fact from the actual project — source code, entry points, manifests, config, and history. Treat README, docs, and code comments as unverified hints that are frequently stale: never copy claims from them, and only state things you can confirm from the code and config themselves.

Spawn 3 sub-agents ${spawnParallel(3)}:

1. **Purpose & Shape Agent**: What does this project actually do, and what are its top-level parts? Read entry points, main modules, exported/public APIs, CLI commands, routes, and manifests. Return: a one-sentence purpose, and for each package/app/module a one-line statement of what it *owns*. Do not rely on the README's description. Do not return a directory listing.
2. **Gotchas & Invariants Agent**: Find the knowledge that is expensive to rediscover. Mine \`git log\` (especially revert/fix/hotfix commits), CI and release workflows, \`NOTE\`/\`HACK\`/\`IMPORTANT\`/\`WARNING\`/\`XXX\` comments, test names asserting surprising behavior, generated-file and build-order constraints, and any config with a non-default value. Return only: rules that are non-obvious from reading the code, ordering/sequencing constraints, things that silently break, and the *reason* each exists. Skip anything a careful reader would infer in 30 seconds.
3. **Workflow & Stack Agent**: How is this project run, built, released, and deployed, from authoritative sources only — package scripts, manifests, Makefiles, CI config, deploy config. Return the workflows and any command that is NOT a plain single manifest script (multi-step sequences, required order, env vars, non-obvious flags, commands living outside the manifest). Do not return commands the auto-generated Verification section already covers (see item 3 above). Do not invent commands from convention, and do not trust README/doc command snippets unless a script or manifest confirms they still exist.

Wait for all sub-agents to complete, then synthesize.

## Step 4: Write the generated block

Inside the fence, write only sections that add project-specific value. Prefer this order — drop any section that would be empty or obvious:

- Project name and one-sentence purpose
- Key packages/apps/modules and what each owns (one line each, no tree)
- Architecture or data-flow notes an agent could not infer quickly from the code
- **Gotchas / invariants** — the highest-value section. Each entry states the rule *and* why it exists.
- Project-specific commands and workflows that survived the Step 3 filter (required publish order, generated-file workflow, dev-server startup, deployment caveats, auth/secrets storage)

Avoid generic sections named "Code Quality", "Organization Rules", or "How to Work" unless every bullet is specific to this project.

## Step 5: Budget and verify

The combined budget for all project context files is 32KB, shared with any parent-directory context files. **Target 6KB or less for the generated block** — a tight 4KB file that gets read every time beats a 25KB file the agent skims.

After writing:

1. Run \`wc -c\` on the file and report the byte size. If the generated block exceeds ~6KB, cut the weakest sections (the ones closest to "derivable by reading the code") and rewrite.
2. Re-read the file and confirm every remaining line passes the bar: **project-specific, supported by a local file you actually read, and not already in the agent's context per the list above.**
3. Report in one line: which file, how many bytes, and how many lines you removed as redundant.

## Step 6: Restart Notice

End your reply with this exact notice so the user doesn't miss it:

${CLAUDE_MD_RESTART_NOTICE}`,
  },
  {
    name: "setup-commit",
    aliases: [],
    description: "Generate a /commit command",
    prompt: `Detect the project type and generate a /commit command that enforces quality checks and an agent code review before committing.

## Step 1: Detect Project and Extract Commands

Check for config files and extract the lint/typecheck commands:
- package.json -> Extract lint, typecheck scripts
- pyproject.toml -> Use configured mypy, pylint/ruff commands
- go.mod -> Use configured go vet/gofmt/staticcheck commands
- Cargo.toml -> Use configured cargo clippy/fmt commands

Prefer existing project scripts. If you must synthesize a command from tool conventions, verify the current CLI flags against official docs first.

## Step 2: Generate /commit Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/commit.md\`:

\`\`\`markdown
---
name: commit
description: Run checks, agent code review, commit with AI message, and push
---

1. Run quality checks:
   [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]
   Fix ALL errors before continuing. Use auto-fix commands where available.

2. Review changes: run git status and git diff --staged and git diff

3. Fast review gate: spawn ONE subagent with the full diff. Instructions: review ONLY
   the diff for real bugs, regressions, leftover debug code, and unintended changes.
   Score each issue 0-100 confidence (pre-existing issues and stylistic nitpicks = false
   positives, score low). Report ONLY issues with confidence >= 80, with file:line and a
   one-line fix. If none, reply "CLEAR". This is a last check, not a deep audit - be fast.

4. If CLEAR: proceed straight to step 5 and push WITHOUT asking the user anything.
   If issues >= 80 were reported: STOP, show the issues, and ask exactly:
   "Want me to fix this first, or commit and push anyway?
   A) Fix it first, then commit & push
   B) Commit & push anyway"
   On A: fix, re-run step 1, then continue (no re-review). On B: continue as-is.

5. Stage relevant files with git add (specific files, not -A)

6. Generate a commit message:
   - Start with verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

7. Commit AND push in one go - never pause for confirmation here:
   git commit -m "your generated message"
   git push
\`\`\`

Replace [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS] with the actual commands.

Keep the command file under 30 lines.

## Step 3: Confirm

Report that /commit is now available with quality checks, an agent code review gate, and AI-generated commit messages, and mention which local scripts/docs verified the commands.`,
  },
  {
    name: "setup-tauri-package",
    aliases: [],
    description: "Set up safe Tauri packaging",
    prompt: `# Set Up a Project-Scoped Tauri Packaging Harness

Audit this repository from its actual root, identify exactly one evidence-backed desktop Tauri application, and generate a deterministic packaging harness plus a thin project command. This is setup work, not a package-manager install, Tauri migration, release, or cleanup task.

Execute the audit and setup directly in the current turn. Do not enter or use plan mode, call \`enter_plan\` or \`exit_plan\`, create or update any file below \`.gg/plans/\`, or pause for plan approval. A plan file is outside the six-file boundary and is a setup failure.

## 1. Audit before writing

Perform a bounded inspection of repository and workspace manifests, lockfiles, package scripts, existing build/package scripts, Cargo.toml files, .cargo/config files, Tauri v1/v2 configuration (tauri.conf.json, JSON5/TOML variants, and platform overlays), referenced resources, sidecars, icons, CI workflows, and release target matrices. Follow workspace membership and nested manifests; do not infer a Tauri root from a directory name.

A candidate is proven only by corroborating local evidence from its Cargo crate, Tauri configuration, and frontend Tauri CLI/build entry point. Determine:

- the repository-relative Tauri root and frontend directory;
- the installed package manager from its lockfile and the exact existing argv-safe Tauri build entry point;
- the locally installed Tauri CLI version and its current \`build --help\` output before choosing flags;
- desktop target IDs, host compatibility, bundle formats, Cargo target placement, output roots, directly runnable artifacts, and required resources/sidecars/icons;
- existing CI/release target evidence and any configured beforeBuild/beforeBundle behavior.

Tauri desktop builds run configured pre-build/pre-bundle commands and platform overlays merge with base configuration, so persist observed local semantics rather than assuming a standard Tauri 2 directory or output layout.

Stop before any write if no candidate is proven, packaging is mobile-only/unsupported, or multiple candidates remain ambiguous. Name the one app-selection decision or unsupported condition needed to continue. Never choose arbitrarily.

Normalize every persisted path to a repository-relative path using \`/\` separators. Reject absolute paths, traversal, unsafe symlink resolution, dynamic or unreadable configuration, deletion-rule globs, and commands requiring shell interpolation. Persist commands as executable-plus-argument arrays, never shell strings.

## 2. Exact setup-owned file boundary

Setup may create or regenerate only these six support files:

1. \`scripts/package-tauri.mjs\` — dependency-free build, stage, gate, manifest, and promotion orchestrator.
2. \`scripts/package-tauri.test.mjs\` — deterministic node:test fixtures for the orchestrator.
3. \`scripts/smoke-tauri-package.mjs\` — dependency-free bounded final-package launcher/validator.
4. \`scripts/smoke-tauri-package.test.mjs\` — deterministic node:test smoke fixtures.
5. \`scripts/package-tauri.config.json\` — normalized evidence, argv, targets, required files, prune rules, baseline inventory, and size gates.
6. \`.gg/commands/package-tauri.md\` — a thin target-selecting project command.

Do not install dependencies; edit package manifests or their scripts; rewrite Tauri/Cargo configuration; publish, upload, or run a release; or perform unrelated cleanup. Do not independently sign or notarize: an existing audited build entry point may perform only its already-configured build-time signing, and setup must never create or change signing configuration, credentials, or release settings.

The setup agent may create or regenerate only the six support files above. Runtime calibration, packaging, and verification may additionally write only below literal repository-relative work/staging/output roots declared in the config and pre-existing generated build-output paths proven by the audited project configuration; they must never modify source or configuration files.

The generated \`/package-tauri\` command must select one audited target, invoke exactly \`node scripts/package-tauri.mjs --target <id>\`, never bypass a failed build, gate, manifest, or smoke result, and report final artifact, evidence report, and manifest paths only after success.

## 3. Ownership, digests, and deterministic rendering

Every support file must carry the exact marker \`Generated by GG Coder /setup-tauri-package tauri-package v1\`, a shared evidence SHA-256, and a content SHA-256. JSON stores these in one reserved top-level metadata object; JavaScript and Markdown use comments. Document and implement one canonical payload algorithm that removes only the content-digest field before hashing, so the stored content digest can be independently recomputed.

Before writing anything, read all six destinations and validate them as one transaction:

- absent destinations may be created;
- an owned file may be regenerated only when its marker, canonical content hash, and shared evidence hash validate;
- an unmarked file, modified generated body, mixed marker/generation/evidence IDs, or partial foreign set is user-owned/manual work;
- any conflict must preserve all six destinations byte-for-byte and prevent partial writes.

After validating all six destinations as one owned set, compare their single shared evidence digest with the freshly audited evidence before rendering any support bytes. If all six owned files validate and their shared evidence digest matches, return successfully immediately: do not render, regenerate, or write any support file. This early no-op is the only same-evidence path.

For an initial absent set, build all six bytes in memory. Only when freshly audited evidence differs may setup regenerate support files, and it must render and replace all six transactionally with rollback-safe temporary files. Validate the complete rendered set before commit. Use stable key ordering, stable path ordering, LF endings, no timestamps, no absolute machine paths, and no shell command strings. Changed evidence triggers one complete rerender; changed generated bytes trigger a conflict, never overwrite.

The evidence digest must cover the normalized local facts that selected the app, commands, configs, resources, host/targets, and gate inputs. Re-read evidence immediately before commit and abort the whole write if it changed during setup.

## 4. Generated runtime contract

Generate standard-library-only ESM. The orchestrator must export testable pure helpers and have a narrow CLI accepting only help, \`--target <id>\`, \`--calibrate --target <id>\`, and \`--verify --target <id>\`. Unknown, duplicate, missing, bypass, skip-gate, skip-smoke, arbitrary-command, or arbitrary-path arguments fail closed. Use \`execFile\` or \`spawn\` with \`shell: false\`; inherit the current environment for toolchain/signing secrets but never serialize or log secret values.

The normalized config must have a schema/version and the shared metadata. Record repository-relative literal roots, evidence inputs and hashes, executable/argument arrays, host and target definitions, bundle/artifact roles, required paths and cardinalities, directly runnable smoke adapter details, literal prune entries, calibrated baseline inventory, and concrete size/file-count gates. Sort targets, roles, paths, and object keys deterministically. Reject unknown schema versions and malformed or duplicate entries.

For a normal package run, perform these stages in this exact order:

1. **Validate before mutation.** Recompute config/support evidence and content hashes; validate target/host compatibility, normalized paths, source evidence, commands, required inputs, roots, sentinels, baseline calibration, and ownership. Work, staging, and output roots must be setup-owned, repository-relative, mutually safe, and outside source/Tauri inputs and the project's ordinary Cargo target. Refuse links or escapes in any mutable ancestor.
2. **Build into owned workspace.** Invoke the audited existing Tauri build entry point with argv and \`shell: false\`, directing Cargo/output only to a setup-owned target workspace using locally verified CLI/environment semantics. Clear only the exact marker-owned selected target bundle directory. Never clean the project's ordinary Cargo target, source tree, Tauri inputs, resources, or an unowned directory. Record run start before spawning.
3. **Prove fresh output.** Require a successful build exit and accepted artifacts beneath the selected owned target root. The selected bundle root was empty after the pre-build clear; every artifact must be newly discovered there and have creation/change evidence after run start. Reject stale pre-existing artifacts, missing or ambiguous cardinality, path escapes, target mismatches, links where regular files are required, and relevant build output found outside the expected target root.
4. **Inventory, stage, and prune.** Capture a lexically sorted pre-prune baseline inventory by role, repository-relative path, byte size, and file/link type. Copy it to a fresh sibling candidate staging directory without following links. Apply only target-specific literal prune entries from config, each carrying target, local evidence, and reason. Pruning is staging-only. Reject glob/regex deletion, path traversal, links, required-file collisions, denylisted roots, target mismatches, and entries not present in the captured baseline. An empty prune list is correct when no safe project evidence proves an item is a non-target duplicate. Never infer that debug symbols, updater data, licenses, resources, sidecars, or platform binaries are disposable from a name or extension.
5. **Gate the candidate.** Enforce required-file existence, type, role, and exact/min/max cardinality. Compare the inventory with a calibrated target baseline and enforce concrete total bytes, per-role/artifact bytes, regular-file count, and allowed absolute plus percentage growth. Every limit must be finite and derived from the recorded baseline policy; no missing/zero/unbounded or runtime-relaxed gate. An uncalibrated target fails a normal package run closed.
6. **Manifest, smoke, and promote.** Emit stable JSON evidence and a lexically sorted SHA-256 manifest covering every regular distributable file. Validate contained symlinks separately without following escapes. Write and immediately verify the manifest, run packaged smoke from the candidate tree, then verify every hash again to detect smoke mutation. Only after all checks pass, promote the sibling candidate with a rollback-safe two-rename swap: rename a marker-owned previous final output to a sibling backup, rename the candidate to the final path, restore the backup if the second rename fails, and remove the backup only after success. Do not claim this directory replacement is atomic across platforms. On failure preserve or restore the previous final output and diagnostics, and never publish the candidate.

The evidence report must include target, normalized command argv, input/evidence hashes, run result, fresh artifact inventory, pre/post-prune inventories, exact prune evidence, gate calculations and limits, manifest hash, smoke result, and final paths. Keep deterministic evidence stable where possible; represent volatile run diagnostics separately from canonical support/config bytes and never place timestamps in the six support files.

### Calibration and verification

Calibration may run the real audited build and measure a bounded baseline inventory, then deterministically write target baseline and gate policy back through the same six-file ownership transaction. It may not publish/promote output, relax an existing gate merely to pass, guess at unavailable targets, or mark ready without successful build, required-file validation, and packaged smoke. If the required host toolchain, configured build-time signing, build, or smoke cannot run, leave the target explicitly uncalibrated, report the single blocker, and do not claim \`/package-tauri\` is ready.

\`--calibrate\` must fail closed and exit nonzero unless that invocation completes the calibration build and required-file validation, packaged smoke satisfies its configured readiness criterion, the calibrated baseline and finite gate policy are persisted through the complete six-file ownership transaction, and the persisted state is reloaded and validates the target as calibrated. A successful build or discovered artifact alone must never return exit code zero. Any smoke/readiness, persistence, reload, digest, or calibrated-state validation failure must preserve the prior support set or leave the target explicitly uncalibrated and exit nonzero.

Verification mode must be read-only and recompute ownership, schema, required paths, gate math, manifest, and final-output hashes for an already promoted target. It cannot build, calibrate, prune, smoke an installer, or repair files.

### Packaged smoke contract

Smoke a directly runnable artifact from the candidate package, never a source-tree binary and never an installer that modifies the machine. Supported adapters may launch a staged Windows executable, a macOS \`.app\` inner executable, or a Linux AppImage/direct binary only when local target evidence identifies it. MSI/NSIS installers, DMGs, DEB/RPM packages, and other install-only outputs need a separately evidenced non-installing validator; otherwise refuse them.

Launch with argv and \`shell: false\` using isolated temporary HOME/user/config/cache directories. Capture bounded stdout/stderr diagnostics without secrets. Require configured readiness evidence or healthy survival for a bounded interval; treat early exit, crash, spawn error, or timeout without the configured criterion as failure. Track the exact child process/tree created by smoke and terminate only that child tree in a finally path. Never use broad process-name killing. Snapshot and re-hash the candidate before and after smoke; any package mutation fails.

## 5. Generated fixture and terminal verification contract

Both generated test files must use only \`node:test\`, Node standard-library modules, and temporary directories. They must never need the real project build, network, signing tools, user home, ordinary Cargo target, or previously generated output. Export/inject filesystem, clock, spawn, and builder boundaries where necessary so every failure is deterministic.

The fixture suite must cover all of these behaviors:

- stable config/object/path ordering; Windows and POSIX separator normalization; rejection of absolute/traversal paths; stable rendering; same-input reruns; marker, content-hash, and evidence-hash tampering; mixed/partial/manual destination conflicts; all-or-nothing preservation; changed-evidence complete rerender; and no shell invocation;
- a fake builder producing fresh artifacts, stale artifacts, failed exits, output outside the target root, path escapes, symlinks, host/target mismatches, missing/duplicate required files, cardinality failures, and oversized outputs;
- sorted baseline inventories; calibrated total/per-role/per-artifact/file-count growth gates with absolute and percentage limits; uncalibrated refusal; exact target-only staging prune; empty prune lists; missing prune evidence; required/prune collisions; denylisted roots; and proof that source/build output is untouched;
- deterministic SHA-256 manifests for every regular file, separate safe-link validation, immediate and post-smoke verification, mutation detection, failed-candidate non-promotion, and rollback-safe two-rename replacement of a marker-owned prior final output;
- fake packaged apps for healthy bounded survival, explicit readiness, early crash, timeout, spawn failure, child-only cleanup, attempted package mutation, artifact path mismatch, and refusal to execute install-only artifacts;
- source guards that fail if generated production scripts contain broad or unscoped recursive deletion, \`shell: true\`, shell interpreters/interpolation, gate/manifest/smoke bypass flags, installer execution, broad process killing, writes outside owned work/staging/output roots, or cleanup of source/Tauri/ordinary Cargo target paths.

Tests must assert both success results and unchanged filesystem state after every refusal. They must prove that secrets inherited by child processes are absent from config, reports, manifests, stdout/stderr summaries, and thrown errors.

## 6. Generate, validate, and prove the real setup

Follow this order and do not claim readiness from fixture tests alone:

1. Finish the evidence audit, render all six support files in memory, revalidate evidence and destination ownership, and commit the six-file set without touching any other file.
2. Run \`node --test scripts/package-tauri.test.mjs scripts/smoke-tauri-package.test.mjs\`. Fix every failure within the six-file boundary and rerun from the start.
3. For the detected host target, run calibration when the audited toolchain permits it. Calibration may update the complete owned support set only through the digest/transaction rules. If a real build, required toolchain or configured build-time signing, or packaged smoke is unavailable, keep that target explicitly uncalibrated and report the blocker; do not fake, skip, publish, or say the generated package command is ready.
4. When calibration succeeds, run one real \`/package-tauri\`-equivalent invocation with \`node scripts/package-tauri.mjs --target <id>\`. Require the real build, gates, packaged smoke, rollback-safe promotion, and immediate manifest verification to pass. Only after promotion succeeds, invoke \`node scripts/package-tauri.mjs --verify --target <id>\` to check the promoted manifest a second time.
5. Re-read every support file and final report/manifest, validate markers and both digests, rerun both fixture suites, rerender setup from unchanged evidence, and prove all six bytes are identical. Compare \`git status --short\` before and after that second render; it must gain no changes. Exercise manual-edit conflict handling in a temporary fixture and prove all six fixture destinations remain byte-for-byte unchanged.

If any support file changes after a check, repeat all terminal checks affected by that change. Finish by reporting: selected app/root and evidence, generated files, target/calibration state, exact fixture and real commands run, artifact/report/manifest paths only if promoted, and any blocker. Never report a successful package, smoke, manifest, calibration, idempotency, or clean status unless the corresponding command and byte/hash checks actually passed.

Do not modify repository files outside the six support destinations. Runtime commands may create or update only the audited generated build outputs and declared owned work/staging/output roots described above.`,
  },
  {
    name: "compare",
    aliases: [],
    description: "Compare real-world code",
    prompt: `Compare the code you just created or modified in this conversation against real-world implementations using the \`mcp__kencode-search__searchCode\` tool.

${KENCODE_UNLOCK_NOTE}

You already know what you just built. For each file you created or modified, use \`mcp__kencode-search__searchCode\` to search for how real projects implement the same patterns. Look at the specific APIs, hooks, functions, and architecture you used.

If you find something consistently done differently across real codebases, or something commonly included that you left out, report it:

\`\`\`
[MISSING/DIVERGENT/INCOMPLETE] file:line - What it is
Wrote: What was implemented
Real-world: What real projects do instead/additionally
Evidence: kencode-search - pattern seen in X out of Y repos searched
\`\`\`

Style preferences and subjective improvements are not valid findings. Only report things backed by clear kencode-search evidence across multiple repos.

After reporting, automatically add every validated finding to the project task list using the \`tasks\` tool. Do not wait for user confirmation.

1. Call the \`tasks\` tool with \`action=list\` before adding anything.
2. Compare each finding against every existing task by meaning, affected code, and intended correction—not title alone. Do not add a semantic duplicate, including a duplicate of a done or in-progress task.
3. For each non-duplicate finding, call the \`tasks\` tool with \`action=add\`. Add exactly one task per finding and use a concise title.
4. Make each task prompt standalone: include the finding type (MISSING, DIVERGENT, or INCOMPLETE), exact file and line, the local implementation, the multi-repo kencode-search evidence, and the concrete correction. The task must be actionable by an agent with no conversation context.
5. After all task calls, if at least one task was added, output exactly: ${TASKS_ADDED_NOTICE}

If the code aligns well with real-world patterns, say so and do not add tasks. That's a good outcome.`,
  },
  {
    name: "setup-skills",
    aliases: [],
    description: "Recommend useful skills",
    prompt: `# Skills Audit: Find useful skills for this project

Analyze this project and recommend skills from the open ecosystem that would make **working on this project more efficient, easier, and safer**. That is the goal, full stop. Every recommendation must pass the test: does this skill save real time, lower real cognitive load, or prevent real mistakes for someone working on THIS project, repeatedly?

Ranked by real impact, not volume.

This project could be anything — a web app, a CLI, a mobile app, a game, firmware, a data pipeline, a library, a scientific tool. Do not assume a stack. Let the codebase tell you what it is, then decide what to look for.

## Phase 1: Understand what this project is

Read just enough to know what kind of project this is. Look at whichever signals actually apply:

- Build / manifest files: \`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`pubspec.yaml\`, \`Podfile\`, Xcode project, Gradle build, \`*.csproj\`, \`CMakeLists.txt\`, Unity/Unreal project files, Makefile — whatever exists.
- Any README, CLAUDE.md, or AGENTS.md.
- Top-level directory layout and obvious entry points.
- Any CI config, lockfile, or config directory that hints at workflow.

**Do NOT read source code yet.** You need only a coarse answer to: what kind of project is this, what platform/stack/language, what stage (greenfield vs mature), and what does the surrounding workflow look like (build, test, release, distribute, deploy — whatever applies for THIS project type).

## Phase 2: Decide which domains to investigate

Based on Phase 1, pick 4–6 domain slices that represent the **recurring work someone actually does on this project** — not abstract "areas of the codebase," but the real activities that eat time, attention, or trust. Do not use a fixed template. The right domains for a Rust CLI are different from an iOS app, a Unity game, a Django backend, a Kubernetes operator, or an ML notebook.

Illustrative only (not prescriptive):

- Web app → shipping features, API changes, handling data safely, deploys
- Mobile app → building screens, store releases, platform quirks, crash & accessibility triage
- CLI tool → adding commands, packaging & distribution, user-facing UX, error handling
- Game → adding content, platform ports, perf passes, build pipeline
- Library → designing public APIs, cutting releases, downstream compatibility, docs/examples
- Data / ML → running experiments, pipeline orchestration, reproducibility, serving models
- Embedded → adding peripherals, size/memory passes, flashing, hardware bring-up

**Announce your chosen domains to the user in one line before spawning agents**, so they can see what you're looking at (e.g. \`Domains: adding content, platform ports, perf passes, build pipeline\`).

## Phase 3: Parallel sweep

Spawn one sub-agent per domain you chose, ${spawnParallel("N")} — one task per domain. Each explores its assigned domain and returns skill-worthy opportunities.

**Skill-worthy means**: a recurring activity someone will do on THIS project — shipping, reviewing, migrating, debugging, onboarding, whatever applies — where a reusable instruction set would make it **faster** (efficient), **lower-effort** (easier), or **less likely to break something** (safer). The test is: will this skill save real time, reduce real cognitive load, or prevent real mistakes, repeatedly, on this project? If no, drop it. A domain returning zero candidates is a valid outcome.

Each sub-agent must return candidates in this exact shape, nothing else:

\`\`\`
[domain] — candidate title
Why: one sentence on the real friction observed in THIS project
Search terms: 2–3 keywords the parent should feed to find-skills
\`\`\`

Don't invent. Don't pad.

## Phase 4: Ecosystem search

After all sub-agents complete, use the **skill** tool to invoke the \`find-skills\` skill. Feed it the aggregated candidate list with search terms. Let find-skills drive discovery across skills.sh, vercel-labs/agent-skills, and anthropics/skills.

For each candidate, record the best 0–1 ecosystem match: skill name, source repo URL, and enough evidence from the skill README/source to prove it fits this project. If no fit exists, record "no match". **Do NOT install anything yet.**

## Phase 5: Prioritized recommendation

Rank every candidate that returned a real match by **crucial factor** — a 0–100% score combining:

- **Frequency** — how often someone will do this work on this project
- **Lift** — how much the skill makes it faster (efficient), lower-effort (easier), or safer (fewer mistakes, broken builds, bad releases) per hit
- **Fit** — how well the ecosystem match actually matches this project

Present highest first, in this exact format:

\`\`\`
# Skills Audit

1. <skill-name> — 92%
   Benefit: <one sentence on what it does for this project>
   Source: <repo URL>
   Scope: project

2. <skill-name> — 78%
   Benefit: …
   Source: …
   Scope: project
\`\`\`

Cap the list at 8. If you'd list more, you're padding. Default scope is \`project\` per find-skills' rules; only mark \`global\` when the skill is genuinely cross-cutting.

If strong candidates had no ecosystem match, list them at the bottom:

\`\`\`
## Gaps worth authoring

- <candidate title> — <why it matters for this project> — consider scaffolding a custom SKILL.md
\`\`\`

## Phase 6: Wait for the user

After presenting the list, ask which (if any) to install. Install nothing without explicit confirmation. Once confirmed, hand off to find-skills to perform the actual install.`,
  },
];

/** Look up a prompt command by name or alias */
export function getPromptCommand(name: string): PromptCommand | undefined {
  return PROMPT_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name));
}
