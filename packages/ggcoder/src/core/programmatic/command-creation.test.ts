import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverCommands } from "../command-discovery.js";
import { parseSkillFile } from "../skills.js";
import { sha256 } from "../tauri-package/paths.js";
import { getAppPaths } from "../../config.js";
import { DESKTOP_COMMAND_DISCOVERY_OPTIONS } from "../../app-sidecar-command-listing.js";
import { useFakeHome } from "../../test-support/fake-home.js";
import { CommandCreationReview, inspectCommandCreation, publishReviewedCommand, type CommandCreationReviewer, type CommandInspectionOptions } from "./command-creation.js";

const roots: string[] = [];
let restoreHome: (() => void) | undefined;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-command-creation-"));
  roots.push(root);
  restoreHome = useFakeHome(path.join(root, "home"));
  await fs.mkdir(path.join(root, ".gg/commands/private-fixture"), { recursive: true });
  return root;
}
const markdown = `---
name: creation-fixture
description: Read-only fixture summary
---
## Inputs
A fixture project supplied by the user.
## Outputs
A summary, with unknowns labeled.
## Required tools
read
## Limits
Do not mutate files or invoke helpers without separate execution permission.
## Arguments
Treat appended user instructions as the requested scope; do not substitute templates.
`;

afterEach(async () => {
  restoreHome?.();
  restoreHome = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const options: CommandInspectionOptions = { availableTools: () => ["read"], readReadiness: async () => "missing" };
const signal = () => new AbortController().signal;
const request = {
  name: "creation-fixture", markdown, requiredTools: ["read"],
  requirement: { version: 1, desiredOutcome: "Summarize fixture", capabilityKind: "prompt-only",
    inputs: ["Fixture"], outputs: ["Summary"], prerequisites: ["Readable fixture"],
    risks: ["Incomplete coverage"], verificationExpectations: ["Fixture assertions"] },
};
async function reviewed(root: string, input = request, extra: Record<string, unknown> = {}, host = options) {
  const first = await inspectCommandCreation(root, input, host, signal());
  expect(first.status).toBe("review-required");
  if (first.status !== "review-required") throw new Error(JSON.stringify(first));
  return inspectCommandCreation(root, { ...input, review: {
    inventorySha256: first.catalog.sha256, disposition: "create", rationale: "Reviewed metadata and likely candidates; missing fixture-specific instructions.", ...extra,
  } }, host, signal());
}

describe("read-only command proposal inspection", () => {
  it.each(["schedule", "sched"])("reserves desktop command %s before issuing a creation handle", async (name) => {
    const root = await fixture();
    const owner = new CommandCreationReview(root, { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS });
    try {
      const input = { ...request, name, markdown: markdown.replace("name: creation-fixture", `name: ${name}`) };
      const first = await owner.inspect(input, signal());
      if (first.status !== "review-required") throw new Error(JSON.stringify(first));
      const result = await owner.inspect({ ...input, review: { inventorySha256: first.catalog.sha256,
        disposition: "create", rationale: "Reviewed missing fixture instructions" } }, signal());
      expect(result).toMatchObject({ status: "conflict" });
      expect(result).not.toHaveProperty("handle");
      expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
    } finally { owner.dispose(); }
  });
  it("keeps another desktop command creatable without inventing client execution handlers", async () => {
    const root = await fixture();
    const host = { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS };
    const result = await reviewed(root, request, {}, host);
    if (result.status !== "proposal") throw new Error(JSON.stringify(result));
    expect(await publishReviewedCommand(result.value, host, signal())).toMatchObject({ created: true, loads: true });
    const discovery = await discoverCommands(root, host);
    expect(discovery.resolve("creation-fixture")?.custom).toBeDefined();
    expect(discovery.resolve("schedule")).toBeUndefined();
    expect(discovery.resolve("sched")).toBeUndefined();
  });

  it.each(["SCHEDULE", "ScHeD"])("normalizes reserved desktop identity %s", async (identity) => {
    const root = await fixture();
    const name = identity.toLowerCase();
    const host = { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS, reservedCommandIdentities: [identity] };
    expect(await reviewed(root, { ...request, name, markdown: markdown.replace("name: creation-fixture", `name: ${name}`) }, {}, host))
      .toMatchObject({ status: "conflict" });
  });

  it.each(["add", "remove"])("requires re-review when reserved inventory changes: %s", async (change) => {
    const root = await fixture();
    const host = { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS };
    const first = await inspectCommandCreation(root, request, host, signal());
    if (first.status !== "review-required") throw new Error(JSON.stringify(first));
    const reservedCommandIdentities = change === "add" ? [...host.reservedCommandIdentities, "another-client-action"] : [];
    const result = await inspectCommandCreation(root, { ...request, review: { inventorySha256: first.catalog.sha256,
      disposition: "create", rationale: "Missing" } }, { ...host, reservedCommandIdentities }, signal());
    expect(result.status).toBe("review-required");
    if (result.status !== "review-required") throw new Error(JSON.stringify(result));
    expect(result.catalog.sha256).not.toBe(first.catalog.sha256);
    expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
  });

  it.each(["before-review", "during-review"])("invalidates a creation handle on reserved inventory drift %s", async (stage) => {
    const root = await fixture();
    const reservedCommandIdentities = [...DESKTOP_COMMAND_DISCOVERY_OPTIONS.reservedCommandIdentities];
    const review = vi.fn<CommandCreationReviewer>(async (question, abortSignal) => {
      reservedCommandIdentities.push("unrelated-client-action");
      return accept(question, abortSignal);
    });
    const owner = new CommandCreationReview(root, { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS,
      reservedCommandIdentities, reviewCreation: review });
    try {
      const proposal = await pending(owner);
      if (stage === "before-review") reservedCommandIdentities.push("another-client-action");
      const publish = vi.fn(async () => ({ status: "fixture-published" }));
      expect(await owner.consume(proposal.handle, signal(), publish)).toMatchObject({ status: "unavailable", reason: "stale-proposal-review-again" });
      expect(publish).not.toHaveBeenCalled();
      expect(review).toHaveBeenCalledTimes(stage === "before-review" ? 0 : 1);
    } finally { owner.dispose(); }
  });

  it.each(["before-publication", "before-staging"])("refuses publication after reserved inventory drift %s", async (stage) => {
    const root = await fixture();
    const reservedCommandIdentities = [...DESKTOP_COMMAND_DISCOVERY_OPTIONS.reservedCommandIdentities];
    const host = { ...options, ...DESKTOP_COMMAND_DISCOVERY_OPTIONS, reservedCommandIdentities };
    const result = await reviewed(root, request, {}, host);
    if (result.status !== "proposal") throw new Error(JSON.stringify(result));
    if (stage === "before-staging") reservedCommandIdentities.push(request.name);
    expect(await publishReviewedCommand(result.value, { ...host, onStage: (current) => {
      if (current === "before-publication") reservedCommandIdentities.push(request.name);
    } }, signal())).toMatchObject({ created: false, loads: false, residualPaths: [] });
    expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
  });

  it("requires a fresh suitability review and produces complete exact bytes without writes", async () => {
    const root = await fixture();
    const before = await fs.readdir(path.join(root, ".gg/commands"));
    const result = await reviewed(root);
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") throw new Error(JSON.stringify(result));
    expect(result.value.files).toEqual([{ path: ".gg/commands/creation-fixture.md", content: markdown }]);
    expect(JSON.parse(result.value.preview).files).toEqual(result.value.files);
    expect(result.value.proposal.snapshot.bodySha256).toBe(sha256(parseSkillFile(markdown, "project").content));
    expect(result.value.proposal.files[0]?.proposedSha256).toBe(sha256(markdown));
    expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(before);
  });

  it.each(["creation-fixture", "CREATION-FIXTURE"])("rejects hidden frontmatter collision %s", async (name) => {
    const root = await fixture();
    await fs.writeFile(path.join(root, ".gg/commands/other.md"), `---\nname: ${name}\n---\nBody`);
    expect(await reviewed(root)).toMatchObject({ status: "conflict" });
  });

  it("rejects filename and reserved alias collisions even when shadowed", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, ".gg/commands/CREATION-FIXTURE.MD"), "---\nname: another-name\n---\nBody");
    expect(await reviewed(root)).toMatchObject({ status: "conflict" });
    const host = { ...options, registryActions: [{ name: "hidden", aliases: ["creation-fixture"], description: "Host",
      input: { text: "optional" as const, references: "none" as const, attachments: "none" as const }, source: "built-in" as const }] };
    expect(await reviewed(root, request, {}, host)).toMatchObject({ status: "conflict" });
  });

  it.each(["built-in", "project", "global"])("returns reviewed reuse of a %s command", async (source) => {
    const root = await fixture();
    const name = source === "built-in" ? "compare" : "existing-fixture";
    if (source !== "built-in") {
      const dir = source === "project" ? path.join(root, ".gg/commands") : path.join(getAppPaths().agentDir, "commands");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\nExisting summary`);
    }
    const input = { ...request, candidates: [name] };
    expect(await reviewed(root, input, { disposition: "reuse", reuseName: name })).toMatchObject({ status: "reuse", command: name });
  });

  it("requires re-review after an unrelated inventory edit", async () => {
    const root = await fixture();
    const first = await inspectCommandCreation(root, request, options, signal());
    if (first.status !== "review-required") throw new Error(JSON.stringify(first));
    await fs.writeFile(path.join(root, ".gg/commands/other.md"), "Existing command");
    expect(await inspectCommandCreation(root, { ...request, review: { inventorySha256: first.catalog.sha256,
      disposition: "create", rationale: "Missing" } }, options, signal())).toMatchObject({ status: "review-required" });
  });

  it.each(["../escape", "CON", "nul", "com1", "x:y", "x.", "/absolute", "nested/name"])("rejects unsafe command name %s", async (name) => {
    const root = await fixture();
    expect(await inspectCommandCreation(root, { ...request, name }, options, signal())).toMatchObject({ status: "unavailable" });
  });

  it("rejects linked command directories without reading escaped content", async () => {
    const root = await fixture();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, ".gg/commands/linked.md"), "junction");
    expect(await inspectCommandCreation(root, request, options, signal())).toMatchObject({ status: "unavailable" });
  });

  it.each(["", "---\nname: broken", markdown.replace("## Limits", "## Omitted"), markdown + "\u0000", markdown + "x".repeat(65_000)])("rejects malformed or unreviewable content %#", async (content) => {
    const root = await fixture();
    const input = { ...request, markdown: content };
    if (!content) expect(await inspectCommandCreation(root, input, options, signal())).toMatchObject({ status: "unavailable" });
    else expect(await reviewed(root, input)).toMatchObject({ status: "unavailable" });
  });

  it("keeps helpers private with exact paths and refuses unavailable tooling", async () => {
    const root = await fixture();
    expect(await reviewed(root, { ...request, requiredTools: ["not_installed"] })).toMatchObject({ status: "unavailable" });
    const result = await reviewed(root, { ...request, requirement: { ...request.requirement, capabilityKind: "script-backed" },
      helpers: [{ name: "summary.mjs", content: "export const count = (items) => items.length;\n", repeatableLogic: "Count fixture items" }] } as typeof request);
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") throw new Error(JSON.stringify(result));
    expect(result.value.proposal.snapshot.helpers[0]?.path).toBe(".gg/commands/.creation-fixture-helpers/summary.mjs");
    expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
  });

  it("binds installed package bytes and rejects missing helper runtimes, duplicates and unreadable catalogs", async () => {
    const root = await fixture();
    const input = { ...request, packages: ["fixture-package"] };
    expect(await reviewed(root, input)).toMatchObject({ status: "unavailable" });
    await fs.mkdir(path.join(root, "node_modules/fixture-package"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules/fixture-package/package.json"), '{"name":"fixture-package","version":"1.0.0"}');
    const first = await reviewed(root, input);
    expect(first.status).toBe("proposal");
    await fs.writeFile(path.join(root, "node_modules/fixture-package/package.json"), '{"name":"fixture-package","version":"2.0.0"}');
    const second = await reviewed(root, input);
    if (first.status !== "proposal" || second.status !== "proposal") throw new Error("missing proposals");
    expect(first.value.prerequisiteSha256).not.toBe(second.value.prerequisiteSha256);
    const helper = { name: "helper.py", content: "print('fixture')", repeatableLogic: "Count" };
    const script = { ...request, requirement: { ...request.requirement, capabilityKind: "script-backed" }, helpers: [helper] };
    expect(await reviewed(root, script)).toMatchObject({ status: "unavailable" });
    expect(await reviewed(root, { ...script, helpers: [{ ...helper, name: "helper.mjs" }, { ...helper, name: "helper.mjs" }] } as typeof request))
      .toMatchObject({ status: "unavailable" });
    await fs.writeFile(path.join(root, ".gg/commands/invalid.md"), Buffer.from([0xff, 0xfe]));
    expect(await inspectCommandCreation(root, request, options, signal())).toMatchObject({ status: "unavailable" });
    await fs.writeFile(path.join(root, ".gg/commands/invalid.md"), "x".repeat(128_001));
    expect(await inspectCommandCreation(root, request, options, signal())).toMatchObject({ status: "unavailable" });
  });

  it("distinguishes development, manual alternatives, remote denial and cancellation", async () => {
    const root = await fixture();
    expect(await inspectCommandCreation(root, { ...request, requirement: { ...request.requirement, capabilityKind: "app-backed" } }, options, signal()))
      .toMatchObject({ status: "development" });
    expect(await reviewed(root, request, { disposition: "manual" })).toMatchObject({ status: "manual" });
    expect(await inspectCommandCreation(root, request, { ...options, localFilesystem: false }, signal())).toMatchObject({ status: "unavailable" });
    const controller = new AbortController(); controller.abort();
    expect(await inspectCommandCreation(root, request, options, controller.signal)).toMatchObject({ status: "unavailable", reason: "cancelled" });
  });
});

const accept: CommandCreationReviewer = async ({ questions }) => ({ action: "answer", answers: {
  [questions[0]!.id]: questions[0]!.options![0]!.value!,
} });
async function pending(owner: CommandCreationReview) {
  const first = await owner.inspect(request, signal());
  if (first.status !== "review-required") throw new Error(JSON.stringify(first));
  const second = await owner.inspect({ ...request, review: { inventorySha256: first.catalog.sha256,
    disposition: "create", rationale: "Reviewed missing fixture instructions" } }, signal());
  if (second.status !== "proposal") throw new Error(JSON.stringify(second));
  return second;
}

describe("host-owned creation review", () => {
  it("binds exact host preview and consumes once before concurrent publication", async () => {
    const root = await fixture();
    const review = vi.fn(accept);
    const owner = new CommandCreationReview(root, { ...options, reviewCreation: review });
    const proposal = await pending(owner);
    const publish = vi.fn(async () => ({ status: "fixture-published" }));
    const results = await Promise.all([owner.consume(proposal.handle, signal(), publish), owner.consume(proposal.handle, signal(), publish)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fixture-published", "unavailable"]);
    expect(publish).toHaveBeenCalledOnce(); expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0]![0].questions[0]!.detail).toBe(proposal.preview);
    expect(review.mock.calls[0]![0].questions[0]!.allowOther).toBe(false);
    expect(await owner.consume(proposal.handle, signal(), publish)).toMatchObject({ status: "unavailable" });
    owner.dispose();
  });

  it("rejects a changed physical project owner even when all reviewed bytes were copied", async () => {
    const root = await fixture();
    const saved = `${root}-old-owner`; roots.push(saved);
    const owner = new CommandCreationReview(root, { ...options, reviewCreation: async (question, abortSignal) => {
      await fs.rename(root, saved); await fs.cp(saved, root, { recursive: true });
      return accept(question, abortSignal);
    } });
    const value = await pending(owner);
    const publish = vi.fn(async () => ({ status: "fixture-published" }));
    expect(await owner.consume(value.handle, signal(), publish)).toMatchObject({ status: "unavailable" });
    expect(publish).not.toHaveBeenCalled(); owner.dispose();
  });

  it.each(["reject", "free-text", "timeout", "drift", "plan", "headless", "dispose", "supersede", "cross-session"])("writes nothing for %s", async (mode) => {
    const root = await fixture();
    const planModeRef = { current: false };
    const reviewer: CommandCreationReviewer = async (question, abortSignal) => {
      if (mode === "timeout") return { action: "cancel" };
      if (mode === "drift") await fs.writeFile(path.join(root, ".gg/commands/creation-fixture.md"), "User file");
      if (mode === "plan") planModeRef.current = true;
      if (mode === "reject" || mode === "free-text") return { action: "answer", answers: { [question.questions[0]!.id]: mode } };
      return accept(question, abortSignal);
    };
    const owner = new CommandCreationReview(root, { ...options, planModeRef, ...(mode === "headless" ? {} : { reviewCreation: reviewer }) });
    const proposal = await pending(owner);
    const publish = vi.fn(async () => ({ status: "fixture-published" }));
    if (mode === "dispose") owner.dispose();
    if (mode === "supersede") await pending(owner);
    const consumer = mode === "cross-session" ? new CommandCreationReview(root, { ...options, reviewCreation: accept }) : owner;
    expect(await consumer.consume(proposal.handle, signal(), publish)).toMatchObject({ status: "unavailable" });
    expect(publish).not.toHaveBeenCalled();
    owner.dispose(); consumer.dispose();
  });
});

describe("command-last no-clobber publication", () => {
  async function proposal(root: string) {
    const input = { ...request, requirement: { ...request.requirement, capabilityKind: "script-backed" }, helpers: [
      { name: "a.mjs", content: "export const a = 1;\n", repeatableLogic: "Fixture a" },
      { name: "b.mjs", content: "export const b = 2;\n", repeatableLogic: "Fixture b" },
    ] };
    const result = await reviewed(root, input);
    if (result.status !== "proposal") throw new Error(JSON.stringify(result));
    return result.value;
  }
  it("publishes complete helpers before discoverable Markdown and never overwrites", async () => {
    const root = await fixture(); const value = await proposal(root);
    await fs.writeFile(path.join(root, ".gg/command-creation.lock"), "Existing user content, not an owned lock");
    const onPreFileMutation = vi.fn(); const onFileMutated = vi.fn();
    const result = await publishReviewedCommand(value, { ...options, onPreFileMutation, onFileMutated }, signal());
    expect(result).toMatchObject({ status: "created", created: true, loads: true, executionApproved: false, residualPaths: [] });
    for (const file of value.files) expect(await fs.readFile(path.join(root, file.path), "utf8")).toBe(file.content);
    expect(onPreFileMutation).toHaveBeenCalled(); expect(onFileMutated).toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, ".gg/command-creation.lock"), "utf8")).toBe("Existing user content, not an owned lock");
    expect((await fs.readdir(path.join(root, ".gg"))).sort()).toEqual(["command-creation.lock", "commands"]);
    expect(await publishReviewedCommand(value, options, signal())).toMatchObject({ created: false });
  });
  it.each(["before-helper", "after-helper", "before-publication", "after-publication"] as const)("preserves the commit point on fault at %s", async (stage) => {
    const root = await fixture(); const value = await proposal(root);
    const result = await publishReviewedCommand(value, { ...options, onStage: (current) => { if (current === stage) throw new Error("fixture fault"); } }, signal());
    const committed = stage === "after-publication";
    expect(result.created).toBe(committed);
    expect(!!(await discoverCommands(root, options)).resolve("creation-fixture")).toBe(committed);
    if (committed) for (const file of value.files) expect(await fs.readFile(path.join(root, file.path), "utf8")).toBe(file.content);
  });
  it("preserves a competing writer and concurrently changed helper during cleanup", async () => {
    const root = await fixture(); const value = await proposal(root);
    const result = await publishReviewedCommand(value, { ...options, onStage: async (stage, destination) => {
      if (stage === "before-publication") {
        await fs.writeFile(destination, "User command");
        await fs.writeFile(path.join(root, ".gg/commands/.creation-fixture-helpers/a.mjs"), "User helper");
      }
    } }, signal());
    expect(result.created).toBe(false);
    expect(await fs.readFile(path.join(root, ".gg/commands/creation-fixture.md"), "utf8")).toBe("User command");
    expect(await fs.readFile(path.join(root, ".gg/commands/.creation-fixture-helpers/a.mjs"), "utf8")).toBe("User helper");
    expect(result.residualPaths).toContain(".gg/commands/.creation-fixture-helpers/a.mjs");
  });
  it("fails closed when the filesystem cannot publish a no-replace link", async () => {
    const root = await fixture(); const value = await proposal(root);
    const link = vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));
    try {
      expect(await publishReviewedCommand(value, options, signal())).toMatchObject({ created: false, residualPaths: [] });
      expect((await discoverCommands(root, options)).resolve("creation-fixture")).toBeUndefined();
      expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
    } finally { link.mockRestore(); }
  });
  it.each(["a.mjs", "b.mjs"])("cleans up a fault after helper %s without exposing a command", async (name) => {
    const root = await fixture(); const value = await proposal(root);
    expect(await publishReviewedCommand(value, { ...options, onStage: (stage, file) => {
      if (stage === "after-helper" && path.basename(file) === name) throw new Error("fault");
    } }, signal())).toMatchObject({ created: false, residualPaths: [] });
    expect((await discoverCommands(root, options)).resolve("creation-fixture")).toBeUndefined();
    expect(await fs.readdir(path.join(root, ".gg/commands"))).toEqual(["private-fixture"]);
  });
  it("fails closed when the actual no-replace link loses a race", async () => {
    const root = await fixture(); const value = await proposal(root);
    const link = fs.link.bind(fs);
    const competing = vi.spyOn(fs, "link").mockImplementationOnce(async (source, destination) => {
      await fs.writeFile(destination, "Competing bytes");
      return link(source, destination);
    });
    try {
      expect(await publishReviewedCommand(value, options, signal())).toMatchObject({ created: false });
      expect(await fs.readFile(path.join(root, value.proposal.commandPath), "utf8")).toBe("Competing bytes");
    } finally { competing.mockRestore(); }
  });
  it("preserves interrupted helper sets and never restores their approval", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, ".gg/commands/.creation-fixture-helpers"));
    await fs.writeFile(path.join(root, ".gg/commands/.creation-fixture-helpers/a.mjs"), "Interrupted bytes");
    const input = { ...request, requirement: { ...request.requirement, capabilityKind: "script-backed" }, helpers: [
      { name: "a.mjs", content: "new bytes", repeatableLogic: "Count" },
    ] };
    expect(await reviewed(root, input)).toMatchObject({ status: "conflict" });
    expect((await discoverCommands(root, options)).resolve("creation-fixture")).toBeUndefined();
    expect(await fs.readFile(path.join(root, ".gg/commands/.creation-fixture-helpers/a.mjs"), "utf8")).toBe("Interrupted bytes");
  });
  it("reports committed files even when notifications fail", async () => {
    const root = await fixture(); const value = await proposal(root);
    const result = await publishReviewedCommand(value, { ...options, onFileMutated: () => { throw new Error("notify"); } }, signal());
    expect(result).toMatchObject({ created: true, loads: true });
    expect(result.warnings).toContain("mutation-notification-failed");
    const freshOwner = new CommandCreationReview(root, { ...options, reviewCreation: accept });
    expect((await freshOwner.inspect(request, signal())).status).toBe("review-required");
    freshOwner.dispose();
  });
});

describe("command creation loader baseline", () => {
  it("loads ordinary Markdown immediately but never private helper Markdown or staged bytes", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, ".gg/commands/creation-fixture.md"), markdown);
    await fs.writeFile(path.join(root, ".gg/commands/private-fixture/helper.md"), "helper body");
    await fs.writeFile(path.join(root, ".gg/commands/incomplete.pending"), markdown);
    const discovery = await discoverCommands(root, { readReadiness: async () => "missing" });
    const command = discovery.resolve("creation-fixture");
    expect(command?.custom?.prompt).toBe(parseSkillFile(markdown, "project").content);
    expect(command?.listing.origin).toBe("project-custom");
    expect(discovery.resolve("helper")).toBeUndefined();
    expect(discovery.resolve("incomplete")).toBeUndefined();
  });

  it("separates raw frontmatter identity from parsed executable prompt identity", () => {
    const edited = markdown.replace("Read-only fixture summary", "Changed description");
    expect(sha256(edited)).not.toBe(sha256(markdown));
    expect(sha256(parseSkillFile(edited, "project").content))
      .toBe(sha256(parseSkillFile(markdown, "project").content));
  });
});
