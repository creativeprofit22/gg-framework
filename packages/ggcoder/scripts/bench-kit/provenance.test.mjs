import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { splitCommand } from "../../assets/bench-kit/lib/argv.mjs";
import { freezeProtocol } from "../../assets/bench-kit/lib/protocol.mjs";
import {
  checkSource,
  collectProvenance,
  toolVersions,
  validateSource,
} from "../../assets/bench-kit/lib/provenance.mjs";
import { validateStudy } from "../../assets/bench-kit/lib/study.mjs";

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=bench@example.invalid",
      "-c",
      "user.name=bench",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", windowsHide: true },
  ).trim();

describe("argv splitting never uses a shell", () => {
  it("handles quotes, keeps Windows backslashes and rejects unclosed quotes", () => {
    assert.deepEqual(splitCommand(`node -e "console.log('v1 2')" C:\\x\\y`).value, [
      "node",
      "-e",
      "console.log('v1 2')",
      "C:\\x\\y",
    ]);
    assert.deepEqual(splitCommand(`a '' "b \\" c"`).value, ["a", "", 'b " c']);
    assert.deepEqual(splitCommand(["x", "y z"]).value, ["x", "y z"]);
    assert.equal(splitCommand(`a "b`).error.code, "ARGV_QUOTE");
    assert.equal(splitCommand("   ").error.code, "ARGV_INVALID");
  });
});

describe("source validation", () => {
  it("accepts a full source block", () => {
    assert.deepEqual(
      validateSource({
        worktree: "../b",
        commit: "abcdef1",
        allowDirty: false,
        files: ["dist/x.js"],
        version: "node -v",
      }),
      [],
    );
  });

  it("names every bad field", () => {
    const problems = validateSource({
      commit: "xyz",
      files: ["../escape", "/abs"],
      version: 'a "b',
      extra: 1,
    });
    const paths = problems.map((p) => p.path).sort();
    assert.deepEqual(paths, [
      ".commit",
      ".extra",
      ".files[0]",
      ".files[1]",
      ".version",
      ".worktree",
    ]);
  });

  it("is enforced by the study validator with the candidate path", () => {
    const study = {
      schema: 1,
      id: "tiny",
      title: "Tiny",
      question: "Which?",
      repeats: 3,
      seed: 7,
      candidates: [
        {
          id: "a",
          adapter: { type: "function", module: "a.mjs", export: "run" },
          source: { commit: "nothex!" },
        },
        { id: "b", adapter: { type: "function", module: "b.mjs", export: "run" } },
      ],
      workload: { items: [{ id: "small", input: "small.json" }] },
      metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
      decision: { reference: "a", primary: { metric: "ms", better: "lower", minRatio: 1.1 } },
    };
    const text = validateStudy(study).join("\n");
    assert.match(text, /candidates\[0\]\.source\.commit/);
    assert.match(text, /candidates\[0\]\.source\.worktree/);
  });
});

