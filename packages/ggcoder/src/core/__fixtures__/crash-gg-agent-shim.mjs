// Stands in for `@kenkaiiii/gg-agent` inside the crash-recovery fixture.
//
// Everything is re-exported from the real package except `agentLoop`, which
// replays a deterministic two-step run and then hard-kills the process in the
// middle of the second step's tool batch — the shape of a real crash, where
// tools have already mutated the filesystem but the loop never returns.

export * from "@kenkaiiii/gg-agent";

const timing = {
  startedAt: Date.now(),
  completedAt: Date.now(),
  providerDurationMs: 1,
};
const usage = { inputTokens: 10, outputTokens: 5 };

function assistant(step) {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `working on step ${step}` },
      { type: "tool_use", id: `t${step}`, name: "bash", input: { command: `echo ${step}` } },
    ],
  };
}

function toolResult(step) {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: `t${step}`, content: `output ${step}` }],
  };
}

export async function* agentLoop(messages) {
  // ── Step 1: runs to completion and checkpoints. ──
  messages.push(assistant(1));
  yield { type: "turn_end", turn: 1, stopReason: "tool_use", usage, timing };
  messages.push(toolResult(1));
  yield { type: "checkpoint", turn: 1 };

  // ── Step 2: the provider answered, then the process dies mid tool batch. ──
  messages.push(assistant(2));
  yield { type: "turn_end", turn: 2, stopReason: "tool_use", usage, timing };
  // The tool ran (its side effects are already on disk) and its result is in
  // memory, but no checkpoint is reached — this is the work a crash loses.
  messages.push(toolResult(2));

  process.stdout.write("CRASHING\n");
  process.kill(process.pid, "SIGKILL");
  // Unreachable; keeps the generator from returning if the signal is slow.
  await new Promise(() => {});
}
