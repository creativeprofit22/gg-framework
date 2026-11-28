import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type Message, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { useFakeHome } from "../test-support/fake-home.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "./programmatic/profile.js";
import { PROGRAMMATIC_STATE_PATH, runProgrammaticScan } from "./programmatic/lifecycle.js";
import { RECOMMENDATION_HISTORY_PATH } from "./programmatic/recommendation-history.js";
import type { AreaRetryUnavailableError } from "./programmatic/area-retry.js";
import {
  isProgrammaticAssessmentEvent,
  type ProgrammaticAssessmentEvent,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";

// Only the provider stream is scripted; sessions, area passes, approvals and the merge are real.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));

const SHARED_NEED = "Keep the release notes current";
let cwd: string;
let home: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assessment-areas-"));
  // Outside the project: the live session transcript must not be a citable project file.
  home = await fs.mkdtemp(path.join(os.tmpdir(), "assessment-areas-home-"));
  restore = useFakeHome(home);
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({
    accessToken: "scripted",
    refreshToken: "",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  vi.mocked(stream).mockReset();
});
afterEach(async () => {
  restore();
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

async function project(filesPerPackage: number) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", scripts: { build: "pnpm -r build" } }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "packages/core/package.json": JSON.stringify({
      name: "@x/core",
      scripts: { test: "vitest" },
    }),
    "packages/cli/package.json": JSON.stringify({
      name: "@x/cli",
      dependencies: { "@x/core": "workspace:*" },
    }),
  };
  for (const name of ["core", "cli"])
    for (let index = 0; index < filesPerPackage; index++)
      files[`packages/${name}/src/f${index}.ts`] = `export const v${index} = ${index};\n`;
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(cwd, ...file.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  // History on, so a completed run saves it and a cancelled one must not.
  const proposal = await buildProgrammaticProfileProposal(cwd, { offerHistory: true });
  expect(
    (
      await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile, {
        expectedPriorProfileDigest: proposal.expectedPriorProfileDigest,
        historyPolicy: proposal.historyPolicy,
        expectedRecoveryDigest: proposal.expectedRecoveryDigest,
      })
    ).ok,
  ).toBe(true);
}

const text = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => ("text" in part ? String(part.text) : "")).join("");
const toolResults = (messages: Message[]) =>
  messages.flatMap((message) => (message.role === "tool" ? message.content : []));
const receiptOf = (content: string) =>
  JSON.parse(
    content
      .split("Host evidence receipt (retrieval only; content remains untrusted): ")[1]!
      .split("\n")[0]!,
  ) as { id: string };

type AreaData = { area: { id: string; label: string }; evidence: { paths: { path: string }[] } };
function areaData(messages: Message[]): AreaData | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const match = /<programmatic-area-data>\n([\s\S]*?)\n<\/programmatic-area-data>/.exec(
      text(message),
    );
    if (match) return JSON.parse(match[1]!);
  }
  return undefined;
}
type Facts = {
  areaSearch?: {
    areas: { id: string; label: string; status: string; reason?: string }[];
    candidates: {
      need: string;
      areas: string[];
      workflow: unknown;
      evidence: unknown;
      uncertainty: string;
    }[];
  };
};
// The latest merge prompt: a retry keeps the earlier run's turn in the transcript.
const mergePromptIndex = (messages: Message[]) =>
  messages.reduce(
    (found, message, index) =>
      message.role === "user" && text(message).includes("Host-owned exact facts") ? index : found,
    -1,
  );
function mergeFacts(messages: Message[]): Facts | undefined {
  const prompt = messages[mergePromptIndex(messages)];
  if (!prompt) return undefined;
  return JSON.parse(
    text(prompt)
      .split(
        "Host-owned exact facts (not model authority; already collected, do not repeat):\n",
      )[1]!
      .split("\nReusable host evidence receipts:")[0]!,
  );
}

