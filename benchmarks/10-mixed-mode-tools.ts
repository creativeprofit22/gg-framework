/**
 * Benchmark 10: Agent Loop — Mixed-Mode Tool Execution
 *
 * Measures: wall-clock time for tool batches that mix parallel-safe and
 * sequential tools. Compares:
 *   1. OLD: one sequential tool → entire batch runs sequentially
 *   2. NEW: mixed-mode — consecutive parallel tools batched concurrently
 */
import { bench, type BenchResult } from "./harness.js";

// ── Types (minimal, matching gg-agent) ──

interface FakeToolCall {
  id: string;
  name: string;
  executionMode: "parallel" | "sequential";
  delayMs: number;
}

// ── Simulated tool execution ──

async function executeTool(tc: FakeToolCall): Promise<{ toolCallId: string; content: string }> {
  if (tc.delayMs > 0) {
    await new Promise((r) => setTimeout(r, tc.delayMs));
  }
  return { toolCallId: tc.id, content: `result of ${tc.name}` };
}

// ── OLD behavior: all sequential if ANY tool is sequential ──

async function runAllSequential(toolCalls: FakeToolCall[]): Promise<unknown[]> {
  const results = [];
  for (const tc of toolCalls) {
    results.push(await executeTool(tc));
  }
  return results;
}

// ── NEW behavior: mixed-mode batching ──

async function runMixedMode(toolCalls: FakeToolCall[]): Promise<unknown[]> {
  // Partition into phases (same logic as executeToolCallsMixed)
  const phases: { parallel: FakeToolCall[]; sequential: FakeToolCall | null }[] = [];
  let currentParallel: FakeToolCall[] = [];
  for (const tc of toolCalls) {
    if (tc.executionMode === "sequential") {
      if (currentParallel.length > 0) {
        phases.push({ parallel: currentParallel, sequential: null });
        currentParallel = [];
      }
      phases.push({ parallel: [], sequential: tc });
    } else {
      currentParallel.push(tc);
    }
  }
  if (currentParallel.length > 0) {
    phases.push({ parallel: currentParallel, sequential: null });
  }

  const results: unknown[] = [];
  for (const phase of phases) {
    if (phase.sequential) {
      results.push(await executeTool(phase.sequential));
    } else if (phase.parallel.length === 1) {
      results.push(await executeTool(phase.parallel[0]!));
    } else {
      const phaseResults = await Promise.all(phase.parallel.map(executeTool));
      results.push(...phaseResults);
    }
  }
  return results;
}

export async function runMixedModeBench(): Promise<{ results: BenchResult[]; comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] }> {
  const comparisons: { name: string; beforeMs: number; afterMs: number; speedup: number }[] = [];
  const results: BenchResult[] = [];

  // Tool delay: 20ms per tool (simulates a fast grep/read)
  const DELAY = 20;

  const scenarios = [
    {
      name: "3 reads + 1 write",
      calls: [
        { id: "1", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "2", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "3", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "4", name: "write", executionMode: "sequential" as const, delayMs: DELAY },
      ],
    },
    {
      name: "5 reads + 1 write + 2 reads",
      calls: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: "read", executionMode: "parallel" as const, delayMs: DELAY })),
        { id: "w1", name: "write", executionMode: "sequential" as const, delayMs: DELAY },
        ...Array.from({ length: 2 }, (_, i) => ({ id: `r${i + 5}`, name: "read", executionMode: "parallel" as const, delayMs: DELAY })),
      ],
    },
    {
      name: "2 grep + edit + 2 grep + write",
      calls: [
        { id: "1", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "2", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "3", name: "edit", executionMode: "sequential" as const, delayMs: DELAY },
        { id: "4", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "5", name: "grep", executionMode: "parallel" as const, delayMs: DELAY },
        { id: "6", name: "write", executionMode: "sequential" as const, delayMs: DELAY },
      ],
    },
    {
      name: "10 reads only (no sequential)",
      calls: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: "read", executionMode: "parallel" as const, delayMs: DELAY })),
    },
  ];

  for (const scenario of scenarios) {
    const before = await bench(`mixed-mode:old-all-sequential(${scenario.name})`, () => runAllSequential(scenario.calls), 10);
    const after = await bench(`mixed-mode:new-batched(${scenario.name})`, () => runMixedMode(scenario.calls), 10);
    results.push(before, after);
    const speedup = Math.round((before.meanMs / after.meanMs) * 100) / 100;
    comparisons.push({ name: scenario.name, beforeMs: before.meanMs, afterMs: after.meanMs, speedup });
  }

  return { results, comparisons };
}
