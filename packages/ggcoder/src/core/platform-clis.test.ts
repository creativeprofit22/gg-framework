import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectPlatformClis, renderPlatformClisSection } from "./platform-clis.js";

let tmpDir: string;
let binDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-clis-"));
  binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

function installBinary(name: string): void {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  fs.writeFileSync(path.join(binDir, file), "", { mode: 0o755 });
}

describe("detectPlatformClis", () => {
  it("returns nothing for a project with no platform signals", () => {
    installBinary("railway");
    expect(detectPlatformClis(tmpDir, binDir)).toEqual([]);
  });

  it("flags a project platform as installed only when the binary is on PATH", () => {
    write("railway.json");
    write("vercel.json");
    installBinary("railway");

    const clis = detectPlatformClis(tmpDir, binDir);
    expect(clis.map((c) => [c.binary, c.installed])).toEqual([
      ["railway", true],
      ["vercel", false],
    ]);
  });

  it("finds project-local CLIs in node_modules/.bin and renders them via npx", () => {
    write("convex/schema.ts");
    write("sst.config.ts");
    const bin = process.platform === "win32" ? "convex.cmd" : "convex";
    write(path.join("node_modules", ".bin", bin));

    const clis = detectPlatformClis(tmpDir, binDir);
    expect(clis.map((c) => [c.binary, c.installed, c.local])).toEqual([
      ["convex", true, true],
      ["sst", false, false],
    ]);
    const section = renderPlatformClisSection(clis);
    expect(section).toContain("- `npx convex` —");
    expect(section).toContain("run `npx convex login`");
    expect(section).toContain(
      "- `sst` — deploy, dev, resource outputs, secrets. Install: npm i sst",
    );
  });

  it("accepts a directory signal", () => {
    write(".github/workflows/ci.yml");
    expect(detectPlatformClis(tmpDir, "").map((c) => c.binary)).toEqual(["gh"]);
  });

  it("one signal can map to several CLIs, in registry order", () => {
    write("samconfig.toml");
    write("Chart.yaml");
    write("config/deploy.yml");
    expect(detectPlatformClis(tmpDir, "").map((c) => c.binary)).toEqual([
      "aws",
      "sam",
      "kubectl",
      "helm",
      "kamal",
    ]);
  });
});

describe("renderPlatformClisSection", () => {
  it("renders nothing when there are no platforms", () => {
    expect(renderPlatformClisSection([])).toBe("");
  });

  it("splits installed and missing, with login and install guidance", () => {
    write("railway.json");
    write("vercel.json");
    write("Dockerfile");
    installBinary("railway");
    installBinary("docker");

    const section = renderPlatformClisSection(detectPlatformClis(tmpDir, binDir));
    expect(section).toContain("## Platform CLIs");
    expect(section).toContain("never send the user to a dashboard");
    expect(section).toContain(
      "- `railway` — logs, deploys, variables, services. Auth failure → ask the user to run `railway login`",
    );
    // docker has no login step, so no auth clause.
    expect(section).toMatch(/- `docker` — [^\n]*compose logs\.\n/);
    expect(section).not.toContain("`docker` — build images, run containers, compose logs. Auth");
    expect(section).toContain("offer ONCE to install");
    expect(section).toContain(
      "- `vercel` — deploys, logs, env vars, domains. Install: npm i -g vercel",
    );
  });
});
