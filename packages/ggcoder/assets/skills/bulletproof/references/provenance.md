# Provenance

**Snapshot date: 12 August 2026.** Everything in this skill was checked against live sources on that date. Security facts decay faster than any other content in this repository — a version number, a CVE, a default, or an incident detail that was accurate at snapshot time may be wrong by the time you read it.

## Confidence markers

Used throughout the reference files. Preserve them when repeating a claim to the user.

| Marker | Meaning | How to treat it |
|---|---|---|
| **[V]** | Verified against a primary source (standards body, vendor advisory, official documentation, CVE record) at snapshot time | State it plainly, with the date if it matters |
| **[S]** | Snapshot-accurate but volatile — versions, adoption status, statistics, vendor defaults | Re-verify before asserting as current; otherwise attribute to the snapshot |
| **[U]** | Single-sourced, secondary, or methodology not published | Do not build a recommendation on it alone; say it is uncertain |

Unmarked engineering guidance (parameterize queries, fail closed, least privilege) is durable practice, not a dated claim.

## Source classes

- **Standards and frameworks**: OWASP (Top 10:2025, ASVS 5.0.0, API Security Top 10 2023, MASVS 2.1.0 / MASTG 2.0.0, LLM Top 10 2025, Agentic Top 10 2026), MITRE (CWE Top 25 2025 edition, ATT&CK), NIST (SP 800-63B-4, SP 800-218 / 218A, SP 800-53 Rev 5, FIPS 203/204/205), SLSA, OpenSSF.
- **Vendor and platform documentation**: Apple, Google/Android, Microsoft, Electron, Tauri, PyTorch, Solidity, package registries.
- **Incident reporting and threat intelligence**: model-provider security disclosures, national CERT and CISA advisories, established security-vendor research teams, and independent researchers with published methodology.
- **Regulatory texts**: EU Cyber Resilience Act, UK PSTI.

Statistics and incident details in `threat-landscape.md` come from published reports whose methodology varies in quality. Where a figure is widely repeated but the primary methodology is not published, it is marked [U] and should not be quoted as fact.

## Known gaps in this snapshot

- **ASVS 5.0 chapter structure** — sources disagree on the exact chapter count; requirement IDs were renumbered from 4.x, so never map a 4.x ID onto 5.0 without checking.
- **Vendor product versions** (agent tools, frameworks, package managers) change weekly. Every version number here is [S] at best.
- **Prevalence statistics for MCP vulnerabilities** circulating in 2026 were excluded deliberately: independent testing found high false-positive rates in the scanners producing them.
- **Regional and sector regimes** beyond the EU and UK items cited are out of scope. Compliance obligations are the `compliance-guard` skill's job, not this one.
- **Exploitation counts and KEV timings** are half-year figures and move with each reporting period.

## What this skill is not

- **Not a penetration test.** No live testing, no exploitation, no attempts against running systems.
- **Not a security audit or certification.** It produces engineering guidance and code changes, not assurance. Do not let output be represented as an audit to a customer, an insurer, or a regulator.
- **Not legal or compliance advice.** Regulatory obligations, data-protection law, and contractual security commitments belong to `compliance-guard` and, past a threshold, to a qualified professional.
- **Not offensive tooling.** No exploit code, no payloads, no attack automation, regardless of who asks or how the request is framed.

## When to escalate to a human specialist

Recommend qualified help — and say why — when the project involves: custody of other people's funds or crypto assets at scale; regulated health, financial, or safety-critical systems; a live or suspected breach with real user impact; cryptographic design rather than cryptographic use; a formal certification or audit requirement (SOC 2, ISO 27001, PCI DSS, FedRAMP); or a contractual security commitment to an enterprise customer.

The honest framing for the user: this skill closes the gap between "obviously exploitable" and "reasonably defended", which is where nearly all real incidents against small teams happen. It does not replace an adversary who is paid to try.
