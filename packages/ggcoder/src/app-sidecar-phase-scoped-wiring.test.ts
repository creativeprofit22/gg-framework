import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { createPhaseScopedRoadmapWiring } from "./app-sidecar-roadmap-session-options.js";

const APP_SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app-sidecar.ts");

interface FakeSession {
  getActivePhaseContext(): { phase: { id: string } } | undefined;
}

function fakeSession(phaseId?: string): FakeSession {
  return {
    getActivePhaseContext: () => (phaseId === undefined ? undefined : { phase: { id: phaseId } }),
  };
}

/**
 * Compile one production expression from app-sidecar.ts into a function of the
 * two candidate session variables, so tests exercise the real closure text
 * (including which variable it captures) against the real wiring helper.
 */
function compileWiringExpression(
  expression: string,
): (session: FakeSession, created: FakeSession) => unknown {
  const js = ts.transpileModule(`(session, created) => (${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled: unknown = vm.runInNewContext(js, { createPhaseScopedRoadmapWiring });
  if (typeof compiled !== "function") throw new Error("wiring expression did not compile");
  return compiled as (session: FakeSession, created: FakeSession) => unknown;
}

describe("app sidecar phase-scoped Roadmap wiring (production call sites)", () => {
  let getActivePhaseIdExpression: string;
  let isPhaseBoundExpression: string;

  beforeAll(async () => {
    const source = ts.createSourceFile(
      "app-sidecar.ts",
      await fs.readFile(APP_SIDECAR, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const draftHostPhaseIds: string[] = [];
    const codingPhaseBound: string[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === "AppSidecarRoadmapDraftToolHost"
      ) {
        const config = node.arguments?.[0];
        if (config && ts.isObjectLiteralExpression(config)) {
          for (const property of config.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "getActivePhaseId"
            ) {
              draftHostPhaseIds.push(property.initializer.getText(source));
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "createAppSidecarCodingRoadmapSessionOptions"
      ) {
        const isPhaseBound = node.arguments[3];
        codingPhaseBound.push(isPhaseBound ? isPhaseBound.getText(source) : "undefined");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(draftHostPhaseIds).toHaveLength(1);
    expect(codingPhaseBound).toHaveLength(1);
    getActivePhaseIdExpression = draftHostPhaseIds[0] ?? "";
    isPhaseBoundExpression = codingPhaseBound[0] ?? "";
  });

  it("scopes roadmap_inspect to the owning session's bound phase", () => {
    const getActivePhaseId = compileWiringExpression(getActivePhaseIdExpression);
    const owning = fakeSession("phase-owning");
    const other = fakeSession("phase-other");

    const resolve = getActivePhaseId(owning, other);
    expect(typeof resolve).toBe("function");
    expect((resolve as () => unknown)()).toBe("phase-owning");
    expect((getActivePhaseId(fakeSession(), other) as () => unknown)()).toBeUndefined();
  });

  it("selects the bound-phase prompt from the coding session being created", () => {
    const isPhaseBound = compileWiringExpression(isPhaseBoundExpression);

    const bound = isPhaseBound(fakeSession(), fakeSession("phase-created"));
    expect(typeof bound).toBe("function");
    expect((bound as () => unknown)()).toBe(true);

    // Must read `created`, not the outer `session` variable.
    const unbound = isPhaseBound(fakeSession("phase-outer"), fakeSession());
    expect((unbound as () => unknown)()).toBe(false);
  });
});
