import fs from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe(
  "A touched-files-only bloat audit confirms routing does not duplicate slash parsing, custom loading, or specialist prompt bodies.",
  () => {
  it("keeps one bounded resolver without execution, prompt, loader, dependency, or lifecycle growth", async () => {
    const [routes, profile, lifecycle, names] = await Promise.all([
      fs.readFile(new URL("./routes.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./profile.ts", import.meta.url), "utf8"),
      fs.readFile(new URL("./lifecycle.ts", import.meta.url), "utf8"),
      fs.readdir(new URL(".", import.meta.url)),
    ]);
    const externalImports = [...routes.matchAll(/from\s+"([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((specifier) => !specifier.startsWith("."));

    expect(externalImports).toEqual([]);
    expect(routes.match(/loadCustomCommands\(/g)).toHaveLength(1);
    expect(routes.match(/export const SPECIALIST_ROUTES/g)).toHaveLength(1);
    expect(profile.match(/resolveProgrammaticRoutes\(/g)).toHaveLength(1);
    const lifecycleFile = ts.createSourceFile("lifecycle.ts", lifecycle, ts.ScriptTarget.Latest, true);
    const resolverImports = lifecycleFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
      const from = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return [];
      return bindings.elements
        .filter((binding) => (binding.propertyName ?? binding.name).text === "resolveProgrammaticRoutes")
        .map((binding) => ({ from, name: binding.name.text }));
    });
    expect(resolverImports).toEqual([{ from: "./routes.js", name: "resolveProgrammaticRoutes" }]);
    // Chat projection and scans are separate consumers, not separate resolvers.
    for (const name of ["projectChatSummaries", "runProgrammaticScan"]) {
      const callers = lifecycleFile.statements.filter(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      expect(callers, name).toHaveLength(1);
      const calls: ts.CallExpression[] = [];
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === "resolveProgrammaticRoutes") calls.push(node);
        ts.forEachChild(node, visit);
      }
      visit(callers[0]!);
      expect(calls, `${name} delegates once to the imported resolver`).toHaveLength(1);
      expect(calls[0]!.arguments).toHaveLength(3);
      expect(callers[0]!.getText(lifecycleFile)).not.toMatch(
        /\b(?:loadCustomCommands|getPromptCommand|resolveOpportunityRoute|resolveSpecialistAvailability)\s*\(|SlashCommandRegistry|SPECIALIST_ROUTES|implementationPrompt|promptTemplate|fallbackPrompt|\.gg[\\/]commands/,
      );
    }
    expect(lifecycle).not.toMatch(/from\s+["'][^"']*(?:custom-commands|prompt-commands|slash-commands)["']/);
    expect(names.filter((name) => /^routes(?:[-_.]v?\d+|[-_]variant)\.ts$/i.test(name))).toEqual([]);
    expect(routes).not.toMatch(
      /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b|\beval\s*\(|new Function|\bfetch\s*\(/,
    );
    expect(routes).not.toMatch(
      /node:fs|\breadFile\b|\breaddir\b|\.gg[\\/]commands|implementationPrompt|promptTemplate|fallbackPrompt/,
    );
    expect(routes).not.toMatch(
      /programmaticLifecycle|reconcileProgrammaticLifecycle|STATE_PATH|\.lifecycle\b|\bqueued\b|\brunning\b|\bcompleted\b|\bdismissed\b/,
    );
  });
  },
);
