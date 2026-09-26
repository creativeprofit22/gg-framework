import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@kenkaiiii/gg-ai";
import { expect, it } from "vitest";
import { SessionManager } from "./core/session-manager.js";

it("serves the completed answer and image sizing warnings unchanged across session reopen", async () => {
  const fixture = JSON.parse(
    await fs.readFile(
      new URL(
        "../../../gg-app/src/test-fixtures/completed-verification-task.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    messages: Message[];
    history: unknown[];
    finalAnswer: string;
  };
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-completed-history-"));
  const project = path.join(home, "project");
  const agentDir = path.join(home, ".gg");
  await fs.mkdir(project);
  const manager = new SessionManager(path.join(agentDir, "sessions"));
  const saved = await manager.create(project, "openai", "gpt-5");
  const timestamp = "2026-01-01T00:00:00.000Z";
  await manager.appendRequiredEntry(saved.path, {
    type: "custom",
    id: randomUUID(),
    parentId: null,
    timestamp,
    kind: "app_transcript_marker",
    data: {
      version: 1,
      kind: "task",
      afterMessageCount: 0,
      data: { title: "Update sample window" },
    },
  });
  await manager.appendRunStarted(saved.path, {
    version: 1,
    generation: 1,
    startedAt: timestamp,
    afterMessageCount: 0,
  });
  let parentId: string | null = null;
  for (const message of fixture.messages) {
    const id = randomUUID();
    await manager.appendRequiredMessage(saved.path, {
      type: "message",
      id,
      parentId,
      timestamp,
      message,
    });
    parentId = id;
  }
  await manager.appendRunFinished(saved.path, { version: 1, generation: 1, outcome: "completed" });
  const { default: sharp } = await import("sharp");
  const originals = new Map<string, Buffer>();
  for (const [width, height] of [[1536, 1024], [1254, 1254], [1024, 1024]]) {
    const imagePath = path.join(project, `${width}x${height}.png`);
    const bytes = await sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
    await fs.writeFile(imagePath, bytes);
    originals.set(imagePath, bytes);
    const warning = width === 1024 ? "" : `WARNING: Image saved, requested dimensions not met. Requested: 1024x1024; actual: ${width}x${height}. Original bytes preserved; no resizing applied to the saved image. Exact-size verification failed. (${imagePath})`;
    const id = randomUUID();
    await manager.appendRequiredMessage(saved.path, {
      type: "message", id, parentId, timestamp,
      message: {
        role: "tool",
        content: [{
          type: "tool_result", toolCallId: `image-${width}`,
          content: [
            { type: "text", text: `Generated image → ${imagePath}` },
            { type: "text", text: warning || "Requested: 1024x1024; actual: 1024x1024. Requested dimensions matched." },
            { type: "image", mediaType: "image/png", data: bytes.toString("base64") },
          ],
        }],
      },
    });
    parentId = id;
    fixture.history.push({ role: "assistant", text: warning, toolImages: [{ src: expect.stringMatching(/^data:image\/png;base64,/), path: imagePath }] });
  }
  const previewFailure = "Partial completion: saved 1 of 2 requested images.\nSaved originals: offline-original.png\nFailure: Preview failed: offline fixture\nNo retry or fallback was attempted; saved originals were not overwritten.";
  await manager.appendRequiredMessage(saved.path, {
    type: "message", id: randomUUID(), parentId, timestamp,
    message: { role: "tool", content: [{ type: "tool_result", toolCallId: "failed-preview", content: previewFailure, isError: true }] },
  });
  fixture.history.push({ role: "assistant", text: previewFailure, toolImages: [] });
  const original = await fs.readFile(saved.path);
  const credentials = {
    accessToken: "fixture-not-a-real-token",
    refreshToken: "",
    expiresAt: Date.now() + 3_600_000,
  };
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({ anthropic: credentials, openai: credentials }),
  );
  const token = randomUUID();
  const nativeToken = randomUUID();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./app-sidecar.ts", import.meta.url))],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HOMEDRIVE: "",
        HOMEPATH: "",
        GG_AGENT_DIR: agentDir,
        GG_APP_CWD: project,
        GG_APP_AUTH_TOKEN: nativeToken,
        GG_APP_TOKEN: token,
        GG_APP_PORT: "0",
        GG_DISABLE_TELEMETRY: "1",
        GG_APP_ORPHAN_CHECK_MS: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Sidecar did not become ready: ${errors.slice(-2000)}`)),
        20_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Sidecar exited: ${errors.slice(-2000)}`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /GG_APP_LISTENING (\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let reload = 0; reload < 2; reload++) {
      const created = await fetch(`${base}/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gg-token": token,
          "x-gg-daemon-token": nativeToken,
        },
        body: JSON.stringify({ cwd: project, sessionPath: saved.path }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await created.json()) as { sessionId: string; error?: string };
      expect(created.status, body.error).toBe(200);
      const response = await fetch(`${base}/history`, {
        headers: { "x-gg-token": token, "x-gg-session": body.sessionId },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as { history: Array<{ role: string; text: string }> };
      expect(result.history).toEqual(fixture.history);
      expect(result.history.at(-5)).toEqual({
        role: "assistant",
        text: fixture.finalAnswer,
        images: [],
        hook: null,
        command: false,
        compacted: false,
      });
    }
    expect(await fs.readFile(saved.path)).toEqual(original);
    for (const [imagePath, bytes] of originals) {
      expect(await fs.readFile(imagePath)).toEqual(bytes);
    }
  } finally {
    child.kill();
    await closed;
    await fs.rm(home, { recursive: true, force: true });
  }
}, 45_000);
