import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGrepTool, detectExternalScanner } from "./grep.js";

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

/**
 * One fixture covering the inputs where two regex engines and two file walkers
 * are most likely to disagree: dot-directories, ignored paths, non-ASCII text,
 * CRLF endings, a line past the truncation cap, and a binary blob.
 */
async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-grep-parity-"));
  const files: Record<string, string> = {
    ".gitignore": "ignored/\n*.min.js\n",
    ".github/workflows/ci.yml": "name: ci\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
    "src/alpha.ts": "export const alpha = 1;\nconst TOKEN = 'alpha';\n// alpha again\n",
    "src/beta.ts": "export function beta() {\n  return 'ALPHA';\n}\n",
    // A nested ignore file must NOT take effect: only the search root's
    // .gitignore applies, on both scanner paths.
    "src/nested/.gitignore": "deep/\n",
    "src/nested/deep/gamma.ts": "// alpha in a deep file\nexport const gamma = 2;\n",
    "src/unicode.ts":
      "const caf\u00e9 = '\u00e9l\u00e8ve \u2014 alpha';\nconst \u65e5\u672c = 'alpha \u6f22\u5b57';\n",
    "src/crlf.ts": "const a = 1;\r\nconst alpha = 2;\r\nconst c = 3;\r\n",
    "src/long.ts": `const long = "${"alpha ".repeat(120)}";\n`,
    "ignored/hidden.ts": "export const alpha = 'should not be searched';\n",
    "vendor/bundle.min.js": "var alpha=1;\n",
    "docs/notes.md": "Alpha, beta and gamma.\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await fs
    .writeFile(
      path.join(dir, "assets", "blob.bin"),
      Buffer.from([0, 1, 2, 97, 108, 112, 104, 97, 0, 3]),
    )
    .catch(async () => {
      await fs.mkdir(path.join(dir, "assets"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "assets", "blob.bin"),
        Buffer.from([0, 1, 2, 97, 108, 112, 104, 97, 0, 3]),
      );
    });
  return dir;
}

interface Query {
  label: string;
  args: { pattern: string; include?: string; case_insensitive?: boolean; max_results?: number };
}

const queries: Query[] = [
  { label: "literal", args: { pattern: "alpha", max_results: 200 } },
  {
    label: "case-insensitive",
    args: { pattern: "alpha", case_insensitive: true, max_results: 200 },
  },
  { label: "inline (?i) flag", args: { pattern: "(?i)ALPHA", max_results: 200 } },
  { label: "anchored", args: { pattern: "^export ", max_results: 200 } },
  { label: "character class", args: { pattern: "const [a-z]+ =", max_results: 200 } },
  { label: "include filter", args: { pattern: "alpha", include: "*.ts", max_results: 200 } },
  { label: "unicode literal", args: { pattern: "\u6f22\u5b57", max_results: 200 } },
  { label: "result cap", args: { pattern: "alpha", max_results: 3 } },
  { label: "no matches", args: { pattern: "zzz-not-present-zzz", max_results: 200 } },
];

let externalAvailable = false;

beforeAll(async () => {
  externalAvailable = (await detectExternalScanner()) !== undefined;
});

describe("grep scanner parity", () => {
  it.each(queries)("returns identical output for $label", async ({ args }) => {
    if (!externalAvailable) {
      // `rg` is optional. Skipping loudly beats a silently green run.
      console.warn("skipping grep parity: the external scanner `rg` is not on PATH");
      return;
    }
    const dir = await makeFixture();
    const inProcess = await createGrepTool(dir, undefined, {
      useExternalScanner: () => false,
    }).execute(args, context());
    const external = await createGrepTool(dir, undefined, {
      useExternalScanner: () => true,
    }).execute(args, context());

    expect(String(external)).toBe(String(inProcess));
  });

  it("falls back in-process for lookahead, which the external engine cannot run", async () => {
    const dir = await makeFixture();
    const args = { pattern: "alpha(?= again)", max_results: 200 };
    const forced = await createGrepTool(dir, undefined, {
      useExternalScanner: () => true,
    }).execute(args, context());
    const reference = await createGrepTool(dir, undefined, {
      useExternalScanner: () => false,
    }).execute(args, context());

    expect(String(forced)).toBe(String(reference));
    expect(String(forced)).toContain("alpha again");
  });
});
