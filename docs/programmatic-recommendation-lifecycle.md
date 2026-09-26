# Recommendation history lifecycle

Recommendation history is independent of deterministic scanner state. A recommendation describes a need and its evidence; it is not a detector result, execution request, receipt, grant or approval. The workflow entry points are documented in [Programmatic workflow](programmatic-workflow.md).

## Consent and compatibility

The exact setup review offers profile envelope V3 with `historyPolicy: { version: 1, enabled: true }`. Approval permits automatic saving of **subsequent configured assessments**, without another history-saving question each time. Setup assessment itself remains project-write-free, even if history was already enabled. Approving settings does not save setup recommendations, import transcripts, scan, create commands or start work.

Existing V1/V2 profiles retain their scanner behavior and do not silently opt into history. Reviewing setup offers an optional history upgrade; declining leaves existing checks usable. The policy, prior-profile digest, recovery-file expectation, session and project belong to the exact review. Older approvals cannot acquire the new permission. A saved V3 policy survives later scanner refreshes. Disabling history does not delete retained records.

Before replacing a legacy profile, the host preserves its **exact bytes** in `.gg/programmatic/profile.previous.json`. A conflicting, unsupported or unsafe recovery file is refused. A bounded exclusive temporary file is verified before replacement. Interruption before the profile rename leaves the old profile authoritative; after that rename the complete V3 profile is authoritative. The previous bytes support a separately authorized recovery, not automatic downgrade. Older binaries are not promised V3 compatibility. This is not a cross-file transaction.

History and recovery files are host-managed inventory exclusions; offering history does not change the saved scanner exclusion policy or manufacture configuration drift. Scanner settings and `state.json` are not migrated or reset.

## Independent records and identity

The host owns UUIDs and timestamps. Strict V1 contracts describe candidates, assessments, observations, decisions, correspondence events and inert references. Candidates are sorted by UUID, carry a record revision, and reference immutable observation/decision provenance. The complete document has a monotonic revision. Extra fields, unsupported versions, duplicate IDs, dangling or inconsistent references, unsafe paths and over-budget records are refused on reads and writes.

An assessment UUID is allocated once at host entry. Retrying identical captured content with that UUID does nothing and consumes no capacity. Reusing the UUID for different captured content is rejected. No model-supplied candidate ID, label, score or command reference authorizes identity or correspondence.

### Exact matching, not semantic matching

Automatic association compares the **entire validated workflow**, with stable key serialization and otherwise exact values:

- Trigger and representative case.
- Inputs and current process, including array order.
- Output and success check.
- Affected scope/subproject and mutation boundary.
- Repeatability basis and explanation.

Outcome/title prose, rationale, command choice and overlapping evidence do not establish identity. Only one-to-one exact workflow matches qualify. Duplicate matching workflows in either saved or incoming sets create distinct candidates marked ambiguous. Several incoming spellings that point at the same human-confirmed canonical candidate are also ambiguous, not silently collapsed. Candidate UUIDs are random, never hashes of prose.

A paraphrase or changed scope creates a separate candidate. A person can inspect both candidates and their revisions, then explicitly confirm correspondence to the earlier canonical candidate. The canonical record gains the later observation links, while the second record, original observation owners and audit event remain. Earlier canonical decisions remain intact. Conflicting explicit decisions refuse consolidation. A terminal decision on the secondary candidate cannot silently transfer to an open canonical candidate; make an explicit canonical decision first. Chained correspondence is refused rather than guessed.

Once correspondence is confirmed, its workflow spellings can exactly match the canonical candidate on later assessments. This is human-confirmed correspondence, not host semantic certainty, a new assessment, or transferred execution permission.

## Observations, evidence and coverage

Exact-workflow replay appends an observation when evidence or the five-choice recommendation changes. Older observations are not rewritten or retroactively verified. All five choices remain distinct: reuse, extension, missing capability, manual work, and needs more evidence. Available/unavailable command reports are historical attribution only.

Persistence projects validated advisory descriptions and bounded evidence summaries, not raw tool output, source bodies, command bodies, tool-call IDs or reusable receipt IDs. Local locations must be normalized relative paths. External attribution removes URL credentials, query strings and fragments and accepts only HTTP(S) metadata. Arbitrary secrets cannot be inferred reliably from prose: summaries remain untrusted project data, not a secret-scanning guarantee. Do not put credentials in recommendations or their summaries.

External validation, assessment display attribution and history capture share exact delivered-receipt matching: inspected URL plus every cited revision and file path. A URL match alone cannot substitute a different file, revision or failed/search receipt. History keeps safe cited locations under `external.location`, never as local-project locations, and takes retrieval time, revision and delivered status from the matched receipt. Assumed or unmatched external evidence remains a lead without a borrowed retrieval time. External receipts currently supply no verified line ranges, so advisory validation still rejects external line claims; the durable location contract can retain safe path/line metadata without implying delivery. The optional external location preserves reads of existing V1 records; unknown fields and unsupported versions still fail closed. Older readers may refuse records containing the new optional field rather than silently discard it.

