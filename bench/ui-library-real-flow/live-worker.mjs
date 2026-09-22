// Live worker: a normal production AgentSession on GLM 5.3, brokered through
// the supervising loopback proxy. Runs inside a sandbox with an isolated HOME,
// so no user settings, memories or real credentials are reachable.
import fs from "node:fs/promises";
import path from "node:path";

const port = process.env.GG_LIVE_BROKER_PORT;
const token = process.env.GG_LIVE_BROKER_TOKEN;
const caseFile = process.env.GG_LIVE_CASE_FILE;
const outFile = process.env.GG_LIVE_OUT_FILE;
if (!port || !token || !caseFile || !outFile) throw new Error("missing broker/case env");

const home = process.env.HOME;
const cwd = process.cwd();
await fs.mkdir(path.join(home, ".gg"), { recursive: true });
// Static-key credential pointing at the broker. The real key never enters here.
await fs.writeFile(path.join(home, ".gg", "auth.json"), JSON.stringify({
  glm: { accessToken: token, refreshToken: "", expiresAt: Date.now() + 86_400_000, baseUrl: `http://127.0.0.1:${port}` },
}, null, 2));
await fs.writeFile(path.join(home, ".gg", "settings.json"), JSON.stringify({ defaultProvider: "glm", defaultModel: "glm-5.3" }));

const { AgentSession } = await import(new URL("../../packages/ggcoder/dist/core/agent-session.js", import.meta.url).href);

const scenario = JSON.parse(await fs.readFile(caseFile, "utf8"));
const started = Date.now();
const events = [];
const session = new AgentSession({
  provider: "glm",
  model: "glm-5.3",
  cwd,
  transient: true,
  loadExtensions: false,
  projectCustomization: false,
  orchestrationPrompt: false,
});
await session.initialize();
const onMutation = (event) => { events.push({ kind: "mutation", file: event?.file ?? event?.file_path ?? String(event) }); };
try { session.on?.("file_mutated", onMutation); } catch { /* event API optional */ }

let finalText = "";
let error = null;
try {
  const result = await session.prompt(scenario.prompt);
  finalText = typeof result === "string" ? result : JSON.stringify(result ?? "") ?? "";
} catch (e) {
  error = String(e?.message ?? e);
}

// Serialize the full transcript: tool calls (name + truncated args) and results.
const transcript = [];
for (const message of session.getMessages()) {
  const entry = { role: message.role };
  if (typeof message.content === "string") entry.content = message.role === "system" ? message.content : message.content.slice(0, 20000);
  else if (Array.isArray(message.content)) {
    entry.content = message.content.map((part) => part?.type === "text" ? { type: "text", text: String(part.text ?? "").slice(0, 20000) } : { type: part?.type });
  }
  if (Array.isArray(message.tool_calls)) {
    entry.tool_calls = message.tool_calls.map((call) => ({
      name: call?.function?.name ?? call?.name,
      arguments: String(call?.function?.arguments ?? call?.arguments ?? "").slice(0, 4000),
    }));
  }
  // Some message shapes carry tool calls as assistant content parts instead.
  if (Array.isArray(message.content)) {
    const partCalls = message.content
      .filter((part) => part?.type === "tool_call" || part?.type === "tool_use")
      .map((part) => ({ name: part?.name ?? part?.function?.name ?? "?", arguments: String(part?.arguments ?? part?.input ?? "").slice(0, 4000) }));
    if (partCalls.length) entry.tool_calls = [...(entry.tool_calls ?? []), ...partCalls];
    entry.content = message.content
      .filter((part) => part?.type === "text")
      .map((part) => ({ type: "text", text: String(part.text ?? "").slice(0, 20000) }));
  }
  transcript.push(entry);
}
await session.dispose().catch(() => {});

const toolCalls = transcript.flatMap((m) => (m.tool_calls ?? []).map((c) => c.name));
await fs.writeFile(outFile, JSON.stringify({
  caseId: scenario.id,
  prompt: scenario.prompt,
  expected: scenario.expected ?? {},
  seconds: (Date.now() - started) / 1000,
  toolCalls,
  transcript,
  mutations: events,
  finalText: finalText.slice(0, 8000),
  error,
}, null, 2));
process.exit(0);
