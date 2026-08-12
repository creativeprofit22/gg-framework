# Provenance and Volatility

## Snapshot

These references were compiled on **11 August 2026** from primary and first-tier sources: EUR-Lex and the Official Journal, EDPB, national data protection authorities, ICO, Ofcom, the European Commission, the FTC, CPPA, state legislature and AG sites, US federal court opinions, the Copyright Office, NIST, OWASP, PCI SSC, and platform developer documentation.

## Confidence markers

Every substantive claim in these files carries a marker. **Preserve them when you report to the user.**

- **[V] Verified** — checked against a primary or first-tier source at snapshot time. Still subject to change after that date.
- **[S] Snapshot** — accurate at snapshot time but date-, threshold-, or version-sensitive. Re-verify before stating it as current.
- **[U] Uncertain** — contested, in litigation, in legislative flux, or where sources conflicted. Present it to the user as uncertain, with both readings if they matter.

Laundering an `[S]` or `[U]` item into a confident assertion is the most damaging failure mode of this skill. A user who acts on a wrong effective date is worse off than a user who was told to check.

## What decays fastest

Re-verify these before relying on them, in rough order of volatility:

1. **US state AI laws** — effective dates have moved repeatedly, some are enjoined, some were repealed and replaced mid-cycle, and federal preemption efforts are active.
2. **State privacy law scope** — new states take effect on 1 January and 1 July cycles; thresholds and cure periods change.
3. **EU AI Act dates** — amended in July 2026; any guidance written before mid-2026 is unreliable on the high-risk timeline.
4. **EU data/ePrivacy reform** — the data-protection half of the Digital Omnibus was still in negotiation at snapshot time and is **not law**. Do not build to proposed cookie or browser-signal provisions.
5. **EU–US transfer framework** — valid at snapshot, with an appeal pending.
6. **Wiretap/pixel litigation** — statutory reform and appellate decisions are actively reshaping which theories survive.
7. **Age-verification and minors' laws** — rapid state adoption plus constitutional litigation.
8. **Platform requirements** — Apple and Google change privacy and account requirements on their own schedule.
9. **Security standards and vendor terms** — OWASP versions, PCI requirements, and LLM vendor retention/training defaults all move.
10. **Penalty amounts** — many are inflation-adjusted annually.

## Known gaps at snapshot

- Jurisdictions outside the EU/UK/US are covered only where they surfaced incidentally (Australia, Canada, Brazil, India). **Do not extrapolate** — if the user targets another market, say the references do not cover it and research it before advising.
- Sector regimes are covered at gate-detection depth, not implementation depth. The purpose is to recognise the gate and route to counsel, not to compliance-engineer a regulated business.
- Fine tiers, transitional dates, and standard versions were flagged individually where they could not be re-verified.

## Using this with web access

When web access is available, verify in this order before making a claim the user will act on: (1) the effective date, (2) whether the law survived litigation, (3) the threshold and whether the user is over it, (4) the penalty and whether a private right of action exists. Prefer the statute, the regulator's own guidance, or the court's opinion over secondary commentary — law-firm blog posts were a recurring source of the errors corrected during this research, including at least one widely-repeated claim about an EU obligation that does not exist.

When web access is unavailable, say so, cite the snapshot date, and mark the affected findings as needing verification.
