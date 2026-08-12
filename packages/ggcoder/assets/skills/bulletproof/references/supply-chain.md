# Supply Chain & Build Integrity

A03:2025 is Software Supply Chain Failures — promoted because this is now the dominant compromise route for small teams. Your dependencies, your CI, and your release pipeline are all code you ship, written by people you have not met.

Snapshot 12 August 2026. **[V]** verified, **[S]** volatile, **[U]** uncertain.

## Adding a dependency

Before adding any package — and **especially** one you or a model produced from memory:

1. **Confirm it exists and is the one you mean.** Models invent package names at a measurable rate, the same invented names recur across runs, and squatters register them [S]. This is slopsquatting, and an agent removes the human "does that name look right" check. Named real-world cases include a plausible-sounding lint plugin and a conflation of two real codemod tools [V].
2. **Check identity, not vibes:** registry age, download history, repository link that actually resolves, maintainer with other work, a version history that is not a single `0.0.1`. New package + high download count + no history is the squat signature.
3. **Check character-level lookalikes** against the package you meant: hyphen vs underscore, singular vs plural, scoped vs unscoped, `-js` suffix, homoglyphs.
4. **Prefer what is already in the project.** The safest dependency is the one you do not add. For a few dozen lines, write the code.
5. **Pin it.** Exact version in the manifest, lockfile committed, and for containers and Actions pin by digest or commit SHA.
6. **Let it age.** A cooldown before adopting brand-new versions would have blocked both major npm worm waves — malicious releases were pulled within hours [V]. A few days of lag costs nothing.

## Install-time execution

`preinstall`/`postinstall` scripts run arbitrary code with full developer privileges before anything is reviewed, with access to your registry tokens, cloud credentials, source, and filesystem [V]. This is the mechanism behind the worm lineage.

- Set `ignore-scripts=true` and allowlist the handful of packages that genuinely need a build step (`onlyBuiltDependencies` or equivalent).
- Use a package manager version that blocks install hooks by default where available [S].
- Eliminate automation tokens that bypass 2FA — the most recent worm only propagated through tokens with publish rights **and** 2FA bypass [V].
- In CI, install with a frozen lockfile and no scripts, in a container without cloud credentials mounted.

## Publishing your own package

If others install your code, you are their supply chain.

- **Trusted publishing / OIDC instead of long-lived registry tokens** [S]. A token in CI is the exact asset every worm enumerates.
- 2FA on the registry account and the source-control account, hardware-backed where possible.
- Generate provenance/attestations (SLSA, Sigstore, registry-native attestations) — but understand the limit: **provenance proves where an artifact was built, not that the build was honest.** A 2026 campaign published malicious versions carrying valid high-level provenance because the build itself was subverted [U].
- Verify what is in the tarball before it ships: `npm pack --dry-run` or equivalent. Ship no source maps, no `.env`, no test fixtures, no internal docs. A source-map leak has already exposed a major product's source [S].
- Review the diff of every release, including dependency bumps. Maintainer-account compromise is the entry point in most of these incidents; a second pair of eyes on the release commit is the cheapest control.

## CI/CD

The highest-value target, because CI holds every credential at once — 59% of machines compromised in one worm forensic study were CI runners, not laptops [V].

| Control | Check |
|---|---|
| **Pin actions by SHA** | `uses: org/action@<40-char-sha>`. A version tag is mutable: one 2025 incident retroactively repointed tags across tens of thousands of repositories, and a 2026 one force-pushed nearly every tag of a security vendor's own action [V] |
| **Least-privilege token** | An explicit `permissions:` block, default `contents: read`, elevated only in the job that needs it |
| **Dangerous triggers** | Workflows that run on pull requests from forks **and** check out the PR head **and** hold secrets. Roughly 38% of organizations still have one [S] |
| **Cache poisoning** | A fork-triggered workflow with write access to the base repository's cache can plant content a later trusted job consumes — the initial access in a 2026 credential-free worm [V] |
| **Script injection** | Never interpolate `${{ github.event.* }}` (titles, branch names, comment bodies) directly into a `run:` block. Pass through `env:` and quote |
| **Secret hygiene** | No secrets echoed, no `set -x` around them, masked in logs, scoped per environment, rotated on any suspicion |
| **Runners** | Prefer ephemeral. A reused self-hosted runner leaks state between jobs, including from forks |
| **Branch protection** | Required review on the release branch, signed commits where feasible, no force-push |

## Consuming other people's code beyond packages

- **Editor extensions**: a 2026 campaign published 77 extensions cloning real extensions' names and descriptions under namespaces the publishers did not own [V]; extensions auto-update by default, and removal from a registry does not clean installed copies. Check publisher identity, install count history, and repository link — not the display name.
- **MCP servers**: the first in-the-wild malicious server was a clone of a legitimate library that added a silent BCC after fifteen clean releases [V]. Install from the official registry with signing and verification where possible; pin versions; review the tool list after every update. See `agent-surface.md`.
- **Container base images**: pin by digest, scan, prefer minimal or distroless, rebuild regularly rather than pinning to a stale digest forever.
- **Model artifacts**: signed and verified at load, code-capable formats rejected, dataset revisions pinned by hash. See the ML section of `platform-playbooks.md`.
- **Opening an untrusted repository is itself an install.** Before opening one in an editor or an agent, check `.vscode/tasks.json` for `runOn: folderOpen`, agent hook configuration (`.claude/settings.json` and equivalents), `.git/config` for `core.fsmonitor` and `core.pager`, and any `postinstall`. The most recent worm persisted through exactly these [V].

## Keeping it current

- Automated dependency updates with a review gate, plus a scanner that fails the build on known-exploited vulnerabilities in reachable code — not on every advisory, or the team learns to ignore it.
- Track a real SBOM (CycloneDX or SPDX) generated in CI per release. It is a regulatory obligation for some products [V], and independently it is the only way to answer "are we affected" in hours instead of days.
- Median time from CVE publication to confirmed exploitation is now roughly 80 days, with about a quarter exploited on or before publication day [V]. **The controllable variable is your patch latency**, not their speed.
- Subscribe to advisories for your actual stack. For a small team, three feeds you read beats thirty you filter.

## If you suspect compromise

Order matters:

1. **Rotate every credential the affected machine or pipeline could reach** — registry tokens, cloud keys, model API keys, source-control tokens, SSH keys, session secrets. Assume everything on that host is gone.
2. Revoke sessions and active tokens; re-issue signing keys if a signing key could have been touched.
3. Check for published artifacts you did not publish, and for commits, branches, and workflow files you did not author.
4. Check persistence: editor tasks, agent hooks, git config, shell profiles, scheduled jobs, new deploy keys, new OAuth app grants.
5. Preserve logs before cleaning. Then rebuild the machine rather than cleaning it.
6. Only then work out how it happened.
