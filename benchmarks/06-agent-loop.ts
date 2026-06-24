/**
 * Benchmark 06: Agent Loop — Per-Turn Overhead
 *
 * Measures: repairToolPairingAdjacent cost as conversation grows.
 * This function runs on every turn and is O(n) → O(n²) over a session.
 */
import { bench } from "./harness.js";
import { generateConversation, generateBrokenConversation } from "./fixtures.js";

// We need to test the actual repair logic. Since it's not exported from
// the compiled package, we inline the exact same algorithm here.
// This gives us an apples-to-apples comparison before/after optimization.

// ── Types (minimal, matching the real codebase) ──

interface ContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  args?: unknown;
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
}

interface Message {
  role: "user" | "assistant" | "tool";
  content: string | ContentPart[];
}

// ── Current implementation (exact copy from agent-loop.ts) ──

function repairToolPairingAdjacentCurrent(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;

    const toolCallIds = (msg.content as ContentPart[])
      .filter((p) => p.type === "tool_call")
      .map((p) => (p as ContentPart & { type: "tool_call"; id: string }).id);
    if (toolCallIds.length === 0) continue;

    const next = messages[i + 1];
    if (next?.role === "tool" && Array.isArray(next.content)) {
      const existingIds = new Set(
        (next.content as ContentPart[]).map((r) =>
          (r as ContentPart & { toolCallId: string }).toolCallId,
        ),
      );
      const missing = toolCallIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        for (const id of missing) {
          (next.content as ContentPart[]).push({
            type: "tool_result",
            toolCallId: id,
            content: "Tool execution was interrupted.",
            isError: true,
          });
        }
      }
    } else {
      messages.splice(i + 1, 0, {
        role: "tool" as const,
        content: toolCallIds.map((id) => ({
          type: "tool_result" as const,
          toolCallId: id,
          content: "Tool execution was interrupted.",
          isError: true,
        })),
      });
    }
  }

  // Reverse repair: strip orphaned tool_results
  const toolCallIdSet = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const p of msg.content as ContentPart[]) {
        if (p.type === "tool_call") toolCallIdSet.add((p as ContentPart & { id: string }).id!);
      }
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      const results = msg.content as ContentPart[];
      const filtered = results.filter((r) => toolCallIdSet.has(r.toolCallId!));
      if (filtered.length === 0) {
        messages.splice(i, 1);
        i--;
      } else if (filtered.length < results.length) {
        (msg as { content: ContentPart[] }).content = filtered;
      }
    }
  }
}

// ── Improved: single-pass with incremental ID tracking ──

function repairToolPairingOptimized(messages: Message[]): void {
  // Build the complete tool-call ID set in ONE pass before repairing.
  // The original rebuilds this set from scratch every call.
  const allToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const p of msg.content as ContentPart[]) {
        if (p.type === "tool_call" && p.id) allToolCallIds.add(p.id);
      }
    }
  }

  // Forward repair: ensure every tool_call has an adjacent tool_result
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;

    const toolCallIds = (msg.content as ContentPart[])
      .filter((p) => p.type === "tool_call")
      .map((p) => p.id!);
    if (toolCallIds.length === 0) continue;

    const next = messages[i + 1];
    if (next?.role === "tool" && Array.isArray(next.content)) {
      const existingIds = new Set(
        (next.content as ContentPart[]).map((r) => r.toolCallId!),
      );
      const missing = toolCallIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        for (const id of missing) {
          (next.content as ContentPart[]).push({
            type: "tool_result",
            toolCallId: id,
            content: "Tool execution was interrupted.",
            isError: true,
          });
        }
      }
    } else {
      messages.splice(i + 1, 0, {
        role: "tool" as const,
        content: toolCallIds.map((id) => ({
          type: "tool_result" as const,
          toolCallId: id,
          content: "Tool execution was interrupted.",
          isError: true,
        })),
      });
    }
  }

  // Reverse repair: use the pre-built set (no rebuild needed)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    const results = msg.content as ContentPart[];
    const filtered = results.filter((r) => allToolCallIds.has(r.toolCallId!));
    if (filtered.length === 0) {
      messages.splice(i, 1);
      i--;
    } else if (filtered.length < results.length) {
      (msg as { content: ContentPart[] }).content = filtered;
    }
  }
}

export async function runAgentLoopBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  const sizes = [100, 300, 500, 1000];

  for (const turns of sizes) {
    // Generate conversation with broken pairings
    const msgs = generateBrokenConversation(turns) as Message[];

    results.push(
      await bench(`agent-loop:repairToolPairing(${turns} turns)`, () => {
        // Clone so each iteration gets a fresh array
        const clone = structuredClone(msgs) as Message[];
        repairToolPairingAdjacentCurrent(clone);
      }, turns <= 300 ? 50 : 20),
    );

    results.push(
      await bench(`agent-loop:repairToolPairing-optimized(${turns} turns)`, () => {
        const clone = structuredClone(msgs) as Message[];
        repairToolPairingOptimized(clone);
      }, turns <= 300 ? 50 : 20),
    );
  }

  // Measure the per-turn cost (simulating running repair every turn in a session)
  for (const totalTurns of [100, 300]) {
    results.push(
      await bench(`agent-loop:cumulative-repair(${totalTurns} turns)`, () => {
        // Simulate: run repair at every turn from 1..N (like the real loop does)
        const msgs = generateConversation(totalTurns) as Message[];
        for (let t = 1; t <= totalTurns; t++) {
          repairToolPairingAdjacentCurrent(msgs.slice(0, t * 3));
        }
      }, 3),
    );

    results.push(
      await bench(`agent-loop:cumulative-repair-optimized(${totalTurns} turns)`, () => {
        const msgs = generateConversation(totalTurns) as Message[];
        for (let t = 1; t <= totalTurns; t++) {
          repairToolPairingOptimized(msgs.slice(0, t * 3));
        }
      }, 3),
    );
  }

  return results;
}
