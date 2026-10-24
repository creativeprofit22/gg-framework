import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSymlink } from "../../test-utils/symlink.js";
import {
  finalizeGeneratedContent,
  generatedMarker,
  parseGeneratedMarker,
} from "../tauri-package/ownership.js";
import {
  CONTENT_DIGEST_SENTINEL,
  canonicalJson,
  normalizedContentSha256,
  sha256,
} from "../tauri-package/paths.js";
import { TEMPLATE_VERSION } from "../tauri-package/types.js";
import {
  commitGeneratedSet,
  GeneratedSetCommitError,
  generatedRecordPath,
  inspectGeneratedSet,
  previewGeneratedSet,
  verifyGeneratedSet,
  type GeneratedFile,
  type GeneratedSetSpec,
} from "./owner.js";
import { generatedFile, renderTemplate } from "./render.js";

const roots: string[] = [];
const PATHS = ["assets/LICENSE", "config/app.json", "config/app.yaml", "scripts/tool.py"];
const RECORD = generatedRecordPath("fixture-gen");

function spec(overrides: Partial<GeneratedSetSpec> = {}): GeneratedSetSpec {
  return {
    ownerId: "fixture-gen",
    paths: PATHS,
    completeSet: false,
    byteCompareExempt: PATHS,
    lockName: "gg-generated-files-test",
    tempPrefix: ".gg-gen-",
    label: "fixture",
    ownership: {
      kind: "side-record",
      legacyMarker: {
        kind: "embedded-marker",
        parse: parseGeneratedMarker,
        templateVersion: TEMPLATE_VERSION,
        digest: normalizedContentSha256,
      },
    },
    ...overrides,
  };
}

function render(label = "stable"): GeneratedFile[] {
  const template = (name: string) => sha256(`template:${name}`);
  return [
    generatedFile("assets/LICENSE", `Licensed ${label}\n`, template("license")),
    generatedFile(
      "config/app.json",
      renderTemplate('{"name": "{{NAME}}"}\n', [["{{NAME}}", label]]),
      template("json"),
    ),
    generatedFile("config/app.yaml", `name: ${label}\n`, template("yaml")),
    generatedFile("scripts/tool.py", `print(${JSON.stringify(label)})\n`, template("py")),
  ];
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "gg-generated-owner-"));
  roots.push(value);
  return value;
}

async function read(repository: string, repositoryPath: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(repository, ...repositoryPath.split("/")));
  } catch {
    return null;
  }
}