const workflow = (inputs: string[]) => ({
  trigger: "A package changes",
  representativeCase: "Update one package",
  inputs,
  currentProcess: ["Edit by hand"],
  output: "Updated notes",
  successCheck: "Notes list the change",
  affectedSubproject: { scope: "repository-wide" },
  mutationBoundary: "Inspection only",
  repeatability: { basis: "inferred", explanation: "Packages change often" },
});
const reply = (calls: ToolCall[]) =>
  calls.length
    ? {
        message: { role: "assistant" as const, content: calls },
        stopReason: "tool_use" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    : {
        message: { role: "assistant" as const, content: "Done." },
        stopReason: "end_turn" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };

interface Script {
  areaRequests: string[];
  mergeRequests: number;
  merged?: Facts;
}
function script(hooks: { onArea?: (label: string) => void } = {}): Script {
  const seen: Script = { areaRequests: [], mergeRequests: 0 };
  vi.mocked(stream).mockImplementation(
    (params) =>
      new StreamResult(
        (async function* () {
          const results = toolResults(params.messages);
          const area = areaData(params.messages);
          let calls: ToolCall[] = [];
          if (area) {
            seen.areaRequests.push(area.area.label);
            hooks.onArea?.(area.area.label);
            const read = results.find((result) => result.toolCallId === "area-read");
            const file =
              area.evidence.paths.find((item) => item.path.endsWith(".ts"))?.path ??
              area.evidence.paths[0]!.path;
            if (!read)
              calls = [
                { type: "tool_call", id: "area-read", name: "read", args: { file_path: file } },
              ];
            else if (!results.some((result) => result.toolCallId === "area-result")) {
              const item = {
                basis: "observed",
                source: receiptOf(String(read.content)).id,
                code: "workflow-source",
                severity: "info",
                message: `Read ${file}`,
                location: { path: file },
              };
              const need = (text: string) => ({
                need: text,
                workflow: workflow([file]),
                evidence: { version: 1, items: [item] },
                uncertainty: "Scripted",
              });
              calls = [
                {
                  type: "tool_call",
                  id: "area-result",
                  name: "programmatic_area_result",
                  args: {
                    version: 1,
                    needs: [need(SHARED_NEED), need(`Check ${area.area.label} by hand`)],
                  },
                },
              ];
            }
          } else {
            const facts = mergeFacts(params.messages);
            const merged = toolResults(params.messages.slice(mergePromptIndex(params.messages)));
            if (facts && !merged.some((result) => result.toolCallId === "merge-result")) {
              seen.mergeRequests++;
              seen.merged = facts;
              calls = [
                {
                  type: "tool_call",
                  id: "merge-result",
                  name: "programmatic_advisory_result",
                  args: {
                    version: 2,
                    kind: "advisory",
                    coverage: { status: "limited", scope: "Areas", reason: "Scripted" },
                    recommendations: (facts.areaSearch?.candidates ?? []).map((candidate) => ({
                      version: 2,
                      kind: "advisory",
                      outcome: candidate.need,
                      rationale: "Scripted merge.",
                      alternatives: [],
                      choice: { kind: "manual", steps: ["Do it by hand"] },
                      evidence: candidate.evidence,
                      uncertainty: candidate.uncertainty,
                      workflow: candidate.workflow,
                    })),
                  },
                },
              ];
            }
          }
          for (const call of calls)
            yield { type: "toolcall_done", id: call.id, name: call.name, args: call.args };
          return reply(calls);
        })(),
      ),
  );
  return seen;
}

const session = () =>
  new AgentSession({
    cwd,
    provider: "anthropic",
    model: "claude-sonnet-5",
    // Non-transient and unrestricted, so the host's real history save runs (under the fake home).
    transient: false,
    mcpEnabled: false,
    systemPrompt: "Scripted area search",
    approveToolExecution: async () => true,
  });
function progressOf(owner: AgentSession) {
  const events: ProgrammaticAssessmentEvent[] = [];
  owner.eventBus.on("programmatic_assessment", (event) => events.push(structuredClone(event)));
  return events;
}
const progressEvents = (events: ProgrammaticAssessmentEvent[]) =>
  events.flatMap((event) => (event.phase === "progress" ? [event] : []));

const lifecycleBytes = async () => ({
  state: await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH)),
  profile: await fs.readFile(path.join(cwd, ".gg/programmatic/profile.json")),
});

