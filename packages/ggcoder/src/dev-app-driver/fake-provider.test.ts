import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureFakeProvider,
  fakeReply,
  lastUserText,
  startFakeProvider,
  type FakeProvider,
} from "./fake-provider.js";
import { createIsolatedProfile } from "./profile.js";

let provider: FakeProvider | undefined;
let dir: string | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function request(text: string): string {
  return JSON.stringify({
    model: "fixture",
    input: [
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "input_text", text: "first question" }] },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: [{ type: "input_text", text }] },
    ],
  });
}

describe("fake provider", () => {
  it("streams one numbered canned reply per request over loopback", async () => {
    provider = await startFakeProvider();
    expect(provider.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openai\/v1\/responses$/);
    const post = (text: string) =>
      fetch(provider?.url ?? "", { method: "POST", body: request(text) });

    const first = await post("hello   there");
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    const body = await first.text();
    expect(body).toContain('"delta":"Fake reply 1: hello there"');
    expect(body).toContain('"type":"response.completed"');
    expect(await (await post("again")).text()).toContain("Fake reply 2: again");
    expect(provider.requests()).toBe(2);
  });

  it("answers only its own endpoint", async () => {
    provider = await startFakeProvider();
    const other = new URL(provider.url);
    other.pathname = "/elsewhere";
    expect((await fetch(other, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(provider.url)).status).toBe(404);
    expect(provider.requests()).toBe(0);
  });

  it("finds the last user message and shortens long echoes", () => {
    expect(lastUserText(request("latest"))).toBe("latest");
    expect(lastUserText(JSON.stringify({ input: [{ role: "user", content: "plain" }] }))).toBe(
      "plain",
    );
    expect(lastUserText("not json")).toBe("");
    expect(lastUserText(JSON.stringify({ input: [{ role: "system", content: "x" }] }))).toBe("");
    expect(fakeReply(3, "")).toBe("Fake reply 3: (no message)");
    expect(fakeReply(1, "a".repeat(100))).toBe(`Fake reply 1: ${"a".repeat(80)}…`);
  });

  it("makes the fake provider the profile's default model", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fake-provider-"));
    const profile = createIsolatedProfile(dir);
    configureFakeProvider(profile, "com.ggcoder.local-fork");
    const agentDir = path.join(profile.home, ".gg", "identities", "com.ggcoder.local-fork");
    expect(JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"))).toMatchObject({
      defaultProvider: "azure",
      defaultModel: "azure:fixture",
    });
    expect(readFileSync(path.join(agentDir, "auth.json"), "utf8")).toBe("{}\n");
  });
});
