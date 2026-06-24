import { describe, it, expect } from "vitest";
import { parseNpxPackage, findPackageBinScript, resolveStdioCommand } from "./resolve-stdio.js";

describe("parseNpxPackage", () => {
  it("extracts the package from `npx -y <pkg>`", () => {
    expect(parseNpxPackage("npx", ["-y", "@kenkaiiii/kencode-search"])).toBe(
      "@kenkaiiii/kencode-search",
    );
  });

  it("extracts the package from a full npx path", () => {
    expect(parseNpxPackage("/usr/local/bin/npx", ["--yes", "some-pkg"])).toBe("some-pkg");
  });

  it("handles `npm exec <pkg>`", () => {
    expect(parseNpxPackage("npm", ["exec", "-y", "some-pkg"])).toBe("some-pkg");
  });

  it("skips `-p`/`--package` flag values to find the positional", () => {
    expect(parseNpxPackage("npx", ["-p", "helper-pkg", "real-pkg", "--", "arg"])).toBe("real-pkg");
  });

  it("returns null for non-npx commands", () => {
    expect(parseNpxPackage("node", ["server.js"])).toBeNull();
    expect(parseNpxPackage("uvx", ["mcp-server"])).toBeNull();
    expect(parseNpxPackage("npm", ["install"])).toBeNull();
  });
});

describe("findPackageBinScript", () => {
  it("resolves the kencode-search bin script from ggcoder's install", () => {
    // kencode-search is a ggcoder dependency, so its bin must resolve from here.
    const script = findPackageBinScript("@kenkaiiii/kencode-search", "kencode-search");
    expect(script).toBeTruthy();
    expect(script).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("returns null for an unknown package", () => {
    expect(findPackageBinScript("this-package-does-not-exist-xyz", "x")).toBeNull();
  });
});

describe("resolveStdioCommand", () => {
  it("rewrites a dependency-backed npx server to `node <binScript>`", () => {
    const out = resolveStdioCommand("npx", ["-y", "@kenkaiiii/kencode-search"]);
    expect(out.command).toBe(process.execPath);
    expect(out.args).toHaveLength(1);
    expect(out.args[0]).toMatch(/kencode-search[/\\].*index\.js$/);
  });

  it("forwards server args that follow the package spec", () => {
    const out = resolveStdioCommand("npx", [
      "-y",
      "@kenkaiiii/kencode-search",
      "--",
      "--flag",
      "value",
    ]);
    expect(out.command).toBe(process.execPath);
    // [binScript, "--flag", "value"] — the `--` separator is dropped.
    expect(out.args.slice(1)).toEqual(["--flag", "value"]);
  });

  it("passes through an npx server that isn't locally resolvable", () => {
    const out = resolveStdioCommand("npx", ["-y", "@vendor/not-installed-mcp"]);
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "@vendor/not-installed-mcp"]);
  });

  it("passes through a non-npx command unchanged", () => {
    const out = resolveStdioCommand("uvx", ["some-mcp-server", "--port", "0"]);
    expect(out.command).toBe("uvx");
    expect(out.args).toEqual(["some-mcp-server", "--port", "0"]);
  });
});
