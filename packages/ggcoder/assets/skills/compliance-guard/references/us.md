# United States

Snapshot **11 Aug 2026**. Markers: **[V]** verified against a primary/first-tier source · **[S]** snapshot, re-verify · **[U]** contested or fast-moving.

**PRA** = private right of action. This is the field that matters most for a small company: regulator-only laws are a compliance project, PRA laws are a lawsuit.

---

## 0. Scoping reality for a tiny startup

Most **comprehensive state privacy laws will not apply** to a pre-scale product — they need tens of thousands of residents' data or large revenue. But four categories apply **at any size**:

1. FTC Act §5 and state unfair-and-deceptive-practices analogues (most state UDAPs *do* have a PRA).
2. Breach-notification statutes in every state.
3. Sector laws: COPPA, HIPAA, GLBA, TCPA, BIPA, consumer-health-data laws.
4. No-threshold plaintiff statutes: CIPA, BIPA, MHMDA, TCPA, VPPA.

Also note **Texas and Nebraska have no revenue or volume threshold** — they apply to anyone doing business in-state who is not an SBA "small business", and even exempt small businesses may not sell sensitive personal data without consent **[V]**.

**Practical answer:** a US indie app under ~25k users in any single state usually falls outside the comprehensive laws — and is still fully exposed to everything in categories 1–4.

---

## 1. State comprehensive privacy laws

