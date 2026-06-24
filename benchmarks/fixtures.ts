/**
 * Test fixtures — synthetic files, message arrays, and data
 * that mimic real-world workloads for benchmarking.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── File generators ──

export function generateTsFile(lines: number): string {
  const parts: string[] = [
    `// Auto-generated TypeScript file (${lines} lines)`,
    `import { EventEmitter } from "node:events";`,
    ``,
    `export class Service${0} extends EventEmitter {`,
    `  private _data: Map<string, unknown> = new Map();`,
    `  private _count = 0;`,
  ];
  for (let i = 0; i < lines - 10; i++) {
    parts.push(
      `  method_${i}(value: string): boolean {`,
      `    const key = "item_" + this._count++;`,
      `    this._data.set(key, { value, index: ${i} });`,
      `    this.emit("change", { key, value });`,
      `    return this._data.has(key);`,
      `  }`,
      ``,
    );
  }
  parts.push(`}`);
  return parts.join("\n");
}

export function generateJsonFile(entries: number): string {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < entries; i++) {
    obj[`key_${i}`] = {
      id: i,
      name: `Entry ${i}`,
      values: Array.from({ length: 10 }, (_, j) => i * 10 + j),
      nested: { deep: { value: i * 1000 } },
    };
  }
  return JSON.stringify(obj, null, 2);
}

export function generatePythonFile(lines: number): string {
  const parts: string[] = [
    `# Auto-generated Python file (${lines} lines)`,
    `import json`,
    `from typing import Dict, List, Optional`,
    ``,
    `class Service:`,
  ];
  for (let i = 0; i < lines - 10; i++) {
    parts.push(
      `    def method_${i}(self, value: str) -> bool:`,
      `        key = f"item_{self._count}"`,
      `        self._count += 1`,
      `        self._data[key] = {"value": value, "index": ${i}}`,
      `        return key in self._data`,
      ``,
    );
  }
  parts.push(`    pass`);
  return parts.join("\n");
}

// ── Temp directory fixtures ──

const FIXTURE_ROOT = path.join(os.tmpdir(), "gg-bench-fixtures");

export function ensureFixtureDir(): string {
  if (!fs.existsSync(FIXTURE_ROOT)) {
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  }
  return FIXTURE_ROOT;
}

export function createFileTree(
  dir: string,
  fileCount: number,
  linesPerFile: number,
  extension = ".ts",
): void {
  if (fs.existsSync(dir)) return; // cached
  fs.mkdirSync(dir, { recursive: true });

  const subdirs = Math.min(20, Math.ceil(fileCount / 50));
  for (let i = 0; i < fileCount; i++) {
    const subdir = path.join(dir, `mod_${i % subdirs}`);
    if (!fs.existsSync(subdir)) fs.mkdirSync(subdir, { recursive: true });
    const content =
      extension === ".ts"
        ? generateTsFile(linesPerFile)
        : extension === ".py"
          ? generatePythonFile(linesPerFile)
          : generateJsonFile(linesPerFile);
    fs.writeFileSync(path.join(subdir, `file_${i}${extension}`), content);
  }
}

export function getFixturePath(name: string): string {
  return path.join(ensureFixtureDir(), name);
}

// ── Large file helpers ──

/** Write a file and return its path, or return cached path if it exists. */
export function ensureLargeFile(name: string, lines: number, ext = ".ts"): string {
  const p = path.join(ensureFixtureDir(), `${name}_${lines}${ext}`);
  if (fs.existsSync(p)) return p;
  const gen = ext === ".ts" ? generateTsFile : ext === ".py" ? generatePythonFile : generateJsonFile;
  fs.writeFileSync(p, gen(lines));
  return p;
}

/** Read a fixture file's content. */
export function readFixtureContent(name: string, lines: number, ext = ".ts"): string {
  const p = ensureLargeFile(name, lines, ext);
  return fs.readFileSync(p, "utf-8");
}

// ── Message array generators (for agent-loop benchmarks) ──

export interface SimpleMessage {
  role: "user" | "assistant" | "tool";
  content: string | unknown[];
}

export function generateConversation(turns: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    // User message
    messages.push({
      role: "user",
      content: `Please help me with task ${i}. I need to refactor the method_${i} function to handle edge cases.`,
    });
    // Assistant message with tool call
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `I'll read the file and make the change.` },
        { type: "tool_call", id: `call_${i}`, name: "edit", args: { file: `f${i}.ts` } },
      ],
    });
    // Tool result
    messages.push({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: `call_${i}`, content: "Edit applied successfully." }],
    });
  }
  return messages;
}

/** Generate conversation with deliberately broken tool pairing (for repair benchmark). */
export function generateBrokenConversation(turns: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content: `Task ${i}`,
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Working on it.` },
        { type: "tool_call", id: `call_${i}`, name: "read", args: { path: `f${i}.ts` } },
      ],
    });
    // Skip the tool result for odd-indexed turns — creates dangling tool calls
    if (i % 2 === 0) {
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: `call_${i}`, content: "done" }],
      });
    }
  }
  return messages;
}

// ── Cleanup ──

export function cleanupFixtures(): void {
  if (fs.existsSync(FIXTURE_ROOT)) {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  }
}
