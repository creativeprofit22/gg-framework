# GG Coder Benchmark Results

**Date**: 2026-06-21
**Method**: 3-1000 iterations per benchmark, warmup cycles, `process.hrtime.bigint()`.
**Run**: `pnpm bench`

---

## Full Results Table — Before → After

| # | Benchmark | Before | After | Speedup | Δ % |
|---|-----------|--------|-------|---------|-----|
| | **EDIT-DIFF (lazy normalization cache)** | | | | |
| 1 | Edit fuzzy no-match (500 lines) | 6.1ms | 1.0ms | **6.1×** | -84% |
| 2 | Edit fuzzy no-match (2,000 lines) | 24.9ms | 3.9ms | **6.5×** | -84% |
| 3 | Edit fuzzy no-match (5,000 lines) | 63.0ms | 10.3ms | **6.1×** | -84% |
| 4 | Edit fuzzy no-match (10,000 lines) | 127.6ms | 20.9ms | **6.1×** | -84% |
| 5 | Edit count no-match (500 lines) | 5.9ms | 1.0ms | **6.2×** | -84% |
| 6 | Edit count no-match (2,000 lines) | 24.1ms | 3.9ms | **6.2×** | -84% |
| 7 | Edit count no-match (5,000 lines) | 60.9ms | 10.5ms | **5.8×** | -83% |
| 8 | Edit count no-match (10,000 lines) | 121.2ms | 21.1ms | **5.8×** | -83% |
| 9 | Edit fuzzy drift-match (500 lines) | 0.7ms | 0.1ms | **5.0×** | -80% |
| 10 | Edit fuzzy drift-match (2,000 lines) | 2.8ms | 0.5ms | **5.4×** | -82% |
| 11 | Edit fuzzy drift-match (5,000 lines) | 7.0ms | 1.3ms | **5.3×** | -81% |
| 12 | Edit fuzzy drift-match (10,000 lines) | 14.3ms | 2.6ms | **5.4×** | -82% |
| | **ls TOOL (parallel stat)** | | | | |
| 13 | ls stat (50 files) | 0.5ms | 0.1ms | **3.7×** | -73% |
| 14 | ls stat (200 files) | 1.9ms | 0.5ms | **4.1×** | -76% |
| 15 | ls stat (500 files) | 4.8ms | 0.9ms | **5.5×** | -82% |
| | **STREAM RESULT (backpressure)** | | | | |
| 16 | StreamResult memory (50K events) | 11.9MB | 1.2MB | **10.0×** | -90% |
| | **MIXED-MODE TOOL EXECUTION** | | | | |
| 17 | 3 reads + 1 write | 86.8ms | 43.2ms | **2.0×** | -50% |
| 18 | 5 reads + 1 write + 2 reads | 174.6ms | 65.2ms | **2.7×** | -63% |
| 19 | 2 grep + edit + 2 grep + write | 130.8ms | 86.6ms | **1.5×** | -34% |
| 20 | 10 reads (no sequential) | 217.8ms | 21.8ms | **10.0×** | -90% |
| | **DIAGNOSTIC GATING** | | | | |
| 21 | Char-count per turn (100 turns) | 0.03ms | 0.00ms | **30×** | -100% |
| 22 | Char-count per turn (2,000 turns) | 0.03ms | 0.00ms | **30×** | -100% |
| 23 | Cumulative overhead (100 turns) | 0.23ms | 0.00ms | **230×** | -100% |
| 24 | Cumulative overhead (300 turns) | 0.72ms | 0.00ms | **720×** | -100% |
| | **MARKDOWN RE-PARSE (debounce)** | | | | |
| 25 | Markdown parse (50 tokens) | 1.2ms | 0.03ms | **40.7×** | -98% |
| 26 | Markdown parse (100 tokens) | 3.3ms | 0.05ms | **66.2×** | -98% |
| 27 | Markdown parse (200 tokens) | 10.7ms | 0.08ms | **133.6×** | -99% |
| 28 | Markdown parse (500 tokens) | 64.4ms | 0.19ms | **339.1×** | -100% |

---

## Changes Implemented

### Round 1 — Core Optimizations

#### 1. Edit-Diff Lazy Normalization Cache ✅
**File**: `packages/ggcoder/src/tools/edit-diff.ts`

**Problem**: `fuzzyFindText()` and `countOccurrences()` re-normalized each content line (6 regex calls) for every sliding-window position. 10K-line file, no match = 60K+ regex calls.

**Fix**: Lazy cache — `normalizedCache[j] ??= normalizeForFuzzyMatch(...)`. Each line normalized once on first access, lines after a match never touched.

**Result**: **5-7× faster** across all scenarios. 10K-line no-match: 128ms → 21ms.