describe("git worktree guard", () => {
  let root;
  let repo;
  let head;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bench-prov-"));
    repo = path.join(root, "engine");
    await mkdir(path.join(repo, "dist"), { recursive: true });
    await writeFile(path.join(repo, "dist", "engine.js"), "export const v = 1;\n");
    await writeFile(
      path.join(repo, "version.mjs"),
      "console.log('engine 1.2.3');\nconsole.log('second line');\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    head = git(repo, "rev-parse", "HEAD");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records commit, file hashes and version for a clean matching worktree", async () => {
    const check = await checkSource(
      {
        worktree: "engine",
        commit: head.slice(0, 8),
        files: ["dist/engine.js"],
        version: "node version.mjs",
      },
      { baseDir: root },
    );
    assert.deepEqual(check.reasons, []);
    assert.equal(check.ok, true);
    assert.equal(check.facts.commit, head);
    assert.equal(check.facts.expectedCommit, head.slice(0, 8));
    assert.equal(check.facts.dirty, false);
    assert.equal(check.facts.worktree, "engine");
    assert.match(check.facts.files["dist/engine.js"], /^[0-9a-f]{64}$/);
    assert.equal(check.facts.version, "engine 1.2.3");
    // Facts stay machine-independent: no absolute path anywhere.
    assert.equal(JSON.stringify(check.facts).includes(root.replace(/\\/g, "\\\\")), false);
  });

  it("refuses a commit mismatch", async () => {
    const check = await checkSource({ worktree: "engine", commit: "0000000" }, { baseDir: root });
    assert.equal(check.ok, false);
    assert.match(check.reasons.join("\n"), /commit mismatch/);
  });

  it("refuses a missing file and a non-git folder", async () => {
    await mkdir(path.join(root, "plain"), { recursive: true });
    const plain = await checkSource({ worktree: "plain" }, { baseDir: root });
    assert.match(plain.reasons.join("\n"), /not a git worktree/);
    const missing = await checkSource(
      { worktree: "engine", files: ["dist/nope.js"] },
      { baseDir: root },
    );
    assert.match(missing.reasons.join("\n"), /missing file: dist\/nope\.js/);
  });

  it("refuses uncommitted changes unless allowDirty, and then records a status digest", async () => {
    await writeFile(path.join(repo, "dist", "engine.js"), "export const v = 2;\n");
    try {
      const strict = await checkSource({ worktree: "engine" }, { baseDir: root });
      assert.equal(strict.ok, false);
      assert.match(strict.reasons.join("\n"), /uncommitted changes/);
      const loose = await checkSource({ worktree: "engine", allowDirty: true }, { baseDir: root });
      assert.equal(loose.ok, true);
      assert.equal(loose.facts.dirty, true);
      assert.match(loose.facts.statusDigest, /^[0-9a-f]{64}$/);
    } finally {
      git(repo, "checkout", "--", ".");
    }
  });

  it("collects per-candidate facts, null without a source, and refuses with reasons", async () => {
    const study = {
      candidates: [
        { id: "a", source: { worktree: "engine", commit: head.slice(0, 7) } },
        { id: "b" },
        { id: "c", source: { worktree: "engine", commit: "1234567" } },
      ],
    };
    const refused = await collectProvenance(study, { baseDir: root });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "PROVENANCE_REFUSED");
    assert.deepEqual(Object.keys(refused.error.details.refused), ["c"]);
    assert.match(refused.error.message, /^c: commit mismatch/);

    const fine = await collectProvenance(
      { candidates: study.candidates.slice(0, 2) },
      { baseDir: root },
    );
    assert.equal(fine.ok, true);
    assert.equal(fine.value.a.commit, head);
    assert.equal(fine.value.b, null);
  });

  it("a new commit changes the protocol fingerprint (new version, never pooled)", async () => {
    const studyDir = path.join(root, "study");
    const kitDir = path.join(root, "kit");
    await mkdir(path.join(studyDir, "workload"), { recursive: true });
    await mkdir(kitDir, { recursive: true });
    await writeFile(path.join(kitDir, "k.mjs"), "export {};\n");
    await writeFile(path.join(studyDir, "workload", "small.json"), "[3,1,2]\n");
    const study = {
      schema: 1,
      id: "tiny",
      title: "Tiny",
      question: "Which?",
      repeats: 3,
      seed: 7,
      candidates: [
        {
          id: "a",
          adapter: { type: "function", module: "a.mjs", export: "run" },
          source: { worktree: "../engine" },
        },
        { id: "b", adapter: { type: "function", module: "b.mjs", export: "run" } },
      ],
      workload: { items: [{ id: "small", input: "small.json" }] },
      metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
      decision: { reference: "a", primary: { metric: "ms", better: "lower", minRatio: 1.1 } },
    };
    await writeFile(path.join(studyDir, "study.json"), `${JSON.stringify(study, null, 2)}\n`);
    const now = () => "2026-10-20T00:00:00.000Z";
    const first = await collectProvenance(study, { baseDir: studyDir });
    assert.equal(first.ok, true);
    const v1 = await freezeProtocol(studyDir, {
      kitDir,
      provenance: first.value,
      now,
      environment: {},
    });
    assert.equal(v1.value.status, "created");

    await writeFile(path.join(repo, "dist", "engine.js"), "export const v = 3;\n");
    git(repo, "commit", "-q", "-am", "next");
    const second = await collectProvenance(study, { baseDir: studyDir });
    assert.equal(second.ok, true);
    const v2 = await freezeProtocol(studyDir, {
      kitDir,
      provenance: second.value,
      now,
      environment: {},
    });
    assert.equal(v2.value.status, "new-version");
  });
});

describe("tool versions", () => {
  it("records the first line, labels missing tools and sorts by name", async () => {
    const exec = async (command) =>
      command === "ffmpeg"
        ? { ok: true, stdout: "ffmpeg version 7.1\nbuilt with gcc" }
        : { ok: false, stdout: "", error: "ENOENT" };
    const versions = await toolVersions(
      [
        { name: "vmaf", command: "vmaf --version" },
        { name: "ffmpeg", command: "ffmpeg -version" },
      ],
      { exec },
    );
    assert.deepEqual(Object.keys(versions), ["ffmpeg", "vmaf"]);
    assert.equal(versions.ffmpeg, "ffmpeg version 7.1");
    assert.equal(versions.vmaf, "unavailable: ENOENT");
  });

  it("really runs a tool through the default runner", async () => {
    const versions = await toolVersions([{ name: "node", command: ["node", "--version"] }]);
    assert.equal(versions.node, process.version);
  });
});
