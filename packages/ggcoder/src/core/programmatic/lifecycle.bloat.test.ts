import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("A touched-files-only bloat audit confirms lifecycle rules are centralized once and storage does not become a generic database abstraction.", () => {
  it("keeps lifecycle policy singular and file persistence specific", async () => {
    const [lifecycle, scanTool] = await Promise.all([
      fs.readFile(new URL("./lifecycle.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("../../tools/programmatic-scan.ts", import.meta.url), "utf8"),
    ]);
    const operations = lifecycle.match(
      /export interface ProgrammaticLifecycleOperations \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(
      `${lifecycle}\n${scanTool}`.match(/^export function reconcileProgrammaticLifecycle\(/gm),
    ).toHaveLength(1);
    expect(lifecycle.match(/\breconcileProgrammaticLifecycle\(/g)).toHaveLength(2);
    expect(scanTool).not.toMatch(
      /\breconcileProgrammaticLifecycle\b|\.lifecycle\b|\.records\b|\.presence\b/,
    );
    expect(operations).toBeDefined();
    expect([...(operations ?? "").matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1])).toEqual([
      "lstat",
      "readFile",
      "writeFile",
      "rename",
      "rm",
    ]);
    expect(lifecycle).not.toMatch(
      /\bclass\s+\w*(?:Database|Repository|Store|Storage)|\b(?:SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE|DROP TABLE)\b/i,
    );
  });
});
