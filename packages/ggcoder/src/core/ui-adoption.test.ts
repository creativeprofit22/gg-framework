import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptionOperations,
  planAdoption,
  preflightAdoption,
  relocateImports,
} from "./ui-adoption.js";
import { UiRegistry } from "./ui-registry.js";
import { createWriteTool } from "../tools/write.js";
import { createUiAdoptTool } from "../tools/ui-adopt.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-ui-adopt-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { react: "19", vite: "7", tailwindcss: "4" } }),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const fixture = (content = "export const Card = () => <button>OK</button>;", target = "") => ({
  name: "card",
  type: "registry:ui",
  dependencies: ["motion"],
  files: [{ path: "/registry/card.tsx", target, content }],
});
const registry = (item = fixture()) =>
  new UiRegistry(
    undefined,
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(item))),
  );

describe("UI adoption", () => {
  it("plans deterministic targets and missing packages without writing", async () => {
    const service = registry();
    const plan = await planAdoption(root, service, "bklit:card");
    expect(plan.framework).toBe("vite-react");
    expect(plan.files[0].target).toBe("components/ui/card.tsx");
    expect(plan.missingPackages).toEqual(["motion"]);
    expect(plan.hash).toBe((await planAdoption(root, service, "bklit:card")).hash);
    await expect(fs.stat(path.join(root, plan.files[0].target))).rejects.toThrow();
  });

  it("relocates only real imports and exports, preserving strings and comments", () => {
    const source = `// import x from '@/old'\nconst prose = "@/old";\nimport { X } from "@/old";\nexport { Y } from '@/old';\nconst x = import('@/old');`;
    const result = relocateImports(source, () => "../new");
    expect(result).toContain(`// import x from '@/old'`);
    expect(result).toContain('const prose = "@/old"');
    expect(result).toContain('from "../new"');
    expect(result).toContain("import('../new')");
  });

  it("creates through checkpoints and notifications without replacing files", async () => {
    const service = registry();
    const before = vi.fn();
    const after = vi.fn();
    const writer = createWriteTool(
      root,
      undefined,
      adoptionOperations(root),
      undefined,
      after,
      before,
    );
    const tool = createUiAdoptTool(root, service, writer);
    const context = { signal: new AbortController().signal, toolCallId: "test" };
    const plan = await planAdoption(root, service, "bklit:card");
    const result = await tool.execute(
      { action: "apply", id: "bklit:card", planHash: plan.hash },
      context,
    );
    expect(JSON.parse(String(result)).created).toEqual(["components/ui/card.tsx"]);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    const reused = await planAdoption(root, service, "bklit:card");
    expect(reused.files[0].status).toBe("reuse");
    await fs.writeFile(path.join(root, reused.files[0].target), "user content");
    const conflict = await planAdoption(root, service, "bklit:card");
    expect(conflict.files[0].status).toBe("conflict");
    await expect(preflightAdoption(root, conflict)).rejects.toThrow(/blocked/);
    expect(await fs.readFile(path.join(root, reused.files[0].target), "utf8")).toBe("user content");
  });

  it("refuses route/config payloads, traversal, symlinks and changed plans", async () => {
    for (const target of [
      "app/page.tsx",
      "vite.config.ts",
      "../outside.tsx",
      "/absolute.tsx",
      "package.json",
    ]) {
      await expect(
        planAdoption(root, registry(fixture(undefined, target)), "bklit:card"),
      ).rejects.toThrow();
    }
    await fs.symlink(
      root,
      path.join(root, "components"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(planAdoption(root, registry(), "bklit:card")).rejects.toThrow(/Symlink/);
  });

  it("blocks Next imports in Vite and missing helper consumers", async () => {
    const plan = await planAdoption(
      root,
      registry(
        fixture(
          'import Image from "next/image"; import { cn } from "@/lib/utils"; export const Card = () => cn("card");',
        ),
      ),
      "bklit:card",
    );
    expect(plan.blockers.join(" ")).toMatch(/Next.js/);
    expect(plan.blockers.join(" ")).toMatch(/Missing local prerequisite/);
  });

  it("honors configured utils and preserves existing helpers", async () => {
    await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
    await fs.writeFile(path.join(root, "src/shared/util.ts"), "export const cn = () => 'theme';");
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    );
    await fs.writeFile(
      path.join(root, "components.json"),
      JSON.stringify({ aliases: { utils: "@/shared/util" } }),
    );
    const plan = await planAdoption(
      root,
      registry(fixture('import { cn } from "@/lib/utils"; export const Card = () => cn();')),
      "bklit:card",
    );
    expect(plan.files[0].content).toContain('from "../../shared/util"');
    expect(plan.blockers).toEqual([]);
  });
});