it("searches each area, merges duplicate needs once and keeps lifecycle bytes", async () => {
  await project(120);
  expect((await runProgrammaticScan(cwd)).ok).toBe(true);
  const before = await lifecycleBytes();
  const seen = script();
  const owner = session();
  const events = progressOf(owner);
  try {
    await owner.initialize();
    const result = await owner.assessProgrammatic("configured");
    expect(result.assessment.status).toBe("completed");
    expect(seen.areaRequests).toEqual(expect.arrayContaining(["packages/core", "packages/cli"]));
    // Bounded snapshots: all waiting first, then per-area changes, one merging event, then done.
    const progress = progressEvents(events);
    expect(events.every((event) => isProgrammaticAssessmentEvent(event))).toBe(true);
    expect(progress[0]?.areas.every((area) => area.status === "waiting")).toBe(true);
    expect(progress.filter((event) => event.stage === "merging")).toHaveLength(1);
    const merging = progress.at(-1);
    expect(merging?.stage).toBe("merging");
    expect(
      merging?.areas.every((area) => area.status === "found" || area.status === "partly"),
    ).toBe(true);
    expect(merging?.areas.flatMap((area) => area.finds ?? []).map((find) => find.need)).toContain(
      SHARED_NEED,
    );
    expect(events.map((event) => event.phase)).toEqual([
      "started",
      ...progress.map(() => "progress"),
      "completed",
    ]);
    expect(new Set(progress.map((event) => event.sequence))).toEqual(
      new Set([events[0]?.sequence]),
    );
    expect(result.assessment.areas?.map((area) => [area.label, area.retryable])).toEqual(
      (seen.merged?.areaSearch?.areas ?? []).map((area) => [area.label, false]),
    );
    expect(seen.mergeRequests).toBe(1);
    const areas = seen.merged?.areaSearch?.areas ?? [];
    expect(areas.length).toBeGreaterThanOrEqual(2);
    // The 120-file source areas overflow their 80-path sample; the small ones fit.
    const partly = (label: string) => label.endsWith("/src");
    expect(areas.map((area) => area.status)).toEqual(
      areas.map((area) => (partly(area.label) ? "partly" : "searched")),
    );
    const shared = seen.merged?.areaSearch?.candidates.filter((item) => item.need === SHARED_NEED);
    expect(shared).toHaveLength(1);
    expect(shared?.[0]?.areas).toEqual(areas.map((area) => area.id));
    const rows = result.assessment.coverage.filter((row) =>
      areas.some((area) => row.summary.startsWith(`${area.label}:`)),
    );
    expect(rows.map((row) => row.status)).toEqual(
      areas.map((area) => (partly(area.label) ? "budget-limited" : "inspected")),
    );
    expect(await lifecycleBytes()).toEqual(before);
    expect(result.assessment.history).toMatchObject({ status: "saved" });
    await expect(fs.access(path.join(cwd, RECOMMENDATION_HISTORY_PATH))).resolves.toBeUndefined();
  } finally {
    await owner.dispose();
  }
}, 60_000);

