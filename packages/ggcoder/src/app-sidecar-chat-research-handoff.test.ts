import { describe, expect, it, vi } from "vitest";
import {
  APP_SIDECAR_CHAT_COMMANDS,
  buildChatResearchContinuationPrompt,
  CHAT_RESEARCH_COMMAND,
  commitChatResearchTransition,
  executeChatResearchHandoff,
  normalizeChatResearchFocus,
  parseChatResearchCommand,
  resolveChatResearchCommandRoute,
} from "./app-sidecar-chat-research-handoff.js";

describe("chat Research command", () => {
  it("publishes isolated command metadata without aliases", () => {
    expect(CHAT_RESEARCH_COMMAND).toEqual({
      name: "research",
      aliases: [],
      description: "Research this conversation and draft net-new Roadmap phases",
      usage: "/research [optional focus]",
      input: { text: "optional", references: "optional", attachments: "none" },
      source: "built-in",
    });
    expect(APP_SIDECAR_CHAT_COMMANDS).toEqual([CHAT_RESEARCH_COMMAND]);
  });

  it("recognizes only the exact case-sensitive command token", () => {
    expect(parseChatResearchCommand("/research")).toEqual({
      focus: null,
      displayText: "/research",
    });
    expect(parseChatResearchCommand("  /research  ")).toEqual({
      focus: null,
      displayText: "/research",
    });

    for (const input of [
      "research",
      "/Research",
      "/RESEARCH",
      "/r",
      "/researcher",
      "/research-now",
      "/research/roadmap",
      "/research: roadmap",
      "/researching roadmap",
    ]) {
      expect(parseChatResearchCommand(input), input).toBeNull();
    }
  });

  it("normalizes optional focus whitespace for execution and display", () => {
    expect(normalizeChatResearchFocus(" \t roadmap   review\n references  ")).toBe(
      "roadmap review references",
    );
    expect(normalizeChatResearchFocus(" \n\t ")).toBeNull();
    expect(parseChatResearchCommand("/research\t roadmap   review\n references ")).toEqual({
      focus: "roadmap review references",
      displayText: "/research roadmap review references",
    });
    expect(parseChatResearchCommand("/research\n\t")).toEqual({
      focus: null,
      displayText: "/research",
    });
  });
});

describe("buildChatResearchContinuationPrompt", () => {
  it("carries normalized focus into a hidden same-conversation continuation", () => {
    const prompt = buildChatResearchContinuationPrompt("  approval   UX\n and citations ");

    expect(prompt).toContain("Continue this same chat as Research");
    expect(prompt).toContain("entire preceding Brainstorm conversation");
    expect(prompt).toContain("<research_focus>approval UX and citations</research_focus>");
    expect(prompt).not.toContain("approval   UX");
  });

  it("encodes the inspect, dedupe, reference, draft, approval, and stop contract", () => {
    const prompt = buildChatResearchContinuationPrompt();
    const inspectIndex = prompt.indexOf("`roadmap_inspect`");
    const draftIndex = prompt.indexOf("`roadmap_phase_draft`");

    expect(prompt).toContain("Gather and verify current authoritative evidence");
    expect(prompt).toContain("Ask one focused clarification");
    expect(prompt).toContain("genuinely material product decision");
    expect(inspectIndex).toBeGreaterThan(-1);
    expect(draftIndex).toBeGreaterThan(inspectIndex);
    expect(prompt).toContain("remove work already covered");
    expect(prompt).toContain("If nothing net-new remains");
    expect(prompt).toContain("canonical references attached to the relevant proposed phases");
    expect(prompt).toContain("flat peer phases");
    expect(prompt).toContain("stop pending explicit user approval");
    expect(prompt).toContain("Do not approve it");
    expect(prompt).toContain("implement anything");
    expect(prompt).toContain("open a coding session");
  });
});

