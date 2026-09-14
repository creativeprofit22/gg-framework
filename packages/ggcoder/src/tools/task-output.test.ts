import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProcessManager,
  type BackgroundProcess,
  type ProcessManagerOptions,
} from "../core/process-manager.js";
import { writeOverflow } from "./overflow.js";
import { createTaskOutputTool, type TaskOutputToolResultDetails } from "./task-output.js";

vi.mock("./overflow.js", () => ({
  writeOverflow: vi.fn(async () => "unexpected-overflow.txt"),
}));

const temporaryRoots: string[] = [];
const toolContext = { signal: new AbortController().signal } as never;

interface TrackedLog {
  manager: ProcessManager;
  process: BackgroundProcess;
  logFile: string;
}

function structuredTaskOutput(result: unknown): {
  content: string;
  details: TaskOutputToolResultDetails;
} {
  if (
    typeof result !== "object" ||
    result === null ||
    typeof (result as { content?: unknown }).content !== "string" ||
    typeof (result as { details?: unknown }).details !== "object" ||
    (result as { details?: unknown }).details === null
  ) {
    throw new Error("Expected a structured task_output result");
  }
  return result as { content: string; details: TaskOutputToolResultDetails };
}

async function trackedLog(
  content: string | Buffer,
  options: ProcessManagerOptions = {},
  running = true,
): Promise<TrackedLog> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-output-"));
  temporaryRoots.push(root);
  const backgroundLogRoot = path.join(root, "background");
  const foregroundLogRoot = path.join(root, "foreground");
  await Promise.all([
    fs.mkdir(backgroundLogRoot, { recursive: true }),
    fs.mkdir(foregroundLogRoot, { recursive: true }),
  ]);
  const logFile = path.join(backgroundLogRoot, "tracked.log");
  await fs.writeFile(logFile, content);

  const manager = new ProcessManager(undefined, undefined, {
    backgroundLogRoot,
    foregroundLogRoot,
    ...options,
  });
  const process: BackgroundProcess = {
    id: "tracked",
    pid: 123,
    command: "fixture",
    logFile,
    startedAt: 1,
    completedAt: running ? null : (options.now?.() ?? Date.now()),
    exitCode: running ? null : 0,
    signal: null,
    lastReadOffset: null,
    logSize: Buffer.byteLength(content),
  };
  const internals = manager as unknown as {
    processes: Map<string, BackgroundProcess>;
    children: Map<string, ChildProcess>;
  };
  internals.processes.set(process.id, process);
  if (running) internals.children.set(process.id, {} as ChildProcess);
  return { manager, process, logFile };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("task_output late readers", () => {
  it("returns a current tail snapshot first and only newly appended bytes next", async () => {
    const fixture = await trackedLog("historical-LATEST", { readCapBytes: 6 });
    const tool = createTaskOutputTool(fixture.manager);

    expect(tool.executionMode).toBe("sequential");

    const first = structuredTaskOutput(await tool.execute({ id: fixture.process.id }, toolContext));
    expect(first.content).toContain("LATEST");
    expect(first.content).not.toContain("historical");
    expect(first.content).toContain("11 earlier bytes skipped");
    expect(first.content).not.toContain("remain unread");
    expect(first.content).toContain(`Retained log: ${fixture.logFile}`);
    expect(first.details.taskOutput).toMatchObject({
      isRunning: true,
      startOffset: 11,
      endOffset: 17,
      skippedBytes: 11,
      remainingBytes: 0,
      logFile: fixture.logFile,
      presentationCapped: false,
    });

    await fs.appendFile(fixture.logFile, "-NEW");
    const second = structuredTaskOutput(
      await tool.execute({ id: fixture.process.id }, toolContext),
    );
    expect(second.content).toContain("-NEW");
    expect(second.content).not.toContain("LATEST");
  });

  it("replays from byte zero and leaves the incremental cursor at the returned range", async () => {
    const fixture = await trackedLog("abcdef", { readCapBytes: 4 });
    const tool = createTaskOutputTool(fixture.manager);

    const snapshot = structuredTaskOutput(
      await tool.execute({ id: fixture.process.id }, toolContext),
    );
    expect(snapshot.content).toContain("cdef");

    const replay = structuredTaskOutput(
      await tool.execute({ id: fixture.process.id, from_start: true }, toolContext),
    );
    expect(replay.content).toContain("abcd");
    expect(replay.content).not.toContain("cdef");

    const continuation = structuredTaskOutput(
      await tool.execute({ id: fixture.process.id }, toolContext),
    );
    expect(continuation.content).toContain("ef");
    expect(continuation.content).not.toContain("abcd");
  });

  it("bounds a large snapshot at 256 KiB and references the original log without overflow", async () => {
    const cap = 256 * 1024;
    const content = `${"A".repeat(300 * 1024)}TAIL`;
    const fixture = await trackedLog(content);

    const allocSpy = vi.spyOn(Buffer, "alloc");
    const result = await fixture.manager.readOutput(fixture.process.id);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(cap);
    expect(Math.max(...allocSpy.mock.calls.map(([size]) => size))).toBeLessThanOrEqual(cap);
    allocSpy.mockRestore();
    expect(result.startOffset).toBe(Buffer.byteLength(content) - cap);
    expect(result.endOffset).toBe(Buffer.byteLength(content));
    expect(result.skippedBytes).toBe(result.startOffset);
    expect(result.remainingBytes).toBe(0);
    expect(result.output.endsWith("TAIL")).toBe(true);

    fixture.process.lastReadOffset = null;
    const rendered = structuredTaskOutput(
      await createTaskOutputTool(fixture.manager).execute({ id: fixture.process.id }, toolContext),
    );
    expect(rendered.content).toContain(`Retained log: ${fixture.logFile}`);
    expect(rendered.details.taskOutput).toMatchObject({
      startOffset: Buffer.byteLength(content) - cap,
      endOffset: Buffer.byteLength(content),
      skippedBytes: Buffer.byteLength(content) - cap,
      remainingBytes: 0,
      logFile: fixture.logFile,
      presentationCapped: true,
    });
    expect(JSON.stringify(rendered.details)).not.toContain("TAIL");
    expect(writeOverflow).not.toHaveBeenCalled();
  });

  it("aligns a UTF-8 tail snapshot past continuation bytes", async () => {
    const fixture = await trackedLog("x😀END", { readCapBytes: 5 });

    const result = await fixture.manager.readOutput(fixture.process.id);

    expect(result.output).toBe("END");
    expect(result.output).not.toContain("�");
    expect(result.startOffset).toBe(5);
    expect(result.endOffset).toBe(8);
    expect(result.skippedBytes).toBe(5);
    expect(result.remainingBytes).toBe(0);
  });

  it("pages from byte zero with exact unread-range metadata", async () => {
    const fixture = await trackedLog("abcdefghij", { readCapBytes: 4 });

    await expect(fixture.manager.readOutput(fixture.process.id, true)).resolves.toMatchObject({
      output: "abcd",
      startOffset: 0,
      endOffset: 4,
      skippedBytes: 0,
      remainingBytes: 6,
    });
    await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
      output: "efgh",
      startOffset: 4,
      endOffset: 8,
      skippedBytes: 0,
      remainingBytes: 2,
    });
    await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
      output: "ij",
      startOffset: 8,
      endOffset: 10,
      skippedBytes: 0,
      remainingBytes: 0,
    });
  });

  it("retains a UTF-8 code point split at a page boundary", async () => {
    const fixture = await trackedLog("A😀B", { readCapBytes: 4 });

    const first = await fixture.manager.readOutput(fixture.process.id, true);
    const second = await fixture.manager.readOutput(fixture.process.id);
    const third = await fixture.manager.readOutput(fixture.process.id);

    expect(first).toMatchObject({ output: "A", startOffset: 0, endOffset: 1, remainingBytes: 5 });
    expect(second).toMatchObject({ output: "😀", startOffset: 1, endOffset: 5, remainingBytes: 1 });
    expect(third).toMatchObject({ output: "B", startOffset: 5, endOffset: 6, remainingBytes: 0 });
    expect(first.output + second.output + third.output).toBe("A😀B");
    expect(first.output + second.output + third.output).not.toContain("�");
  });

  it("retains an incomplete live UTF-8 suffix until later bytes arrive", async () => {
    const fixture = await trackedLog("A", { readCapBytes: 1 });
    await fixture.manager.readOutput(fixture.process.id);
    const emoji = Buffer.from("😀");
    await fs.appendFile(fixture.logFile, emoji.subarray(0, 2));

    await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
      output: "",
      startOffset: 1,
      endOffset: 1,
      remainingBytes: 2,
    });

    await fs.appendFile(fixture.logFile, Buffer.concat([emoji.subarray(2), Buffer.from("Z")]));
    const completedCodePoint = await fixture.manager.readOutput(fixture.process.id);
    const suffix = await fixture.manager.readOutput(fixture.process.id);

    expect(completedCodePoint).toMatchObject({
      output: "😀",
      startOffset: 1,
      endOffset: 5,
      remainingBytes: 1,
    });
    expect(suffix).toMatchObject({ output: "Z", startOffset: 5, endOffset: 6 });
    expect(completedCodePoint.output + suffix.output).not.toContain("�");
  });

  it("consumes incomplete or invalid terminal UTF-8 bytes after completion", async () => {
    for (const suffix of [Buffer.from([0xf0, 0x9f]), Buffer.from([0xff])]) {
      const content = Buffer.concat([Buffer.from("done"), suffix]);
      const fixture = await trackedLog(content, { readCapBytes: 16 }, false);

      await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
        output: "done",
        startOffset: 0,
        endOffset: content.length,
        remainingBytes: 0,
      });
      await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
        output: "",
        startOffset: content.length,
        endOffset: content.length,
        remainingBytes: 0,
      });
    }
  });

  it("recovers from file truncation without retaining an invalid byte cursor", async () => {
    const fixture = await trackedLog("abcdef", { readCapBytes: 16 });

    await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
      output: "abcdef",
      startOffset: 0,
      endOffset: 6,
    });
    await fs.writeFile(fixture.logFile, "xy");
    await expect(fixture.manager.readOutput(fixture.process.id)).resolves.toMatchObject({
      output: "xy",
      startOffset: 0,
      endOffset: 2,
    });
  });
});

