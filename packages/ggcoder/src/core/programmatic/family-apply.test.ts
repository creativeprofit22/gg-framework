import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useFakeHome } from "../../test-support/fake-home.js";
import { generatedRecordPath } from "../generated-files/owner.js";
import { sha256 } from "../tauri-package/paths.js";
import { inspectCommandCreation, publishReviewedCommand } from "./command-creation.js";
import { CommandVerification } from "./command-verification.js";
import { claimProgrammaticProject } from "./execution.js";
import {
  applyFamily,
  familyGitGate,
  familyOwnerId,
  planFamily,
  runProjectCheck,
  type FamilyApplyDeps,
  type FamilyApplyReport,
  type FamilyPlan,
  type ReadyGenerator,
} from "./family-apply.js";

let root: string;
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const options = { availableTools: () => ["bash"], readReadiness: async () => "missing" as const };
const FAMILY_ID = "0123456789abcdef";
const names = ["alpha", "beta", "delta", "gamma"];
const generatorInput = {
  familyId: FAMILY_ID,
  kind: "directory",
  reference: "tools/alpha",
  placeholders: ["name"],
  members: names.map((name) => ({
    path: `tools/${name}`,
    values: [{ key: "name", value: name }],
  })),
  files: [
    { path: "tools/{{name}}/__init__.py", content: "from .main import run\n" },
    { path: "tools/{{name}}/main.py", content: 'NAME = "{{name}}"\n' },
  ],
};
const rendered = (name: string) => ({
  [`tools/${name}/__init__.py`]: "from .main import run\n",
  [`tools/${name}/main.py`]: `NAME = "${name}"\n`,
});
const noGit: FamilyApplyDeps["git"] = async () => ({ repository: false });
const noChecks = () => [];

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function git(...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}
async function read(file: string): Promise<string | null> {
  return fs.readFile(path.join(root, file), "utf8").catch(() => null);
}
/** Every file's bytes under the root, for exact no-write assertions. */
async function tree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.name === ".git" || entry.name === "home") continue;
      if (entry.isDirectory()) await walk(absolute);
      else
        out[path.relative(root, absolute).split(path.sep).join("/")] = sha256(
          await fs.readFile(absolute),
        );
    }
  };
  await walk(root);
  return out;
}

async function verifiedGenerator(setup?: () => Promise<void>) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gg-family-apply-")));
  restore = useFakeHome(path.join(root, "home"));
  for (const [file, content] of Object.entries(rendered("alpha"))) await write(file, content);
  const input = {
    name: "family-fixture",
    requiredTools: ["bash"],
    markdown:
      "---\nname: family-fixture\ndescription: generator\n---\n## Inputs\nMember\n## Outputs\nFiles\n## Required tools\nbash\n## Limits\nFamily only\n## Arguments\nAppend member\n",
    generator: generatorInput,
    requirement: {
      version: 1,
      desiredOutcome: "Generate a family member",
      capabilityKind: "script-backed",
      inputs: ["Member"],
      outputs: ["Files"],
      prerequisites: ["Node"],
      risks: ["Template drift"],
      verificationExpectations: ["Reproduces the reference"],
    },
  };
  const first = await inspectCommandCreation(root, input, options, signal());
  if (first.status !== "review-required") throw new Error(JSON.stringify(first));
  const inspected = await inspectCommandCreation(
    root,
    {
      ...input,
      review: {
        inventorySha256: first.catalog.sha256,
        disposition: "create",
        rationale: "No existing generator",
      },
    },
    options,
    signal(),
  );
  if (inspected.status !== "proposal") throw new Error(JSON.stringify(inspected));
  await publishReviewedCommand(inspected.value, options, signal());
  const verifier = new CommandVerification(options);
  verifier.created(inspected.value);
  const handle = inspected.value.proposal.proposalId;
  expect(await verifier.inspect(handle, [], "", signal())).toMatchObject({
    generator: { generatorVerified: true },
  });
  await setup?.();
  return { verifier, handle, generator: await ready(verifier, handle) };
}
async function ready(verifier: CommandVerification, handle: string): Promise<ReadyGenerator> {
  const generator = await verifier.generatorForApply(handle, signal());
  if (generator.status !== "ready") throw new Error(JSON.stringify(generator));
  return generator;
}
async function plan(generator: ReadyGenerator, deps: FamilyApplyDeps = {}): Promise<FamilyPlan> {
  const result = await planFamily(generator, {}, signal(), {
    git: noGit,
    detectChecks: noChecks,
    ...deps,
  });
  if (result.status !== "planned") throw new Error(JSON.stringify(result));
  return result.plan;
}
const member = (report: FamilyApplyReport, name: string) =>
  report.members.find((item) => item.path === `tools/${name}`);

