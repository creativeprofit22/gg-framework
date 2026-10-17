import { describe, expect, it } from "vitest";
import {
  checkCommandNetwork,
  checkUrlNetwork,
  extractCommandHosts,
  isHostAllowed,
} from "./network-guard.js";

describe("isHostAllowed", () => {
  it("matches exact hosts case-insensitively", () => {
    expect(isHostAllowed("GitHub.com", ["github.com"])).toBe(true);
    expect(isHostAllowed("github.com", ["GITHUB.COM"])).toBe(true);
    expect(isHostAllowed("gitlab.com", ["github.com"])).toBe(false);
  });

  it("matches a leading *. wildcard against subdomains only", () => {
    expect(isHostAllowed("api.github.com", ["*.github.com"])).toBe(true);
    expect(isHostAllowed("a.b.github.com", ["*.github.com"])).toBe(true);
    expect(isHostAllowed("github.com", ["*.github.com"])).toBe(false);
    expect(isHostAllowed("evilgithub.com", ["*.github.com"])).toBe(false);
  });

  it("rejects everything against an empty allowlist", () => {
    expect(isHostAllowed("github.com", [])).toBe(false);
    expect(isHostAllowed("", ["github.com"])).toBe(false);
  });
});

describe("extractCommandHosts", () => {
  it.each<[string, string[]]>([
    ["curl -sSL https://example.com/x.sh", ["example.com"]],
    ["wget https://files.example.org/a.tar.gz -O a.tgz", ["files.example.org"]],
    ["git clone https://github.com/owner/repo.git", ["github.com"]],
    ["git clone git@gitlab.com:owner/repo.git", ["gitlab.com"]],
    ["git push origin main", []],
    ["ssh deploy@prod.example.com 'uptime'", ["prod.example.com"]],
    ["scp file.txt deploy@prod.example.com:/tmp", ["prod.example.com"]],
    ["npm install left-pad", ["registry.npmjs.org"]],
    ["pnpm add -D vitest", ["registry.npmjs.org"]],
    ["yarn add react", ["registry.yarnpkg.com"]],
    ["pip install requests", ["pypi.org"]],
    ["cd repo && curl https://api.example.com/v1", ["api.example.com"]],
  ])("extracts hosts from %s", (command, expected) => {
    expect(extractCommandHosts(command).sort()).toEqual(expected.sort());
  });

  it.each([
    "ls -la",
    "npm run build",
    "git status",
    "git commit -m 'curl https://example.com'",
    "echo hello",
    "python3 script.py",
    "rm -rf node_modules",
  ])("finds no host in %s (no false blocks)", (command) => {
    expect(extractCommandHosts(command)).toEqual([]);
  });
});

describe("checkCommandNetwork", () => {
  it("is a total no-op when the mode is off", () => {
    expect(checkCommandNetwork("curl https://evil.example", "off", [])).toBeNull();
  });

  it("blocks a disallowed host and names the setting", () => {
    const error = checkCommandNetwork("curl https://evil.example/x", "allowlist", ["github.com"]);
    expect(error).toContain("evil.example");
    expect(error).toContain("networkAllow");
  });

  it("allows an allow-listed host and unrecognised commands", () => {
    expect(
      checkCommandNetwork("git clone https://github.com/o/r.git", "allowlist", ["github.com"]),
    ).toBeNull();
    expect(checkCommandNetwork("make build", "allowlist", [])).toBeNull();
  });
});

describe("checkUrlNetwork", () => {
  it("is a total no-op when the mode is off", () => {
    expect(checkUrlNetwork("https://evil.example", "off", [])).toBeNull();
  });

  it("enforces the allowlist on a URL", () => {
    expect(checkUrlNetwork("https://api.github.com/x", "allowlist", ["*.github.com"])).toBeNull();
    expect(checkUrlNetwork("https://evil.example/x", "allowlist", ["*.github.com"])).toContain(
      "evil.example",
    );
  });
});
