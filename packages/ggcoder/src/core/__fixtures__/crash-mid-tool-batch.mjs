// Drives a real AgentSession through a run that is killed mid tool batch.
//
// Run as a CHILD PROCESS so the kill is genuine: no unwinding, no `finally`,
// no post-loop flush. Whatever is in the session file afterwards is what a
// crash would actually leave behind.
//
// Usage: node --import tsx crash-mid-tool-batch.mjs <cwd>
// Requires HOME to already point at a prepared fake home (auth + settings).

import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const SHIM = pathToFileURL(path.join(import.meta.dirname, "crash-gg-agent-shim.mjs")).href;

// Redirect the session's `@kenkaiiii/gg-agent` import to the shim. The shim
// itself must reach the real package, hence the parent check.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@kenkaiiii/gg-agent" && context.parentURL !== SHIM) {
      return { url: SHIM, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: crash-mid-tool-batch.mjs <cwd>");

const { AgentSession } = await import("../agent-session.js");

const session = new AgentSession({
  provider: "anthropic",
  model: "claude-test",
  cwd,
  systemPrompt: "crash fixture system prompt",
  // Any allow-list with no MCP whitelist skips MCP entirely, so the fixture
  // never spawns stdio servers it would then have to clean up.
  allowedTools: ["bash"],
});
await session.initialize();
process.stdout.write(`SESSION ${session.getState().sessionPath}\n`);

await session.prompt("do the thing");

// The shim SIGKILLs before the loop returns; reaching here means the crash
// never happened and the test should fail loudly.
process.stdout.write("NO_CRASH\n");
process.exit(3);
