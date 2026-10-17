# Programmatic user flow

[Workflow index](programmatic-workflow.md) · [Recommendation policy](programmatic-recommendation-policy.md) · [Architecture and scanner storage](programmatic-architecture.md)

## Language and presentation

This surface is written for people who build with AI and have some coding familiarity, not professional developers. The default view explains the useful outcome, decision-changing limits and next action in complete sentences. Technical evidence remains inspectable; shorter presentation does not reduce the accepted evidence record or change approval rules.

When suggestions or saved results exist, they appear ahead of setup instructions. Current setup is a compact status with **Change settings**, which requests inspection only. Selecting a task shows its explanation once and moves keyboard focus to its heading. **Browse suggested tasks** or **Browse saved check results** returns to the list without discarding the selection. History and routine coverage remain secondary. Errors keep an explicit recovery action near the top; unknown saves never retry automatically.

## Commands and ownership

Programmatic setup starts with a bounded, read-only assessment of project needs and workflows, alongside exact host-generated scanner settings. It does not require a recognized framework, manifest or available specialist, and never turns repository scripts or instructions into executable scanners.

Both `/setup-programmatic` and `/programmatic` are built-in, code-mode workflows, not general chat prompts or shell launchers. Slash discovery advertises `/setup-programmatic` first and withholds `/programmatic` until saved setup is approved and current. Direct calls without current setup return setup or repair guidance rather than starting the model. `/programmatic-run` is an internal selection/approval path, not an advertised executable command.

`/programmatic` accepts optional advisory focus, for example `/programmatic check packaging risks`. Focus is trimmed, limited to 4,000 characters, and accepts multiline or non-ASCII text but not prohibited control characters or attachments. Empty focus requests a general assessment. Supplied focus must be nonempty after trimming; only normal whitespace controls are allowed. Focus is untrusted advisory context: it does not filter the deterministic scan, change settings or identity, select opportunities or approve execution.

The desktop **Opportunities** view also exposes discovery without configuring checks first. **Find tasks to automate** uses setup-mode assessment when configuration is not current, and configured assessment when it is current. This does not remove the separate slash/scanner readiness gate. Non-code sessions cannot use this workflow; plan mode allows viewing existing results and details, not provider-backed review, writes or task execution.

## Discover and review candidates

**Find tasks to automate** asks the selected provider to inspect repeatable needs; it does not create or run automation. **Suggested tasks** distinguishes an existing command, changes to a command, new automation, manual work and missing evidence. **Review this task** prepares read-only review; when evidence is missing, it performs scoped inspection of that evidence using current permissions. Commands that are unavailable or need their availability checked again instead offer **Reinspect command (read-only)**. Manual suggestions have no review button. Stale current suggestions offer **Check again**, an explicit fresh discovery request, not an automatic retry.

Select a task to see its explanation, uncertainty, scope, proposed changes, risks and relevant requirements. Missing recorded risks do not establish safety. Material consequences stay outside **Details**; workflow examples, evidence, alternatives, expected output and success checks are secondary. Proposed changes describe the suggestion, not permission. Review is read-only preparation, not creation, editing or execution. These later operations use the [capability extension workflow](programmatic-capability-extension.md).

Previous, historical, pending or uncertain evidence is not current review authority. Selection and response guards reject stale assessment/revision/owner responses. Discovery completion that cannot be confirmed does not retry work; once idle, the user may explicitly discover again. A completed empty result explains that no tasks were suggested from the information checked and that this was not a complete project check. Missing typed detail is not an empty-result verdict.

**Browse recommendation history** exposes **Load history**, **Previous history**, **Next history**, saved candidate selection and, for linked records, **View earlier candidate**. It displays recorded decisions and retained observations, not transferable approval. Historical candidates require fresh discovery before actionable review. Decision/correspondence inspect/apply APIs remain host interfaces, not visible decision buttons; [history lifecycle](programmatic-recommendation-lifecycle.md) owns their consent and retention rules.

Control/source check: labels and review requests were checked against `gg-app/src/ProgrammaticDiscovery.tsx`; current-response guards against `gg-app/src/programmatic-discovery-state.ts`; request forwarding against `packages/ggcoder/src/app-sidecar-programmatic-chat.ts`; and scoped read-only review against `packages/ggcoder/src/core/agent-session.ts` and `packages/ggcoder/src/core/programmatic/discovery-projection.ts`. The request retains `review-candidate`, `review-only`, `source: "current"`, the exact assessment/candidate identifiers and expected revision defined in `packages/gg-core/src/programmatic-discovery-contract.ts` (re-exported by `programmatic-recommendation-contract.ts`). This is a source check, not a native UI run.

## Review, save, scan, select, approve

The model-facing setup tool requires a separate host question before saving a session-owned inspected proposal. Approval is single-use and bound to exact configuration, profile, prior-file digest, session and project; these are revalidated before commit. Cancellation, reset, replay and owner/configuration drift invalidate it. `/setup-programmatic` is capability-restricted to inspection for the entire initial invocation, even if the model ignores the prompt. Generation requires a later invocation and host review. Hosts without an appropriate question transport, including the terminal tool registry, return `unsupported-host` without saving. The native **Approve and save setup** workflow remains separate. Neither setup route approves command execution.