async function put(repository: string, repositoryPath: string, content: string): Promise<void> {
  const absolute = path.join(repository, ...repositoryPath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("shared generated-file owner", () => {
  it("owns comment-less formats through a sorted, canonical side record", async () => {
    const first = await root();
    const second = await root();
    await commitGeneratedSet(first, spec(), render());
    await commitGeneratedSet(second, spec(), [...render()].reverse());

    const record = await read(first, RECORD);
    expect(record?.equals((await read(second, RECORD)) ?? Buffer.alloc(0))).toBe(true);
    const parsed = JSON.parse(record?.toString("utf8") ?? "{}") as {
      files: Array<{ path: string; content_sha256: string }>;
    };
    expect(record?.toString("utf8")).toBe(canonicalJson(parsed));
    expect(parsed.files.map((file) => file.path)).toEqual(PATHS);
    for (const file of render()) {
      expect((await read(first, file.path))?.equals(file.bytes)).toBe(true);
    }
    const inspection = await inspectGeneratedSet(first, spec());
    expect(inspection.state).toBe("owned");
    expect(inspection.files.map((file) => file.path)).toEqual(PATHS);
  });

  it("refuses unowned files and preserves their bytes", async () => {
    const repository = await root();
    await put(repository, "config/app.yaml", "mine: true\n");

    await expect(commitGeneratedSet(repository, spec(), render())).rejects.toThrow(
      "config/app.yaml: not owned by fixture-gen; refusing to overwrite",
    );
    expect((await read(repository, "config/app.yaml"))?.toString()).toBe("mine: true\n");
    expect(await read(repository, "config/app.json")).toBeNull();
    expect(await read(repository, RECORD)).toBeNull();
  });

  it("reports hand-edited owned files as conflicts", async () => {
    const repository = await root();
    await commitGeneratedSet(repository, spec(), render());
    await put(repository, "config/app.json", '{"name": "edited"}\n');

    const inspection = await inspectGeneratedSet(repository, spec());
    expect(inspection.state).toBe("conflict");
    expect(inspection.conflicts).toEqual([
      "config/app.json: owned file was edited outside the generator",
    ]);
    await expect(commitGeneratedSet(repository, spec(), render("next"))).rejects.toThrow(
      "Refusing to overwrite fixture files",
    );
    expect((await read(repository, "config/app.json"))?.toString()).toBe('{"name": "edited"}\n');
  });

  it("regenerates owned, unedited side-record files from a new render or template", async () => {
    const repository = await root();
    const strict = spec({ byteCompareExempt: [] });
    await commitGeneratedSet(repository, strict, render("v1"));

    const next = render("v2");
    const result = await commitGeneratedSet(repository, strict, next);
    expect(result.paths).toEqual([...PATHS, RECORD]);
    for (const file of next) {
      expect((await read(repository, file.path))?.equals(file.bytes)).toBe(true);
    }
    const recordFiles = () =>
      read(repository, RECORD).then(
        (bytes) => (JSON.parse(bytes?.toString("utf8") ?? "{}") as { files: unknown[] }).files,
      );
    expect(await recordFiles()).toEqual(
      next.map((file) => ({
        path: file.path,
        template_sha256: file.template_sha256,
        content_sha256: sha256(file.bytes),
      })),
    );

    const retemplated = next.map((file) =>
      file.path === "config/app.yaml"
        ? generatedFile(file.path, file.bytes, sha256("template:yaml-v2"))
        : file,
    );
    const retemplate = await commitGeneratedSet(repository, strict, retemplated);
    expect(retemplate).toEqual({ changed: true, paths: [...PATHS, RECORD] });
    expect(await recordFiles()).toContainEqual({
      path: "config/app.yaml",
      template_sha256: sha256("template:yaml-v2"),
      content_sha256: sha256(Buffer.from("name: v2\n")),
    });
    expect(await verifyGeneratedSet(repository, strict, retemplated)).toEqual({
      ok: true,
      stale: [],
      conflicts: [],
    });
  });

  it("treats corrupt, extra-field and stale records as conflicts", async () => {
    const repository = await root();
    await commitGeneratedSet(repository, spec(), render());
    const valid = (await read(repository, RECORD))?.toString("utf8") ?? "";

    await put(repository, RECORD, "{");
    expect((await inspectGeneratedSet(repository, spec())).conflicts).toContain(
      `${RECORD}: invalid ownership record`,
    );

    await put(repository, RECORD, canonicalJson({ ...JSON.parse(valid), extra: true }));
    expect((await inspectGeneratedSet(repository, spec())).conflicts).toContain(
      `${RECORD}: invalid ownership record`,
    );

    await put(repository, RECORD, valid);
    const narrowed = spec({ paths: PATHS.slice(1), byteCompareExempt: [] });
    expect((await inspectGeneratedSet(repository, narrowed)).conflicts).toContain(
      `${RECORD}: stale ownership record lists assets/LICENSE`,
    );
  });

  it("recognises files stamped with the legacy in-file marker and adopts them", async () => {
    const repository = await root();
    const templateSha256 = sha256("template:py");
    const legacy = finalizeGeneratedContent(
      `# ${generatedMarker(templateSha256, CONTENT_DIGEST_SENTINEL)}\nprint("stable")\n`,
    );
    await put(repository, "scripts/tool.py", legacy.bytes.toString("utf8"));

    const before = await inspectGeneratedSet(repository, spec());
    expect(before.state).toBe("owned");
    expect(before.files.map((file) => file.path)).toEqual(["scripts/tool.py"]);

    const replacement = generatedFile("scripts/tool.py", legacy.bytes, templateSha256);
    const result = await commitGeneratedSet(repository, spec(), [replacement]);
    expect(result.paths).toEqual(["scripts/tool.py", RECORD]);
    const record = JSON.parse((await read(repository, RECORD))?.toString("utf8") ?? "{}") as {
      files: Array<{ path: string; content_sha256: string }>;
    };
    expect(record.files).toEqual([
      {
        path: "scripts/tool.py",
        template_sha256: templateSha256,
        content_sha256: sha256(legacy.bytes),
      },
    ]);
  });

  it("aborts on a concurrent edit and rolls back earlier writes", async () => {
    const repository = await root();
    await expect(
      commitGeneratedSet(repository, spec(), render(), {
        onPreMutation: async (repositoryPath) => {
          if (repositoryPath === "assets/LICENSE") {
            await put(repository, "config/app.json", "user\n");
          }
        },
      }),
    ).rejects.toThrow("Concurrent mutation detected: config/app.json");
    expect(await read(repository, "assets/LICENSE")).toBeNull();
    expect((await read(repository, "config/app.json"))?.toString()).toBe("user\n");
    expect(await read(repository, RECORD)).toBeNull();
  });

  it("restores every file and the record to the snapshot after a late failure", async () => {
    const fresh = await root();
    await expect(
      commitGeneratedSet(fresh, spec(), render(), {
        afterWrite: (repositoryPath) => {
          if (repositoryPath === RECORD) throw new Error("injected record failure");
        },
      }),
    ).rejects.toThrow("injected record failure");
    for (const repositoryPath of [...PATHS, RECORD]) {
      expect(await read(fresh, repositoryPath)).toBeNull();
    }

    const existing = await root();
    await commitGeneratedSet(existing, spec(), render("v1"));
    const snapshot = new Map<string, Buffer | null>();
    for (const repositoryPath of [...PATHS, RECORD]) {
      snapshot.set(repositoryPath, await read(existing, repositoryPath));
    }
    await expect(
      commitGeneratedSet(existing, spec(), render("v2"), {
        afterWrite: (repositoryPath) => {
          if (repositoryPath === RECORD) throw new Error("injected record failure");
        },
      }),
    ).rejects.toThrow("injected record failure");
    for (const [repositoryPath, bytes] of snapshot) {
      expect((await read(existing, repositoryPath))?.equals(bytes ?? Buffer.alloc(0))).toBe(true);
    }
    const names = await readdir(path.join(existing, "config"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves files changed during rollback untouched and reports them", async () => {
    const repository = await root();
    await expect(
      commitGeneratedSet(repository, spec(), render(), {
        afterWrite: async (_repositoryPath, index) => {
          if (index === 1) {
            await put(repository, "assets/LICENSE", "user license\n");
            throw new Error("injected write failure");
          }
        },
      }),
    ).rejects.toThrow("assets/LICENSE: changed concurrently; left untouched");
    expect((await read(repository, "assets/LICENSE"))?.toString()).toBe("user license\n");
    expect(await read(repository, "config/app.json")).toBeNull();
  });

  it("rejects Windows-style, escaping and case-colliding paths", async () => {
    const repository = await root();
    for (const paths of [["config\\app.json"], ["../outside.json"]]) {
      await expect(inspectGeneratedSet(repository, spec({ paths }))).rejects.toThrow();
    }
    await expect(
      inspectGeneratedSet(repository, spec({ paths: ["config/App.json", "config/app.json"] })),
    ).rejects.toThrow("Case-colliding");
    await expect(
      commitGeneratedSet(repository, spec(), [
        generatedFile("config/other.json", "{}\n", sha256("t")),
      ]),
    ).rejects.toThrow("outside the fixture set");
  });

  it("refuses generated-file parents linked outside the repository", async () => {
    const repository = await root();
    const outside = await root();
    await createTestSymlink(outside, path.join(repository, "config"), "dir");

    await expect(commitGeneratedSet(repository, spec(), render())).rejects.toThrow(
      /Symbolic links|Unsafe generated-file parent/,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("treats a second identical commit as a no-op", async () => {
    const repository = await root();
    expect((await commitGeneratedSet(repository, spec(), render())).changed).toBe(true);
    const written: string[] = [];
    const second = await commitGeneratedSet(repository, spec(), render(), {
      onPreMutation: (repositoryPath) => {
        written.push(repositoryPath);
      },
    });
    expect(second).toEqual({ changed: false, paths: [] });
    expect(written).toEqual([]);
  });

  it("classifies every file in per-file preview and writes nothing", async () => {
    const repository = await root();
    const absent = await previewGeneratedSet(repository, spec(), render());
    expect(absent.map((file) => file.action)).toEqual(["create", "create", "create", "create"]);
    expect(await readdir(repository)).toEqual([]);

    await commitGeneratedSet(repository, spec({ paths: PATHS.slice(0, 3) }), render().slice(0, 3));
    await put(repository, "config/app.json", '{"name": "edited"}\n');
    await put(repository, "scripts/tool.py", 'print("next")\n');
    const before = await Promise.all([...PATHS, RECORD].map((item) => read(repository, item)));
    const preview = await previewGeneratedSet(repository, spec(), render("next"));
    expect(preview).toEqual([
      {
        path: "assets/LICENSE",
        action: "change",
        priorSha256: sha256(Buffer.from("Licensed stable\n")),
      },
      {
        path: "config/app.json",
        action: "conflict",
        reason: "owned file was edited outside the generator",
        priorSha256: sha256(Buffer.from('{"name": "edited"}\n')),
      },
      {
        path: "config/app.yaml",
        action: "change",
        priorSha256: sha256(Buffer.from("name: stable\n")),
      },
      {
        path: "scripts/tool.py",
        action: "skip",
        reason: "unowned file already has these exact bytes; left alone",
        priorSha256: sha256(Buffer.from('print("next")\n')),
      },
    ]);
    expect((await previewGeneratedSet(repository, spec(), render()))[0]).toMatchObject({
      action: "unchanged",
    });
    await put(repository, "scripts/tool.py", "mine\n");
    expect((await previewGeneratedSet(repository, spec(), render("next")))[3]).toMatchObject({
      action: "conflict",
      reason: "not owned by fixture-gen; refusing to overwrite",
    });
    await put(repository, RECORD, "{");
    expect(
      (await previewGeneratedSet(repository, spec(), render())).every(
        (file) => file.action === "conflict" && file.reason?.includes("invalid ownership record"),
      ),
    ).toBe(true);
    await put(repository, RECORD, before[4]?.toString("utf8") ?? "");
    await put(repository, "scripts/tool.py", 'print("next")\n');
    const after = await Promise.all([...PATHS, RECORD].map((item) => read(repository, item)));
    expect(after).toEqual(before);
  });

  it("rolls the set back when afterAllWrites throws and reports incomplete rollback", async () => {
    const repository = await root();
    await commitGeneratedSet(repository, spec(), render("v1"));
    const snapshot = await Promise.all([...PATHS, RECORD].map((item) => read(repository, item)));
    const failure = await commitGeneratedSet(repository, spec(), render("v2"), {
      afterAllWrites: async () => {
        throw new Error("project check failed");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GeneratedSetCommitError);
    expect(failure).toMatchObject({
      code: "write-failed",
      rollbackIncomplete: false,
      message: "project check failed",
    });
    expect(await Promise.all([...PATHS, RECORD].map((item) => read(repository, item)))).toEqual(
      snapshot,
    );

    const incomplete = await commitGeneratedSet(repository, spec(), render("v3"), {
      afterAllWrites: async () => {
        await put(repository, "config/app.yaml", "user\n");
        throw new Error("late failure");
      },
    }).catch((error: unknown) => error);
    expect(incomplete).toMatchObject({ code: "write-failed", rollbackIncomplete: true });
    expect(String((incomplete as Error).message)).toContain(
      "config/app.yaml: changed concurrently; left untouched",
    );
    expect((await read(repository, "config/app.yaml"))?.toString()).toBe("user\n");

    const other = await root();
    await put(other, "config/app.yaml", "mine: true\n");
    await expect(commitGeneratedSet(other, spec(), render())).rejects.toMatchObject({
      code: "refused",
    });
  });

  it("lists stale outputs in check-only mode without writing", async () => {
    const repository = await root();
    const absent = await verifyGeneratedSet(repository, spec(), render());
    expect(absent).toEqual({ ok: false, stale: [...PATHS, RECORD].sort(), conflicts: [] });
    expect(await read(repository, RECORD)).toBeNull();

    await commitGeneratedSet(repository, spec(), render("v1"));
    expect(await verifyGeneratedSet(repository, spec(), render("v1"))).toEqual({
      ok: true,
      stale: [],
      conflicts: [],
    });
    const strict = spec({ byteCompareExempt: ["config/app.yaml"] });
    const drift = await verifyGeneratedSet(repository, strict, render("v2"));
    expect(drift.stale).toEqual(["assets/LICENSE", "config/app.json", "scripts/tool.py"]);
    expect((await read(repository, "assets/LICENSE"))?.toString()).toBe("Licensed v1\n");
  });
});
