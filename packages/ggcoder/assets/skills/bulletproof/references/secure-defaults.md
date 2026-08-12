# Secure Defaults

The values to write **while building**, so the audit finds nothing. When a choice is not obviously required by the project, pick the default here and state it in one line.

Snapshot 12 August 2026. **[V]** verified, **[S]** snapshot-volatile, **[U]** uncertain. Re-verify version-sensitive items before asserting them as current.

## Secrets

**The single highest-yield control for a small team.** 28.65M new hardcoded secrets appeared on public GitHub in 2025, and 64% of valid secrets leaked in 2022 were still live in 2026 [V] — leaks are not revoked, so prevention and rotation both matter.

- Never in source, never in a client bundle, never in a log, never in an error response, never in a fixture that gets committed. `.env` in `.gitignore` from the first commit; commit `.env.example` with empty values.
- Anything prefixed `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_` **is published**. Check the built bundle, not the source.
- Scope every credential to the narrowest permission and shortest lifetime that works. Prefer short-lived OIDC federation over long-lived cloud keys; prefer per-service tokens over one shared key.
- **A secret that touched a public surface, a build log, a paste, a screenshot, or a third-party tool is compromised.** Rotate it. Removing the commit does not unpublish it.
- Config files for AI tooling count: thousands of live credentials have been found inside MCP configuration files [V]. Treat `.mcp.json`, agent settings, and editor config as secret-bearing.
- Run a secret scanner in CI **and** as a pre-commit hook — gitleaks or trufflehog, both free. Detection after push is a rotation trigger, not prevention.

## Authentication

Baseline per **NIST SP 800-63B-4** (final 31 Jul 2025) [V]:

- **Minimum 15 characters** for single-factor passwords; support at least 64; allow all printable characters including spaces.
- **No composition rules** and **no scheduled rotation** — change only on evidence of compromise. Both are explicit SHALL NOTs now; the old advice is now a finding.
- **Screen against a breached-password blocklist** on set and change.
- Allow password managers and paste/autofill. No password hints, no knowledge-based questions.
- Passkeys/WebAuthn are the preferred factor — synced passkeys count at AAL2, device-bound at AAL3 [S]. Offer them before offering SMS.

Implementation:

- Hash with **argon2id** (memory-hard, tuned so a verification takes ~100–300 ms on your hardware) or bcrypt where argon2 is unavailable. Never a bare SHA family hash, never MD5.
- **OAuth 2.1 direction** [S]: PKCE required for all authorization-code flows, the implicit and password grants are gone, exact redirect-URI matching, refresh-token rotation with reuse detection. Follow the OAuth Security BCP.
- Session tokens from a CSPRNG, ≥128 bits. Rotate the session identifier on login and on privilege change. Server-side revocation must exist — a stateless token you cannot revoke is an outage during an incident.
- Constant-time comparison for tokens, signatures, and MFA codes — but **validate the shape before you compare**. A stored credential whose hex/base64 decodes to the wrong length, or whose scheme/salt/hash does not parse, must be rejected as malformed and fail closed; never fall through to the comparison. `timingSafeEqual` on two empty buffers returns true, so an unparsed record can verify any password.
- Rate-limit and lock out on login, reset, MFA, and token exchange. Generic failure messages: never reveal whether the account exists.

## Authorization

