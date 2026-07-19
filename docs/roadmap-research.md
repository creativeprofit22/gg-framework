# Roadmap and Notes Research

Research date: 2026-07-19

Status: research only; no product code was changed.

This document records the evidence and product direction discussed for extending GG Coder's existing Notes feature. It does not replace or modify the repository's existing [`roadmap.md`](../roadmap.md).

## Scope

The proposed feature has four connected jobs:

1. Act on a prompt recommended by Ken in the current session or a fresh session.
2. Save a recommended prompt into Notes for later.
3. Add a lightweight roadmap to Notes without replacing the existing Notes sections.
4. Let GG Coder and Ken update roadmap progress automatically while preserving manual control.

The research focused on current repositories and real source files for:

- compact notes, roadmap, and linked-reference UI;
- agent-maintained task status;
- plan approval and execution lifecycles;
- session-to-work-item links;
- prompt saving and fresh-session creation;
- context-efficient reference injection;
- reminders and native desktop notifications.

## Current GG Coder baseline

Verified locally before the external research:

- Notes currently contains **Now**, **Next**, **Handoff**, **Reference**, and **Done / Archive**.
- Roadmap is an addition; none of those sections should be replaced.
- Notes currently persists a versioned document in webview storage through `gg-app/src/useProjectNotes.ts` and `gg-app/src/notes-storage.ts`.
- Ken prompt blocks already expose **Send to GG Coder** through `gg-app/src/Markdown.tsx`.
- A fresh project session already exists through `PaneAgentClient.newSession()` and the app's confirmed new-session flow.
- `roadmap.md` remains untouched and is not the proposed storage surface for this feature.

---

# Verified evidence

The entries below describe observed source code only. Recommendations derived from them are kept in a separate section.

## Evidence register

### 1. Plane: compact roadmap rows, progress, peek details, and snooze

