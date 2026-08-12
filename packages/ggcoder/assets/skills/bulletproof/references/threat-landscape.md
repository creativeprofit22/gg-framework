# Threat Landscape — snapshot 12 August 2026

Why the defaults in this skill are what they are. Confidence markers: **[V]** verified against a primary source at snapshot time, **[S]** snapshot-accurate but volatile, **[U]** uncertain or single-sourced. Preserve the markers when you repeat these claims.

Read this once per full review to set the threat model. Do not paste incident lists into a report — cite only the ones that map to a finding.

## 1. What automation actually changed

**Confirmed: AI-orchestrated intrusion is real and operational.**

- **GTG-1002** [V] — Anthropic disclosed (13 Nov 2025) the first documented largely-autonomous AI-orchestrated espionage campaign: a likely China-nexus actor drove an agent plus tooling through recon, vulnerability discovery, exploitation, lateral movement, credential harvesting and exfiltration against roughly 30 targets, with the large majority of operational tasks machine-executed. Now tracked as MITRE ATT&CK campaign **C0062**.
- **Post-compromise, not just phishing** [V] — Anthropic's ATT&CK mapping of 832 banned accounts (Mar 2025–Mar 2026, published 3 Jun 2026) found AI used most for malware development, with AI-assisted account discovery rising while AI-assisted phishing fell. The durable differentiator is scaffolding that chains stages autonomously, not the operator's skill.
- **Runtime LLM use inside malware** [V] — Google GTIG (5 Nov 2025) documented the first malware families querying a model at runtime: a dropper that requests just-in-time obfuscation, and a data-theft tool with no hard-coded collection commands that prompts a hosted model for them instead. Signature-based detection degrades against code that rewrites itself per execution.
- **Machine-found bugs at scale** [V] — Anthropic's Glasswing programme reported scanning 1,000+ open-source projects, yielding tens of thousands of issues with thousands rated high or critical and a high validation rate on the sampled subset.

**The honest counterweight — do not overstate this.** VulnCheck (28 Jul 2026) [V] found that of ~1,061 vulnerabilities attributed to AI-assisted discovery, only about 1.3% are confirmed exploited in the wild — roughly the same rate as vulnerabilities generally. Discovery volume is not exploitation volume. Machine-scale scanning has moved the bottleneck to **maintainer capacity to triage, patch, test and ship**, which is exactly where a small team is weakest.

**What this means for the code you write:**

1. Assume any public repository has been read end-to-end by an automated system. Obscurity was never a control; now it is not even a delay.
2. The bug classes machines find fastest are the ones with a cheap verification oracle — web/API classes and memory-safety in parsers. Business logic and multi-actor authorization remain comparatively hard for them, and remain where the expensive breaches happen.
3. Patch latency is now the dominant controllable variable. A dependency you cannot update quickly is a standing liability.
4. Breakout speed is measured in minutes [S] — CrowdStrike's 2026 report cites an average eCrime breakout time under half an hour, with the fastest well under a minute. Detection that requires a human to read a dashboard within the hour is not a control.

## 2. Supply chain — the dominant compromise route for small teams

Named incidents, with the fingerprint a defender can grep for. All [V] unless marked.

**The self-propagating npm worm lineage.** Shai-Hulud (Sept 2025) established the pattern: steal a publish token, enumerate every package the victim can publish, inject, republish. CISA warned of 500+ compromised packages targeting source-control and cloud credentials; the marker artifact was a workflow file named `shai-hulud-workflow.yml`. The November 2025 wave added destructive behavior; forensics across ~6,943 compromised machines found tens of thousands of unique secrets, and **59% of compromised machines were CI/CD runners rather than laptops** — CI is the real target.

Successor waves worth knowing because each broke a different assumption:

- **Mini Shai-Hulud / TanStack (11 May 2026)** — first credential-free initial access: a fork-triggered workflow with write access to the base repository's cache allowed cache poisoning, and publishing rode the registry's OIDC endpoint. Reported [U] that resulting malicious versions carried valid signed provenance at the highest build level. **Provenance proves where an artifact was built, not that the build was honest.** Treat provenance as necessary, not sufficient.
- **Miasma wave (Jun–Jul 2026)** — dozens of packages under a vendor scope, then several release pipelines of a well-known specification project, each reusing an obfuscated install-time stealer.
- **CHAINDROP (4 Aug 2026)** — the most recent and the most instructive. A maintainer compromise trojanized a monorepo with a worm that backdoored every package that maintainer could publish, reaching packages with very large download counts. Its two novel properties matter more than its scale:
  - **Persistence outside the registry.** It committed an agent session-start hook in `.claude/settings.json` and an editor `folderOpen` task in `.vscode/tasks.json`, pushed across many branches. Opening the repository in an editor or an agent was enough to execute. Grep any untrusted repo for both before opening it.
  - **Credential sweep aimed at AI accounts.** Its collector targeted coding-assistant and model-provider credentials alongside the usual cloud keys. Your model API keys are now first-class loot.
  - Reported mitigations that worked: newer npm versions blocking install hooks by default, eliminating automation tokens that bypass 2FA, and a soak period before adopting new versions.

**CI/CD.** The `tj-actions/changed-files` compromise (Mar 2025, CVE-2025-30066) [V] retroactively repointed version tags at a malicious commit and dumped secrets into build logs across tens of thousands of repositories; a related action compromise enabled it. A 2026 analysis [S] found roughly 38% of organizations still have at least one workflow vulnerable to script injection or a dangerous trigger. In March 2026 a scanner vendor's own action had nearly all of its version tags force-pushed to malicious code [V]. **A mutable tag is not a pin. Pin actions by commit SHA.**

