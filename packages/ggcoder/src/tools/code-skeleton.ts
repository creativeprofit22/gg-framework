import ts from "typescript";

/**
 * Extract an API skeleton from a TypeScript/JavaScript source file: imports,
 * re-exports, exported declarations with their full signatures, and type
 * definitions — with function/method *bodies* stubbed out.
 *
 * Purpose: let the agent understand a file's public API for a fraction of the
 * tokens of a full read. It is a pure structural transform over the TS AST —
 * it never invents text, only keeps or stubs nodes that are really there.
 *
 * SCOPE — read this before using it anywhere:
 *   - SAFE for "what does this file export / how do I call it" (understanding).
 *   - NOT safe for editing the file: bodies and original line numbers are gone.
 *     The edit path must always do a full read.
 *
 * Faithfulness guarantees (see code-skeleton.test.ts, mechanically asserted):
 *   1. Every exported symbol survives with a usable signature — including
 *      re-export barrels (`export { x } from`, `export *`) and arrow consts
 *      whose callable shape is preserved (params + return, even when inferred).
 *   2. Stubbed bodies are explicitly marked with a body stub — never silently empty.
 */

export interface SkeletonResult {
  skeleton: string;
  /** Names of every exported symbol found in the source. */
  exports: string[];
  /** True when the file had no extractable top-level API (skeleton is empty). */
  empty: boolean;
}

const BODY_STUB = "{ /* … */ }";

function stubSignature(node: ts.Node, sf: ts.SourceFile): string {
  const full = node.getText(sf);
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) {
      const head = full.slice(0, body.getStart(sf) - node.getStart(sf)).trimEnd();
      return `${head} ${BODY_STUB}`;
    }
  }
  return full;
}

/**
 * For `export const x = (a: A): R => {…}` or `= function (…) {…}`, keep the
 * callable head (everything up to the body) and stub the body. For non-callable
 * initializers, keep the declared/annotated type and stub the value. This is
 * what fixes the "name kept but signature lost" hole.
 */
function stubVariable(decl: ts.VariableDeclaration, sf: ts.SourceFile, exported: boolean): string {
  const prefix = exported ? "export const " : "const ";
  const name = decl.name.getText(sf);
  const init = decl.initializer;

  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    // Slice the initializer's text up to its body so params + return type
    // survive — whether the body is a block `{…}` or an expression `=> x`.
    const initFull = init.getText(sf);
    const head = initFull.slice(0, init.body.getStart(sf) - init.getStart(sf)).trimEnd();
    return `${prefix}${name} = ${head} ${BODY_STUB};`;
  }

  const type = decl.type ? `: ${decl.type.getText(sf)}` : "";
  return `${prefix}${name}${type} = /* … */;`;
}

export function extractSkeleton(source: string, fileName = "module.ts"): SkeletonResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const exports: string[] = [];

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

  sf.forEachChild((node) => {
    // import … (kept verbatim — cheap, and clarifies the file's dependencies)
    if (ts.isImportDeclaration(node)) {
      out.push(node.getText(sf));
      return;
    }

    // export { a, b } from "x"  /  export * from "x"  /  export { a }
    if (ts.isExportDeclaration(node)) {
      out.push(node.getText(sf));
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) exports.push(el.name.text);
      }
      // `export *` re-exports unknown names; the line itself is the signal.
      return;
    }

    // export = x  /  export default …
    if (ts.isExportAssignment(node)) {
      out.push(node.getText(sf).split("\n")[0]);
      exports.push(node.isExportEquals ? "export=" : "default");
      return;
    }

    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      out.push(node.getText(sf)); // type-level: pure signal, keep whole
      if (isExported(node) && node.name) exports.push(node.name.text);
      return;
    }

    if (ts.isFunctionDeclaration(node)) {
      out.push(stubSignature(node, sf));
      if (isExported(node)) {
        if (node.name) exports.push(node.name.text);
        else exports.push("default"); // export default function (anon)
      }
      return;
    }

    if (ts.isClassDeclaration(node)) {
      const heritage = node.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? "";
      const members = node.members
        .filter((m) => {
          // Drop private members — not part of the consumable API.
          const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
          return !mods?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword);
        })
        .map((m) => `  ${stubSignature(m, sf)}`)
        .join("\n");
      const name = node.name?.text ?? "";
      const decl = isExported(node) ? "export class" : "class";
      const heritagePart = heritage ? ` ${heritage}` : "";
      out.push(`${decl} ${name}${heritagePart} {\n${members}\n}`);
      if (isExported(node)) exports.push(name || "default");
      return;
    }

    if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) return; // internal consts aren't API
      for (const d of node.declarationList.declarations) {
        out.push(stubVariable(d, sf, true));
        exports.push(d.name.getText(sf));
      }
    }
  });

  const skeleton = out.join("\n\n");
  return { skeleton, exports, empty: out.length === 0 };
}
