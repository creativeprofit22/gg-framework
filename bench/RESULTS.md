# Bench Results — A/B/C/D (3 July 2026)

Live arms ran against **gpt-5.5 via real OAuth** (codex transport). Scripts in `bench/`,
Ink harness in `packages/ggcoder/.bench-render.mjs`. Note: gg-ai's OpenAI usage mapping
**subtracts** cached tokens from `inputTokens`, so `input` = billed uncached tokens.

## A — Eager vs deferred MCP tool injection  → WIN, implement

`bench/a-mcp-tools.mjs`. Eager = 15 builtin + 11 MCP tools (kencode-search + refero).
Deferred = builtin + one `tool_search` stub. 2 runs × 6 turns each arm.

Static (captured wire payload):

| arm | tools | tools bytes | ~tokens |
|---|---|---|---|
| eager | 26 | 47,638 | ~11,910 |
| deferred | 16 | 14,443 | ~3,611 |
| **delta** | | **−33,195 B** | **−8,299 tok/cold turn** |

Live (12 turns/arm):

| arm | total billed input tok | avg TTFT | cost per cache-miss turn |
|---|---|---|---|
| eager | 41,830 | 1,883ms | ~9,800 tok |
| deferred | 18,209 | 1,439ms | ~2,600 tok |

- **56% fewer billed input tokens**, **−24% TTFT**.
- Provider-side random full-misses happened in BOTH arms (~25% of turns) — with
  eager tools each miss re-bills the whole 9.7k prefix; deferred caps the blast
  radius at 3.8× less.
- Note: refero alone is ~8 tools of schema; every future MCP server makes eager worse.

## B — Streaming render flush interval (TUI)  → WIN, implement

`bench/b-render-cpu.mjs`. Real `AssistantMessage` + `TerminalSizeProvider` under Ink,
12s synthetic stream at ~800 chars/s, fresh process per arm.