- **One chokepoint.** A policy function, a scoped repository, or database RLS — not a check copy-pasted into each handler.
- Default deny. New endpoints and new tables are inaccessible until a rule grants access.
- Authorize on the **object**, not just the route: `canRead(user, invoice)`, never "the route is under `/admin` so it is fine".
- Never accept a client-supplied user, tenant, role, or price. Derive them from the session server-side.
- Re-check on every request; a permission granted at login can be revoked mid-session.
- Test it: the cross-user access test (user B requests user A's resource, expect 403/404) is the highest-value security test a small team can write.

## Cryptography

Do not invent constructions. Use a vetted library's high-level API.

| Need | Default | Notes |
|---|---|---|
| Password hashing | argon2id | Never a fast hash |
| Symmetric encryption | AES-256-GCM or XChaCha20-Poly1305 | Always AEAD. **Never reuse a nonce with GCM** — random 96-bit nonces are only safe under a key-rotation bound; XChaCha's 192-bit nonce is safer for high volume |
| Hashing | SHA-256 or SHA-512 | MD5 and SHA-1 are dead for anything security-relevant |
| MAC | HMAC-SHA-256 | Verify with a constant-time compare — only after both operands are known well-formed (a malformed operand can make an empty-empty compare return true) |
| Signatures | Ed25519, or ECDSA P-256 | Verify the algorithm from your own policy, not from the token header |
| Randomness | The OS CSPRNG (`crypto.randomBytes`, `secrets`, `getrandom`) | Never `Math.random`, `rand()`, or a seeded PRNG for tokens, IDs, or salts |
| Transport | TLS 1.3, HSTS with a long max-age | TLS 1.0/1.1 gone; 1.2 only for legacy peers |
| Tokens | Short-lived, audience-bound, revocable | Reject `alg: none`; pin the expected algorithm |

**Post-quantum** [V]: FIPS 203 (ML-KEM), 204 (ML-DSA) and 205 (SLH-DSA) were finalised Aug 2024. Hybrid key exchange **X25519MLKEM768 is the de facto browser default in 2026** — Chrome since v131, Firefox since v132, with Apple platform support from the 2025 OS releases. Certificates remain classical; only the key exchange is PQ-protected. Practical guidance for an app developer: enable the hybrid group on your servers (prefer `X25519MLKEM768`, fall back to `X25519`), and treat **harvest-now-decrypt-later** as real only for data that must stay confidential for a decade or more. Do not hand-roll PQC. CNSA 2.0 dates matter only for national-security systems [V].

## Input handling

- **Validate at the boundary with a schema**, allowlist-shaped, rejecting unknown fields. Parse into typed structures rather than passing raw maps inward.
- Encode at the point of use, not on input. Escaping for HTML, SQL, shell, and JSON are different operations; a single "sanitize" pass at ingress is a false sense of safety.
- Bound everything: body size, array length, string length, upload size, nesting depth, page size, and decompressed size.
- Canonicalize paths with `realpath` and verify containment **after** resolution; reject `..` and absolute entries in archives.
- For file uploads: validate content by sniffing, not by extension or client-supplied MIME; store outside the web root with generated names; never serve them from your app's origin if they can be HTML.

## Web response headers

Baseline for anything rendering HTML:

- **CSP with nonces and `strict-dynamic`**, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. An allowlist-only CSP is bypassable in practice; nonce-based is the current recommendation.
- `Strict-Transport-Security` with a long max-age and `includeSubDomains`.
- `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; a restrictive `Permissions-Policy`.
- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax` (or `Strict` for sensitive actions), `__Host-` prefix where scoping allows.
- CORS: never `Access-Control-Allow-Origin: *` together with credentials; echo only from an allowlist; never reflect arbitrary origins.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy` for isolation; add COEP when you need cross-origin isolation.
- Subresource Integrity on third-party scripts, or self-host them.
- Trusted Types where the framework supports it — it eliminates DOM XSS sinks structurally [S].

## Cloud, containers & infrastructure

- **OIDC federation instead of long-lived cloud keys** in CI. This removes the credential that supply-chain worms are hunting.
- IAM scoped to specific actions and resources. No `Action: *`, no wildcard `PassRole`. Separate roles per service.
- Storage private by default; block public access at the account level; presigned URLs short-lived and scoped.
- Enforce the hardened instance metadata service (IMDSv2 / hop limit 1). SSRF plus a legacy metadata service equals cloud credentials.
- Containers: non-root user, read-only root filesystem, dropped capabilities, no `--privileged`, no Docker socket mount, a seccomp profile, minimal or distroless base images, pinned by digest.
- Kubernetes: enforce the `restricted` Pod Security Standard, network policies default-deny, no cluster-admin service accounts, secrets from a manager rather than plain manifests.
- Databases and caches never on a public interface. Redis, Postgres, Mongo, Elasticsearch bound to private networks with authentication on.

## Logging & detection

You cannot respond to what you cannot see, and A09:2025 covers alerting, not just logging.

- Log authentication outcomes, authorization denials, privilege changes, secret access, admin actions, and payment events — with actor, source, and timestamp.
- **Never log** credentials, tokens, session identifiers, full card numbers, or request bodies containing them. Redact at the logger, not at each call site.
- Alert on the few things that mean compromise: a spike in authorization denials, a new admin, a credential used from an unexpected location, a dependency-install failure in CI, an unexpected published release.
- Keep enough retention to investigate — 90 days is a reasonable floor for a small team.

## Failure behavior

A10:2025 exists because of this: **fail closed.** When the auth service times out, deny. When the policy engine errors, deny. When signature verification throws, reject. Grep for `catch` blocks that swallow an error and continue on the success path, and for defaults that grant access when a value is missing or `undefined`.
