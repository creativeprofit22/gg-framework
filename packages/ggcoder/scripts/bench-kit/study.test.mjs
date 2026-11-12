import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPoolable,
  canonicalJson,
  freezeProtocol,
  hashTree,
  readProtocol,
  verifyProtocol,
} from "../../assets/bench-kit/lib/protocol.mjs";
import { gatesFor, loadStudy, validateStudy } from "../../assets/bench-kit/lib/study.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, "../../assets/bench-kit");
const samplePath = path.join(kitRoot, "templates/study.sample.json");
const loadSample = async () => JSON.parse(await readFile(samplePath, "utf8"));
const clock = () => "2026-10-20T00:00:00.000Z";

/** Minimal valid study for a temp folder. */
const minimal = () => ({
  schema: 1,
  id: "tiny",
  title: "Tiny",
  question: "Which sort is faster?",
  repeats: 3,
  seed: 7,
  candidates: [
    { id: "a", adapter: { type: "function", module: "a.mjs", export: "run" } },
    { id: "b", adapter: { type: "function", module: "b.mjs", export: "run" } },
  ],
  workload: { items: [{ id: "small", input: "small.json" }] },
  metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
  decision: { reference: "a", primary: { metric: "ms", better: "lower", minRatio: 1.1 } },
});

describe("validateStudy", () => {
  it("accepts the shipped 3-engine sample", async () => {
    assert.deepEqual(validateStudy(await loadSample()), []);
  });

  it("reports every problem with its field path", () => {
    const study = minimal();
    study.candidates[1].id = "a";
    study.repeats = 1;
    study.decision.primary.metric = "nope";
    const errors = validateStudy(study);
    assert.ok(errors.includes('candidates[1].id: duplicate id "a"'), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("repeats:")));
    assert.ok(errors.some((e) => e.startsWith("decision.primary.metric:")));
  });

  it("rejects LLM judges as gates", () => {
    const study = { ...minimal(), gates: [{ id: "judge", type: "llm-judge" }] };
    assert.ok(validateStudy(study).some((e) => e.includes("LLM judges cannot gate")));
  });

  it("requires a worst-case cost for paid candidates and a paid flag for agents", () => {
    const study = minimal();
    study.candidates[1] = { id: "b", paid: true, adapter: { type: "cli", command: "x" } };
    assert.ok(validateStudy(study).some((e) => e.startsWith("budget.perSampleWorstCase.usd:")));
    study.candidates[1] = { id: "b", adapter: { type: "agent", preset: "ggcoder" } };
    assert.ok(validateStudy(study).some((e) => e.startsWith("candidates[1].paid:")));
  });

  it("rejects workload paths that escape the study folder", () => {
    const study = minimal();
    study.workload.items[0].input = "../secret.json";
    assert.ok(validateStudy(study).some((e) => e.startsWith("workload.items[0].input:")));
  });

  it("validates every decision, unmeasured and sandbox field the kit reads", () => {
    const study = minimal();
    study.decision.resamples = 10;
    study.decision.noise = { requireAA: "yes" };
    study.decision.secondary = [{ metric: "ms", better: "faster", statistic: "mode" }];
    study.unmeasured = [{ what: "Looks", how: 3 }];
    const errors = validateStudy(study);
    for (const field of [
      "decision.resamples:",
      "decision.noise:",
      "decision.secondary[0].better:",
      "decision.secondary[0].statistic:",
      "unmeasured:",
    ])
      assert.ok(
        errors.some((e) => e.startsWith(field)),
        `${field} missing from\n${errors.join("\n")}`,
      );
  });

  it("refuses docker settings and candidates that docker cannot honour", () => {
    const study = minimal();
    study.sandbox = { type: "docker", image: "node:22", network: "host", memory: "lots", pids: 0 };
    study.candidates[1] = {
      id: "b",
      adapter: { type: "cli", command: "node run.mjs {workload}/x.json {out}" },
    };
    const errors = validateStudy(study);
    for (const field of [
      "sandbox.network:",
      "sandbox.memory:",
      "sandbox.pids:",
      "candidates[0].adapter.type: function candidates run only in the process sandbox",
      "candidates[1].adapter.command: the {workload} slot",
    ])
      assert.ok(
        errors.some((e) => e.startsWith(field)),
        `${field} missing from\n${errors.join("\n")}`,
      );
    study.candidates[0] = {
      id: "a",
      paid: false,
      source: { version: "ggcoder --version" },
      adapter: { type: "agent", preset: "ggcoder" },
    };
    assert.ok(
      validateStudy(study).some((e) =>
        e.startsWith(
          "candidates[0].adapter.type: agent candidates run only in the process sandbox",
        ),
      ),
    );
  });

  it("runs type-specific validators from the registries", () => {
    const registries = {
      adapters: { function: { validate: (c) => (c.module ? [] : ["module: required"]) } },
    };
    const study = minimal();
    delete study.candidates[0].adapter.module;
    assert.deepEqual(validateStudy(study, registries), ["candidates[0].adapter: module: required"]);
  });

  it("selects gates per candidate", () => {
    const study = {
      ...minimal(),
      gates: [
        { id: "g1", type: "exit-code" },
        { id: "g2", type: "exit-code", appliesTo: ["b"] },
      ],
    };
    assert.deepEqual(
      gatesFor(study, "a").map((g) => g.id),
      ["g1"],
    );
    assert.deepEqual(
      gatesFor(study, "b").map((g) => g.id),
      ["g1", "g2"],
    );
  });
});