| flush | CPU total | CPU % of core | renders | vs 16ms (current) |
|---|---|---|---|---|
| per-delta | 10,374ms | 86% | 455 | +26% |
| **16ms (current)** | 8,242ms | 69% | 448 | — |
| 50ms | 6,305ms | 53% | 236 | **−24%** |
| 100ms (Claude Code's pick) | 4,202ms | 35% | 120 | **−49%** |

- Matches Claude Code 2.1.191's reported ~37% cut.
- CPU scales with render count, not delta count — the Markdown re-render dominates.
- 100ms is imperceptible for streaming text; keep first-token immediate paint.
- gg-app webview uses rAF (~16ms) — same change applies to `useAgentEvents.flushChunks`.

## C — Partial output on mid-stream failure  → REAL GAP, implement

`bench/c-partial-loss.mjs`. Real `agentLoop` vs a local OpenAI-SSE mock that streams
750 chars then kills the socket; retry serves a distinguishable response.

| metric | value |
|---|---|
| partial preserved across retry | **NO — discarded, fully regenerated** |
| output chars paid twice | 750 (100% of pre-drop output) |
| wasted output tokens | ~188 per drop (scales with drop point — a drop at 10k chars wastes ~2.5k tok) |
| retry detection | 435ms (stream_stall) + 1,000ms backoff |

- The retry works (good), but everything streamed pre-drop is thrown away and
  re-billed at output-token prices. Claude Code 2.1.199 keeps the partial.
- Fix shape: on transport-failure retry, keep accumulated text/tool blocks as an
  assistant message + continuation instruction, instead of replaying the turn.

## D — Prefix-cache health + steering audit  → PASS, no bug; ship observability

`bench/d-cache-audit.mjs`. Real GG Coder system prompt (~7.9k tok). 3 arms × 2 runs × 6 turns.

| arm | warm hit% | avg TTFT (warm) | total billed input |
|---|---|---|---|
| control | 84.8% | 1,463ms | 29,279 |
| steering (wrapped msg at turn 4) | 94.1% | 1,615ms | 13,637 |
| volatile suffix (timestamp per turn) | 84.4% | 1,893ms | 29,677 |

- **Steering wrapper is cache-safe** — 93–95% hits immediately after injection.
  The OpenCode bug (steering reminder nuking prefix cache) does NOT exist here.
- **UNCACHED_MARKER date-suffix design validated**: even a per-turn timestamp at the
  END of the system prompt only cost the tail — prefix matching saved the rest.
- Residual issue is provider-side random full-misses (~1–2 per 6-turn run, both
  arms) — exactly why hit-rate observability in the UI is worth shipping.

## E — Model-switch prompt-cache cost (27 July 2026)  → NO measurable cache win

`bench/e-model-switch-cache.mjs`. Anthropic `claude-sonnet-5`, real GG Coder system
prompt (~4.7k tok cached prefix), 3 turns per arm with a model switch between turn 2
and turn 3. Arms differ only in WHERE the model-dependent async-orchestration block
lives: inside the `cache_control` block (`prefix-mutation`, the old composition) vs
after the `<!-- uncached -->` marker (`tail-only`, current).

| arm | cacheRead (turn after switch) | cacheWrite | fresh input |
|---|---|---|---|
| prefix-mutation | 4,671 | 262 | 2 |
| tail-only | 4,671 | 273 | 2 |

**cache-read delta: +0 tokens (0.0%).** The hypothesis was that mutating the cached
block on a model switch forces a full re-write. It does not: the old composition
appended the model-dependent block at the very END of the system prompt, and
Anthropic's prefix matching still served the unchanged head — the same effect bench D
found for the date suffix. Only the ~230-token tail is re-written either way.

- The composition change **still ships**: model-dependent content is now deterministically
  placed behind the cache marker instead of being spliced into `messages[0]` on every
  switch, and the switch itself is recorded as a durable marker plus a standalone
  trailing message (replayable on resume) rather than a silent prompt mutation.
- The justification is correctness and replayability, **not** token savings. Do not
  claim a cache win for it.

## F — Durable-memory prompt-tail cost (27 July 2026)  → bounded; default stays OFF

Per-turn cost of `buildMemoryPromptTail` at the default wake budget (12 lines / 2,000
chars), measured on a synthetic log of realistic notes. Tokens estimated at 3.5 chars/token.

| notes in log | tail chars | ≈ tokens/turn |
|---|---|---|
| 0 | 0 | 0 |
| 1 | 268 | 77 |
| 10 | 1,127 | 322 |
| 50 | 1,460 | 418 |
| 200 | 1,473 | 421 |
| 1,000 | 1,473 | **421** |

- **Cost plateaus at ~420 tokens/turn** and does not grow with the log — that is the
  whole point of decoupling the read budget from storage. A 1,000-note project costs
  the same per turn as a 200-note one.
- An empty log costs exactly 0, so the feature is free until a note is written.
- ~420 tokens/turn is real recurring spend (uncached, by design). **`memoryEnabled`
  ships defaulting to off**; flipping it is a product call that should be made against
  a real multi-session project, not this synthetic log.

## G — Does injected memory suppress verification? (27 July 2026)  → YES; keep default OFF

`bench/f-memory-staleness.mjs`. gpt-5.5, 5 trials/arm. The model is asked which test
runner the project uses and is given a `read` tool it may call to check. Arms differ
only in the injected memory tail.

| arm | verified (called a tool) | asserted the false fact |
|---|---|---|
| none — no memory | **5/5** | 0/5 |
| fresh — note is TRUE | 0/5 | 0/5 |
| stale — note is FALSE | 0/5 | **5/5** |
| stale + note ages shown | 0/5 | **5/5** |
| stale + "unverified, verify first" header | 0/5 | **5/5** |
| stale + ages + hedged header | 0/5 | **5/5** |
| fresh + ages + hedged header | 0/5 | 0/5 |

**Memory does not add a fact — it replaces the act of checking.** With no memory the
model investigated the repo 5/5 times. With *any* memory present it investigated 0/5
times, whether the note was true or false. The mechanism that makes memory useful is
the same one that makes it dangerous.

**Prompt-level mitigation does not work.** Neither showing each note's age, nor a
header explicitly stating the notes are unverified and may be outdated, nor both
together, restored verification even once or prevented a single false assertion.

Consequences:

- Notes that **cannot become false** are safe — historical events ("worked on X",
  "changed files Y"). Suppressing re-verification of a past event costs nothing.
  The compaction-written notes are already exactly this shape.
- Notes that **assert current state** ("the test runner is jest") decay silently and
  are then asserted with full confidence while suppressing the check that would have
  caught them. The free-form `memory note` action is what invites these.
- `memoryEnabled` **stays default off** pending a decision on whether to keep
  free-form notes at all (see Verdict).

### Harness bug found while running this

`bench/lib.mjs` listened for a `toolcall_end` event that gg-ai never emits (the real
event is `toolcall_done`, with `{id, name, args}` inline), so `toolCalls` was always
empty. The first run of this bench therefore reported "0 verifications" in *every*
arm, including the control — the finding above only appeared after the fix. Any
earlier bench conclusion that relied on counting tool calls should be re-checked.

## H — LIVE end-to-end journal test + redundancy audit (27 July 2026)

`bench/g-journal-live.mjs`. Real `AgentSession`, real credentials
(`anthropic/claude-sonnet-5`), scratch project: 5 real turns → real compaction →
inspect `.gg/memory.md` → **new session** → ask a question only the journal can answer.

| check | result |
|---|---|
| journal file created by a real compaction | **YES** |
| reached the new session's prompt | **YES** |
| placed in the uncached tail (cache-safe) | **YES** |
| new session answered from it | **YES** |

Three bugs this found that unit tests could not:

1. **The feature silently never fired.** Compaction keeps ~8K tokens of recent history
   verbatim and only summarizes what is older, so short conversations produce
   `compacted: false` and write nothing. The first two live attempts wrote no file at
   all. Only a genuinely long session exercises this path.
2. **Entries were raw markdown.** The compactor's summary is authored for a transcript
   (`### Primary Request and Intent`, lists, backticks, `<read-files>` blocks) and was
   being pasted verbatim into a one-line entry.
3. **Entries were badly redundant** — see below.

### Redundancy audit

Measured on the live output. Two sources of pure waste, both fixed:

| | before | after |
|---|---|---|
| written per compaction | 508 chars / 146 tok | **202 chars / 58 tok** (−60%) |
| recurring prompt tail (1 compaction) | — | 132 tok/turn |
| recurring prompt tail (13 compactions) | — | **282 tok/turn, plateaus** |
| empty journal | — | **0** |

- **Summary duplicated the request entry.** 64% of the `request` entry's words already
  appeared inside the summary blob. The compactor emits seven labelled sections; only
  `What Was Done` and `Errors and Fixes` are now journalled. `Primary Request and
  Intent` / `User Messages` duplicate the `request` entry, `Files Touched` duplicates
  the `files` entry, and `Current Work` / `Next Step` are in-flight state that bench G
  proves would be asserted as current fact forever.
- **Turn-budget continuation echoed text already in context.** It re-sent up to 600
  chars of the "original request" — read out of the very `messages` array being sent,
  so the model already had it verbatim. Worse, after a compaction the first user
  message *is* the compaction summary, so the echo quoted the summary back instead of
  the request. Removed entirely; the continuation is now instruction-only (<400 chars).

### Truncation quality

Entries were hard-sliced at the budget, mid-word (`…read src/router.ts in fu…`).
Replaced with one shared boundary-aware clamp (sentence → word → hard cut), used by
both writers instead of two duplicate `clamp` copies. On the real live string:

| | tail of entry |
|---|---|
| before | `… suffix, differing only by index. - Read src/router.ts in fu…` |
| after | `… suffix, differing only by index. …` |

Periods inside code (`input.toLowerCase()`) are correctly not treated as sentence
ends. Cost of the cleaner ending: 25 chars (~7 tokens) per truncated entry.

## I — Why project memory was REMOVED (27 July 2026)

The durable project journal (`.gg/memory.md`, benches F/G/H) shipped in `ggcoder@5.26.0`
/ app `v0.31.0` and was **removed the same day**. Recording why, so it is not rebuilt.

**What it did:** on every compaction, wrote past-tense entries ("Was asked to X",
"Edited Y", plus the summary's What Was Done / Errors and Fixes) into `.gg/memory.md`,
and auto-injected the recent ones into every later session's prompt.

**Why that is the wrong design for a *coding* agent:**

1. **It duplicated the repo.** Everything it recorded — what was asked, what changed,
   what the code now does — is already in `git log`, `git diff`, and the source, in
   exact rather than paraphrased form. An ETH Zurich ablation on auto-generated
   context files measured **~3% lower success rate and >20% higher cost**, attributed
   specifically to duplicating what the agent can already discover. The test it
   proposes — *can the agent find this by reading the code?* — was "yes" for every
   entry this feature wrote.
2. **It suppressed verification** (bench G): 5/5 → 0/5 tool checks, and a stale entry
   was then asserted as fact 5/5. Neither note ages nor an explicit "unverified"
   header fixed it. Independently corroborated: uncurated auto-memory accumulates
   stale assumptions the agent then applies with full confidence.
3. **It cost ~282 tok/turn** for the above.
4. **It was cross-task noise.** A new session on an unrelated task still received the
   previous task's history.

**What the field actually does** (surveyed 27 July 2026):

| agent | cross-session memory | what it stores |
|---|---|---|
| opencode (189k★) | **none** — open feature requests only | — |
| gemini-cli | GEMINI.md, edited only on explicit request | instructions |
| claude-code | auto-memory, on by default | **selective insights**: build commands, debugging insights, architecture notes, preferences |
| codex | memories, **off** by default | summaries + entries |
| MiMo-Code | SQLite FTS5 + checkpoint subagent | layered |

The distinction that matters: Claude Code stores *insights* and explicitly **does not
save every session** — it judges whether something would be useful later. This feature
dumped *event history* unconditionally on a compaction timer. Different mechanism,
different value.

**If memory is rebuilt, build the other shape:** agent-judged capture of what is NOT
recoverable from the repo — approaches tried and abandoned (dead ends are never
committed, so they are genuinely lost), tooling gotchas, verified commands, and *why*
an architecture is the way it is. Written when something is worth keeping, not on a
timer. Bench G still applies: anything injected will suppress verification, so only
inject what cannot go stale.

## Verdict

| bench | verdict | expected gain |
|---|---|---|
| A deferred MCP tools | implement | −56% billed input tok, −24% TTFT (scales with MCP count) |
| B flush 100ms | implement | −49% streaming CPU (TUI); same fix for webview rAF batching |
| C partial preservation | implement | no re-billed output on transport retries; ~0.4–2.5k tok/drop |
| D steering/cache | no change needed | ship cache-hit% in ActivityBar (uses existing `cacheRead`) |
| E model-switch cache | ship for correctness | **no token gain (+0%)** — do not claim one |
| F memory cost | bounded | ~420 tok/turn, plateaus regardless of log size |
| G memory suppresses verification | **default OFF; open question** | 5/5 → 0/5 verification; wording fixes do not work |
| H live journal + de-dup | ~~ship~~ **superseded by I** | worked end-to-end, but see I |
| I project memory | **REMOVED** | duplicated the repo; that shape measures −3% success / +20% cost |

Reproduce: `node bench/a-mcp-tools.mjs` · `node bench/b-render-cpu.mjs` ·
`node bench/c-partial-loss.mjs` · `node bench/d-cache-audit.mjs` ·
`node bench/e-model-switch-cache.mjs` · `node bench/f-memory-staleness.mjs`
(from repo root).
