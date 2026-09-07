import React from "react";
import { renderToString } from "ink";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentModule from "@kenkaiiii/gg-agent";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as AgentLoopModule from "./hooks/useAgentLoop.js";
import type { useAgentLoop } from "./hooks/useAgentLoop.js";

// Drive the real hook and App callbacks; replace only the agent event source
// and OS process snapshots, not the verification gate or stop bookkeeping.
vi.mock("../core/logger.js", () => ({ log: vi.fn() }));
const flow = vi.hoisted(() => ({
  events: [] as AgentEvent[],
  stops: [] as (Message[] | null)[],
  stopCount: 1,
  loop: undefined as ReturnType<typeof useAgentLoop> | undefined,
}));
vi.mock("@kenkaiiii/gg-agent", async (original) => ({
  ...(await original<typeof AgentModule>()),
  agentLoop: async function* (
    _messages: Message[],
    options: { getFollowUpMessages?: () => Promise<Message[] | null> },
  ) {
    for (const event of flow.events) yield event;
    for (let i = 0; i < flow.stopCount; i++) {
      flow.stops.push((await options.getFollowUpMessages?.()) ?? null);
    }
  },
}));
vi.mock("./hooks/useAgentLoop.js", async (original) => {
  const actual = await original<typeof AgentLoopModule>();
  return {
    ...actual,
    useAgentLoop: (...args: Parameters<typeof useAgentLoop>) => {
      flow.loop = actual.useAgentLoop(...args);
      return flow.loop;
    },
  };
});
import { App } from "./App.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
import { ProcessManager, type BackgroundTaskSnapshot } from "../core/process-manager.js";
const processManager = new ProcessManager();
let processes: BackgroundTaskSnapshot[] = [];

function start(id: string, name: string, args: Record<string, unknown>): AgentEvent {
  return { type: "tool_call_start", toolCallId: id, name, args };
}
function end(id: string, exitCode?: number): Extract<AgentEvent, { type: "tool_call_end" }> {
  return {
    type: "tool_call_end",
    toolCallId: id,
    result: "Exit code: 0\n",
    isError: false,
    durationMs: 1,
    details:
      exitCode === undefined
        ? undefined
        : { bashDiagnostics: { reason: exitCode === 0 ? "completed" : "nonZeroExit", exitCode } },
  };
}
const edit = () => [start("edit", "edit", { file_path: "src/a.ts" }), end("edit")];
function background(exitCode: number | null): void {
  processes = [
    {
      id: "bg",
      pid: 1,
      command: "pnpm test",
      logFile: "",
      startedAt: 0,
      completedAt: exitCode === null ? null : 1,
      exitCode,
      signal: null,
      lastReadOffset: 0,
      logSize: 0,
      isRunning: exitCode === null,
    },
  ];
}
const launch = () => [
  start("check", "bash", { command: "pnpm test", run_in_background: true }),
  { ...end("check"), result: "ID: bg\n" },
];
const output = () => [start("output", "task_output", { id: "bg" }), end("output")];

beforeEach(() => {
  processes = [];
  vi.spyOn(processManager, "list").mockImplementation(() => processes);
  flow.events = [];
  flow.stops = [];
  flow.stopCount = 1;
  flow.loop = undefined;
  renderToString(
    <TerminalSizeProvider>
      <App
        provider="anthropic"
        model="test"
        tools={[]}
        messages={[]}
        cwd={process.cwd()}
        version="test"
        idealReviewEnabled={false}
        processManager={processManager}
      />
    </TerminalSizeProvider>,
    { columns: 100 },
  );
});

describe("CLI verification callback and stop flow", () => {
  it("allows a fresh successful check and an exact rerun after failure", async () => {
    flow.events = [
      ...edit(),
      start("red", "bash", { command: "pnpm test" }),
      end("red", 1),
      start("green", "bash", { command: "pnpm test" }),
      end("green", 0),
    ];
    await flow.loop!.run("fix source");
    expect(flow.stops).toEqual([null]);
  });
  it("budgets stops per run without interrupting later question-only runs", async () => {
    flow.stopCount = 2;
    flow.events = [...edit(), start("red", "bash", { command: "pnpm test" }), end("red", 1)];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
    expect(flow.stops[1]).toBeNull();
    flow.stopCount = 1;
    flow.events = [];
    await flow.loop!.run("explain the result");
    expect(flow.stops[2]).toBeNull();
    flow.events = edit();
    await flow.loop!.run("edit again");
    expect(String(flow.stops[3]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("accepts background success once, not after another edit", async () => {
    background(0);
    flow.events = [...edit(), ...launch(), ...output()];
    await flow.loop!.run("fix source");
    expect(flow.stops).toEqual([null]);
    flow.events = [...edit(), ...output()];
    await flow.loop!.run("edit again");
    expect(String(flow.stops[1]?.[0]?.content)).toContain("Re-run the affected checks");
  });
  it.each([0, null])(
    "rejects stale or still-running background evidence (exit %s)",
    async (exitCode) => {
      background(exitCode);
      flow.events = [...launch(), ...edit(), ...output()];
      await flow.loop!.run("fix source");
      expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
    },
  );
  it.each([
    undefined,
    { bashDiagnostics: { reason: "timedOut", exitCode: 0 } },
    { bashDiagnostics: { reason: "completed", exitCode: null } },
  ])("rejects missing or inconsistent host diagnostics %j", async (details) => {
    flow.events = [
      ...edit(),
      start("check", "bash", { command: "pnpm test" }),
      { ...end("check"), details },
    ];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it.each([
    { command: "pnpm test", persist: true },
    { command: "pnpm test || true" },
    { command: "pnpm test --watch" },
    { command: "pnpm dev" },
    { command: "pnpm lint --fix" },
  ])("rejects unbounded or unsafe check $command", async (args) => {
    flow.events = [...edit(), start("check", "bash", args), end("check", 0)];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("retains tool-error failures even when another check succeeds", async () => {
    flow.events = [
      ...edit(),
      start("test", "bash", { command: "pnpm test" }),
      { ...end("test", 1), isError: true },
      start("lint", "bash", { command: "pnpm lint" }),
      end("lint", 0),
    ];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("rejects background exit 1 despite claimed success in output", async () => {
    background(1);
    flow.events = [...edit(), ...launch(), ...output()];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("rejects completion of a check started before an edit", async () => {
    flow.events = [start("test", "bash", { command: "pnpm test" }), ...edit(), end("test", 0)];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("retains a failed check after an unrelated pass", async () => {
    flow.events = [
      ...edit(),
      start("test", "bash", { command: "pnpm test" }),
      end("test", 1),
      start("lint", "bash", { command: "pnpm lint" }),
      end("lint", 0),
    ];
    await flow.loop!.run("fix source");
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
  it("demands a check after an edit at the first stop", async () => {
    flow.events = edit();
    await flow.loop!.run("edit the source");
    expect(flow.stops).toHaveLength(1);
    expect(String(flow.stops[0]?.[0]?.content)).toContain("Run the project's verification");
  });
});