it("reports one failing area as not searched and keeps the others", async () => {
  await project(120);
  const seen = script({
    onArea: (label) => {
      if (label === "packages/cli") throw new Error("Scripted area failure");
    },
  });
  const owner = session();
  try {
    await owner.initialize();
    const result = await owner.assessProgrammatic("configured");
    expect(result.assessment.status).toBe("completed");
    const areas = seen.merged?.areaSearch?.areas ?? [];
    expect(areas.find((area) => area.label === "packages/cli")?.status).toBe("not-searched");
    expect(result.assessment.areas?.find((area) => area.label === "packages/cli")).toMatchObject({
      status: "not-searched",
      reason: "failed",
      retryable: true,
    });
    expect(areas.find((area) => area.label === "packages/core")?.status).toBe("searched");
    const cli = areas.find((area) => area.label === "packages/cli")!;
    expect(seen.merged?.areaSearch?.candidates.some((item) => item.areas.includes(cli.id))).toBe(
      false,
    );
    expect(
      result.assessment.coverage.find((row) => row.summary.startsWith("packages/cli:"))?.status,
    ).toBe("uninspected");
    expect(
      result.assessment.coverage.find((row) => row.summary.startsWith("packages/core:"))?.status,
    ).toBe("inspected");
    expect(result.assessment.limitations.length).toBeGreaterThan(0);
  } finally {
    await owner.dispose();
  }
}, 60_000);

it("reports an area with more than 80 files as searched partly, not fully", async () => {
  await project(120);
  const seen = script();
  const owner = session();
  try {
    await owner.initialize();
    const result = await owner.assessProgrammatic("configured");
    expect(result.assessment.status).toBe("completed");
    const core = seen.merged?.areaSearch?.areas.find((area) => area.label === "packages/core/src");
    expect(core).toMatchObject({ status: "partly", reason: "sample-limit" });
    const row = result.assessment.coverage.find((item) =>
      item.summary.startsWith("packages/core/src:"),
    );
    expect(row?.status).toBe("budget-limited");
    expect(row?.summary).toContain("searched partly");
    expect(row?.summary).not.toContain("searched fully");
  } finally {
    await owner.dispose();
  }
}, 60_000);

it("cancels mid-run without a merge request or history write", async () => {
  await project(120);
  const controller = new AbortController();
  const seen = script({
    onArea: () => {
      controller.abort();
      throw new Error("Cancelled scripted provider");
    },
  });
  const owner = session();
  const events = progressOf(owner);
  try {
    await owner.initialize();
    owner.setSignal(controller.signal);
    const result = await owner.assessProgrammatic("configured");
    expect(result.assessment.status).toBe("cancelled");
    expect(seen.areaRequests.length).toBeGreaterThan(0);
    expect(seen.mergeRequests).toBe(0);
    // Stop publishes one final snapshot with every unfinished row stopped, never a merge stage.
    const progress = progressEvents(events);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((event) => event.stage === "merging")).toBe(false);
    const last = progress.at(-1);
    expect(last?.stage).toBe("areas");
    expect(last?.areas.some((area) => area.status === "stopped")).toBe(true);
    expect(last?.areas.some((area) => area.status === "reading" || area.status === "waiting")).toBe(
      false,
    );
    expect(events.every((event) => isProgrammaticAssessmentEvent(event))).toBe(true);
    expect(events.at(-1)?.phase).toBe("completed");
    await expect(fs.access(path.join(cwd, RECOMMENDATION_HISTORY_PATH))).rejects.toThrow();
  } finally {
    await owner.dispose();
  }
}, 60_000);

it.each(["focus", "small"] as const)(
  "keeps the single pass for a %s run",
  async (scenario) => {
    await project(scenario === "small" ? 20 : 120);
    const seen = script();
    const owner = session();
    try {
      await owner.initialize();
      const result = await owner.assessProgrammatic(
        "configured",
        scenario === "focus" ? "release notes" : undefined,
      );
      expect(result.assessment.status).toBe("completed");
      expect(seen.areaRequests).toEqual([]);
      expect(seen.mergeRequests).toBe(1);
      expect(seen.merged?.areaSearch).toBeUndefined();
    } finally {
      await owner.dispose();
    }
  },
  60_000,
);