1. **Review setup** uses the same current-session assessment owner as `/setup-programmatic`: bounded project/workflow evidence and command matching, plus a separately host-inspected exact declarative profile, fingerprint, routes, exclusions and configuration changes. Initial setup writes nothing, runs no scanner and dispatches no specialist. An empty scanner profile is valid: it means no enabled deterministic checks, not no useful work.
2. **Approve and save setup** saves the reviewed profile. A configuration fingerprint and prior-file digest guard against concurrent changes; neither digest is user approval. A stale proposal must be inspected and approved again.
3. **Run project checks** uses the same current-session assessment owner as `/programmatic [focus]`. Before provider entry, the host attempts exactly one unchanged `programmatic_scan({})` when permitted; the model must not repeat it. Needs assessment is independent of enabled scanner count or specialist availability. Only the deterministic scan reconciles scanner results; an unchanged scan leaves scanner lifecycle bytes unchanged. Advice does not start tasks.
4. Select one deterministic result to inspect evidence, route, risks and success condition. Selection and **Refresh results** are reads, not execution permission. **Dismiss this item** records a snapshot-guarded soft dismissal.
5. **Review task approval** asks separately before an isolated specialist starts. It names whether the task is read-only or may mutate. A mutating specialist's scope is task context, not a filesystem sandbox: later tool actions and plans require their own approval.
6. Review the result and explicitly rescan when appropriate. Rescans retain terminal history and stable opportunity identity rather than rerunning completed work.

Execution uses a transient child session with the selected provider/model and necessary project context, not the parent's conversation. It does not persist a child transcript. Research lacks write, edit, shell, installation, corpus-addition and MCP capabilities. This does not mean no network access: allowlisted read-only web/corpus tools may be available. Completion must match the selected success condition and cite observed successful tool calls; that is attributed specialist evidence, not independent host certification. Failure, cancellation, deadline and cleanup outcomes remain distinct.

## Configuration drift and legacy setup

GG compares the saved configuration baseline with current configuration inputs and policy. Manifest/configuration changes can require setup refresh; ordinary source or lifecycle changes do not by themselves require a new profile.

When configuration drifts, inspection shows exact added, removed and modified inputs and policy/schema/exclusion changes. Old results remain inspectable, but task execution and scanning are blocked until required setup approval is current. **Review setup refresh** does not write. **Approve and save refresh** changes the profile only; it does not scan or reset lifecycle records. A subsequent **Run project checks** reconciles the new configuration while preserving identity and terminal history.

A current setup needs no regeneration. **Change settings** opens a new read-only inspection; saving remains a separate explicit approval. A supported legacy profile can require explicit upgrade approval. Legacy data without a per-file baseline cannot explain historical file-level differences: GG reports that limitation rather than inventing changes. Unreadable or unsupported setup is not permission to overwrite it. History opt-in/legacy envelope upgrades have their authoritative rules in [Consent and compatibility](programmatic-recommendation-lifecycle.md#consent-and-compatibility).

## Recovery and interrupted ownership

Use **Refresh results** (or **Retry loading results** after an error) to inspect saved scanner data without repairing it. If the primary lifecycle file is invalid and a previous validated snapshot exists, the report can show older saved results. Reads preserve both files byte-for-byte. **Run project checks** explicitly reconciles and writes a valid primary when the current profile and ownership checks permit it; invalid primary bytes must not replace the valid previous snapshot.

If no validated state is available, stop and preserve files and diagnostics. There is no automatic destructive reset or guarantee that lost history can be reconstructed. Do not delete lifecycle files to clear a warning.

Reloading the application or a module does not prove an interrupted specialist has stopped. Persisted active ownership continues to block conflicting actions. GG does not silently clear a running owner on restart, and inspection/recovery controls are not a force-unlock API. Preserve diagnostic evidence when ownership cannot be settled normally. Recovery from corrupt scanner lifecycle state is distinct from daemon restart, Roadmap notification recovery and [recommendation history recovery](programmatic-recommendation-lifecycle.md#recovery-boundary).

## Presentation verification scope

The September 2026 clear-language pass was checked with focused backend/UI tests, a real AgentPane integration test fixture, TypeScript checks, the web build, and synthetic component previews at desktop, 390px and 320px widths. Tests cover explicit action mapping, selection/focus, disclosure, stale recovery and unknown saves. The previews do not exercise native IPC or live provider transactions. Density measurement was unavailable without configuration; canonical state/affordance heuristics retained warnings that were investigated with source and keyboard checks. Full assistive-technology conformance and comprehension by representative users remain unverified.

The identical advisory-rendering fixture decreased from 1,247 to 518 UTF-16 code units (1,251 to 522 UTF-8 bytes), without changing its accepted data. This measures rendered output only, not provider-token or cost savings.