describe("task_output rendering", () => {
  it("reports unknown IDs and no-new-output running state", async () => {
    const fixture = await trackedLog("");
    const tool = createTaskOutputTool(fixture.manager);

    const unknown = structuredTaskOutput(await tool.execute({ id: "missing" }, toolContext));
    expect(unknown.content).toContain('No background process with id "missing"');

    const running = structuredTaskOutput(
      await tool.execute({ id: fixture.process.id }, toolContext),
    );
    expect(running.content).toContain(`Process ${fixture.process.id}: running`);
    expect(running.content).toContain("(no new output)");
    expect(running.details.taskOutput).toEqual({
      isRunning: true,
      exitCode: null,
      signal: null,
      completedAt: null,
      startOffset: 0,
      endOffset: 0,
      skippedBytes: 0,
      remainingBytes: 0,
      logFile: fixture.logFile,
      presentationCapped: false,
    });
  });

  it("renders normal completion metadata", async () => {
    const completedAt = Date.UTC(2026, 6, 24, 12, 34, 56);
    const fixture = await trackedLog("final output", { now: () => completedAt }, false);
    fixture.process.exitCode = 7;
    fixture.process.completedAt = completedAt;

    const rendered = structuredTaskOutput(
      await createTaskOutputTool(fixture.manager).execute({ id: fixture.process.id }, toolContext),
    );

    expect(rendered.content).toContain("exited (code 7, completed 2026-07-24T12:34:56.000Z)");
    expect(rendered.content).toContain("final output");
    expect(rendered.details.taskOutput).toMatchObject({
      isRunning: false,
      exitCode: 7,
      signal: null,
      completedAt,
    });
  });

  it("renders native signal completion metadata without a synthetic exit code", async () => {
    const completedAt = Date.UTC(2026, 6, 24, 12, 34, 56);
    const fixture = await trackedLog("terminated", { now: () => completedAt }, false);
    fixture.process.exitCode = null;
    fixture.process.signal = "SIGTERM";
    fixture.process.completedAt = completedAt;

    const rendered = structuredTaskOutput(
      await createTaskOutputTool(fixture.manager).execute({ id: fixture.process.id }, toolContext),
    );

    expect(rendered.content).toContain(
      "exited (signal SIGTERM, completed 2026-07-24T12:34:56.000Z)",
    );
    expect(rendered.content).not.toContain("code 1");
    expect(rendered.details.taskOutput).toMatchObject({
      isRunning: false,
      exitCode: null,
      signal: "SIGTERM",
      completedAt,
    });
  });

  it("separates unread-page guidance and uses the retained log for presentation truncation", async () => {
    const fixture = await trackedLog(
      Array.from({ length: 3_000 }, (_, index) => `line ${index}`).join("\n"),
      { readCapBytes: 16 * 1024 },
    );
    fixture.process.lastReadOffset = 0;

    const rendered = structuredTaskOutput(
      await createTaskOutputTool(fixture.manager).execute({ id: fixture.process.id }, toolContext),
    );

    expect(rendered.content).toContain("bytes remain unread");
    expect(rendered.content).toContain(
      `Invoke task_output again with id="${fixture.process.id}" to read the next page.`,
    );
    expect(rendered.content).toContain(`Retained log: ${fixture.logFile}`);
    expect(rendered.details.taskOutput).toMatchObject({
      startOffset: 0,
      endOffset: 16 * 1024,
      skippedBytes: 0,
      remainingBytes: expect.any(Number),
      logFile: fixture.logFile,
      presentationCapped: false,
    });
    expect(rendered.details.taskOutput.remainingBytes).toBeGreaterThan(0);
    expect(writeOverflow).not.toHaveBeenCalled();
  });

  it("references the retained log when presentation compression hides output", async () => {
    const fixture = await trackedLog(
      Array.from({ length: 3_000 }, (_, index) => `presentation line ${index}`).join("\n"),
    );

    const rendered = structuredTaskOutput(
      await createTaskOutputTool(fixture.manager).execute(
        { id: fixture.process.id, from_start: true },
        toolContext,
      ),
    );

    expect(rendered.content).toContain(`Full output: ${fixture.logFile}`);
    expect(rendered.details.taskOutput).toMatchObject({
      logFile: fixture.logFile,
      presentationCapped: true,
    });
    expect(writeOverflow).not.toHaveBeenCalled();
  });
});

