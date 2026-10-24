import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPlaceholders } from "../generated-files/render.js";
import { sha256 } from "../tauri-package/paths.js";
import { commandLocalStat, readCommandText } from "./command-creation.js";
import {
  checkReferenceReproduction,
  evaluateGeneratorVerification,
  FAMILY_GENERATOR_HELPER_SOURCE,
  FAMILY_GENERATOR_HELPERS,
  familyGeneratorInputSchema,
  prepareFamilyGenerator,
  type FamilyFileAccess,
  type FamilyGeneratorInput,
} from "./family-generator.js";

const io: FamilyFileAccess = { stat: commandLocalStat, readText: readCommandText };
const signal = () => new AbortController().signal;
const helperDirectory = ".gg/commands/.make-tool-helpers";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-family-generator-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, "utf8");
  }
  return root;
}

const pythonReference = {
  "tools/alpha/__init__.py": "from .main import run\r\n",
  "tools/alpha/main.py":
    '"""Alpha tool."""\r\n\r\nNAME = "alpha"\r\n\r\n\r\ndef run():\r\n    return "Alpha"\r\n',
};
const pythonDraft = (): FamilyGeneratorInput =>
  familyGeneratorInputSchema.parse({
    familyId: "0123456789abcdef",
    kind: "directory",
    reference: "tools/alpha",
    placeholders: ["name", "title"],
    members: [
      {
        path: "tools/alpha",
        values: [
          { key: "name", value: "alpha" },
          { key: "title", value: "Alpha" },
        ],
      },
      {
        path: "tools/beta",
        values: [
          { key: "name", value: "beta" },
          { key: "title", value: "Beta" },
        ],
      },
      {
        path: "tools/gamma",
        values: [
          { key: "name", value: "gamma" },
          { key: "title", value: "Gamma" },
        ],
      },
    ],
    files: [
      { path: "tools/{{name}}/__init__.py", content: "from .main import run\r\n" },
      {
        path: "tools/{{name}}/main.py",
        content:
          '"""{{title}} tool."""\r\n\r\nNAME = "{{name}}"\r\n\r\n\r\ndef run():\r\n    return "{{title}}"\r\n',
      },
    ],
  });

const markdownReference = {
  "docs/guide-setup.md": "\uFEFF# Setup guide\n\nRead this before setup.\n",
};
const markdownDraft = (): FamilyGeneratorInput =>
  familyGeneratorInputSchema.parse({
    familyId: "fedcba9876543210",
    kind: "file",
    reference: "docs/guide-setup.md",
    placeholders: ["slug", "title"],
    members: [
      {
        path: "docs/guide-setup.md",
        values: [
          { key: "slug", value: "setup" },
          { key: "title", value: "Setup" },
        ],
      },
      {
        path: "docs/guide-deploy.md",
        values: [
          { key: "slug", value: "deploy" },
          { key: "title", value: "Deploy" },
        ],
      },
      {
        path: "docs/guide-debug.md",
        values: [
          { key: "slug", value: "debug" },
          { key: "title", value: "Debug" },
        ],
      },
    ],
    files: [
      {
        path: "docs/guide-{{slug}}.md",
        content: "\uFEFF# {{title}} guide\n\nRead this before {{slug}}.\n",
      },
    ],
  });

async function prepareAndWrite(root: string, draft: FamilyGeneratorInput) {
  const prepared = await prepareFamilyGenerator(root, draft, helperDirectory, io, signal());
  if (prepared.status !== "ready") throw new Error(`not ready: ${prepared.reason}`);
  await fs.mkdir(path.join(root, helperDirectory), { recursive: true });
  for (const helper of prepared.helpers)
    await fs.writeFile(path.join(root, helperDirectory, helper.name), helper.content, "utf8");
  return {
    prepared,
    check: (runtimeExecutable = process.execPath) =>
      checkReferenceReproduction({
        root,
        metadata: prepared.metadata,
        helpers: prepared.helpers.map((helper) => ({
          path: `${helperDirectory}/${helper.name}`,
          sha256: sha256(helper.content),
        })),
        referenceFiles: prepared.referencePrerequisites,
        runtimeExecutable,
        io,
        signal: signal(),
      }),
  };
}

async function snapshot(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true });
  return entries.map((entry) => entry.split(path.sep).join("/")).sort();
}

