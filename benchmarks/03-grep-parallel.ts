/**
 * Benchmark 03: Grep — Sequential vs Parallel File Scanning
 *
 * Measures: file enumeration + content search across N files.
 * Baseline: current sequential for-loop.
 */
import { bench } from "./harness.js";
import { createFileTree, getFixturePath } from "./fixtures.js";
import path from "node:path";
import readline from "node:readline";
import fs from "node:fs";

// ── Import the actual grep implementation (searchFile function) ──
// We inline the core search logic to benchmark it without the AgentTool wrapper.
async function searchFileSequential(
  filePath: string,
  regex: RegExp,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return results;
  } catch {
    return results;
  }

  const stream = fs.createReadStream(filePath, "utf-8");
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNum = 0;
    try {
      for await (const line of rl) {
        lineNum++;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          results.push(`${filePath}:${lineNum}:${line.slice(0, 500)}`);
          if (results.length >= maxResults) break;
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    // skip
  } finally {
    stream.destroy();
  }
  return results;
}

/**
 * Walk a directory tree recursively, collecting all file paths.
 * We use fs.readdir instead of fast-glob since the benchmark
 * measures the file scanning + content matching, not glob parsing.
 */
async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.promises.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

const CONCURRENCY = 16;

export async function grepSequential(
  dir: string,
  regex: RegExp,
  maxResults: number,
): Promise<string[]> {
  const files = await walkDir(dir);

  const results: string[] = [];
  for (const filePath of files) {
    if (results.length >= maxResults) break;
    const ext = path.extname(filePath).toLowerCase();
    if (BIN_EXT.has(ext)) continue;
    const fileResults = await searchFileSequential(filePath, regex, maxResults - results.length);
    results.push(...fileResults);
  }
  return results;
}

export async function grepParallel(
  dir: string,
  regex: RegExp,
  maxResults: number,
): Promise<string[]> {
  const files = await walkDir(dir);

  const allResults: string[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < files.length && allResults.length < maxResults) {
      const current = idx++;
      const filePath = files[current];
      if (!filePath) break;
      const ext = path.extname(filePath).toLowerCase();
      if (BIN_EXT.has(ext)) continue;
      const fileResults = await searchFileSequential(filePath, regex, 50);
      allResults.push(...fileResults);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return allResults.slice(0, maxResults);
}

const BIN_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".mp3", ".mp4", ".avi", ".mov",
  ".woff", ".woff2", ".ttf", ".eot", ".exe", ".dll", ".so", ".dylib",
]);

export async function runGrepBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  // Create file trees of varying sizes
  const configs = [
    { name: "small", files: 100, lines: 50 },
    { name: "medium", files: 500, lines: 50 },
    { name: "large", files: 2000, lines: 80 },
  ];

  const regex = /method_\d+/g;

  for (const cfg of configs) {
    const dir = getFixturePath(`grep-${cfg.name}`);
    createFileTree(dir, cfg.files, cfg.lines);

    // Sequential baseline
    results.push(
      await bench(`grep:sequential(${cfg.files} files)`, async () => {
        await grepSequential(dir, regex, 50);
      }, 5),
    );

    // Parallel improved
    results.push(
      await bench(`grep:parallel(${cfg.files} files)`, async () => {
        await grepParallel(dir, regex, 50);
      }, 5),
    );
  }

  return results;
}
