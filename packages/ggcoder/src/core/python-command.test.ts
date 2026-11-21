import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pythonInsteadOfPython3 } from "./python-command.js";
import { buildSystemPrompt } from "../system-prompt.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function binDir(sub: string, files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-python-"));
  dirs.push(root);
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

describe("pythonInsteadOfPython3", () => {
  it("picks python when python3 is only the Microsoft Store placeholder", () => {
    const store = binDir("Microsoft/WindowsApps", ["python3.exe", "python.exe"]);
    const real = binDir("Python313", ["python.exe"]);
    expect(pythonInsteadOfPython3({ platform: "win32", pathEnv: `${store};${real}` })).toBe(
      "python",
    );
  });

  it("keeps python3 when a real python3 comes first", () => {
    const real = binDir("Python313", ["python3.exe", "python.exe"]);
    const store = binDir("Microsoft/WindowsApps", ["python3.exe"]);
    expect(pythonInsteadOfPython3({ platform: "win32", pathEnv: `${real};${store}` })).toBeNull();
  });

  it("stays silent when no real python exists or off Windows", () => {
    const store = binDir("Microsoft/WindowsApps", ["python3.exe", "python.exe"]);
    expect(pythonInsteadOfPython3({ platform: "win32", pathEnv: store })).toBeNull();
    expect(pythonInsteadOfPython3({ platform: "win32", pathEnv: "" })).toBeNull();
    expect(pythonInsteadOfPython3({ platform: "linux", pathEnv: store })).toBeNull();
  });
});

it.runIf(process.platform === "win32")(
  "tells the model to run python in the prompt's Platform line",
  async () => {
    const store = binDir("Microsoft/WindowsApps", ["python3.exe"]);
    const real = binDir("Python313", ["python.exe"]);
    const previous = process.env.PATH;
    process.env.PATH = `${store};${real};${previous ?? ""}`;
    try {
      const prompt = await buildSystemPrompt(real);
      expect(prompt).toMatch(/^- Platform: win32 \(run `python`; `python3` won't run here\)$/m);
    } finally {
      process.env.PATH = previous;
    }
  },
);