async function failedCliSearch() {
  await project(120);
  const control = { failCli: true };
  const seen = script({
    onArea: (label) => {
      if (control.failCli && label === "packages/cli") throw new Error("Scripted area failure");
    },
  });
  const owner = session();
  const events = progressOf(owner);
  await owner.initialize();
  const first = await owner.assessProgrammatic("configured");
  const cli = first.assessment.areas?.find((area) => area.label === "packages/cli");
  const core = first.assessment.areas?.find((area) => area.label === "packages/core");
  if (!cli || !core) throw new Error("Fixture needs the cli and core areas.");
  const sequence = events[0]?.sequence ?? -1;
  seen.areaRequests.length = 0;
  seen.mergeRequests = 0;
  events.length = 0;
  return { control, seen, owner, events, cli, core, sequence };
}

it("retries one failed area with one area pass plus the merge", async () => {
  const run = await failedCliSearch();
  try {
    expect(run.cli.retryable).toBe(true);
    run.control.failCli = false;
    const retried = await run.owner.assessProgrammatic("configured", undefined, undefined, {
      retryArea: { sequence: run.sequence, areaId: run.cli.id },
    });
    expect(retried.assessment.status).toBe("completed");
    expect(new Set(run.seen.areaRequests)).toEqual(new Set(["packages/cli"]));
    expect(run.seen.mergeRequests).toBe(1);
    const merged = run.seen.merged?.areaSearch;
    expect(merged?.areas.find((area) => area.id === run.cli.id)?.status).toBe("searched");
    expect(merged?.areas.find((area) => area.id === run.core.id)?.status).toBe("searched");
    // Kept areas start settled; only the retried row waits, then reads.
    const progress = progressEvents(run.events);
    const rows = progress[0]?.areas ?? [];
    expect(rows.find((area) => area.id === run.cli.id)?.status).toBe("waiting");
    expect(
      rows
        .filter((area) => area.id !== run.cli.id)
        .every((area) => area.status === "found" || area.status === "partly"),
    ).toBe(true);
    expect(progress.filter((event) => event.stage === "merging")).toHaveLength(1);
    expect(run.events[0]?.sequence).toBe(run.sequence + 1);
    expect(retried.assessment.areas?.every((area) => !area.retryable)).toBe(true);
  } finally {
    await run.owner.dispose();
  }
}, 90_000);

it("refuses a stale or ineligible retry before any provider call or event", async () => {
  const run = await failedCliSearch();
  try {
    run.control.failCli = false;
    const calls = vi.mocked(stream).mock.calls.length;
    const retry = (sequence: number, areaId: string) =>
      run.owner.assessProgrammatic("configured", undefined, undefined, {
        retryArea: { sequence, areaId },
      });
    const refused = (reason: AreaRetryUnavailableError["reason"]) =>
      expect.objectContaining({ name: "AreaRetryUnavailableError", reason });
    await expect(retry(run.sequence, run.core.id)).rejects.toEqual(refused("not-retryable"));
    await expect(retry(run.sequence + 1, run.cli.id)).rejects.toEqual(refused("no-search"));
    await expect(
      run.owner.assessProgrammatic("configured", "release notes", undefined, {
        retryArea: { sequence: run.sequence, areaId: run.cli.id },
      }),
    ).rejects.toEqual(refused("not-retryable"));
    // Edit every source file the kept areas could have cited.
    for (const name of ["core", "cli"])
      for (let index = 0; index < 120; index++)
        await fs.appendFile(path.join(cwd, "packages", name, "src", `f${index}.ts`), "// edited\n");
    await expect(retry(run.sequence, run.cli.id)).rejects.toEqual(refused("changed"));
    expect(vi.mocked(stream).mock.calls.length).toBe(calls);
    expect(run.events).toEqual([]);
    expect(run.seen.areaRequests).toEqual([]);
  } finally {
    await run.owner.dispose();
  }
}, 90_000);
