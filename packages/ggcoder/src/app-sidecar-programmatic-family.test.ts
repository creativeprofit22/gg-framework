import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type Message, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./core/agent-session.js";
import { AuthStorage } from "./core/auth-storage.js";
import { RunClaim } from "./core/run-claim.js";
import type { AskUserPrompt } from "./core/ask-user.js";
import { useFakeHome } from "./test-support/fake-home.js";
import {
  familyEvaluationFixtures,
  materializeFamilyFixture,
  type FamilyEvaluationFixture,
} from "./test-support/programmatic-evaluation-fixtures.js";
import {
  AppSidecarProgrammaticChat,
  programmaticChatIdentity,
} from "./app-sidecar-programmatic-chat.js";

// Real session, tool loop, desktop adapter and filesystem; only provider streaming is scripted.
vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));

type StreamParams = Parameters<typeof stream>[0];
type Step = (params: StreamParams) => ToolCall[];
type Question = AskUserPrompt["questions"][number];
interface FamilyFacts {
  families: {
    id: string;
    kind: string;
    parent: string;
    members: { path: string; missing: string[]; missingCount: number }[];
  }[];
}

const run = promisify(execFile);
let base: string;
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desktop-family-")));
  cwd = path.join(base, "project");
  await fs.mkdir(cwd);
  // Home lives outside the project so it never enters the inventory.
  restore = useFakeHome(path.join(base, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({
    accessToken: "fixture",
    refreshToken: "",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  vi.mocked(stream).mockReset();
});
afterEach(async () => {
  restore();
  vi.restoreAllMocks();
  // Windows may still hold a just-closed handle; fs.rm retries EBUSY/ENOTEMPTY itself.
  await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const call = (name: string, args: Record<string, unknown>, id = `${name}-${randomUUID()}`) =>
  ({ type: "tool_call", id, name, args }) satisfies ToolCall;

function toolResults(params: StreamParams) {
  return params.messages.flatMap((message) => (message.role === "tool" ? message.content : []));
}
function resultText(params: StreamParams, id: string): string {
  const result = toolResults(params).find((item) => item.toolCallId === id);
  if (!result) throw new Error(`No result for ${id}`);
  return String(result.content);
}
function resultJson(params: StreamParams, id: string) {
  return JSON.parse(resultText(params, id));
}
function receiptOf(params: StreamParams, id: string): string {
  const receipt = /^Host receipt IDs: (receipt-[a-f0-9-]+)/.exec(resultText(params, id))?.[1];
  if (!receipt) throw new Error(`No host receipt for ${id}`);
  return receipt;
}
function messageText(message: Message): string {
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : "";
}
function setupFamilies(params: StreamParams): FamilyFacts {
  const prompt = params.messages.map(messageText).find((text) => text.includes("Host-owned exact facts"));
  const json = prompt
    ?.split("already collected, do not repeat):\n")[1]
    ?.split("\nReusable host evidence receipts:")[0];
  if (!json) throw new Error("Setup facts were not delivered");
  return JSON.parse(json).setupFacts.item_families;
}

async function snapshot(root: string, relative: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else files[child] = await fs.readFile(path.join(root, child), "utf8");
    }
  };
  await walk(relative);
  return files;
}
const exists = (relative: string) =>
  fs.stat(path.join(cwd, relative)).then(
    () => true,
    () => false,
  );
const commandFiles = () => fs.readdir(path.join(cwd, ".gg/commands")).catch(() => []);

async function gitAvailable(): Promise<boolean> {
  return run("git", ["--version"]).then(
    () => true,
    () => false,
  );
}

function generatorDraft(fixture: FamilyEvaluationFixture, familyId: string) {
  const name = `${fixture.parent.split("/").at(-1)}-generator`;
  return {
    name,
    requiredTools: ["bash"],
    markdown: `---\nname: ${name}\ndescription: Generate one family member from the verified reference\n---\n## Inputs\nFamily member path\n## Outputs\nThe member's files\n## Required tools\nbash\n## Limits\nFamily members only; no installs\n## Arguments\nAppend the member path\n`,
    generator: {
      familyId,
      kind: "directory",
      reference: fixture.reference.path,
      placeholders: fixture.placeholders,
      members: fixture.members.map((member) => ({
        path: member,
        values: fixture.placeholders.map((key) => ({
          key,
          value: fixture.values[member]?.[key] ?? "",
        })),
      })),
      files: fixture.template,
    },
    requirement: {
      version: 1,
      desiredOutcome: `Generate ${fixture.parent} members from one reference`,
      capabilityKind: "script-backed",
      inputs: ["Member name and title"],
      outputs: ["Member files"],
      prerequisites: ["Node runtime"],
      risks: ["Template drift from the reference"],
      verificationExpectations: ["Reproduces the reference byte for byte"],
    },
  };
}

it.each(familyEvaluationFixtures)(
  "connects detect, recommend, reference, create, reproduce, preview, approve, apply and rescan: $id",
  { timeout: 120_000 },
  async (fixture) => {
    const git = await gitAvailable();
    await materializeFamilyFixture(cwd, fixture);
    if (git) {
      await run("git", ["init", "-q"], { cwd });
      await run("git", ["add", "-A"], { cwd });
      await run(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
        { cwd },
      );
    }
    const original = await snapshot(cwd, fixture.parent);

    // Every approval card the host raises; answers come from the current stage.
    const cards: Question[] = [];
    let answer: (question: Question) => string | Promise<string> = () => "reject";
    const session = new AgentSession({
      cwd,
      provider: "anthropic",
      model: "claude-sonnet-5",
      mcpEnabled: false,
      systemPrompt: "Scripted family journey",
      approveToolExecution: async () => true,
      reviewCommandCreation: async (request) => {
        const question = request.questions[0];
        if (!question || request.questions.length !== 1) throw new Error("One card expected");
        cards.push(question);
        return { action: "answer", answers: { [question.id]: await answer(question) } };
      },
    });
    const claim = new RunClaim();
    const adapter = new AppSidecarProgrammaticChat(
      () => ({
        cwd,
        identity: programmaticChatIdentity(session.getConversationIdentity()),
        codeMode: true,
        planMode: false,
        busy: claim.active,
      }),
      () => claim.claim(),
      () => claim.release(),
      undefined,
      undefined,
      (mode, assessmentRequestId) =>
        session.assessProgrammatic(mode, undefined, undefined, { assessmentRequestId }),
      (request) => session.reviewDiscoveryCandidate(request),
    );

    // Stage machine: each provider request takes the next scripted step; an
    // exhausted script ends the turn. Unexpected extra requests stay visible.
    let script: Step[] = [];
    const requests: StreamParams[] = [];
    vi.mocked(stream).mockImplementation(
      (params) =>
        new StreamResult(
          (async function* () {
            requests.push(params);
            const step = script.shift();
            const calls = step ? step(params) : [];
            if (calls.length) {
              for (const item of calls)
                yield { type: "toolcall_done", id: item.id, name: item.name, args: item.args };
              return {
                message: { role: "assistant", content: calls },
                stopReason: "tool_use",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            }
            return {
              message: { role: "assistant", content: "Scripted turn complete." },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        ),
    );
    const turn = async (steps: Step[], start: () => Promise<unknown>) => {
      script = steps;
      const before = requests.length;
      const outcome = await start();
      expect(script, "every scripted step ran").toEqual([]);
      return { outcome, requests: requests.slice(before) };
    };
    const last = () => {
      const params = requests.at(-1);
      if (!params) throw new Error("No provider request");
      return params;
    };

    const evidencePaths = [
      fixture.variant === "non-javascript" ? "CONTRIBUTING" : "INTEGRATIONS",
      ...(fixture.reference.kind === "existing-member"
        ? fixture.template.map((file) =>
            file.path.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
              fixture.values[fixture.reference.path]?.[key] ?? "",
            ),
          )
        : [`${fixture.members[2]}/index.ts`]),
    ].sort();
    const readIds = evidencePaths.map((file) => `read-${file}`);
    const readCalls = () => [
      ...evidencePaths.map((file, index) => call("read", { file_path: file }, readIds[index])),
      call("command_information", { action: "list" }, "catalog"),
    ];

    try {
      await session.initialize();

      // 1. Detect + recommend: the host delivers path-derived families to setup.
      let familyId = "";
      const discovery = await turn(
        [
          (params) => {
            const family = setupFamilies(params).families.find(
              (item) => item.kind === "sibling-directories" && item.parent === fixture.parent,
            );
            expect(family?.members.map((member) => member.path)).toEqual(fixture.members);
            for (const member of family?.members ?? [])
              expect(member.missing).toEqual(fixture.missingAtDiscovery[member.path]);
            familyId = family?.id ?? "";
            const offered = (params.tools ?? []).map((tool) => tool.name);
            for (const name of ["programmatic_command", "bash", "write", "edit"])
              expect(offered).not.toContain(name);
            return readCalls();
          },
          (params) => [
            call(
              "programmatic_advisory_result",
              {
                version: 2,
                kind: "advisory",
                coverage: { status: "limited", scope: fixture.parent, reason: fixture.coverage },
                recommendations: [
                  {
                    version: 2,
                    kind: "advisory",
                    outcome: `Add ${fixture.parent} members from one reference`,
                    rationale: "Members repeat the same files and differ only in name and title",
                    uncertainty: "Path shape and the inspected files only; behaviour is unverified",
                    workflow: {
                      trigger: "A new member is added",
                      representativeCase: "One member lacks a shared file",
                      inputs: ["Member name", "Member title"],
                      currentProcess: ["Copy a member by hand and rename"],
                      output: "The member's files",
                      successCheck: "Every member has the shared files",
                      affectedSubproject: { scope: "subproject", path: fixture.parent },
                      mutationBoundary: "Only family member files",
                      repeatability: { basis: "observed", explanation: "Three similar members" },
                    },
                    choice: {
                      kind: "generate-from-reference",
                      generator: {
                        version: 1,
                        familyId,
                        members: fixture.members,
                        sharedShape: fixture.template.map((file) => path.posix.basename(file.path)),
                        varyingInputs: ["Member name", "Member title"],
                        reference:
                          fixture.reference.kind === "existing-member"
                            ? {
                                kind: "existing-member",
                                path: fixture.reference.path,
                                reason: "The only member with every shared file",
                              }
                            : {
                                kind: "build-by-hand-first",
                                reason: "Every member lacks a different shared file",
                              },
                        risks: ["Hand-edited member files may differ from the template"],
                        verificationExpectations: ["The generator reproduces the reference exactly"],
                      },
                    },
                    alternatives: [
                      { kind: "reuse-command", reasonNotSelected: "No existing generator" },
                      { kind: "manual", reasonNotSelected: "Members are added repeatedly" },
                    ],
                    evidence: {
                      version: 1,
                      items: evidencePaths.map((file, index) => ({
                        basis: "observed",
                        source: receiptOf(params, readIds[index] ?? ""),
                        code: "family-member",
                        severity: "info",
                        message: `Inspected ${file}`,
                        location: { path: file },
                      })),
                    },
                  },
                ],
              },
              "submit",
            ),
          ],
        ],
        () => adapter.handle({ version: 1, action: "discover", requestId: "family-discovery" }),
      );
      const discovered = discovery.outcome as Awaited<ReturnType<typeof adapter.handle>>;
      expect(discovered.status, JSON.stringify(discovered.body).slice(0, 4000)).toBe(200);
      expect(discovered.body).toMatchObject({
        assessment: { status: "completed", mode: "setup" },
      });
      const candidate =
        "assessment" in discovered.body
          ? discovered.body.assessment?.discovery?.candidates[0]
          : undefined;
      if (!candidate) throw new Error("Missing generate-from-reference candidate");
      expect(candidate.choice).toBe("generate-from-reference");
      const recommendationText = "Proposal only: use one reference example";
      expect(JSON.stringify(session.getMessages())).toContain(recommendationText);
      const transcriptAfterDiscovery = session.getMessages().map((message) => JSON.stringify(message));
      const reportBefore = await adapter.handle({ version: 1, action: "report", offset: 0 });

      // 2. Review: bounded inspection; creation, apply and shell are refused.
      let reviewHandle = randomUUID();
      const review = await turn(
        [
          () => readCalls(),
          ...(fixture.reference.kind === "existing-member"
            ? ([
                () => [
                  call(
                    "programmatic_command",
                    { action: "inspect", proposal: generatorDraft(fixture, familyId) },
                    "review-catalog",
                  ),
                ],
                (params) => [
                  call(
                    "programmatic_command",
                    {
                      action: "inspect",
                      proposal: {
                        ...generatorDraft(fixture, familyId),
                        review: {
                          inventorySha256: resultJson(params, "review-catalog").catalog.sha256,
                          disposition: "create",
                          rationale: "No existing generator for this family",
                        },
                      },
                    },
                    "review-draft",
                  ),
                ],
              ] satisfies Step[])
            : []),
          (params) => {
            if (fixture.reference.kind === "existing-member") {
              const draft = resultJson(params, "review-draft");
              expect(draft).toMatchObject({ status: "proposal" });
              reviewHandle = draft.handle;
            }
            return [
              call("programmatic_command", { action: "create", handle: reviewHandle }, "no-create"),
              call(
                "programmatic_command",
                { action: "apply_family", handle: reviewHandle, preview_id: randomUUID() },
                "no-apply",
              ),
              call("bash", { command: "echo forbidden" }, "no-bash"),
            ];
          },
        ],
        () =>
          adapter.handle({
            version: 1,
            action: "review-candidate",
            intent: "review-only",
            source: "current",
            assessmentId: candidate.assessmentId,
            candidateId: candidate.candidateId,
            expectedRevision: candidate.revision,
          }),
      );
      const reviewed = review.outcome as Awaited<ReturnType<typeof adapter.handle>>;
      expect(reviewed.status, JSON.stringify(reviewed.body).slice(0, 4000)).toBe(200);
      expect(reviewed.body).toMatchObject({ candidateReview: { status: "prepared" } });
      for (const id of ["no-create", "no-apply", "no-bash"]) {
        const refused = toolResults(last()).find((item) => item.toolCallId === id);
        expect(refused?.isError, id).toBe(true);
      }
      // No implicit creation, execution or approval after detect, recommend and review.
      expect(cards).toEqual([]);
      expect(await commandFiles()).toEqual([]);
      expect(await exists(".gg/programmatic/profile.json")).toBe(false);
      expect(await exists(".gg/programmatic/state.json")).toBe(false);
      expect(await exists(".gg/programmatic")).toBe(false);
      expect(await snapshot(cwd, fixture.parent)).toEqual(original);
      expect(claim.active).toBe(false);

      // 3. Reference: build it by hand through the ordinary approved write tool.
      let familyBefore = original;
      if (fixture.reference.kind === "build-by-hand-first") {
        const writes = Object.entries(fixture.reference.build);
        await turn(
          [() => writes.map(([file, content]) => call("write", { file_path: file, content }))],
          () => session.prompt(`Finish ${fixture.reference.path} by hand as the reference.`),
        );
        for (const [file, content] of writes)
          expect(await fs.readFile(path.join(cwd, file), "utf8")).toBe(content);
        familyBefore = await snapshot(cwd, fixture.parent);
        expect(cards).toEqual([]);
      }

      // 4-6. Create (card #1), reproduce the reference, preview without writing.
      answer = (question) => question.options?.[0]?.value ?? "";
      let handle = "";
      let firstPreview: Record<string, unknown> = {};
      const draft = generatorDraft(fixture, familyId);
      await turn(
        [
          () => [call("tool_search", { query: "programmatic_command" }, "load")],
          () => [call("programmatic_command", { action: "inspect", proposal: draft }, "catalog-c")],
          (params) => [
            call(
              "programmatic_command",
              {
                action: "inspect",
                proposal: {
                  ...draft,
                  review: {
                    inventorySha256: resultJson(params, "catalog-c").catalog.sha256,
                    disposition: "create",
                    rationale: "No existing generator for this family",
                  },
                },
              },
              "draft-c",
            ),
          ],
          (params) => {
            expect(resultJson(params, "draft-c")).toMatchObject({ status: "proposal" });
            handle = resultJson(params, "draft-c").handle;
            return [call("programmatic_command", { action: "create", handle }, "create")];
          },
          (params) => {
            expect(resultJson(params, "create")).toMatchObject({ created: true });
            expect(cards).toHaveLength(1);
            return [call("programmatic_command", { action: "verification", handle }, "verify")];
          },
          (params) => {
            const verified = resultJson(params, "verify");
            expect(verified.generator).toMatchObject({
              generatorVerified: true,
              referenceCheck: { result: "passed" },
              projectCheck: { status: "none-found" },
            });
            expect(verified.report.cases).toContainEqual(
              expect.objectContaining({ category: "reproduces-reference", result: "passed" }),
            );
            return [call("programmatic_command", { action: "preview_family", handle }, "preview")];
          },
          (params) => {
            firstPreview = resultJson(params, "preview");
            return [];
          },
        ],
        () => session.prompt("Create the reviewed generator, verify it and preview the family."),
      );
      expect(await commandFiles()).toContain(`${draft.name}.md`);
      expect(firstPreview).toMatchObject({
        status: "previewed",
        written: false,
        members: fixture.expected.members.map((member) => ({
          path: member.path,
          status: member.preview,
          files: member.files,
        })),
        git: git ? { repository: true, dirty: [] } : { repository: false },
        projectCheck: null,
      });
      // Preview writes nothing.
      expect(await snapshot(cwd, fixture.parent)).toEqual(familyBefore);
      expect(await exists(".gg/programmatic")).toBe(false);

      // 7. Apply: a rejected card writes nothing; an earlier card's approval does not
      // approve a later preview; only the fresh card's own answer applies.
      let changedBeforeAnswer = true;
      answer = async (question) => {
        const index = cards.length - 1;
        if (index === 1) return "reject";
        if (index === 2) {
          const replayed = cards[1]?.options?.[0]?.value ?? "";
          expect(question.options?.map((option) => option.value)).not.toContain(replayed);
          return replayed;
        }
        changedBeforeAnswer =
          JSON.stringify(await snapshot(cwd, fixture.parent)) !== JSON.stringify(familyBefore);
        return question.options?.[0]?.value ?? "";
      };
      const applySteps: Step[] = [() => [call("tool_search", { query: "programmatic_command" })]];
      for (const attempt of ["rejected", "replayed", "approved"]) {
        applySteps.push(() => [
          call("programmatic_command", { action: "preview_family", handle }, `preview-${attempt}`),
        ]);
        applySteps.push((params) => [
          call(
            "programmatic_command",
            {
              action: "apply_family",
              handle,
              preview_id: resultJson(params, `preview-${attempt}`).previewId,
            },
            `apply-${attempt}`,
          ),
        ]);
      }
      let applied: Record<string, unknown> = {};
      applySteps.push((params) => {
        expect(resultJson(params, "apply-rejected")).toEqual({
          status: "unavailable",
          reason: "apply-not-approved",
        });
        expect(resultJson(params, "apply-replayed")).toEqual({
          status: "unavailable",
          reason: "apply-not-approved",
        });
        applied = resultJson(params, "apply-approved");
        return [];
      });
      await turn(applySteps, () => session.prompt("Apply the previewed generator to the family."));
      expect(changedBeforeAnswer, "no family file changed before the apply card was answered").toBe(
        false,
      );
      expect(cards).toHaveLength(4);
      expect(cards[0]?.question).not.toContain("Write the previewed generator output");
      for (const card of cards.slice(1))
        expect(card.question).toContain("Write the previewed generator output");
      expect(new Set(cards.map((card) => card.id)).size).toBe(4);
      expect(new Set(cards.slice(1).map((card) => card.options?.[0]?.value)).size).toBe(3);

      // 8. Report matches disk.
      expect(applied).toMatchObject({
        status: "applied",
        report: {
          status: fixture.expected.report,
          members: fixture.expected.members.map((member) => ({
            path: member.path,
            status: member.applied,
          })),
        },
      });
      const after = await snapshot(cwd, fixture.parent);
      for (const member of fixture.expected.members) {
        const values = fixture.values[member.path] ?? {};
        for (const file of member.files) {
          const template = fixture.template.find((item) =>
            file.path.endsWith(`/${path.posix.basename(item.path)}`),
          );
          const rendered = (template?.content ?? "").replace(
            /\{\{(\w+)\}\}/g,
            (_, key: string) => values[key] ?? "",
          );
          if (member.applied === "skipped" || file.action === "conflict")
            expect(after[file.path], file.path).toBe(familyBefore[file.path]);
          else expect(after[file.path], file.path).toBe(rendered);
        }
      }
      expect(await exists(".gg/programmatic/generated")).toBe(true);

      // 9. Rescan: a fresh discovery sees the applied members complete.
      const rescan = await turn(
        [
          (params) => {
            const family = setupFamilies(params).families.find(
              (item) => item.kind === "sibling-directories" && item.parent === fixture.parent,
            );
            expect(family?.id).toBe(familyId);
            for (const member of family?.members ?? []) expect(member.missingCount).toBe(0);
            return [
              call(
                "programmatic_advisory_result",
                {
                  version: 2,
                  kind: "advisory",
                  coverage: { status: "limited", scope: fixture.parent, reason: "Rescan only" },
                  recommendations: [],
                },
                "rescan-submit",
              ),
            ];
          },
        ],
        () => adapter.handle({ version: 1, action: "discover", requestId: "family-rescan" }),
      );
      expect((rescan.outcome as Awaited<ReturnType<typeof adapter.handle>>).status).toBe(200);
      let secondPreview: Record<string, unknown> = {};
      await turn(
        [
          () => [call("tool_search", { query: "programmatic_command" })],
          () => [call("programmatic_command", { action: "verification", handle }, "reverify")],
          (params) => {
            expect(resultJson(params, "reverify").generator).toMatchObject({
              generatorVerified: true,
            });
            return [call("programmatic_command", { action: "preview_family", handle }, "again")];
          },
          (params) => {
            secondPreview = resultJson(params, "again");
            return [];
          },
        ],
        () => session.prompt("Preview the family again."),
      );
      expect(secondPreview).toMatchObject({
        status: "previewed",
        written: false,
        members: fixture.expected.members.map((member) => ({
          path: member.path,
          status: member.applied === "skipped" ? "conflict" : "unchanged",
        })),
      });
      expect(await snapshot(cwd, fixture.parent)).toEqual(after);
      expect(cards).toHaveLength(4);

      // No history loss: the transcript only grows and keeps the first recommendation;
      // the lifecycle report and profile are neither created nor rewritten.
      const transcript = session.getMessages().map((message) => JSON.stringify(message));
      expect(transcript.slice(0, transcriptAfterDiscovery.length)).toEqual(transcriptAfterDiscovery);
      expect(transcript.length).toBeGreaterThan(transcriptAfterDiscovery.length);
      expect(JSON.stringify(session.getMessages())).toContain(recommendationText);
      // The configuration fingerprint covers project files and moves with the
      // generator and applied files; every recorded row and status stays the same.
      const withoutFingerprint = (response: Awaited<ReturnType<typeof adapter.handle>>) =>
        JSON.parse(JSON.stringify(response), (key, value) =>
          key === "currentFingerprint" ? undefined : value,
        );
      expect(
        withoutFingerprint(await adapter.handle({ version: 1, action: "report", offset: 0 })),
      ).toEqual(withoutFingerprint(reportBefore));
      expect(await exists(".gg/programmatic/profile.json")).toBe(false);
      expect(await exists(".gg/programmatic/state.json")).toBe(false);
      expect(claim.active).toBe(false);
    } finally {
      adapter.dispose();
      await session.dispose();
    }
  },
);