**In force in 2026: 20 states** (CA, VA, CO, CT, UT, TX, OR, MT, IA, DE, NE, NH, NJ, TN, MN, MD, IN, KY, RI, and Florida's narrower law which applies only above $1B revenue) **[V]**. Enforcement is AG-only; penalties commonly $7,500–$10,000 per violation **[V]**. Cure periods are expiring across states **[S]**.

Thresholds range from 25,000 consumers (Montana) to 175,000 (Tennessee); 10,000 consumers where a share of revenue comes from selling data (RI, DE, NH, MD); Maryland pairs a 35,000-consumer threshold with the strictest data-minimisation and sensitive-data rules, and bans the sale of sensitive data outright **[V]**.

**Universal opt-out / Global Privacy Control — the cheapest high-value engineering task.** As of 1 Jan 2026, twelve states require honouring it (CA, CO, CT, DE, MD, MN, MT, NE, NH, NJ, OR, TX); Virginia-template states do not **[V]**.

```
Read the Sec-GPC: 1 request header and navigator.globalPrivacyControl.
Treat as an opt-out of sale/share + targeted advertising.
Apply BEFORE firing any ad pixel. Persist server-side against the user/device.
Disclose signal handling in the privacy notice.
```
Honouring GPC for **every** visitor is the safe default: it satisfies the strictest state and violates none **[V]**.

**Why an ordinary ad pixel triggers everything.** "Sale" requires no money — any disclosure for other valuable consideration counts — and "sharing" expressly covers cross-context behavioural advertising **[V]**. Meta Pixel, GA4 with ad features, TikTok, Reddit and LinkedIn tags are a sale/share/targeted ad in nearly every state. Build: a tag inventory, consent-gated loading, and an opt-out that actually severs the pixel rather than filing a form.

**Sensitive data requires opt-in** in Virginia-model states (precise geolocation, race, religion, health, sex life/orientation, immigration status, biometrics, genetic data, children's data) **[V]**. California instead grants a right to limit use.

**Minors:** opt-in for targeted ads, sale, and profiling for known 13–16 year-olds; Maryland extends to under-18 on a "should have known" standard **[V]**.

**Rights and timing:** access, delete, correct, portability, opt-out, non-discrimination. **45 days, extendable by 45** **[V]**. Virginia-model states require an **appeal** mechanism. California requires two intake methods. Never identity-verify an opt-out — verification is for access/deletion.

**Notice content:** categories collected/sources/purposes/recipients, sensitive-data uses, **retention periods per category** (California), rights and how to exercise them, opt-out-signal handling, appeal process, contact, and a last-updated date with an annual refresh **[V]**.

**Assessments:** written data-protection assessments required in most Virginia-model states for targeted advertising, sale, sensitive data, and risky profiling; retained and producible to the AG **[V]**.

---

## 2. California specifics

**Applicability:** for-profit doing business in CA meeting any one of — annual gross revenue over ~$26.6M (CPI-adjusted), buying/selling/sharing PI of 100,000+ CA consumers or households a year, or 50%+ of revenue from selling/sharing PI **[V]**. Penalties per violation with a higher tier for intentional violations or those involving minors. **Consumers may sue only over certain breaches** ($107–$799 per consumer per incident) — there is no general PRA for policy or opt-out-link failures **[V]**.

**2026 regulations package (effective 1 Jan 2026)** **[V]**:
- *Risk assessments* — begin 1 Jan 2026, complete for ongoing activities by 31 Dec 2027, first certified reports 1 Apr 2028. Triggered by sensitive PI, targeted ads to minors, ADMT for significant decisions, or training ADMT.
- *ADMT* — pre-use notice, access, and opt-out for automated decision-making about significant decisions (including employees, contractors, applicants). **Compliance deadline 1 Jan 2027.**
- *Cyber audits* — only above revenue plus scale thresholds; first certifications from 2028. A pre-revenue startup is out of scope.

**Delete Act / DROP** — if you sell PI of consumers you have no direct relationship with, you are a data broker. **No revenue threshold.** Registration plus, **from 1 Aug 2026**, processing consumer deletion requests through the state mechanism every 45 days with downstream deletion directives; per-day penalties apply whether or not you registered **[V]**. Enforcement has already hit companies of exactly this size. Ask at design review: *do we sell PI of people who never used us?*

**Breach notice (SB 446)** — since 1 Jan 2026, notify affected California residents within **30 calendar days** of discovery, and report to the AG within **15 calendar days** of notifying individuals **[V]**.

**AI transparency (SB 942 as amended by AB 853)** — covered providers are generative-AI systems with **over 1M monthly users**; duties operative 2 Aug 2026, with hosting-platform duties from 1 Jan 2027 **[V]**. Most small devs are out of scope, but the hosting-platform duty catches anyone distributing GenAI systems.

**AB 2013 training-data transparency** — **no size threshold**. Developers of generative AI systems made available to Californians must publish training-data documentation; compliance required from 1 Jan 2026 and on substantial modification **[V]**. Catches small fine-tuners, not mere API consumers.

**SB 243 companion chatbots — the highest-risk new law for small AI apps.** Effective 1 Jan 2026. Applies to chatbots sustaining a relationship or human-like emotional engagement (excludes customer-service bots, limited game NPCs, voice assistants). Requires non-human disclosure, mental-health crisis protocols, and minor protections including blocking sexual content and enforcing breaks. **PRA: YES** — minimum $1,000 damages plus fees, and UCL pairing can reach individuals personally **[V]**.

**Employment ADS regulations** under state anti-discrimination law add notice and recordkeeping duties for automated decision systems **[S]**.

---

## 3. Children and teens

**COPPA amended Rule — full compliance date 22 Apr 2026** **[V]**. Trigger: a child-directed service, or actual knowledge of collecting personal information from under-13s. Mixed-audience services may age-screen. Concrete changes:

- **Separate** verifiable parental consent for disclosing children's data to third parties (including for targeted advertising).
- New **data-retention limits** and a **published written retention policy** — indefinite retention is prohibited.
- Broader definition of personal information now expressly including **biometric identifiers** (face templates, fingerprints, voiceprints), government identifiers, phone numbers, audio recordings, and certain geolocation.
- A written children's information security programme with vendor due diligence.
- Parent review/deletion flows must cover biometric data.

**App Store Accountability Acts (TX, UT, LA, AL, CA)** — these impose duties on **app developers**, not just the stores **[V]**. Texas SB 2420 is in effect after appellate and Supreme Court refusals to freeze it (which is not a ruling on constitutionality) **[V]**; Utah developer requirements from 6 May 2026; Louisiana 1 July 2026; California 1 Jan 2027 **[V]**. Build: consume the store's age-signal API, branch features on age category, store only a category flag, re-request consent on significant app changes. Some states allow private suits.

**NY SAFE for Kids** — final rules July 2026, effective **25 Jan 2027**, targeting platforms with addictive feeds **[V]**.

**Adult content age verification** — 26 states with live laws following the 2025 Supreme Court decision upholding Texas's law **[V]**. Typical trigger is ≥1/3 sexual material harmful to minors, a few with no threshold. Use a third-party verifier returning a boolean; retain nothing reconstructable; geo-route per state. Several states allow private suits.

**TAKE IT DOWN Act §3 (NCII) — enforced from 19 May 2026, and it reaches tiny platforms** **[V]**. Any site, app or service that hosts user content must publish a plain-language notice-and-removal process usable by **users and non-users**, and remove reported non-consensual intimate imagery — including AI-generated — plus known identical copies **within 48 hours**. Non-compliance is trivially detectable: a regulator just checks whether the notice exists. Build `/report/ncii`, an acknowledgement + 48h SLA timer, hash-based re-upload suppression, and a footer link.

**CSAM reporting** — providers must report apparent child sexual abuse material to the national tipline as soon as reasonably possible after obtaining actual knowledge, with a **one-year preservation** duty; there is no general proactive monitoring mandate **[V]**. Register a point of contact, define an escalation path, and never re-transmit the material except to the tipline or law enforcement.

---

## 4. Health, biometric, genetic, location

**HIPAA usually does *not* cover a direct-to-consumer wellness app** — it reaches covered entities and their business associates. You become a business associate the moment you handle PHI *on behalf of* a covered entity, which requires a BAA, Security Rule compliance, and 60-day breach notice **[V]**. If you are not HIPAA, you are in the consumer-health-data regime below.

**Washington My Health My Data Act — the top small-company landmine.** **No revenue or volume threshold**, in effect since 2024 **[V]**. "Consumer health data" is defined broadly enough to include precise location that could indicate seeking health services. Requires a **standalone** consumer-health-data privacy policy at its own link, **separate consent for collection**, **separate consent for sharing**, and a **distinct signed authorisation to sell**, plus a geofencing prohibition and processor contracts. **PRA: YES**, via the state consumer-protection act, up to $7,500 per violation **[V]**. The first class action targeted an ordinary ad SDK collecting location. Any period tracker, fitness, mental-health, or symptom app — or anything collecting precise location — is squarely in scope. Nevada has a similar regime without a PRA **[V]**.

**Illinois BIPA** — see `lawsuit-vectors.md` §3. Required **before first capture**: written notice of collection and specific purpose, notice of the retention schedule and destruction guidelines, a **written release**, a publicly available retention/destruction policy, no profiting from biometrics, and reasonable-care storage **[V]**. Texas and Washington have AG-enforced analogues.

**Genetic data** — roughly 14 states require separate express consent per purpose and per disclosure; some allow private suits **[S]**. Treat raw DNA as opt-in-per-purpose and get counsel.

**Precise geolocation** — sensitive/opt-in in every Virginia-model state, and health-linked location is consumer health data **[V]**. Request coarse location by default; never ship precise location to ad SDKs.

**FTC Health Breach Notification Rule** — applies to non-HIPAA health apps that can draw data from multiple sources (e.g. platform health data plus user input). Critically, a "breach" includes an **unauthorised disclosure** — firing a health event to an ad pixel is itself reportable **[V]**. 500+ affected means notifying the regulator within 60 days.

---

## 5. AI laws

- **Colorado** — the original AI Act was delayed and then repealed/replaced with a narrower automated-decision framework; assume a scaled-back regime effective **1 Jan 2027** and verify the enrolled text before building **[U]**.
- **Texas TRAIGA** — effective 1 Jan 2026, reaching out-of-state developers whose AI is accessible to Texas users. Intent-based liability for AI that promotes self-harm, facilitates crime, discriminates, or produces prohibited deepfakes. AG-only with a 60-day cure; **safe harbour for documented NIST AI RMF-aligned compliance** **[V]**. Practical step for a small dev: a one-page RMF-aligned policy plus retained prompt/eval logs.
- **Illinois HB 3773** — from 1 Jan 2026, using AI with a discriminatory *effect* in employment violates the state human-rights act; intent is no defence **[V]**.
- **NYC Local Law 144** — annual independent bias audit plus published summary and candidate notice for automated employment decision tools used for NYC roles **[V]**.
- **Mental-health AI** — Illinois bans AI delivering mental-health treatment or clinical decisions outright; Nevada, Utah and Tennessee restrict or require disclosure; treat "AI therapist" as a **hard gate** **[V]**.
- **Companion chatbots** — California (PRA), New York (AG-only), Oregon (PRA, from 2027), Washington (from 2027) **[V]**. **Baseline build for any consumer LLM chat:** persistent non-human disclosure, self-harm detection with a crisis interstitial, minor-mode content restrictions and break reminders, retained incident logs.
- **Frontier-model laws** target training compute far beyond any small developer **[V]**.
- **Federal posture** — a December 2025 executive order seeks to weaken state AI regulation via litigation and funding conditions, with a DOJ task force operating from January 2026 **[V]**. Do **not** advise a user to ignore state AI law on this basis; the laws remain in force unless and until enjoined.

---

## 6. Cross-cutting federal

- **FTC Act §5** — any statement in your privacy policy, marketing page, app-store listing or in-app copy that is not literally true of your code is deception. Dark patterns in consent and cancellation flows are deception/unfairness; failure to maintain reasonable security is unfairness **[V]**. No federal PRA, but most state UDAP analogues have one.
- **Consumer Reviews and Testimonials Rule** — prohibits fake, incentivised-by-sentiment, and undisclosed insider reviews, with civil penalties in the tens of thousands per violation; enforcement is active **[V]**.
- **Negative option / click-to-cancel** — the federal rule was vacated in 2025 and a new rulemaking is under way **[V]**. Do not tell a user they are safe: ROSCA and ~25 state auto-renewal laws still govern, and California's amended law broadened liability **[V]**.
- **TCPA** — see `lawsuit-vectors.md` §4. Consent records, revocation handling on any channel, quiet hours in the recipient's timezone, DNC scrubbing, carrier campaign registration **[V]**. Exact effective dates of the universal-revocation mandate are reported inconsistently **[U]**.
- **CAN-SPAM** — accurate headers and subject, advertising identification, **valid physical postal address**, working opt-out honoured within **10 business days** and functional for 30 days after send; you are liable for your sending platform and affiliates **[V]**.
- **State breach notification** — all states; deadlines and AG-notice thresholds vary; several sector rules add shorter clocks **[V]**.
- **ADA accessibility** — Title II has fixed rule deadlines for public entities; Title III private-business exposure is driven by private litigation rather than a technical rule **[V]**. WCAG 2.1 AA is the practical benchmark.
- **GLBA Safeguards Rule** — "financial institution" is far broader than banks and catches many fintech, lending, tax-prep and advisory products: written InfoSec programme, a named qualified individual, MFA, encryption, vendor oversight, and 30-day regulator notice for larger incidents **[V]**.
- **FCRA** — if you assemble or use consumer reports for employment, tenant, credit or insurance decisions: permissible purpose, **standalone** disclosure plus authorisation, pre-adverse-action packet with a waiting period, adverse-action notice. **PRA: YES**, with heavy class-action volume over standalone-disclosure defects **[V]**.
- **ECOA/Reg B and FHA** — adverse-action notices with **specific principal reasons** within 30 days. A black-box model that cannot articulate reasons is itself the violation **[V]**. **PRA: YES.**

---

## 7. PRA ranking — what actually produces suits against small companies

1. California CIPA (trackers, pixels, chat widgets, session replay) — $5,000 per violation, no threshold **[V]**
2. ADA Title III accessibility (plus state statutory damages) **[V]**
3. TCPA/SMS — $500–$1,500 per message, uncapped **[V]**
4. Illinois BIPA — per-person statutory damages, a single in-state user suffices **[V]**
5. Washington MHMDA — up to $7,500 per violation, extremely broad health-data definition **[V]**
6. Auto-renewal claims via state consumer statutes **[V]**
7. CCPA breach claims — $107–$799 per consumer, filed reflexively after AG breach reports **[V]**
8. California SB 243 companion chatbots — new, untested, minimum $1,000 plus fees **[V]**
9. VPPA — video plus ad pixel, $2,500 per person, circuit split **[U]**
10. FCRA — standalone-disclosure defects **[V]**
11. State wiretap analogues beyond California **[U]** on the exact state list
12. AI employment discrimination — low volume today, rising **[S]**

**Regulator-only (no PRA):** every state comprehensive privacy law except California's breach claim, COPPA, TAKE IT DOWN, TRAIGA, frontier-model laws, SB 942, NYC LL144, Nevada health law, the Delete Act, GLBA, CAN-SPAM, and FTC rules.

---

## 8. Verify before relying

Colorado's replacement AI law text and date · Vermont and Nebraska children's-code dates · the TCPA universal-revocation effective date · VPPA scope · state mini-TCPA and mini-wiretap lists · genetic-privacy specifics per state · SaaS sales-tax nexus.
