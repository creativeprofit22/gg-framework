import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";

// Source HTTP tests exercise real prompt persistence, never provider generation.
// The parent releases this gate over private fixture IPC, not an application route.
if (!process.send) throw new Error("Source sidecar fixture requires IPC");
let release!: () => void;
const generation = new Promise<void>((resolve) => { release = resolve; });
process.on("message", (message) => {
  if (message === "release-generation") release();
});
Object.defineProperty(AgentSession.prototype, "runLoop", {
  configurable: true,
  value: async function (this: {
    tools: AgentTool[];
    messages: Message[];
    getHookSteeringMessages(): Message[] | null;
    flushPendingMessages(): Promise<void>;
  }) {
    process.send?.("generation-started");
    if (process.env.GG_FIXTURE_PARK_QUESTION === "1") {
      const ask = this.tools.find((tool) => tool.name === "ask_user");
      if (!ask) throw new Error("Fixture ask_user tool missing");
      await ask.execute({ questions: [{ id: "approval", kind: "choice",
        question: "Allow this action?", options: [{ label: "Allow action", value: "allow" }, { label: "Stop action", value: "stop" }] }] },
        { signal: new AbortController().signal, toolCallId: "fixture-ask" });
    }
    await generation;
    if (process.env.GG_FIXTURE_QUEUE_DRAIN) {
      if (process.env.GG_FIXTURE_QUEUE_DRAIN === "steering") {
        // Include a hidden runtime row before consumption; hints must use actual positions.
        this.messages.push({ role: "user", content: "Fixture runtime notification",
          provenance: { source: "runtime", kind: "notification", visibility: "hidden" } });
        this.messages.push(...(this.getHookSteeringMessages() ?? []));
      }
      await this.flushPendingMessages();
      return;
    }
    throw new Error("Fixture generation failed after acceptance");
  },
});

await import("../app-sidecar.js");
