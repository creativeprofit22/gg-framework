import { expect, it } from "vitest";
import type { Tool } from "@kenkaiiii/gg-ai";
import { ProgrammaticCommandParams } from "./programmatic-command.js";

it("serializes programmatic commands without unsupported regex lookarounds in strict mode", async () => {
  // Exercise current provider source without adding a public export or compiling
  // another package's implementation into ggcoder's TypeScript root.
  const serializerUrl = new URL(
    "../../../gg-ai/src/providers/openai-responses-core.ts",
    import.meta.url,
  ).href;
  const { serializeResponsesTools } = (await import(serializerUrl)) as {
    serializeResponsesTools: (tools: Tool[], options: { strict: boolean | null }) => unknown[];
  };
  const tools = serializeResponsesTools(
    [
      {
        name: "programmatic_command",
        description: "Regression fixture",
        parameters: ProgrammaticCommandParams,
      },
    ],
    { strict: true },
  );
  expect(tools[0]).toMatchObject({ name: "programmatic_command", strict: true });
  const patterns: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "pattern" && typeof child === "string") patterns.push(child);
      visit(child);
    }
  }
  visit(tools);
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) expect(pattern).not.toMatch(/\(\?(?:[=!]|<[=!])/);
});

const selection = {
  version: 1,
  command: {
    version: 1,
    name: "Check-file.v2_1",
    source: "project-custom",
    invocationKind: "prompt",
  },
  arguments: "",
  outcome: "Check",
  successCondition: "Checked",
  helpers: [],
  prerequisites: [],
  requiredTools: ["read_file"],
  mode: "read-only",
  containment: "agent-session",
};

it("preserves valid command punctuation and tool names", () => {
  expect(ProgrammaticCommandParams.safeParse({ action: "run", selection }).success).toBe(true);
});

it.each(["\n", "\r", "\r\n", "\u2028", "\u2029", " ", "/", "\0"])(
  "rejects invalid suffix %j in command and required tool names locally",
  (suffix) => {
    expect(
      ProgrammaticCommandParams.safeParse({
        action: "run",
        selection: {
          ...selection,
          command: { ...selection.command, name: selection.command.name + suffix },
        },
      }).success,
    ).toBe(false);
    expect(
      ProgrammaticCommandParams.safeParse({
        action: "run",
        selection: {
          ...selection,
          requiredTools: ["read_file" + suffix],
        },
      }).success,
    ).toBe(false);
  },
);
