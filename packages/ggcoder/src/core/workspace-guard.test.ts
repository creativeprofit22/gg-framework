import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCatastrophicCommand, resolveWriteGuard } from "./workspace-guard.js";

const cwd = path.join(os.tmpdir(), "guard-test-workspace");

describe("resolveWriteGuard", () => {
  it("allows paths under the workspace cwd", () => {
    expect(resolveWriteGuard(cwd, path.join(cwd, "src", "a.ts")).allowed).toBe(true);
    expect(resolveWriteGuard(cwd, cwd).allowed).toBe(true);
  });

  it("allows paths under the OS temp dir", () => {
    const target = path.join(os.tmpdir(), "scratch", "notes.md");
    expect(resolveWriteGuard("/somewhere/else", target).allowed).toBe(true);
  });

  it("allows paths under the agent's own ~/.gg state dir", () => {
    const target = path.join(os.homedir(), ".gg", "plans", "plan.md");
    expect(resolveWriteGuard(cwd, target).allowed).toBe(true);
  });

  it("blocks paths outside all allowed roots with an instructive reason", () => {
    const target = path.join(os.homedir(), "Documents", "outside.txt");
    const result = resolveWriteGuard(cwd, target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the workspace");
    expect(result.reason).toContain("allowOutsideWorkspaceWrites");
  });

  it("does not treat sibling directories with a shared prefix as inside", () => {
    const result = resolveWriteGuard(cwd, `${cwd}-evil/file.txt`);
    // `${cwd}-evil` shares the cwd string prefix but is a different directory.
    // It IS still under tmpdir here, so use a home-based pair instead.
    const home = path.join(os.homedir(), "project");
    expect(resolveWriteGuard(home, `${home}-evil/file.txt`).allowed).toBe(false);
    expect(result.allowed).toBe(true); // tmpdir root still allows it
  });

  it("allows writes under an additional root", () => {
    const extra = path.join(os.homedir(), "sibling-sdk");
    const target = path.join(extra, "src", "index.ts");
    expect(resolveWriteGuard(cwd, target).allowed).toBe(false);
    expect(resolveWriteGuard(cwd, target, { additionalRoots: [extra] }).allowed).toBe(true);
  });

  it("still blocks paths outside every root and names them all", () => {
    const extra = path.join(os.homedir(), "sibling-sdk");
    const target = path.join(os.homedir(), "Documents", "outside.txt");
    const result = resolveWriteGuard(cwd, target, { additionalRoots: [extra] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(cwd);
    expect(result.reason).toContain(extra);
  });

  it("does not treat a shared-prefix sibling of an additional root as inside", () => {
    const extra = path.join(os.homedir(), "sibling-sdk");
    const result = resolveWriteGuard(path.join(os.homedir(), "project"), `${extra}-evil/file.txt`, {
      additionalRoots: [extra],
    });
    expect(result.allowed).toBe(false);
  });

  it("allows everything when allowOutsideWorkspaceWrites is enabled", () => {
    const target = path.join(os.homedir(), "Documents", "outside.txt");
    expect(resolveWriteGuard(cwd, target, { allowOutsideWorkspaceWrites: true }).allowed).toBe(
      true,
    );
  });

  // A cloned/opened repo is untrusted content, and a committed symlink is a
  // normal thing for one to carry. Before these tests the containment check was
  // pure string arithmetic, so `<repo>/link/x` counted as inside the repo no
  // matter where `link` pointed — an unprompted write primitive into ~/.ssh.
  describe("symlink containment", () => {
    const made: string[] = [];
    // Captured before the redirect below, so scratch repos land in the REAL
    // temp dir rather than the decoy the guard will be pointed at.
    const realTmp = os.tmpdir();
    const tmpVars = ["TMPDIR", "TEMP", "TMP"] as const;
    const savedTmpVars = new Map<string, string | undefined>();

    async function scratch(name: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(realTmp, `guard-${name}-`));
      made.push(dir);
      return dir;
    }

    // The guard allows the OS temp dir outright. A scratch repo created there
    // would therefore be allowed no matter what `cwd` said — the assertions
    // below would pass even against a completely broken workspace root, which
    // is exactly the regression this fix could cause (a symlinked workspace
    // denying legitimate writes) left unguarded. Point the guard's temp root
    // at an empty decoy that is a SIBLING of the scratch repos, so `cwd` is
    // the only root that can allow them.
    beforeEach(async () => {
      const decoy = await fs.mkdtemp(path.join(realTmp, "guard-decoy-"));
      made.push(decoy);
      for (const key of tmpVars) {
        savedTmpVars.set(key, process.env[key]);
        process.env[key] = decoy;
      }
    });

    afterEach(async () => {
      for (const key of tmpVars) {
        const previous = savedTmpVars.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      savedTmpVars.clear();
      while (made.length > 0) {
        await fs.rm(made.pop()!, { recursive: true, force: true });
      }
    });

    it("puts scratch repos outside every root except cwd (guards the tests below)", async () => {
      const repo = await scratch("control");
      const target = path.join(repo, "src", "a.ts");

      // Same target, a cwd that does not contain it: must be denied. If this
      // ever passes, the "allows" tests below have stopped proving anything.
      expect(resolveWriteGuard(path.join(realTmp, "some-other-workspace"), target).allowed).toBe(
        false,
      );
      expect(resolveWriteGuard(repo, target).allowed).toBe(true);
    });

    // The link points at the home directory: somewhere that genuinely exists,
    // is outside every allowed root, and is the real target of this attack
    // (~/.ssh, ~/.zshrc). Nothing is written there — the guard is a pure
    // function, so these tests only ask it for a verdict.
    async function repoWithEscapingLink(name: string): Promise<string> {
      const repo = await scratch(name);
      await fs.symlink(os.homedir(), path.join(repo, "link"), "dir");
      return repo;
    }

    it("blocks a write through a symlink that escapes the workspace", async () => {
      const repo = await repoWithEscapingLink("escape");

      const result = resolveWriteGuard(repo, path.join(repo, "link", ".ssh", "authorized_keys"));

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("symlink");
    });

    it("blocks it for a nested target whose parent does not exist yet", async () => {
      const repo = await repoWithEscapingLink("nested");

      const target = path.join(repo, "link", "deep", "not", "created", "yet.txt");
      expect(resolveWriteGuard(repo, target).allowed).toBe(false);
    });

    it("still allows a symlink that stays inside the workspace", async () => {
      const base = await scratch("inside");
      const repo = path.join(base, "repo");
      const real = path.join(repo, "packages", "core");
      await fs.mkdir(real, { recursive: true });
      await fs.symlink(real, path.join(repo, "core-link"), "dir");

      const target = path.join(repo, "core-link", "index.ts");
      expect(resolveWriteGuard(repo, target).allowed).toBe(true);
    });

    it("allows a brand-new file in a real workspace directory", async () => {
      const repo = await scratch("plain");
      const target = path.join(repo, "src", "brand", "new.ts");
      expect(resolveWriteGuard(repo, target).allowed).toBe(true);
    });
  });
});

describe("isCatastrophicCommand", () => {
  it.each([
    "rm -rf /",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm -rf ~",
    "rm -rf $HOME",
    'rm -rf "$HOME"',
    "sudo rm -rf /",
    `rm -rf ${os.homedir()}`,
  ])("blocks %s", (command) => {
    const result = isCatastrophicCommand(command, cwd);
    expect(result).not.toBeNull();
    expect(result).toContain("user confirmation");
  });

  it("blocks recursive force-remove of the workspace root itself", () => {
    expect(isCatastrophicCommand("rm -rf .", cwd)).not.toBeNull();
    expect(isCatastrophicCommand(`rm -rf ${cwd}`, cwd)).not.toBeNull();
  });

  it("blocks Windows rd /s /q on a bare drive root", () => {
    expect(isCatastrophicCommand("rd /s /q C:\\", cwd)).not.toBeNull();
    expect(isCatastrophicCommand("rmdir /s /q C:\\", cwd)).not.toBeNull();
  });

  it("blocks a chained catastrophic command", () => {
    expect(isCatastrophicCommand("echo done && rm -rf /", cwd)).not.toBeNull();
  });

  it("blocks git push --force --mirror", () => {
    expect(isCatastrophicCommand("git push --force --mirror origin", cwd)).not.toBeNull();
    expect(isCatastrophicCommand("git push --mirror -f origin", cwd)).not.toBeNull();
  });

  it.each([
    "rm -rf node_modules",
    "rm -rf ./dist",
    "rm -rf /tmp/scratch-dir",
    "rm -rf build coverage",
    "rm file.txt",
    "rm -r src/old",
    "git reset --hard HEAD~1",
    "git push --force origin feature-branch",
    "git push --mirror backup", // mirror without force
    "rd /s /q build",
    "ls -la /",
  ])("allows %s", (command) => {
    expect(isCatastrophicCommand(command, cwd)).toBeNull();
  });
});