- **Repository:** `makeplane/plane`
- **License:** AGPL-3.0-only
- **Source:** [`apps/web/core/components/modules/module-list-item.tsx`](https://github.com/makeplane/plane/blob/7cef741c29cf61d3bca18dc892e6af11a1e7becc/apps/web/core/components/modules/module-list-item.tsx)
- **Anchor:** `ModuleListItem`, `CircularProgressIndicator`, `openModuleOverview`
- **Observed:** A module stays a compact list row; progress is visible before opening it, and secondary information opens in a peek view instead of expanding every row.
- **Why it matters:** This is a strong model for keeping roadmap phases scannable without forcing a long modal scroll.

Additional evidence:

- **Source:** [`packages/types/src/inbox.ts`](https://github.com/makeplane/plane/blob/7cef741c29cf61d3bca18dc892e6af11a1e7becc/packages/types/src/inbox.ts)
- **Anchor:** `EInboxIssueStatus`, `snoozed_till`
- **Observed:** Inbox items distinguish pending, snoozed, accepted, declined, and duplicate states, with a persisted snooze time.
- **Why it matters:** A reminder is better represented as explicit state and time, rather than repeatedly notifying for every unfinished phase.

### 2. Outline: small reference tabs that disappear when empty

- **Repository:** `outline/outline`
- **License:** Business Source License 1.1; the checked repository license lists a 2030-07-13 change date to Apache-2.0.
- **Source:** [`app/scenes/Document/components/References.tsx`](https://github.com/outline/outline/blob/d57db81c6bb95db721141df61b465a3d1524596c/app/scenes/Document/components/References.tsx)
- **Anchor:** `References`, `showBacklinks`, `showChildDocuments`, `Tabs`
- **Observed:** Child documents and backlinks share a small tabbed surface; empty groups are not rendered, and the remaining group becomes active automatically.
- **Why it matters:** Notes tabs and counts can stay quiet when a project has no roadmap phases, references, or archived items.

### 3. AFFiNE: references remain linked and load only when opened

- **Repository:** `toeverything/AFFiNE`
- **License:** Mixed repository license; the root license states that content outside named backend/native restrictions is MIT, while named directories and third-party components may have separate terms. The cited path is outside the named backend/native carve-outs.
- **Source:** [`blocksuite/affine/blocks/embed-doc/src/embed-linked-doc-block/embed-linked-doc-block.ts`](https://github.com/toeverything/AFFiNE/blob/81df4751a367f2795bc0d165586650dbe8db73d6/blocksuite/affine/blocks/embed-doc/src/embed-linked-doc-block/embed-linked-doc-block.ts)
- **Anchor:** `EmbedLinkedDocBlockComponent`, `_load`, `Peekable`, `renderLinkedDocInCard`
- **Observed:** A linked document keeps its identity and display metadata, supports peek navigation, and avoids loading the full linked document for citation-only cases.
- **Why it matters:** A roadmap row can show reference identity and metadata without injecting or rendering the full reference body.

### 4. Logseq: grouped linked references with include/exclude controls

- **Repository:** `logseq/logseq`
- **License:** AGPL-3.0
- **Source:** [`deps/db/src/logseq/db/common/reference.cljs`](https://github.com/logseq/logseq/blob/a4963dca579f42817135d8473166a03fa7ea2409/deps/db/src/logseq/db/common/reference.cljs)
- **Anchor:** `get-filters`, `get-linked-references`, `linked-references/includes`, `linked-references/excludes`
- **Observed:** Linked references are first-class relations; callers can include or exclude sources, and reference results preserve source grouping and counts.
- **Why it matters:** Shared project references can be reused across phases while each phase selects only the references that belong in its execution context.

Additional presentation evidence:

- **Source:** [`deps/publish/src/logseq/publish/render.cljs`](https://github.com/logseq/logseq/blob/a4963dca579f42817135d8473166a03fa7ea2409/deps/publish/src/logseq/publish/render.cljs)
- **Anchor:** `linked-references`, `linked-by-page`
- **Observed:** Linked references are grouped by source page rather than flattened into an anonymous list.
- **Why it matters:** GitHub references should retain repository ownership and source identity.

### 5. Continue: typed context items separate identity from content

- **Repository:** `continuedev/continue`
- **License:** Apache-2.0
- **Source:** [`core/index.d.ts`](https://github.com/continuedev/continue/blob/d0a3c0b626b5bebc3bef4742eec05a0242be0bab/core/index.d.ts)
- **Anchor:** `ContextItemId`, `ContextItemUri`, `ContextItem`, `ContextItemWithId`
- **Observed:** Context items have stable provider/item IDs, display metadata, optional file or URL identity, content, visibility, and status.
- **Why it matters:** A saved reference should not be only a pasted text blob; identity and retrieval metadata must survive independently from fetched content.

Additional UI evidence:

- **Source:** [`gui/src/components/mainInput/belowMainInput/ContextItemsPeek.tsx`](https://github.com/continuedev/continue/blob/d0a3c0b626b5bebc3bef4742eec05a0242be0bab/gui/src/components/mainInput/belowMainInput/ContextItemsPeek.tsx)
- **Anchor:** `ContextItemsPeek`, `ContextItemsPeekItem`, `openContextItem`
- **Observed:** Context items are shown as compact rows, hidden items are filtered out, URLs open externally, and files open at their source.
- **Why it matters:** Roadmap references can appear as compact chips or rows with direct open/inspect behavior.

### 6. Agentlog: GitHub context is typed and validated

- **Repository:** `imran31415/agentlog`
- **License:** No repository license was detected by GitHub's license endpoint during this review; treat the source as evidence only and do not copy it.
- **Source:** [`internal/types/task.go`](https://github.com/imran31415/agentlog/blob/68970960a32fda3dbe83b42c0f6c66c82f66ae80/internal/types/task.go)
- **Anchor:** `ContextSourceType`, `ContextSource`, `GitHubContext`, `TaskCreateRequest`
- **Observed:** A task can carry typed context sources; GitHub context stores owner, repository, issue number, PR number, and branch separately.
- **Why it matters:** Ken MCP results should be saved as structured GitHub references, not as unstructured output that the agent must reinterpret later.

Additional validation evidence:

- **Source:** [`internal/tasks/context.go`](https://github.com/imran31415/agentlog/blob/68970960a32fda3dbe83b42c0f6c66c82f66ae80/internal/tasks/context.go)
- **Anchor:** `ValidateContextSource`, `ValidateAllContextSources`, `ParseContextSourceData`
- **Observed:** Each context-source type has required fields and rejects malformed or unknown data.
- **Why it matters:** Invalid or incomplete repository references should be caught when saved, not discovered after starting a phase.

### 7. Cognia: inject a compact active plan, not the entire planning store

- **Repository:** `MaxQian888/cognia-next`
- **License:** AGPL-3.0
- **Source:** [`lib/agent/plan/prompts.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/lib/agent/plan/prompts.ts)
- **Anchor:** `renderPlanSystemSection`, `renderStepLine`, `PLAN_SECTION_MARKER`
- **Observed:** The active plan is rendered as a compact ordered checklist plus one current-step callout; the plan is explicitly framed as working data rather than higher-priority instructions.
- **Why it matters:** GG Coder can keep the selected roadmap phase present without allowing a large roadmap or reference library to dominate context.

Additional injection evidence:

- **Source:** [`lib/agent/plan/context-injector.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/lib/agent/plan/context-injector.ts)
- **Anchor:** `appendPlanContext`
- **Observed:** Plan context is appended only while the plan is executing and leaves unrelated sends unchanged.
- **Why it matters:** Roadmap context should be scoped to the linked phase session, not injected into every project conversation.

Additional persistence evidence:

- **Source:** [`lib/db/plans.ts`](https://github.com/MaxQian888/cognia-next/blob/43abbe2cf1efddb9973489b8fb6aad33a110fc12/lib/db/plans.ts)
- **Anchor:** `OPEN_PLAN_STATUSES`, session-scoped open-plan invariant, append-only events
- **Observed:** At most one open plan is allowed per session, and lifecycle events are append-only with a per-plan cap.
- **Why it matters:** One roadmap phase should have one authoritative active session and an auditable status history.

### 8. n8n: the agent owns structured progress updates

- **Repository:** `n8n-io/n8n`
- **License:** Sustainable Use License 1.0 for the cited non-`.ee` source; the repository has separate enterprise terms for named `.ee` paths.
- **Source:** [`packages/@n8n/agents/src/runtime/tools/write-todos-tool.ts`](https://github.com/n8n-io/n8n/blob/d5d3da67c1447606a74645dcd35cbfd4d5ae45b0/packages/%40n8n/agents/src/runtime/tools/write-todos-tool.ts)
- **Anchor:** `WRITE_TODOS_TOOL_NAME`, `todoStatusSchema`, `buildWriteTodosSystemInstruction`
- **Observed:** The agent receives a dedicated structured status tool with pending, in-progress, completed, blocked, and cancelled states; instructions require immediate updates rather than batching all completion changes at the end.
- **Why it matters:** Roadmap state should be updated by an explicit agent capability during work, not inferred only from the final prose response.

Additional UI evidence:

- **Source:** [`packages/frontend/editor-ui/src/features/agents/utils/write-todos-tool.ts`](https://github.com/n8n-io/n8n/blob/d5d3da67c1447606a74645dcd35cbfd4d5ae45b0/packages/frontend/editor-ui/src/features/agents/utils/write-todos-tool.ts)
- **Anchor:** `STATUS_ORDER`, `parseWriteTodosOutput`, `formatWriteTodosMarkdown`
- **Observed:** Active work is ordered before pending, completed, blocked, and cancelled work, while details are placed in an expandable panel.
- **Why it matters:** The Notes overview should surface active or blocked phases first and keep settled detail collapsed.

### 9. Feynman: completion can be derived from verified step state

- **Repository:** `companion-inc/feynman`
- **License:** MIT
- **Source:** [`src/workbench/plan.ts`](https://github.com/companion-inc/feynman/blob/54d08a33dfe17abca118c093ad7f2c6b1a41421a/src/workbench/plan.ts)
- **Anchor:** `planStatusForSteps`, `approveGeneratedPlan`, plan step updates
- **Observed:** A plan becomes complete when every step is complete, running when any step has started, and approved after leaving the approval gate.
- **Why it matters:** Programmatic phase status can follow the real plan lifecycle instead of asking the user to mark each phase manually.

### 10. Gemini CLI: waiting for approval is an explicit runtime event

- **Repository:** `google-gemini/gemini-cli`
- **License:** Apache-2.0
- **Source:** [`packages/core/src/scheduler/types.ts`](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/scheduler/types.ts)
- **Anchor:** `CoreToolCallStatus.AwaitingApproval`
- **Observed:** Awaiting approval is distinct from validating, scheduled, executing, success, error, and cancelled.
- **Why it matters:** **Waiting for approval** should not be shown as **In progress** or guessed from elapsed time.

Additional event evidence:

- **Source:** [`packages/a2a-server/src/agent/task.ts`](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/a2a-server/src/agent/task.ts)
- **Anchor:** `CoderAgentEvent.ToolCallConfirmationEvent`, `pendingToolConfirmationDetails`
- **Observed:** Approval requests publish a distinct event and retain confirmation details for the owning call.
- **Why it matters:** GG Coder already has event-driven session plumbing; phase state should subscribe to authoritative events rather than poll UI text.

### 11. Kanban Code: work items retain session, prompt, repo, and manual-override links

- **Repository:** `langwatch/kanban-code`
- **License:** AGPL-3.0
- **Source:** [`Sources/KanbanCodeCore/Domain/Entities/Link.swift`](https://github.com/langwatch/kanban-code/blob/1927029fcc044c170fcfa139035baf10e7afd7bf/Sources/KanbanCodeCore/Domain/Entities/Link.swift)
- **Anchor:** `SessionLink`, `promptBody`, `sessionLink`, `worktreeLink`, `prLinks`, `issueLink`, `discoveredRepos`, `manualOverrides`
- **Observed:** A card stores its prompt independently while linking to a session, worktree, issue, pull requests, browser tabs, discovered repositories, and explicit manual overrides.
- **Why it matters:** A roadmap phase can start as a saved prompt, then become a resumable session without losing its references or user corrections.

Additional reconciliation evidence:

- **Source:** [`specs/sessions/linking.feature`](https://github.com/langwatch/kanban-code/blob/1927029fcc044c170fcfa139035baf10e7afd7bf/specs/sessions/linking.feature)
- **Anchor:** `Manual Override`, `reconciler should not overwrite`, concurrent reconcile guard
- **Observed:** Manually changed links are protected from later automatic reconciliation; concurrent reconciliation is rejected to prevent duplicate cards.
- **Why it matters:** Automatic phase updates must preserve manual status/reference changes and prevent duplicate session launches.

Additional multi-repository evidence:

- **Source:** [`Sources/KanbanCodeCore/UseCases/BoardStore.swift`](https://github.com/langwatch/kanban-code/blob/1927029fcc044c170fcfa139035baf10e7afd7bf/Sources/KanbanCodeCore/UseCases/BoardStore.swift)
- **Anchor:** `discoveredRepos`, branch discovery, repository grouping
- **Observed:** Discovered branches retain the repository they came from, including repositories different from the card's primary project.
- **Why it matters:** A phase may cite several Ken MCP repositories; each reference must keep its own repository identity.

### 12. Cherry Studio: create and activate a fresh chat safely

- **Repository:** `CherryHQ/cherry-studio`
- **License:** AGPL-3.0
- **Source:** [`src/renderer/pages/home/HomePage.tsx`](https://github.com/CherryHQ/cherry-studio/blob/61ac59406c76b577f07c18bacf3a330cbb67284c/src/renderer/pages/home/HomePage.tsx)
- **Anchor:** `createAndActivateEmptyTopic`, `createAndActivateFreshTopic`, `isCreatingTopicRef`, `findReusableEmptyTopic`
- **Observed:** Topic creation has a re-entry lock, distinguishes truly fresh creation from safe empty-placeholder reuse, activates the new topic before continuing, and handles creation failure without leaving a deleted or stale topic active.
- **Why it matters:** **New session + send** must be one guarded flow so double clicks cannot create duplicate roadmap sessions or send into the old context.

Additional action-boundary evidence:

- **Source:** [`src/renderer/components/composer/variants/shared/composerProviderActions.ts`](https://github.com/CherryHQ/cherry-studio/blob/61ac59406c76b577f07c18bacf3a330cbb67284c/src/renderer/components/composer/variants/shared/composerProviderActions.ts)
- **Anchor:** `ProviderActionHandlers`, `addNewTopic`, `replaceDraft`
- **Observed:** Composer actions are exposed through a shared typed action surface rather than coupling the composer to page implementation.
- **Why it matters:** Ken's prompt block should request **send**, **fresh send**, or **save** through app-level actions rather than directly managing session state.

### 13. Phoenix: agent-proposed saves can support manual and automatic acceptance

- **Repository:** `Arize-ai/phoenix`
- **License:** Elastic License 2.0
- **Source:** [`app/src/agent/tools/playgroundSavePrompt/clientActions.ts`](https://github.com/Arize-ai/phoenix/blob/30fc981982eb0a192076addc57aec5f01da66c75/app/src/agent/tools/playgroundSavePrompt/clientActions.ts)
- **Anchor:** `createSavePromptClientAction`, `PendingSavePrompt`, `shouldAutoAccept`, `getSavePromptPreview`
- **Observed:** An agent save request is parsed and previewed, remains tied to its tool call and session, and can either wait for user acceptance or auto-accept under policy.
- **Why it matters:** Ken can propose adding a prompt or reference to Notes while manual mode preserves user confirmation and Autopilot can save automatically.

### 14. Claude Command Center: use explicit attention signals, not age heuristics

- **Repository:** `amirfish1/claude-command-center`
- **License:** MIT
- **Source:** [`hooks/notification.py`](https://github.com/amirfish1/claude-command-center/blob/32468899b1f1f1065af7b24e6d85ca1e8775e02e/hooks/notification.py)
- **Anchor:** notification hook, needs-approval marker, PostToolUse clearing
- **Observed:** A dedicated notification event writes a needs-approval marker; a later tool event clears it. The source explicitly replaced a brittle pending-tool/age heuristic.
- **Why it matters:** **Needs attention** must be driven by actual approval, question, error, or cancellation events rather than by a timer guessing that an agent is stuck.

Additional display evidence:

- **Source:** [`static/coo-board.html`](https://github.com/amirfish1/claude-command-center/blob/32468899b1f1f1065af7b24e6d85ca1e8775e02e/static/coo-board.html)
- **Anchor:** `blockReason`
- **Observed:** The UI derives a short, current reason from approval messages, user questions, soft blocks, and next-step data.
- **Why it matters:** A roadmap row should say why it needs attention, not only show a red status.

### 15. Worklenz: separate project views and let users hide secondary fields

- **Repository:** `Worklenz/worklenz`
- **License:** AGPL-3.0
- **Source:** [`worklenz-frontend/src/lib/project/project-view-constants.ts`](https://github.com/Worklenz/worklenz/blob/7c808e5fc79bb75396b409a20bc7f71b721d97e1/worklenz-frontend/src/lib/project/project-view-constants.ts)
- **Anchor:** `tabItems`, task list, board, files, updates, roadmap
- **Observed:** Project concerns are split into views rather than stacked into one long page.
- **Why it matters:** Notes should stop presenting every section in one scrolling column.

Additional density evidence:

- **Source:** [`worklenz-frontend/src/features/task-management/taskListFields.slice.ts`](https://github.com/Worklenz/worklenz/blob/7c808e5fc79bb75396b409a20bc7f71b721d97e1/worklenz-frontend/src/features/task-management/taskListFields.slice.ts)
- **Anchor:** `DEFAULT_FIELDS`, `visible`, `toggleField`
- **Observed:** Secondary columns default to hidden and field visibility is persisted per project.
- **Why it matters:** Phase rows should expose only title, status, references count, and primary action until opened.

### 16. Huly: milestones remain separate from issues and use a small lifecycle

- **Repository:** `hcengineering/platform`
- **License:** EPL-2.0
- **Source:** [`plugins/tracker/src/index.ts`](https://github.com/hcengineering/platform/blob/4c5d2d578e3aceb380db511e4b73848af4f14937/plugins/tracker/src/index.ts)
- **Anchor:** `MilestoneStatus`, `Milestone`, issue `milestone` relation
- **Observed:** Milestones have their own title, description, status, dates, comments, and attachments; issues link to milestones rather than becoming milestones.
- **Why it matters:** Roadmap phases should be a new Notes entity, not a replacement or reinterpretation of existing Notes tasks.

### 17. Obsidian-DASH: reminder delivery is deduplicated

- **Repository:** `RayRayElite/Obsidian-DASH`
- **License:** Apache-2.0, verified from the repository's commit-pinned `LICENSE` file.
- **Source:** [`main.ts`](https://github.com/RayRayElite/Obsidian-DASH/blob/d7be3206edee3de53d4a89754c395f20fa707f43/main.ts)
- **Anchor:** `maybeWarnUpcomingCalendarEvents`, `warnedCalendarEventKeys`, `reminderAt`
- **Observed:** Reminder visibility is time-window based and each reminder occurrence is deduplicated with a stable event key.
- **Why it matters:** Reopening GG Coder should not replay the same reminder sound on every render or window refresh.

### 18. Stirling PDF: desktop notifications should be background-aware

- **Repository:** `Stirling-Tools/Stirling-PDF`
- **License:** Stirling PDF User License for the cited `frontend/editor/src/desktop/` path; it permits limited trial/evaluation use and restricts copying, distribution, and production use without a valid license, so this source is behavioral evidence only.
- **Source:** [`frontend/editor/src/desktop/services/desktopNotificationService.ts`](https://github.com/Stirling-Tools/Stirling-PDF/blob/8b179fbc55d7bb912c98bec5423ed268b042b9dc/frontend/editor/src/desktop/services/desktopNotificationService.ts)
- **Anchor:** background `canNotify` gate, `isPermissionGranted`, `requestPermission`
- **Observed:** Native notification delivery is skipped when the app is focused, then checks permission before sending.
- **Why it matters:** In-app badges should handle focused use; native notifications and sounds are for background or restart recovery.

### 19. Galcode Island: ask for notification permission only when needed

- **Repository:** `sjyinzju/Galcode_island`
- **License:** No license was reported by the code-search index during this review; use as behavioral evidence only.
- **Source:** [`src/hooks/useTaskCompletionNotifier.ts`](https://github.com/sjyinzju/Galcode_island/blob/03f7b3dc26f1b3fe38fe8c8131042bb6a007a6c4/src/hooks/useTaskCompletionNotifier.ts)
- **Anchor:** initial permission probe, cached `permissionPromiseRef`, lazy `requestPermission`
- **Observed:** The app probes notification capability without immediately prompting, requests permission only on the first real notification path, and caches the in-flight permission promise to avoid duplicate prompts.
- **Why it matters:** GG Coder should not interrupt startup with a permission dialog merely because a reminder feature exists.

### 20. VS Code: saving a useful response is a first-class chat action

- **Repository:** `microsoft/vscode`
- **License:** MIT
- **Source:** [`src/vs/workbench/contrib/chat/browser/promptSyntax/saveAsPromptFileActions.ts`](https://github.com/microsoft/vscode/blob/693614c9f239b49f6d13d55da7f1a851d5b82c36/src/vs/workbench/contrib/chat/browser/promptSyntax/saveAsPromptFileActions.ts)
- **Anchor:** `SAVE_AS_PROMPT_FILE_ACTION_ID`, `SaveAsPromptFileAction`
- **Observed:** Saving chat content as a reusable prompt is modeled as a named command/action rather than hidden inside copy/paste behavior.
- **Why it matters:** **Save to Notes** deserves an explicit prompt-block action even if it sits behind a compact secondary-actions control.

---

# Recommendations

These are product decisions derived from the verified evidence. They are not claims about the referenced products.

## 1. Product structure

Keep the existing Notes concepts and add Roadmap as a separate first-class section.

Recommended Notes navigation:

1. **Overview**
   - Now
   - Next
   - Handoff
   - compact counts for active roadmap phases and reminders
2. **Roadmap**
   - ordered phases
   - one-line collapsed rows
   - one selected phase shown in a detail pane
3. **Reference**
   - existing free-form reference notes
   - structured saved references from Ken MCP
4. **Archive**
   - existing archived Notes tasks
   - completed or archived roadmap phases

Recommended desktop composition:

- Make the Notes modal wider and nearly full-height.
- Keep the tab bar fixed.
- Scroll only the active tab's content.
- In Roadmap, use a list/detail layout rather than a Kanban board.
- Keep each collapsed phase row to:
  - phase title;
  - status;
  - linked-reference count;
  - reminder state when relevant;
  - one primary action: **Start**, **Resume**, or **Review**.
- Put editing, status override, archive, and reminder controls in the opened detail pane.
- Hide empty tabs or empty subsections where doing so does not make navigation jump unexpectedly.

Why this direction:

- It fixes the current excessive vertical scrolling.
- It preserves Now, Next, Handoff, Reference, and Archive.
- It keeps roadmap and references visibly connected without showing all reference bodies.
- It avoids importing the density and maintenance cost of a full project-management board.

## 2. Recommended roadmap phase model

A phase should be its own entity rather than an expanded Notes task.

Suggested conceptual fields:

- stable phase ID;
- title;
- short goal;
- completion criteria or **Done when**;
- ordered position;
- status;
- linked reference IDs;
- source prompt, when saved from Ken;
- linked session ID and session path;
- reminder time and last-delivered occurrence key;
- attention reason;
- timestamps for creation, update, start, completion, and archive;
- manual-override markers for fields changed by the user;
- append-only lifecycle events for diagnosis and recovery.

Existing Notes tasks remain unchanged and continue to serve the lightweight **Next** list.

## 3. Status model

Recommended user-facing states:

1. **Not started**
2. **Planning**
3. **Waiting for approval**
4. **In progress**
5. **Review**
6. **Done**
7. **Needs attention**
8. **Cancelled**

Recommended automatic transitions:

| Event | New status |
|---|---|
| User chooses **Start phase** | Planning |
| Plan is presented for manual approval | Waiting for approval |
| Autopilot approves, or the user accepts the plan | In progress |
| Implementation run completes and verification begins | Review |
| Agent verification passes and Ken/Autopilot returns an all-clear | Done |
| Agent asks a real question, approval is required, a provider/tool fails, or the session cannot continue | Needs attention |
| User cancels before completion | Cancelled, or Needs attention when resumable work remains |
| User resumes a blocked/cancelled phase | Planning, In progress, or Review according to the linked session's authoritative state |

Rules:

- Do not mark a phase done from a generic `run_end` event alone.
- Prefer explicit plan-step completion plus verification/review evidence.
- Store a short reason whenever entering **Needs attention**.
- Allow manual status changes at all times.
- A manual status or reference change wins over later background reconciliation until the user resets that override.
- Record automatic and manual transitions with source and timestamp.

## 4. Start phase means plan and implement

The primary button should be **Start phase**, not **Plan this phase**.

Expected flow:

1. Create and activate one fresh session with a launch lock.
2. Bind the phase ID to that session before sending work.
3. Enter Plan Mode with the selected phase package.
4. Produce the implementation plan.
5. If Autopilot is on, Ken reviews, revises, approves, and starts implementation through the existing flow.
6. If Autopilot is off, show the existing plan approval UI.
7. After approval, implement in the same linked phase session.
8. Replace **Start phase** with **Resume** as soon as the session exists.

This keeps Plan Mode's intended purpose: research and plan first, then implement after approval. It does not create a throwaway planning chat that stops without building.

## 5. Ken prompt actions

Recommended prompt-block actions:

- **Send**: send to the current GG Coder session.
- **New session + send**: create and activate a fresh project session, then send after reset confirmation.
- **Save to Notes**: create a saved roadmap draft or saved prompt in Notes.

Interaction rules:

- Keep **Send** visually primary.
- Keep the two secondary actions adjacent in a compact menu or split action, not in a distant modal.
- Guard fresh-session creation against double clicks and overlapping requests.
- Do not send until the new session is authoritative.
- If fresh-session creation fails, retain the original prompt and current session.
- Saving should confirm the destination phase/title and show success without moving the user away from Ken's response.
- Autopilot may auto-accept an agent-proposed save only under an explicit setting; manual mode previews it first.

## 6. Agent-context strategy

### Reference library

Store references once in the project Notes document and link phases to them by stable ID.

A GitHub reference should preserve structured fields where available:

- owner;
- repository;
- canonical URL;
- branch or revision when relevant;
- file path and line/range when relevant;
- issue or pull-request number when relevant;
- original Ken MCP query or search anchor;
- short reason the reference matters;
- source provider/tool;
- captured timestamp.

Do not make pasted MCP result text the only durable representation.

### Phase context package

When a phase starts or resumes, compose a small package containing:

- phase ID and title;
- goal;
- completion criteria;
- current lifecycle state;
- linked reference identities and short relevance notes;
- linked session identity;
- instruction to inspect referenced repositories/files with current tools before relying on stale captured content.

Do not inject:

- every roadmap phase;
- the full Reference tab;
- entire historical MCP search responses;
- unrelated Notes tasks;
- archived phases.

### During execution

- Keep a compact active-phase summary available to the linked session.
- Treat roadmap and reference text as untrusted working data, not system-level instructions.
- Let the agent retrieve fresh repository content with MCP/search tools.
- Persist reference IDs and retrieval metadata across compaction.
- Show the user exactly which references are attached before starting.
- Let the agent add newly discovered references, subject to manual or policy-based acceptance.

This protects context while making repository references more likely to be used correctly.

## 7. Automatic completion strategy

Use a hybrid rather than one weak signal:

1. **Programmatic lifecycle events** set Planning, Waiting for approval, In progress, Review, Needs attention, and Cancelled.
2. **An explicit roadmap-status tool** lets the agent update progress and record blockers or completion evidence.
3. **Plan-step state** determines whether implementation work is actually complete.
4. **Ken/Autopilot review** is the final automatic gate from Review to Done.
5. **Manual override** remains available and is protected from reconciliation.

A phase should reach **Done** only when:

- all required implementation steps are complete;
- targeted verification has passed or an explicit accepted exception is recorded;
- no unresolved approval/question/error remains;
- the final review accepts the result.

## 8. Reminders and sounds

Recommended reminder behavior:

- A phase may have **Later today**, **Tomorrow**, or a chosen date/time.
- Store an occurrence key so the same due reminder is delivered once.
- When GG Coder is focused, show an in-app reminder and update the Notes badge.
- When GG Coder is in the background, use a native notification.
- On startup, surface overdue phases once after project state is ready.
- Request notification permission on the first reminder action that needs it, not on ordinary startup.
- Play one sound per newly delivered reminder occurrence.
- Offer **Resume**, **Snooze**, and **Dismiss reminder**.
- Dismissing a reminder does not mark the phase done.
- Respect existing sound settings and reduced-interruption expectations.

## 9. Storage direction

Before expanding the current Notes schema, move authoritative Notes/roadmap persistence behind the app-sidecar boundary or another project-scoped durable store.

Reasons:

- Roadmap phases need stable session links and programmatic updates from agent-side events.
- Multiple windows must see one authoritative project state.
- Agent tools need controlled read/write access without scraping webview storage.
- Lifecycle reconciliation and reminders should not depend on one mounted React tree.
- Structured data should survive webview resets and future schema migrations.

The exact durable location remains an implementation decision. The product requirement is one authoritative project-scoped repository with versioned migration, not a second `roadmap.md` and not independent copies per window.

---

# Resolved design direction

Build a **compact Notes workspace with a list-and-detail Roadmap**, not a full Kanban board.

- Existing Notes content stays intact.
- Roadmap is additive.
- References live in a shared library and are linked to phases.
- A phase starts in one fresh, bound session.
- Plan Mode proceeds into implementation after approval.
- The agent and event system maintain status automatically.
- Ken/Autopilot review gates automatic completion.
- Manual edits always remain possible and protected.
- Only the active phase and its linked reference metadata enter agent context.

---

# Research process and saturation log

## Source discovery

Used `mcp__kencode-search__referenceSources` for:

- product UI;
- real application screens;
- documents;
- coding agents;
- tool use;
- multi-agent systems;
- observability;
- content/documentation systems.

Used `mcp__kencode-search__discoverRepos` with varied terms including:

- `Claude Code kanban`;
- `coding agent kanban sessions task board`;
- `notion alternative`;
- `open source project management roadmap issue tracker`;
- `open source linked notes knowledge base desktop`;
- `AI chat desktop prompt library notes task`.

The discovered set included large and small current projects, coding-agent dashboards, project-management systems, knowledge tools, and localized repositories beyond the obvious high-star results.

## Literal code searches

High-value anchors included:

- `ModuleListItem`;
- `linked-references`;
- `LinkedDoc`;
- `ContextItem`;
- `ContextSource`;
- `renderPlanSystemSection`;
- `write_todos`;
- `in_progress`;
- `awaiting_approval`;
- `SessionLink`;
- `manualOverrides`;
- `discoveredRepos`;
- `newTopic`;
- `savePrompt`;
- `reminderAt`;
- `isPermissionGranted()`;
- `needs_attention`;
- `pending_tool`.

Pagination performed:

- `savePrompt`: offsets 0, 40, 80, and 120;
- `in_progress`: offsets 0, 40, and 80;
- `awaiting_approval`: offsets 0 and 40;
- targeted repository searches used additional file and path anchors.

## Saturation result

The pass stopped after diversified later pages mainly returned:

- duplicate status enums;
- generic persistence wrappers;
- unrelated job/upload/payment states;
- tutorial prompt managers;
- forks or clones of older chat projects;
- component galleries without real product behavior;
- full enterprise tables and boards that were less suitable than the compact list/detail evidence;
- patterns already represented more strongly by Plane, Continue, n8n, Gemini CLI, Kanban Code, Cherry Studio, and the linked-reference tools above.

## Rejected or de-emphasized sources

- Generic component galleries: useful for styling fragments, weak for workflow or agent-state decisions.
- Payload, Strapi, Directus, and other CMS references: mature content systems, but too broad for this project-specific Notes workflow.
- Small localStorage-only prompt managers: persistence patterns were weaker than GG Coder's existing versioned Notes storage and sidecar architecture.
- Full Kanban clones: visually heavier than the requested Notes experience and likely to recreate the scrolling/density problem.
- Stale tutorials and archived repositories: excluded from recommendations.
- Repositories with unclear or missing licenses: retained only where they offered unique behavioral evidence, explicitly marked, and not recommended as code-copy sources.
- Stirling PDF's desktop notification source: retained as observed behavior but explicitly marked as covered by the restrictive path-specific Stirling PDF User License.

---

# Link and coverage review

Reviewed on 2026-07-19.

## Link checks

- Every evidence entry includes a repository, exact commit-pinned source-file URL, code anchor, license note, observed behavior, and relevance.
- Source URLs point to files rather than repository home pages.
- URLs use the commit hashes returned by the research index where available.
- The n8n scoped package path encodes `@` as `%40` for a valid GitHub URL.
- The existing [`roadmap.md`](../roadmap.md) is linked but was not edited.
- License uncertainty and path-specific licensing are called out rather than guessed.

## Coverage checks

| Requirement | Covered by |
|---|---|
| Roadmap is additive | Current GG Coder baseline; Huly entity separation |
| Reduce Notes scrolling | Plane, Outline, Worklenz, Continue |
| Keep roadmap tied to references | AFFiNE, Logseq, Continue, Agentlog, Kanban Code |
| Keep agent context small | Cognia, Continue, Logseq |
| Use GitHub references reliably | Agentlog, Kanban Code |
| Fresh session plus immediate send | Cherry Studio |
| Save Ken prompts | Phoenix, VS Code |
| Plan and then implement | Cognia, Feynman, Gemini CLI, GG Coder's existing Plan Mode |
| Automatic status updates | n8n, Feynman, Gemini CLI, Claude Command Center |
| Manual fallback wins | Kanban Code manual overrides |
| Prevent duplicate starts | Cherry Studio launch lock; Kanban Code reconciliation guard |
| Resume linked work | Kanban Code session links |
| Reliable Needs attention state | Gemini CLI, Claude Command Center |
| Reminders after restart | Plane snooze model, Obsidian-DASH occurrence deduplication |
| Native notification behavior | Stirling PDF, Galcode Island |
| Sound without repeated annoyance | occurrence-key recommendation derived from reminder deduplication |
| Preserve `roadmap.md` | Confirmed by repository diff review |

## Remaining unknowns for implementation planning

- Exact sidecar storage file/location and migration path from Notes v2.
- Whether a saved Ken prompt first enters a small Notes inbox or requires immediate phase selection.
- The exact event contract between a roadmap-status tool, plan events, and Autopilot review.
- Notification deep-link behavior across multiple Tauri windows.
- Reminder scheduling while the app is closed versus startup-only overdue delivery.
- Whether reference freshness should be shown as a timestamp or refreshed silently at phase start.

These are implementation-design questions, not gaps in the recommended product direction.