describe("app-sidecar chat Research routing", () => {
  it("routes an idle attachment-free chat command with its optional focus", () => {
    const route = resolveChatResearchCommandRoute({
      mode: "chat",
      text: "  /research   approval UX  ",
      attachmentCount: 0,
      busy: false,
    });

    expect(route.kind).toBe("start");
    if (route.kind !== "start") throw new Error("expected Research route");
    expect(route.command).toEqual({
      focus: "approval UX",
      displayText: "/research approval UX",
    });
    expect(route.continuationPrompt).toContain("<research_focus>approval UX</research_focus>");
  });

  it("rejects attachments before busy state and never produces an executable route", () => {
    expect(
      resolveChatResearchCommandRoute({
        mode: "chat",
        text: "/research citations",
        attachmentCount: 1,
        busy: true,
      }),
    ).toEqual({
      kind: "reject",
      status: 409,
      body: {
        error: "research_attachments_unsupported",
        message: "Start /research without attachments.",
      },
    });

    expect(
      resolveChatResearchCommandRoute({
        mode: "chat",
        text: "/research",
        attachmentCount: 0,
        busy: true,
      }),
    ).toMatchObject({
      kind: "reject",
      body: { error: "research_session_busy" },
    });
  });

  it("leaves coding prompts, ordinary chat prompts, and near-match slash text unchanged", () => {
    for (const input of [
      { mode: "code" as const, text: "/research roadmap" },
      { mode: "chat" as const, text: "research roadmap" },
      { mode: "chat" as const, text: "/Research roadmap" },
      { mode: "chat" as const, text: "/researcher roadmap" },
      { mode: "chat" as const, text: "Please research the roadmap" },
    ]) {
      expect(
        resolveChatResearchCommandRoute({
          ...input,
          attachmentCount: 0,
          busy: false,
        }),
        input.text,
      ).toEqual({ kind: "pass" });
    }
  });

  it("commits the switch and marker before publishing state or continuing", async () => {
    const route = resolveChatResearchCommandRoute({
      mode: "chat",
      text: "/research   citations and UX",
      attachmentCount: 0,
      busy: false,
    });
    if (route.kind !== "start") throw new Error("expected Research route");

    const session = { id: "same-logical-session" };
    const seenSessions: Array<typeof session> = [];
    const events: string[] = [];
    let restoredUserText = "";
    let modelPrompt = "";

    await executeChatResearchHandoff(route, {
      session,
      commitResearchTransition: (active) =>
        commitChatResearchTransition({
          session: active,
          previousAgent: "general",
          researchAgent: "research",
          switchAgent: async (target) => {
            seenSessions.push(target);
            events.push("switch:research");
            return true;
          },
          persistAgentHandoff: async (target) => {
            seenSessions.push(target);
            events.push("marker:research");
          },
          onCommitted: () => events.push("publish:research"),
        }),
      persistUserHint: async (active, displayText) => {
        seenSessions.push(active);
        restoredUserText = displayText;
        events.push(`hint:${displayText}`);
      },
      prompt: async (active, continuationPrompt) => {
        seenSessions.push(active);
        modelPrompt = continuationPrompt;
        events.push("prompt:hidden");
      },
    });

    expect(events).toEqual([
      "switch:research",
      "marker:research",
      "publish:research",
      "hint:/research citations and UX",
      "prompt:hidden",
    ]);
    expect(restoredUserText).toBe("/research citations and UX");
    expect(modelPrompt).toBe(route.continuationPrompt);
    expect(modelPrompt).not.toContain("/research citations and UX");
    expect(modelPrompt).toContain("<research_focus>citations and UX</research_focus>");
    expect(seenSessions).toEqual([session, session, session, session]);
  });

  it.each(["switch", "marker"] as const)(
    "restores live and restart state when the %s step fails",
    async (failurePoint) => {
      const session = { id: "same-logical-session" };
      let liveAgent = "general";
      let restoredAgent = "general";
      const publishedAgents: string[] = [];

      await expect(
        commitChatResearchTransition({
          session,
          previousAgent: "general",
          researchAgent: "research",
          switchAgent: async (_active, nextAgent) => {
            liveAgent = nextAgent;
            if (failurePoint === "switch" && nextAgent === "research") {
              throw new Error("switch failed");
            }
            return true;
          },
          persistAgentHandoff: async () => {
            if (failurePoint === "marker") throw new Error("marker failed");
            restoredAgent = "research";
          },
          onCommitted: () => publishedAgents.push("research"),
        }),
      ).rejects.toThrow(`${failurePoint} failed`);

      expect(liveAgent).toBe("general");
      expect(restoredAgent).toBe("general");
      expect(publishedAgents).toEqual([]);
    },
  );

  it.each(["transition", "hint", "prompt"] as const)(
    "stops immediately when the %s operation fails without undoing a commit",
    async (failurePoint) => {
      const route = resolveChatResearchCommandRoute({
        mode: "chat",
        text: "/research",
        attachmentCount: 0,
        busy: false,
      });
      if (route.kind !== "start") throw new Error("expected Research route");

      const calls: string[] = [];
      let liveAgent = "general";
      let restoredAgent = "general";
      const operation = (name: (typeof calls)[number]) =>
        vi.fn(async () => {
          calls.push(name);
          if (name === failurePoint) throw new Error(`${name} failed`);
        });

      await expect(
        executeChatResearchHandoff(route, {
          session: {},
          commitResearchTransition: async () => {
            calls.push("transition");
            if (failurePoint === "transition") throw new Error("transition failed");
            liveAgent = "research";
            restoredAgent = "research";
          },
          persistUserHint: operation("hint"),
          prompt: operation("prompt"),
        }),
      ).rejects.toThrow(`${failurePoint} failed`);

      const failureIndex = ["transition", "hint", "prompt"].indexOf(failurePoint);
      expect(calls).toEqual(["transition", "hint", "prompt"].slice(0, failureIndex + 1));
      expect(liveAgent).toBe(failurePoint === "transition" ? "general" : "research");
      expect(restoredAgent).toBe(failurePoint === "transition" ? "general" : "research");
    },
  );
});