Evidence records delivered/lead/failed/cancelled status and known retrieval time. Older receipts without a known time do not get an invented retrieval timestamp. Known external revisions and command snapshot digests are provenance, not availability or success. Existing local receipts have locations rather than content digests, so saved evidence explicitly says **not revalidated**. A later delivery is a new observation.

Reported model coverage is stored separately from host receipt counts/coverage. Configuration and catalog digests identify inputs; neither proves complete inspection. Focus qualifies only its assessment. A completed empty assessment can add coverage but cannot resolve candidates. Incomplete, unavailable or cancelled outcomes cannot promote partial observations or change decisions. If cancellation, reset, mode, policy or session ownership makes the save path unavailable, existing history is retained and the assessment reports unsaved history.

## Decisions and human review

Candidates without decision events are open. Explicit host review can append `open`, `dismissed` or `completed` decisions, guarded by the inspected candidate revision. Reopening retains the earlier dismissal/completion event. Omission, a failed read, limited scope, a scan or a command run never performs a transition.

User-declared completion is distinct from completion with an inert referenced verification-result ID. A reference alone never completes a candidate and does not prove the need was met. Command snapshots, creation-review IDs and execution-result IDs are historical references; missing or stale references do not become current availability, successful verification or execution grants.

The authenticated sidecar exposes bounded history report/detail and inspect/apply interfaces. Opportunities currently presents history browsing and typed candidate detail; decision and correspondence inspect/apply remain host interfaces, not visible decision buttons. Reports page at 50 candidates; details page one immutable display record at a time. Display JSON is inert text and must never become an executable request. Review shows the candidate revision, latest captured workflow/choice/evidence, current decision and the intended operation.

Review/apply requires Code mode, no plan mode, the current authenticated session/project and the existing exclusive run claim. The host keeps one single-use review handle, binds it to project identity, profile digest and history revision, and expires it on reset/disposal/owner change. Apply carries only the host handle, never an executable payload or evidence body. Requests remain within the native bridge's 2,048-byte budget. Credentials stay native-only. The model result tool remains read-only, with no history or decision writer.

Opportunities now includes **Discover opportunities**, current candidate selection and read-only review, alongside the separate deterministic rows. **Browse recommendation history** offers **Load history**, **Previous history**, **Next history**, saved candidate details and **View earlier candidate** for linked records. Historical evidence and recorded decisions are not current review or execution authority; fresh discovery is required before actionable candidate review. The current controls and stale-selection boundaries are documented in [User flow](programmatic-user-flow.md#discover-and-review-candidates), verified against `ProgrammaticDiscovery.tsx` and `programmatic-discovery-state.ts`. No new dashboard or native verification claim is implied.

## Persistence, retention and failure

The host stores `.gg/programmatic/recommendations.json` and `recommendations.previous.json`, independently of scanner `state.json` and `state.previous.json`. No new database, runtime, polling loop, model similarity service or package dependency is involved.

History writes acquire locks in **profile → history** order, then re-read and validate. They never hold those locks across provider calls or human review. Before publishing each file, they revalidate the approved profile digest, current ownership and expected history. A valid primary is copied to previous before replacing primary. Fixed exclusive temporary files are validated again after pre-mutation hooks and before rename. Paths with links, non-regular files or unsafe containment are refused.

Bounds:

| Resource | Limit |
| --- | ---: |
| Candidates | 1,000 |
| Assessments | 4,096 |
| Total observation + decision + correspondence records | 16,384 |
| Serialized UTF-8 document | 16 MiB |

Individual observations retain advisory limits. Capacity refusal preserves the existing history and reports the current assessment unsaved. There is no age pruning, deletion, silent eviction, background retry or automatic provider/scanner rerun. Dismissed/completed records remain subject to the same retention. Export and pruning policy are outside this phase.

Assessment/scanner success and history-save status are separate. `saved` identifies the assessment and history revision. `disabled`, `setup-not-saved`, `unsaved` and `acknowledgement-unknown` do not become scanner failure. When rename has published the primary but a later notification/cleanup fails, the host does not claim rollback. **Read before retrying.** Retrying the captured assessment, not the provider, is the idempotent persistence path; no user-facing retry button is added here.

## Recovery boundary

A valid previous history can be returned as **recovered, read-only**, without changing files. Invalid primary and previous never become empty history. An unsupported version fails closed; an older valid copy is not permission to overwrite a future-version document. Mutation of recovered history requires separate recovery authorization; there is no automatic repair/reset command.

For recovery investigation, preserve both files and diagnostics, inspect the reported revision and relevant decisions, and restore/reopen a copy in a disposable location before approving any replacement. Do not delete history to clear a warning. A previous file is **not an off-machine backup**. These guards cover tested process-write boundaries; they do not promise power-loss/fsync durability, disk-loss recovery or recovery of already-corrupt copies.

The disposable restore/reopen drill and criterion-specific verification are recorded in [recommendation history evidence](../.gg/evidence/programmatic-recommendation-history.md). Scripted-provider fixtures are not evidence of live-model semantic quality or installed/native UI behavior.