**Slopsquatting.** Frontier models invent package names at a measurable rate — a 2026 study across ~200,000 prompts found single-digit-percentage hallucination rates, with over a hundred invented names produced identically by every model tested and a large fraction of those names still unregistered at the time of study [S]. Roughly 43% of hallucinated names recur across identical runs, which is what makes them registrable and profitable. **Agents removed the human "does that name look right" checkpoint.** Verify a package exists, is old enough, and is the one you meant, before adding it — see `supply-chain.md`.

**Editor extensions and MCP servers.** A July–August 2026 campaign published 77 extensions to an open registry that copied real extensions' names and descriptions at version `0.0.1` under namespaces the publishers did not own, beaconing host details on editor start [V]; removal from the registry does not clean already-installed copies. The first malicious MCP server in the wild (Sept 2025) [V] was a clone of a legitimate mail library that added a single silent BCC header — after fifteen clean releases built trust. Separately, hundreds of extension-publisher secrets have leaked, and extensions auto-update by default.

## 3. AI coding agents as an attack surface

If the project you are hardening is itself an agent, a tool server, or ships an AI feature, read `agent-surface.md` in full. The headline facts:

- **Prompt injection has no known reliable prevention** [V]. A 2025 evaluation of twelve proposed defenses reported a 100% bypass rate by adaptive human red-teamers. Design for containment, not for a filter that holds.
- **The lethal trifecta** — private data access + untrusted content + an egress channel. Any two are usually fine; all three is exploitable. This is the single most useful architectural test for an agent feature.
- **Sandbox escapes were the 2026 bumper crop** [S] — multiple critical-severity escapes across the major coding-agent products, including symlink-based escapes and configuration-file protections bypassed from inside the sandbox. The recurring root pattern: **files the agent writes inside the sandbox are later read, loaded, or executed by a trusted process outside it.**
- **Rules-file and skill backdoors** [V] — instructions hidden in `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or a shared skill using invisible Unicode (tag codepoints, bidi controls, zero-width characters) land directly in the model's context. Documented payloads have instructed agents to exfiltrate local `.env` contents while suppressing output, and to inject credential-harvesting code into every file they generate — turning the agent into the delivery mechanism for a backdoor that reaches CI and production.
- **Fetched content is executable-adjacent** [V] — a malicious issue in a public repository was enough to make an assistant leak private repository contents; a support ticket containing embedded instructions caused an agent holding a privileged database credential to publish secrets back into a public thread. Google reported (Apr 2026) a measurable rise in prompt injections embedded in ordinary web pages [S].

## 4. What is actually being exploited against small teams

- **Secret sprawl is the number one route.** GitGuardian's 2026 report [V] counted 28.65M new hardcoded secrets on public GitHub in 2025 (+34% year over year), including a large and fast-growing share tied to AI services, thousands of valid credentials inside MCP configuration files, and — the fact that should change behavior — **64% of valid secrets first leaked in 2022 were still unrevoked in 2026**. The same report found a materially higher secret-leak rate in AI-assisted commits than the baseline.
- **Backend-as-a-service row-level security is the highest-yield indie misconfiguration** [S]. A May 2026 study catalogued the failure modes in rank order: RLS disabled entirely; a permissive `using (true)` policy; partial coverage where reads are locked but writes are not; a service-role key shipped in the client bundle; and subtly wrong `auth.uid()` logic. Two details make this worse than it sounds — the dashboard shows an "enabled" badge for the permissive-policy case, and `using (true)` is exactly what a code generator produces when told to "add an RLS policy" without a specific rule. Enumeration is trivial because generated schemas converge on identical table names.
- **Exposed AI and developer infrastructure** [V] — tens of thousands of internet-facing local-inference servers, plus smaller populations of notebook, experiment-tracking and MCP endpoints. Note the honest caveat from the same research: it recorded essentially no AI-aware exploitation; the traffic hitting those ports was generic credential-harvesting scanning probing for `.env` files and cloud secrets. Generic scanners find you first.
- **AI gateways concentrate credentials** [S] — a compromised dependency in a gateway library can expose an organization's entire portfolio of model provider keys at once. Several agent-framework and low-code AI platform CVEs have been used for initial access, credential harvesting and lateral movement, with at least one on CISA's exploited-vulnerabilities catalog.
- **Do not over-rotate to AI, though** [V] — one-third of known-exploited vulnerabilities in the first half of 2026 were content-management systems (largely plugins), with network edge devices generating the rest. If the project runs a CMS or sits behind an appliance, that is the likelier door.

## 5. Speed and economics

- **Median time from CVE publication to confirmed exploitation fell from about 120 days (2025) to about 80 days (1H 2026)** [V]. Roughly a quarter of newly-exploited CVEs showed exploitation on or before publication day. Absolute early-exploitation counts are flat while CVE issuance grew sharply — so the *rate* is falling even as the *speed* rises.
- **Leaked credentials are used, not archived.** Assume any secret that touched a public surface, a build log, a paste, or a third-party service is compromised at the moment of exposure. Rotation is the fix; deleting the commit is not.
- **Patch aggressively where there is evidence of exploitation.** Guidance in 2026 [S] points toward days, not weeks, for vulnerabilities that are automatable, exploited, and reachable in your deployment.

## How to use this file

1. Pick the two or three items above that plausibly apply to *this* project and write them into the threat model as concrete scenarios with named actors and objectives.
2. Skip the rest. A threat model that lists every incident of the last two years is not a threat model.
3. Re-verify anything marked [S] or [U] before putting it in front of the user as current fact.