/** Statuses must match disk: written members hold the render, others kept their prior bytes. */
async function expectReportMatchesDisk(report: FamilyApplyReport, planned: FamilyPlan) {
  for (const item of planned.members) {
    const status = report.members.find((entry) => entry.path === item.path)?.status;
    const written = status === "created" || status === "updated";
    for (const file of item.files) {
      const bytes = await fs.readFile(path.join(root, file.path)).catch(() => null);
      if (written && file.action !== "skip")
        expect(bytes && sha256(bytes)).toBe(file.renderedSha256);
      else expect(bytes ? sha256(bytes) : undefined).toBe(file.priorSha256);
    }
    const record = await read(generatedRecordPath(item.ownerId));
    if (written) expect(record).not.toBeNull();
    else if (!item.files.some((file) => file.action === "unchanged")) expect(record).toBeNull();
  }
}

describe("family preview", () => {
  it("lists create, change, skip and conflict per member and writes nothing", async () => {
    const { generator } = await verifiedGenerator(async () => {
      // Unowned but byte-identical: skipped, never adopted.
      await write("tools/beta/__init__.py", "from .main import run\n");
      // Unowned and different: conflict, the whole member is skipped.
      await write("tools/gamma/main.py", "hand written\n");
    });
    const before = await tree();
    const planned = await plan(generator);
    expect(await tree()).toEqual(before);
    expect(planned.members.map((item) => [item.path, item.status])).toEqual([
      ["tools/beta", "ready"],
      ["tools/delta", "ready"],
      ["tools/gamma", "conflict"],
    ]);
    const actions = (name: string) =>
      planned.members
        .find((item) => item.path === `tools/${name}`)
        ?.files.map((file) => [file.path, file.action]);
    expect(actions("beta")).toEqual([
      ["tools/beta/__init__.py", "skip"],
      ["tools/beta/main.py", "create"],
    ]);
    expect(actions("gamma")).toEqual([
      ["tools/gamma/__init__.py", "create"],
      ["tools/gamma/main.py", "conflict"],
    ]);
    expect(planned.text).toContain("Nothing has been written.");
    expect(planned.text).toContain("Not a git repository: there is no git undo");
    expect(planned.text).toContain("only exact rendering will be checked");
    expect(planned.text).toContain("CONFLICT tools/gamma/main.py (not owned by");

    // Owned, unedited files with new bytes are `change`; a re-plan still writes nothing.
    const report = await applyFamily({
      root,
      plan: planned,
      runProjectCheck: false,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 60_000,
    });
    expect(member(report, "delta")?.status).toBe("created");
    const afterApply = await tree();
    const changed = await plan(generator, {
      render: async (input) => {
        const { renderMemberInFixture } = await import("./family-generator.js");
        const output = await renderMemberInFixture(input);
        if (output.status !== "rendered") return output;
        for (const [file, bytes] of output.files)
          if (file.endsWith("main.py"))
            output.files.set(file, Buffer.concat([bytes, Buffer.from("# v2\n")]));
        return output;
      },
    });
    expect(await tree()).toEqual(afterApply);
    expect(changed.members.find((item) => item.path === "tools/delta")?.files).toMatchObject([
      { path: "tools/delta/__init__.py", action: "unchanged" },
      { path: "tools/delta/main.py", action: "change" },
    ]);
  });

  it("changes its digest when a member file, the git state or the generator changes", async () => {
    const { verifier, handle, generator } = await verifiedGenerator();
    const first = await plan(generator);
    expect((await plan(generator)).previewSha256).toBe(first.previewSha256);
    await write("tools/gamma/notes.txt", "unrelated to the render\n");
    expect((await plan(generator)).previewSha256).toBe(first.previewSha256);
    await write("tools/gamma/main.py", "appeared after the preview\n");
    expect((await plan(generator)).previewSha256).not.toBe(first.previewSha256);
    await fs.rm(path.join(root, "tools/gamma/main.py"));
    expect(
      (
        await plan(generator, {
          git: async () => ({ repository: true, dirty: ["tools/beta/main.py"] }),
        })
      ).previewSha256,
    ).not.toBe(first.previewSha256);
    expect((await plan(generator, { detectChecks: () => ["npm test"] })).previewSha256).not.toBe(
      first.previewSha256,
    );
    // Reference or helper edits invalidate the verified generator itself.
    await write("tools/alpha/main.py", 'NAME = "edited"\n');
    expect(await verifier.generatorForApply(handle, signal())).toEqual({
      status: "unavailable",
      reason: "stale-generator-verify-again",
    });
    await write("tools/alpha/main.py", 'NAME = "alpha"\n');
    expect((await ready(verifier, handle)).binding).toEqual(generator.binding);
    const helper = path.join(root, generator.metadata.helperDirectory, "template.json");
    await fs.appendFile(helper, " ");
    expect(await verifier.generatorForApply(handle, signal())).toMatchObject({
      reason: "stale-generator-verify-again",
    });
    verifier.clear();
    expect(await verifier.generatorForApply(handle, signal())).toMatchObject({
      reason: "unknown-session-proposal",
    });
  });

  it("fails closed when git status cannot answer and refuses unknown or reference members", async () => {
    const { generator } = await verifiedGenerator();
    const failing = await planFamily(generator, {}, signal(), {
      detectChecks: noChecks,
      git: async () => {
        throw new Error("git timed out");
      },
    });
    expect(failing).toEqual({ status: "unavailable", reason: "git-status-failed" });
    expect(await planFamily(generator, { members: ["tools/alpha"] }, signal())).toEqual({
      status: "unavailable",
      reason: "reference-already-in-place",
    });
    expect(await planFamily(generator, { members: ["tools/omega"] }, signal())).toMatchObject({
      reason: "unknown-member: tools/omega",
    });
  });
});