function runHelper(script: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("family generator reference check", () => {
  it("reproduces a Python sibling-directory reference byte for byte, CRLF included", async () => {
    const root = await project(pythonReference);
    const before = await snapshot(root);
    const { prepared, check } = await prepareAndWrite(root, pythonDraft());
    expect(prepared.metadata.referenceFiles).toEqual(Object.keys(pythonReference).sort());
    expect(prepared.referencePrerequisites.map((item) => item.path)).toEqual(
      Object.keys(pythonReference).sort(),
    );
    expect(prepared.helpers.map((helper) => helper.name)).toEqual(
      Object.values(FAMILY_GENERATOR_HELPERS),
    );
    expect(prepared.helpers[0]?.content).toBe(FAMILY_GENERATOR_HELPER_SOURCE);
    const result = await check();
    expect(result).toEqual({ result: "passed", files: Object.keys(pythonReference).sort() });
    // Only the reviewed helper files were added; no other member was generated.
    const after = await snapshot(root);
    expect(after.filter((entry) => !before.includes(entry))).toEqual(
      [
        ".gg",
        ".gg/commands",
        helperDirectory,
        ...Object.values(FAMILY_GENERATOR_HELPERS).map((name) => `${helperDirectory}/${name}`),
      ].sort(),
    );
    expect(after.some((entry) => entry.startsWith("tools/beta"))).toBe(false);
  });

  it("reproduces a Markdown file-name-pattern reference with its BOM", async () => {
    const root = await project(markdownReference);
    const { check } = await prepareAndWrite(root, markdownDraft());
    expect(await check()).toEqual({ result: "passed", files: ["docs/guide-setup.md"] });
    await expect(fs.readdir(path.join(root, "docs"))).resolves.toEqual(["guide-setup.md"]);
  });

  it("fails on a one-byte difference and reports the offset and a unified diff", async () => {
    const root = await project(pythonReference);
    const draft = pythonDraft();
    const main = draft.files[1];
    if (!main) throw new Error("fixture");
    main.content = main.content.replace('NAME = "{{name}}"', 'NAME = "{{name}}!"');
    const { check } = await prepareAndWrite(root, draft);
    const result = await check();
    if (result.result !== "failed") throw new Error(`expected failure, got ${result.result}`);
    expect(result.reason).toBe("differences");
    expect(result.differences).toHaveLength(1);
    const [difference] = result.differences;
    expect(difference).toMatchObject({
      path: "tools/alpha/main.py",
      kind: "bytes",
      firstDifferentByte: pythonReference["tools/alpha/main.py"].indexOf('alpha"') + 5,
    });
    expect(difference?.generatedBytes).toBe((difference?.referenceBytes ?? 0) + 1);
    expect(difference?.diff).toContain("--- reference/tools/alpha/main.py");
    expect(difference?.diff).toContain("+++ generated/tools/alpha/main.py");
    expect(difference?.diff).toContain('-NAME = "alpha"');
    expect(difference?.diff).toContain('+NAME = "alpha!"');
  });

  it("reports missing and unexpected output files", async () => {
    const root = await project(pythonReference);
    const { prepared } = await prepareAndWrite(root, pythonDraft());
    // A reviewed template whose rendered names drift: the check, not inspection, catches it.
    const template = JSON.parse(prepared.helpers[1]?.content ?? "{}") as {
      files: { path: string; content: string }[];
    };
    const first = template.files[0];
    if (!first) throw new Error("fixture");
    first.path = "tools/{{name}}/init.py";
    const edited = `${JSON.stringify(template, null, 2)}\n`;
    await fs.writeFile(path.join(root, helperDirectory, "template.json"), edited, "utf8");
    const result = await checkReferenceReproduction({
      root,
      metadata: prepared.metadata,
      helpers: prepared.helpers.map((helper) => ({
        path: `${helperDirectory}/${helper.name}`,
        sha256: sha256(helper.name === "template.json" ? edited : helper.content),
      })),
      referenceFiles: prepared.referencePrerequisites,
      runtimeExecutable: process.execPath,
      io,
      signal: signal(),
    });
    if (result.result !== "failed") throw new Error(`expected failure, got ${result.result}`);
    expect(result.differences.map((item) => [item.path, item.kind])).toEqual([
      ["tools/alpha/__init__.py", "missing"],
      ["tools/alpha/init.py", "unexpected"],
    ]);
  });

  it("refuses edited helpers and edited reference files instead of comparing them", async () => {
    const root = await project(pythonReference);
    const { check } = await prepareAndWrite(root, pythonDraft());
    await fs.appendFile(path.join(root, helperDirectory, "template.json"), " ");
    expect(await check()).toEqual({ result: "unavailable", reason: "reviewed-helper-changed" });

    const other = await project(pythonReference);
    const second = await prepareAndWrite(other, pythonDraft());
    await fs.appendFile(path.join(other, "tools/alpha/main.py"), "#");
    expect(await second.check()).toEqual({ result: "unavailable", reason: "reference-changed" });
  });

  it("fails closed when the Node runtime is missing", async () => {
    const root = await project(pythonReference);
    const { check } = await prepareAndWrite(root, pythonDraft());
    expect(await check(path.join(root, "missing-node", "node.exe"))).toEqual({
      result: "unavailable",
      reason: "node-runtime-unavailable",
    });
    const verification = evaluateGeneratorVerification({
      reference: "tools/alpha",
      referenceCheck: { result: "unavailable", reason: "node-runtime-unavailable" },
      detectedCommands: [],
      receipts: [],
    });
    expect(verification.generatorVerified).toBe(false);
    expect(verification.checksRun).toEqual([]);
    expect(verification.statement).toContain("could not run (node-runtime-unavailable)");
  });
});

describe("family generator structural review", () => {
  const reasonFor = async (edit: (draft: FamilyGeneratorInput) => void) => {
    const root = await project(pythonReference);
    const draft = pythonDraft();
    edit(draft);
    const prepared = await prepareFamilyGenerator(root, draft, helperDirectory, io, signal());
    return prepared.status === "invalid" ? prepared.reason : "ready";
  };

  it("accepts placeholders only for values that differ across members", async () => {
    await expect(
      reasonFor((draft) => {
        draft.placeholders.push("lang");
        for (const member of draft.members) member.values.push({ key: "lang", value: "python" });
        const first = draft.files[0];
        if (first) first.content = "# {{lang}}\r\n" + first.content;
      }),
    ).resolves.toBe("placeholder-value-does-not-vary");
  });

  it("rejects unused, colliding and out-of-member placeholders", async () => {
    await expect(
      reasonFor((draft) => {
        draft.placeholders.push("unused");
        for (const [index, member] of draft.members.entries())
          member.values.push({ key: "unused", value: `u${index}` });
      }),
    ).resolves.toBe("unused-placeholder");
    await expect(
      reasonFor((draft) => {
        draft.members[0]?.values.push({ key: "name", value: "again" });
      }),
    ).resolves.toBe("duplicate-member-value-key");
    await expect(
      reasonFor((draft) => {
        const first = draft.files[0];
        if (first) first.path = "tools/{{name}}/main.py";
      }),
    ).resolves.toBe("rendered-path-outside-member-unsafe-or-duplicate");
    await expect(
      reasonFor((draft) => {
        const first = draft.files[0];
        if (first) first.path = "lib/{{name}}/__init__.py";
      }),
    ).resolves.toBe("rendered-path-outside-member-unsafe-or-duplicate");
    await expect(
      reasonFor((draft) => {
        draft.reference = "tools/delta";
      }),
    ).resolves.toBe("reference-not-a-member");
  });

  it("rejects a reference whose file set or text the template cannot represent", async () => {
    await expect(
      reasonFor((draft) => {
        draft.files.shift();
      }),
    ).resolves.toBe("rendered-reference-paths-differ-from-reference-files");
    const root = await project({
      ...pythonReference,
      "tools/alpha/main.py": 'NAME = "{{name}}"\n',
    });
    const prepared = await prepareFamilyGenerator(
      root,
      pythonDraft(),
      helperDirectory,
      io,
      signal(),
    );
    expect(prepared).toEqual({ status: "invalid", reason: "reference-contains-placeholder-text" });
  });
});

describe("host-owned helper", () => {
  it("renders exactly like renderPlaceholders and refuses an existing --out", async () => {
    const values = { name: "a$&b$1", title: "{x} $' tail" };
    const template = {
      version: 1,
      familyId: "0123456789abcdef",
      kind: "directory",
      placeholders: ["name", "title"],
      files: [
        {
          path: "tools/a/out.txt",
          content: "{{title}} {{unknown}} {{ name }} {{name}}{{title}}\r\n",
        },
      ],
    };
    const root = await project({
      "h/generate.mjs": FAMILY_GENERATOR_HELPER_SOURCE,
      "h/template.json": JSON.stringify(template),
      "h/inputs.json": JSON.stringify({
        version: 1,
        reference: "tools/a",
        members: [{ path: "tools/a", values }],
      }),
    });
    const script = path.join(root, "h/generate.mjs");
    const out = path.join(root, "out");
    const run = await runHelper(script, ["--member", "tools/a", "--out", out]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ member: "tools/a", files: ["tools/a/out.txt"] });
    const expected = renderPlaceholders(template.files[0]?.content ?? "", values);
    expect(expected).toBe("{x} $' tail {{unknown}} {{ name }} a$&b$1{x} $' tail\r\n");
    await expect(fs.readFile(path.join(out, "tools/a/out.txt"), "utf8")).resolves.toBe(expected);

    const again = await runHelper(script, ["--member", "tools/a", "--out", out]);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("--out must be a new directory");
  });
});
