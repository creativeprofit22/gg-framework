import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import type { EventBus } from "../core/event-bus.js";

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
    eventBus: EventBus;
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
    const truncated = process.env.GG_FIXTURE_TRUNCATED;
    if (truncated === "refusal" || truncated === "empty_response") {
      this.eventBus.emit("truncated", { reason: truncated, continued: false });
      return;
    }
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

// Seed only the disposable home supplied by withRealSidecar, never a user's store.
if (process.env.GG_FIXTURE_PROGRESS_XP) {
  const { updateProgress } = await import("../core/progress/store.js");
  const xp = Number(process.env.GG_FIXTURE_PROGRESS_XP);
  if (!Number.isFinite(xp) || xp < 0) throw new Error("Invalid fixture XP");
  await updateProgress(async (file) => {
    file.xp = xp;
    return { file, levelledUp: false };
  });
}

await import("../app-sidecar.js");