describe.skipIf(!hasGit())("family git gate", () => {
  it("lists only dirty affected paths, and apply refuses them without an override", async () => {
    const { generator } = await verifiedGenerator(async () => {
      git("init", "-q");
      git("config", "user.email", "fixture@example.com");
      git("config", "user.name", "Fixture");
      git("config", "core.autocrlf", "false");
      git("add", "-A");
      git("commit", "-q", "-m", "fixture");
    });
    const clean = await plan(generator, { git: familyGitGate });
    expect(clean.git).toEqual({ repository: true, dirty: [] });
    expect(clean.text).toContain("affected paths have no uncommitted changes");
    await write("README.md", "unrelated dirty file\n");
    await write("tools/beta/__init__.py", "from .main import run\n");
    const dirty = await plan(generator, { git: familyGitGate });
    expect(dirty.git).toEqual({ repository: true, dirty: ["tools/beta/__init__.py"] });
    expect(dirty.previewSha256).not.toBe(clean.previewSha256);
    expect(dirty.text).toContain("Uncommitted changes to affected paths");
    const before = await tree();
    const base = {
      root,
      plan: dirty,
      runProjectCheck: false,
      signal: signal(),
      deadlineMs: 60_000,
    };
    await expect(applyFamily({ ...base, dirtyOverride: false })).rejects.toThrow(/override/);
    expect(await tree()).toEqual(before);
    const report = await applyFamily({ ...base, dirtyOverride: true });
    expect(report).toMatchObject({
      status: "completed",
      git: { repository: true, dirtyOverride: true, dirty: ["tools/beta/__init__.py"] },
    });
    await expectReportMatchesDisk(report, dirty);
  });
});