import type { WakeRules } from "../core/process-manager.js";
import { AgentNotificationQueue } from "../core/agent-notifications.js";

const managers: ProcessManager[] = [];
const directories: string[] = [];
const context = { signal: new AbortController().signal, toolCallId: "server-readiness" };

async function start(wake?: WakeRules) {
  const bgDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-task-output-"));
  directories.push(bgDir);
  const notifications = new AgentNotificationQueue();
  const manager = new ProcessManager({ bgDir, notifications });
  managers.push(manager);
  const process = await manager.start(
    "readiness test server",
    bgDir,
    {
      file: globalThis.process.execPath,
      args: [
        "-e",
        "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('READY',s.address().port));",
      ],
      isCmdFallback: false,
      sandboxed: false,
    },
    wake,
  );
  return { manager, notifications, id: process.id, tool: createTaskOutputTool(manager) };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const process of manager.list()) await manager.stop(process.id);
    await manager.shutdownAll();
  }
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("task_output readiness", () => {
  it("retains a wake fired before waiting, but does not replay it after reading", async () => {
    const { manager, tool, notifications, id } = await start({ pattern: /READY/ });
    expect(await manager.waitForExitOrWake(id, 15_000)).toBe("pattern");
    // Delivery to the agent and watcher retirement must not lose a pending wake.
    expect(notifications.drain().some((entry) => entry.text.includes("wake pattern"))).toBe(true);
    expect(
      structuredTaskOutput(await tool.execute({ id, wait_ms: 15_000 }, context)).content,
    ).toContain("wake pattern matched");
    expect(
      structuredTaskOutput(await tool.execute({ id, wait_ms: 1000 }, context)).content,
    ).toContain("still running after waiting 1s");
  });

  it("releases on silence without claiming the server is ready", async () => {
    const { tool, id } = await start({ silenceMs: 100 });
    const output = structuredTaskOutput(
      await tool.execute({ id, wait_ms: 15_000 }, context),
    ).content;
    expect(output).toContain("running — silence wake fired");
    expect(output).toContain("not necessarily ready");
  });

  it("does not treat unrelated output as a readiness match", async () => {
    const { tool, id } = await start({ pattern: /NEVER_MATCHES/ });
    const output = structuredTaskOutput(await tool.execute({ id, wait_ms: 1000 }, context)).content;
    expect(output).toContain("still running after waiting 1s");
    expect(output).not.toContain("wake pattern matched");
  });

  it("releases a blocking wait when the server is ready, without stopping it", async () => {
    const { tool, id } = await start({ pattern: /READY/ });
    const output = structuredTaskOutput(
      await tool.execute({ id, wait_ms: 15_000 }, context),
    ).content;
    expect(output).toContain("running — wake pattern matched");
    expect(output).not.toContain("still running after waiting");
    const port = output.match(/READY (\d+)/)?.[1];
    expect(port).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