describe("loadStudy and protocol", () => {
  /** @type {string} */
  let root;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bench-kit-study-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** @param {string} name */
  const studyDir = async (name, study = minimal()) => {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, "workload"), { recursive: true });
    await writeFile(path.join(dir, "study.json"), `${JSON.stringify(study, null, 2)}\n`);
    await writeFile(path.join(dir, "workload/small.json"), "[3,1,2]\n");
    return dir;
  };

  it("returns precise error codes for missing, CRLF, bad JSON and invalid studies", async () => {
    const dir = path.join(root, "load");
    await mkdir(dir, { recursive: true });
    assert.equal(
      (await loadStudy(dir)).ok ? "" : (await loadStudy(dir)).error.code,
      "STUDY_MISSING",
    );
    await writeFile(path.join(dir, "study.json"), '{\r\n"schema": 1\r\n}\r\n');
    const crlf = await loadStudy(dir);
    assert.equal(crlf.ok ? "" : crlf.error.code, "STUDY_CRLF");
    await writeFile(path.join(dir, "study.json"), "{nope");
    const bad = await loadStudy(dir);
    assert.equal(bad.ok ? "" : bad.error.code, "STUDY_JSON");
    await writeFile(path.join(dir, "study.json"), '{"schema": 1}\n');
    const invalid = await loadStudy(dir);
    assert.equal(invalid.ok ? "" : invalid.error.code, "STUDY_INVALID");
    assert.ok(!invalid.ok && Array.isArray(invalid.error.details));
  });

  it("hashes trees deterministically and rejects CRLF only in text files", async () => {
    const dir = path.join(root, "tree");
    await mkdir(path.join(dir, "b"), { recursive: true });
    await writeFile(path.join(dir, "b/z.txt"), "z\n");
    await writeFile(path.join(dir, "a.bin"), Buffer.from([13, 10, 0]));
    const first = await hashTree(dir);
    const second = await hashTree(dir);
    assert.ok(first.ok && second.ok);
    assert.deepEqual(
      first.value.files.map((f) => f.path),
      ["a.bin", "b/z.txt"],
    );
    assert.equal(first.value.digest, second.value.digest);
    await writeFile(path.join(dir, "b/y.csv"), "a,b\r\n");
    const crlf = await hashTree(dir);
    assert.equal(crlf.ok ? "" : crlf.error.code, "HASH_CRLF");
    const missing = await hashTree(path.join(dir, "does-not-exist"));
    assert.ok(missing.ok && missing.value.files.length === 0);
  });

  it("canonicalJson sorts keys at every level", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: null } }),
      '{"a":{"c":null,"d":[1,{"e":2,"f":1}]},"b":1}',
    );
  });

  it("freezes v1, keeps it when unchanged and creates v2 on any edit", async () => {
    const dir = await studyDir("freeze");
    const options = { kitDir: kitRoot, now: clock, environment: { test: true } };
    const v1 = await freezeProtocol(dir, options);
    assert.ok(v1.ok, v1.ok ? "" : v1.error.message);
    assert.equal(v1.value.status, "created");
    assert.equal(v1.value.version.version, 1);

    const again = await freezeProtocol(dir, options);
    assert.ok(
      again.ok &&
        again.value.status === "unchanged" &&
        again.value.version.digest === v1.value.version.digest,
    );
    assert.ok((await verifyProtocol(dir, options)).ok);

    const edited = { ...minimal(), repeats: 5 };
    await writeFile(path.join(dir, "study.json"), `${JSON.stringify(edited, null, 2)}\n`);
    const drift = await verifyProtocol(dir, options);
    assert.equal(drift.ok ? "" : drift.error.code, "PROTOCOL_DRIFT");
    assert.deepEqual(drift.ok ? [] : drift.error.details, ["study.json"]);

    const v2 = await freezeProtocol(dir, options);
    assert.ok(v2.ok && v2.value.status === "new-version" && v2.value.version.version === 2);
    assert.deepEqual(v2.value.changed, ["study.json"]);
    assert.notEqual(v2.value.version.digest, v1.value.version.digest);

    const stored = await readProtocol(dir);
    assert.ok(stored.ok && stored.value);
    assert.equal(stored.value.current, 2);
    assert.deepEqual(
      stored.value.versions.map((v) => v.version),
      [1, 2],
    );

    const pooled = assertPoolable([
      { runId: "r1", protocolVersion: 1, protocolDigest: v1.value.version.digest },
      { runId: "r2", protocolVersion: 2, protocolDigest: v2.value.version.digest },
    ]);
    assert.equal(pooled.ok ? "" : pooled.error.code, "POOL_MIXED");
    const same = assertPoolable([
      { runId: "r3", protocolVersion: 2, protocolDigest: v2.value.version.digest },
      { runId: "r2", protocolVersion: 2, protocolDigest: v2.value.version.digest },
    ]);
    assert.ok(same.ok && same.value.runIds.join() === "r2,r3");
  });

  it("detects workload, seed and provenance changes", async () => {
    const dir = await studyDir("drift");
    const options = {
      kitDir: kitRoot,
      now: clock,
      environment: {},
      provenance: { a: { commit: "abc", dirty: false } },
    };
    assert.ok((await freezeProtocol(dir, options)).ok);
    await writeFile(path.join(dir, "workload/small.json"), "[9,8,7]\n");
    const workload = await verifyProtocol(dir, options);
    assert.deepEqual(workload.ok ? [] : workload.error.details, ["workload"]);
    const provenance = await verifyProtocol(dir, {
      ...options,
      provenance: { a: { commit: "def", dirty: false } },
    });
    assert.deepEqual(provenance.ok ? [] : provenance.error.details, [
      "workload",
      "candidate provenance",
    ]);
  });

  it("refuses to freeze when a declared workload file is missing", async () => {
    const study = minimal();
    study.workload.items.push({ id: "big", input: "big.json" });
    const dir = await studyDir("missing", study);
    const result = await freezeProtocol(dir, { kitDir: kitRoot, now: clock, environment: {} });
    assert.equal(result.ok ? "" : result.error.code, "WORKLOAD_MISSING");
  });

  it("accepts a folder as an item input (e.g. an agent task bundle), but not an empty one", async () => {
    const study = minimal();
    study.workload.items.push({ id: "bundle", input: "task/" });
    const dir = await studyDir("folder-input", study);
    await mkdir(path.join(dir, "workload", "task", "files"), { recursive: true });
    await writeFile(path.join(dir, "workload", "task", "files", "a.mjs"), "export {};\n");
    const frozen = await freezeProtocol(dir, { kitDir: kitRoot, now: clock, environment: {} });
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.error.message);

    const empty = minimal();
    empty.workload.items.push({ id: "bundle", input: "nothing" });
    const emptyDir = await studyDir("empty-folder-input", empty);
    await mkdir(path.join(emptyDir, "workload", "nothing"), { recursive: true });
    const refused = await freezeProtocol(emptyDir, {
      kitDir: kitRoot,
      now: clock,
      environment: {},
    });
    assert.equal(refused.ok ? "" : refused.error.code, "WORKLOAD_MISSING");
  });

  it("refuses to verify before freezing", async () => {
    const dir = await studyDir("unfrozen");
    const result = await verifyProtocol(dir, { kitDir: kitRoot });
    assert.equal(result.ok ? "" : result.error.code, "PROTOCOL_NOT_FROZEN");
  });
});