describe("family apply", () => {
  it("applies members independently: conflicts are never written and a mid-run failure rolls back only that member", async () => {
    const { generator } = await verifiedGenerator(async () => {
      await write("tools/gamma/main.py", "hand written\n");
    });
    const planned = await plan(generator);
    const mutated: string[] = [];
    const report = await applyFamily({
      root,
      plan: planned,
      runProjectCheck: false,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 60_000,
      onMutated: (file) => {
        mutated.push(path.relative(root, file).split(path.sep).join("/"));
      },
      deps: {
        afterWrite: (name, _file, index) => {
          if (name === "tools/delta" && index === 1) throw new Error("injected write failure");
        },
      },
    });
    expect(report.status).toBe("partial");
    expect(report.stopped).toBeNull();
    expect(member(report, "beta")).toMatchObject({
      status: "created",
      reason: "written; only exact rendering was checked",
    });
    expect(member(report, "delta")).toMatchObject({ status: "failed" });
    expect(member(report, "delta")?.reason).toContain("rolled back: injected write failure");
    expect(member(report, "gamma")).toMatchObject({ status: "skipped" });
    expect(member(report, "gamma")?.reason).toContain("tools/gamma/main.py: not owned by");
    expect(await read("tools/gamma/main.py")).toBe("hand written\n");
    expect(await read("tools/gamma/__init__.py")).toBeNull();
    expect(await read("tools/delta/main.py")).toBeNull();
    expect(await read("tools/delta/__init__.py")).toBeNull();
    expect(await read("tools/beta/main.py")).toBe('NAME = "beta"\n');
    expect(
      JSON.parse((await read(generatedRecordPath(familyOwnerId(FAMILY_ID, "tools/beta")))) ?? "{}"),
    ).toMatchObject({
      owner: familyOwnerId(FAMILY_ID, "tools/beta"),
      files: [{ path: "tools/beta/__init__.py" }, { path: "tools/beta/main.py" }],
    });
    // Watchers hear about committed paths and about the rolled-back delta path.
    expect(mutated).toEqual(
      expect.arrayContaining(["tools/beta/main.py", "tools/delta/__init__.py"]),
    );
    expect(report.projectCheck).toEqual({
      command: null,
      baseline: "not-run",
      statement: "No project check was found; only exact rendering was checked.",
    });
    expect(report.limits.join("\n")).toContain("does not prove the member works");
    await expectReportMatchesDisk(report, planned);

    // Re-running is idempotent for written members and still never touches the conflict.
    const again = await applyFamily({
      root,
      plan: await plan(generator),
      runProjectCheck: false,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 60_000,
    });
    expect(again.members.map((item) => [item.path, item.status])).toEqual([
      ["tools/beta", "unchanged"],
      ["tools/delta", "created"],
      ["tools/gamma", "skipped"],
    ]);
  });

  it("runs the chosen project check after each member and rolls back the one that fails", async () => {
    const { generator } = await verifiedGenerator();
    const planned = await plan(generator, { detectChecks: () => ["fixture-check"] });
    expect(planned.projectCheck).toBe("fixture-check");
    const seen: string[] = [];
    const report = await applyFamily({
      root,
      plan: planned,
      runProjectCheck: true,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 60_000,
      deps: {
        runCheck: async (command) => {
          seen.push(command);
          // Baseline, beta, delta (fails), gamma.
          const failing = seen.length === 3;
          return {
            exitCode: failing ? 1 : 0,
            timedOut: false,
            outputTail: failing ? "1 test failed" : "",
          };
        },
      },
    });
    expect(seen).toEqual(["fixture-check", "fixture-check", "fixture-check", "fixture-check"]);
    expect(report.status).toBe("partial");
    expect(member(report, "beta")).toMatchObject({ status: "created", projectCheck: "passed" });
    expect(member(report, "delta")).toMatchObject({ status: "failed", projectCheck: "failed" });
    expect(member(report, "delta")?.reason).toContain(
      "`fixture-check` exited 1; this member was rolled back",
    );
    expect(member(report, "delta")?.reason).toContain("1 test failed");
    expect(member(report, "gamma")).toMatchObject({ status: "created", projectCheck: "passed" });
    expect(await read("tools/delta/main.py")).toBeNull();
    expect(report.projectCheck.baseline).toBe("passed");
    expect(report.projectCheck.statement).toContain("ran after each written member");
    await expectReportMatchesDisk(report, planned);
  });

  it("does not judge members with a check that already fails, and says only rendering was checked", async () => {
    const { generator } = await verifiedGenerator();
    const planned = await plan(generator, { detectChecks: () => ["fixture-check"] });
    let runs = 0;
    const base = {
      root,
      plan: planned,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 60_000,
    };
    const report = await applyFamily({
      ...base,
      runProjectCheck: true,
      deps: {
        runCheck: async () => {
          runs++;
          return { exitCode: 2, timedOut: false, outputTail: "" };
        },
      },
    });
    expect(runs).toBe(1);
    expect(report.status).toBe("completed");
    expect(report.projectCheck).toMatchObject({ baseline: "failed" });
    expect(report.projectCheck.statement).toContain("already failed before any write (exit 2)");
    expect(report.projectCheck.statement).toContain("only exact rendering was checked");
    expect(report.members.every((item) => item.projectCheck === undefined)).toBe(true);
    const declined = await applyFamily({
      ...base,
      plan: await plan(generator, { detectChecks: () => ["fixture-check"] }),
      runProjectCheck: false,
    });
    expect(declined.projectCheck.statement).toBe(
      "The project check `fixture-check` was not chosen; only exact rendering was checked.",
    );
  });

  it("cancellation rolls back the current member and leaves the rest not attempted", async () => {
    const { generator } = await verifiedGenerator();
    const planned = await plan(generator);
    const controller = new AbortController();
    const report = await applyFamily({
      root,
      plan: planned,
      runProjectCheck: false,
      dirtyOverride: false,
      signal: controller.signal,
      deadlineMs: 60_000,
      deps: {
        afterWrite: (name, _file, index) => {
          if (name === "tools/delta" && index === 0) controller.abort();
        },
      },
    });
    expect(report).toMatchObject({ status: "cancelled", stopped: "cancelled" });
    expect(report.members.map((item) => [item.path, item.status])).toEqual([
      ["tools/beta", "created"],
      ["tools/delta", "failed"],
      ["tools/gamma", "not-attempted"],
    ]);
    expect(member(report, "delta")?.reason).toBe(
      "cancelled during this member; it was rolled back",
    );
    expect(await read("tools/delta/__init__.py")).toBeNull();
    expect(await read(generatedRecordPath(familyOwnerId(FAMILY_ID, "tools/delta")))).toBeNull();
    await expectReportMatchesDisk(report, planned);
  });

  it("stops the rest when the deadline passes", async () => {
    const { generator } = await verifiedGenerator();
    const planned = await plan(generator);
    const report = await applyFamily({
      root,
      plan: planned,
      runProjectCheck: false,
      dirtyOverride: false,
      signal: signal(),
      deadlineMs: 1,
      deps: {
        afterWrite: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
    });
    expect(report.stopped).toBe("deadline");
    expect(report.status).not.toBe("completed");
    expect(report.members.some((item) => item.status === "not-attempted")).toBe(true);
    await expectReportMatchesDisk(report, planned);
  });

  it("runs a real project check, reports its exit, and tree-kills it on timeout or cancellation", async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gg-family-check-")));
    const exit = await runProjectCheck(
      'node -e "console.log(42); process.exit(3)"',
      root,
      signal(),
      30_000,
    );
    expect(exit).toMatchObject({ exitCode: 3, timedOut: false });
    expect(exit.outputTail).toContain("42");
    const hang = 'node -e "setTimeout(() => {}, 60000)"';
    expect(await runProjectCheck(hang, root, signal(), 300)).toMatchObject({ timedOut: true });
    const controller = new AbortController();
    const pending = runProjectCheck(hang, root, controller.signal, 30_000);
    setTimeout(() => controller.abort(new Error("stop")), 300);
    await expect(pending).rejects.toThrow("stop");
  });

  it("shares the reviewed runner's per-project claim", async () => {
    const { generator } = await verifiedGenerator();
    const release = claimProgrammaticProject(generator.root);
    expect(release).not.toBeNull();
    expect(claimProgrammaticProject(generator.root)).toBeNull();
    release?.();
    release?.();
    const again = claimProgrammaticProject(generator.root);
    expect(again).not.toBeNull();
    again?.();
  });
});
