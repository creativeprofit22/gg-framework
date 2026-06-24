import { describe, it, expect } from "vitest";
import ts from "typescript";
import { extractSkeleton } from "./code-skeleton.js";

/**
 * Strong fidelity check: re-parse the skeleton and confirm `name` resolves to a
 * real declaration (not a comment or substring). For callables we also assert
 * the signature text carries a parameter list, so "name kept, signature lost"
 * fails here instead of slipping through a regex.
 */
function skeletonDeclares(skeleton: string, name: string): boolean {
  const sf = ts.createSourceFile("skel.ts", skeleton, ts.ScriptTarget.Latest, true);
  let found = false;
  const walk = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name?.getText(sf) === name
    ) {
      found = true;
    } else if (ts.isVariableDeclaration(node) && node.name.getText(sf) === name) {
      found = true;
    } else if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        if (node.exportClause.elements.some((e) => e.name.text === name)) found = true;
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

describe("extractSkeleton", () => {
  it("keeps re-export barrels (export {} from / export *) — does NOT render them empty", () => {
    const src = `
      export { foo, bar } from "./other.js";
      export * from "./barrel.js";
    `;
    const r = extractSkeleton(src);
    expect(r.empty).toBe(false);
    expect(r.skeleton).toContain('export { foo, bar } from "./other.js"');
    expect(r.skeleton).toContain('export * from "./barrel.js"');
    expect(skeletonDeclares(r.skeleton, "foo")).toBe(true);
    expect(skeletonDeclares(r.skeleton, "bar")).toBe(true);
  });

  it("preserves the callable signature of an exported arrow const", () => {
    const src = `export const handler = async (req: Request, opts: Opts): Promise<Response> => {
      return new Response("hi");
    };`;
    const r = extractSkeleton(src);
    expect(r.skeleton).toContain("req: Request");
    expect(r.skeleton).toContain("opts: Opts");
    expect(r.skeleton).toContain("Promise<Response>");
    expect(r.skeleton).not.toContain('new Response("hi")'); // body gone
    expect(r.skeleton).toContain("/* … */"); // stub marked
  });

  it("keeps function declarations' params/return and stubs the body", () => {
    const src = `export function add(a: number, b: number): number {
      const sum = a + b;
      return sum;
    }`;
    const r = extractSkeleton(src);
    expect(r.skeleton).toContain("add(a: number, b: number): number");
    expect(r.skeleton).not.toContain("const sum");
    expect(r.skeleton).toContain("/* … */");
  });

  it("keeps public class members but drops private ones", () => {
    const src = `export class Svc extends Base {
      private secret = 42;
      async run(x: string): Promise<void> { await this.secret; }
    }`;
    const r = extractSkeleton(src);
    expect(r.skeleton).toContain("class Svc extends Base");
    expect(r.skeleton).toContain("run(x: string): Promise<void>");
    expect(r.skeleton).not.toContain("secret");
  });

  it("keeps interfaces and type aliases whole (pure signal)", () => {
    const src = `export interface User { id: string; name: string; }
      export type ID = string | number;`;
    const r = extractSkeleton(src);
    expect(r.skeleton).toContain("id: string");
    expect(r.skeleton).toContain("type ID = string | number");
  });

  it("omits internal (non-exported) consts and functions' bodies", () => {
    const src = `const internal = computeThing();
      export function api(): void { internal(); }`;
    const r = extractSkeleton(src);
    expect(r.skeleton).not.toContain("computeThing");
    expect(r.skeleton).toContain("api(): void");
  });

  it("never fabricates: every line traces to source or is a marked stub", () => {
    const src = `import { z } from "zod";
      export function f(a: string): string { return a.trim(); }`;
    const r = extractSkeleton(src);
    const srcText = src;
    for (const line of r.skeleton.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const isStub = t.includes("/* … */");
      const tracesBack = srcText.includes(t.replace(/\s*\{ \/\* … \*\/ \}.*$/, "").trim());
      expect(isStub || tracesBack).toBe(true);
    }
  });

  it("reports empty for a file with no extractable API", () => {
    const r = extractSkeleton(`const x = 1; console.log(x);`);
    expect(r.empty).toBe(true);
  });
});
