import { describe, expect, it } from "vitest";
import { routePromptCommandInput } from "./prompt-routing.js";
import { expandPromptCommand } from "../core/prompt-command-expansion.js";
import { PROMPT_COMMANDS, getPromptCommand } from "../core/prompt-commands.js";

const commands = [
  { name: "builtin", aliases: ["alias"], description: "Fixture", prompt: "Built-in prompt" },
];
const customCommands = [{ name: "MyCommand", prompt: "Custom prompt" }];

describe("prompt command routing", () => {
  it.each([" ", "\t", "\n", "\r\n", "\u00a0"])(
    "routes whitespace %j without changing focus",
    (separator) => {
      const focus = "café\n日本語\r\n\tkeep  spaces";
      for (const [name, promptText] of [
        ["builtin", "Built-in prompt"],
        ["alias", "Built-in prompt"],
        ["MyCommand", "Custom prompt"],
      ]) {
        expect(
          routePromptCommandInput(`  /${name}${separator}  ${focus}  `, commands, customCommands),
        ).toEqual({
          cmdName: name,
          cmdArgs: focus,
          promptText,
          fullPrompt: expandPromptCommand(promptText, focus),
        });
      }
    },
  );

  it("keeps blank focus empty and custom names case-sensitive", () => {
    expect(routePromptCommandInput("/MyCommand\t\r\n ", commands, customCommands)).toEqual({
      cmdName: "MyCommand",
      cmdArgs: "",
      promptText: "Custom prompt",
      fullPrompt: "Custom prompt",
    });
    for (const input of ["/mycommand focus", "/unknown", "ordinary text", "/"]) {
      expect(routePromptCommandInput(input, commands, customCommands)).toBeNull();
    }
  });

  it.each(["steroids", "commit"])("lets a custom /%s replace the built-in body", (name) => {
    const route = routePromptCommandInput(`/${name} focus`, PROMPT_COMMANDS, [
      { name, prompt: "My own recipe" },
    ]);
    expect(route).toMatchObject({ cmdName: name, cmdArgs: "focus", promptText: "My own recipe" });
  });

  it.each(["steroids", "commit", "init"])("runs the built-in /%s with no custom file", (name) => {
    expect(routePromptCommandInput(`/${name}`, PROMPT_COMMANDS, [])?.promptText).toBe(
      getPromptCommand(name)?.prompt,
    );
  });

  it("keeps a non-overridable built-in over a same-named custom command", () => {
    const builtin = getPromptCommand("init")?.prompt;
    expect(builtin).toBeTruthy();
    expect(
      routePromptCommandInput("/init", PROMPT_COMMANDS, [{ name: "init", prompt: "Shadow" }])
        ?.promptText,
    ).toBe(builtin);
  });

  it("retains built-in precedence over custom commands", () => {
    expect(
      routePromptCommandInput("/alias\tfocus", commands, [{ name: "alias", prompt: "Shadow" }])
        ?.promptText,
    ).toBe("Built-in prompt");
  });
});
