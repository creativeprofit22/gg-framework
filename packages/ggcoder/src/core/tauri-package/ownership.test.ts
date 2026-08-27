import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSymlink } from "../../test-utils/symlink.js";
import { CONTENT_DIGEST_SENTINEL, GENERATED_PATHS, sha256 } from "./paths.js";
import {
  commitSupportSet,
  finalizeGeneratedContent,
  generatedMarker,
  inspectSupportSet,
} from "./ownership.js";
import type { GeneratedFile } from "./types.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "gg-tauri-owner-"));
  roots.push(value);
  return value;
}

function render(label = "stable"): GeneratedFile[] {
  return GENERATED_PATHS.map((repositoryPath) => {
    const templateSha256 = sha256(`template:${repositoryPath}`);
    const provisional = `// ${generatedMarker(templateSha256, CONTENT_DIGEST_SENTINEL)}\nexport default ${JSON.stringify(label)};\n`;
    const final = finalizeGeneratedContent(provisional);
    return {
      path: repositoryPath,
      bytes: final.bytes,
      template_sha256: templateSha256,
      content_sha256: final.contentSha256,
    };
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("generated support ownership", () => {
  it("detects absent, partial, unknown, edited, and mixed-version sets", async () => {
    const repository = await root();
    expect((await inspectSupportSet(repository)).state).toBe("absent");

    await mkdir(path.join(repository, "scripts"));
    await writeFile(path.join(repository, GENERATED_PATHS[0]), "legacy\n");
    const partial = await inspectSupportSet(repository);
    expect(partial.state).toBe("conflict");
    expect(partial.conflicts).toContain(`${GENERATED_PATHS[1]}: missing from partial support set`);

    await rm(repository, { recursive: true });
    await mkdir(repository);
    await commitSupportSet(repository, render());
    await writeFile(path.join(repository, GENERATED_PATHS[0]), "legacy\n");
    expect((await inspectSupportSet(repository)).conflicts[0]).toContain("unknown or legacy");

    await rm(repository, { recursive: true });
    await mkdir(repository);
    await commitSupportSet(repository, render());
    const editedPath = path.join(repository, GENERATED_PATHS[0]);
    await writeFile(editedPath, `${await readFile(editedPath, "utf8")}manual edit\n`);
    expect((await inspectSupportSet(repository)).conflicts[0]).toContain("content digest mismatch");

    await rm(repository, { recursive: true });
    await mkdir(repository);
    await commitSupportSet(repository, render());
    const mixedPath = path.join(repository, GENERATED_PATHS[0]);
    await writeFile(mixedPath, (await readFile(mixedPath, "utf8")).replace("template_version=1", "template_version=2"));
    expect((await inspectSupportSet(repository)).conflicts[0]).toContain("template version 2");
  });

  it("is a no-op when deterministic bytes already exist", async () => {
    const repository = await root();
    const rendered = render();
    expect(await commitSupportSet(repository, rendered)).toMatchObject({ changed: true });
    expect(await commitSupportSet(repository, rendered)).toEqual({ changed: false, paths: [] });
  });

  it("revalidates before mutation and writes nothing when evidence is stale", async () => {
    const repository = await root();
    await expect(
      commitSupportSet(repository, render(), {
        revalidate: () => Promise.reject(new Error("stale evidence")),
      }),
    ).rejects.toThrow("stale evidence");
    expect((await inspectSupportSet(repository)).state).toBe("absent");
  });

  it("rolls back every completed write after an injected failure", async () => {
    const repository = await root();
    await expect(
      commitSupportSet(repository, render(), {
        afterWrite: (_repositoryPath, index) => {
          if (index === 2) throw new Error("injected write failure");
        },
      }),
    ).rejects.toThrow("injected write failure");
    expect((await inspectSupportSet(repository)).state).toBe("absent");
  });

  it("calls mutation hooks around a successful complete commit", async () => {
    const repository = await root();
    const before: string[] = [];
    const after: string[] = [];
    await commitSupportSet(repository, render(), {
      onPreMutation: (repositoryPath) => { before.push(repositoryPath); },
      onCommitted: (repositoryPath) => { after.push(repositoryPath); },
    });
    expect(before).toEqual(GENERATED_PATHS);
    expect(after).toEqual(GENERATED_PATHS);
  });

  it("refuses generated-file parents linked outside the repository", async () => {
    const repository = await root();
    const outside = await root();
    await createTestSymlink(outside, path.join(repository, "scripts"), "dir");

    await expect(commitSupportSet(repository, render())).rejects.toThrow(/Symbolic links|Unsafe generated-file parent/);
    await expect(readFile(path.join(outside, "package-tauri.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