#### 2. ls Parallel stat ✅
**File**: `packages/ggcoder/src/tools/ls.ts`

**Problem**: Sequential `await ops.stat()` per file. 500 files = 500 serial syscalls.

**Fix**: `Promise.all()` — all stats fire concurrently.

**Result**: **3.7-5.5× faster**. 500 files: 4.8ms → 0.9ms.

#### 3. StreamResult Backpressure ✅
**File**: `packages/gg-ai/src/utils/event-stream.ts`

**Problem**: Unbounded buffer growth — pump eagerly pulled events regardless of consumer speed. 50K events × 200 bytes = ~12MB.

**Fix**: High-water/low-water marks (5K/1K). Pump pauses when buffer exceeds 5K, resumes when consumer drains below 1K. `iterating` flag prevents deadlock when `await stream()` is called without iteration.

**Result**: **10× memory reduction**. 50K events: 11.9MB → 1.2MB.

### Round 2 — Agent Loop & Rendering

#### 4. Mixed-Mode Tool Execution ✅
**File**: `packages/gg-agent/src/agent-loop.ts`

**Problem**: One sequential tool (bash/edit/write) in a batch forced ALL tools to run sequentially. `[grep, grep, write, grep]` = 4 serial calls.

**Fix**: New `executeToolCallsMixed()` — partitions the batch into phases. Consecutive parallel-safe tools run concurrently via `Promise.all`, sequential tools run one-at-a-time in their original position. Preserves ordering semantics (read before write sees pre-write content).

**Result**: **2-10× faster** for mixed batches. `5 reads + write + 2 reads`: 175ms → 65ms.

#### 5. Per-Tool Timeout Isolation ✅
**File**: `packages/gg-agent/src/agent-loop.ts`

**Problem**: When a caller signal was provided (the normal case), no per-tool timeout was added. A hung tool (dead host, blocking input prompt) blocked indefinitely.

**Fix**: `AbortSignal.any([callerSignal, AbortSignal.timeout(300_000)])` — every tool now has a 5-minute timeout regardless of whether the caller signal has one. Either signal firing aborts the tool.

**Result**: No more indefinite hangs from stuck tools. Zero performance cost.

#### 6. Diagnostic Char-Count Gating ✅
**File**: `packages/gg-agent/src/agent-loop.ts`

**Problem**: O(n) char-counting loop over the full message history ran every turn, unconditionally, even when no diagnostic callback was registered (production default).

**Fix**: Gated behind `if (_diagFn)` — the loop is skipped entirely when no diagnostic callback is set.

**Result**: **100% elimination** of per-turn overhead in production. Cumulative 300-turn overhead: 0.72ms → 0.00ms.

#### 7. Markdown Re-parse Cost (benchmarked, not yet implemented in UI) 📊
**File**: `benchmarks/12-markdown-reparse.ts`

**Problem**: `ReactMarkdown` + `remarkGfm` + `rehypeHighlight` re-parses the entire accumulated response on every `text_delta`. A 500-token code-heavy response triggers 500 full markdown re-parses — classic O(n²).

**Benchmark result**: Debouncing (parse once on completion instead of per-token) would yield **40-339× less CPU**. A 500-token response: 64ms → 0.19ms.

**Status**: Benchmark proves the win. UI implementation requires changes to `Markdown.tsx` (conditional raw-text rendering during streaming) and `App.tsx` (rAF-batched `appendAssistant`).

---

## Tested & Reverted

| Change | Why |
|--------|-----|
| JSON-RPC growable buffer | V8 optimizes `Buffer.concat` well at LSP scales. No measurable improvement. |
| Token estimator "hybrid" | Had *worse* accuracy (19% vs 10%). Current heuristic is better. |

## Benchmarked & Found Negligible

| Area | Finding |
|------|---------|
| Agent loop `repairToolPairingAdjacent` | 2ms for 1000 turns. Not a bottleneck. |
| LSP `findExecutable` statSync | 0.11ms per resolution, runs once per session. |
| Grep parallel scanning | Slower than sequential for small repos (Promise overhead). |

---

## Benchmark Files

```
benchmarks/
├── harness.ts               # Timer + stats + table renderer
├── fixtures.ts              # File generators (TS/Python/JSON, file trees)
├── comparison.ts            # Edit-diff + ls + stream comparisons
├── 10-mixed-mode-tools.ts   # Sequential vs mixed-mode batching
├── 11-diagnostic-overhead.ts # Char-count gating
├── 12-markdown-reparse.ts   # Markdown re-parse O(n²) cost
├── run-comparison.ts        # Entry point: runs all, prints table
├── 02-09-*.ts               # Individual exploratory benchmarks
└── results/                 # JSON output (gitignored)
```

Run: `pnpm bench`
