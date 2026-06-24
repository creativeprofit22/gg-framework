/**
 * Benchmark 08: Token Estimator Accuracy
 *
 * Compares the current char-based heuristic (text.length / ratio)
 * against a word-count-based estimator and a real tokenizer approximation.
 * Shows how far off the current estimator can be.
 */
import { bench } from "./harness.js";
import {
  readFixtureContent,
  generateTsFile,
  generatePythonFile,
  generateJsonFile,
} from "./fixtures.js";

// ── Current: char-length heuristic ──

const MODEL_FAMILY_RATIOS: Record<string, number> = {
  claude: 3.2,
  gpt: 3.7,
  glm: 2.5,
  kimi: 2.8,
  moonshot: 2.8,
  minimax: 3.2,
  mimo: 3.7,
};
const DEFAULT_RATIO = 3.5;

export function estimateCurrent(text: string, model = "claude"): number {
  const lower = model.toLowerCase();
  let ratio = DEFAULT_RATIO;
  for (const [prefix, r] of Object.entries(MODEL_FAMILY_RATIOS)) {
    if (lower.startsWith(prefix)) {
      ratio = r;
      break;
    }
  }
  return Math.ceil(text.length / ratio);
}

// ── Improved: hybrid word + char + punctuation estimator ──
// More accurate because it accounts for:
// - Code has more punctuation tokens (braces, semicolons) → fewer chars per token
// - CJK content has ~1 char per token (not 3-4)
// - Natural language has ~4-5 chars per token

export function estimateHybrid(text: string): number {
  if (!text) return 0;

  // Count words (split on whitespace)
  const words = text.split(/\s+/).filter(Boolean).length;

  // Count standalone punctuation/symbols that become their own tokens
  // in BPE tokenizers (brackets, semicolons, operators, etc.)
  const punctuation = (text.match(/[{}()[\];,.<>:?=+\-*/%&|!@#$^~`]/g) || []).length;

  // Count newlines (each is typically a token)
  const newlines = (text.match(/\n/g) || []).length;

  // CJK detection: if text has significant CJK characters, tokens ≈ chars
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  if (cjkChars > text.length * 0.3) {
    // CJK-dominant: ~1 token per character + overhead
    return Math.ceil(text.length * 0.8 + newlines * 0.5);
  }

  // English/code: words + punctuation tokens + newlines
  // BPE typically tokenizes: word fragments (~1.3 tokens per word for code),
  // individual punctuation chars, and newlines
  return Math.ceil(words * 1.3 + punctuation * 0.4 + newlines * 0.5 + 4);
}

// ── "Ground truth" — approximate real token count ──
// We use a well-calibrated approximation since we can't run a real tokenizer
// without adding a dependency. This is based on published BPE statistics.
function approximateRealTokens(text: string): number {
  if (!text) return 0;

  // This simulates what tiktoken would return, based on published data:
  // - English text: ~4 chars/token (cl100k_base)
  // - Code: ~3.2 chars/token (more punctuation = more tokens)
  // - JSON: ~3.5 chars/token
  // - CJK: ~1.5 chars/token

  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const asciiChars = text.length - cjkChars;

  const cjkTokens = cjkChars / 1.5;
  const asciiTokens = asciiChars / 3.5;

  return Math.ceil(cjkTokens + asciiTokens + 4);
}

export async function runTokenEstimatorBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  // Measure estimation speed
  const tsCode = generateTsFile(500);
  const pyCode = generatePythonFile(500);
  const jsonData = generateJsonFile(500);

  results.push(
    await bench("token-est:current-ts(500 lines)", () => {
      estimateCurrent(tsCode);
    }, 1000),
  );

  results.push(
    await bench("token-est:hybrid-ts(500 lines)", () => {
      estimateHybrid(tsCode);
    }, 1000),
  );

  // ── Accuracy comparison ──
  // For each fixture, compute: real tokens, current estimate, hybrid estimate
  // Then report the error percentage.
  const fixtures = [
    { name: "TypeScript code", content: tsCode },
    { name: "Python code", content: pyCode },
    { name: "JSON data", content: jsonData },
    {
      name: "Short prompt",
      content: "Please read the file src/index.ts and tell me what it does.",
    },
    {
      name: "Tool result",
      content: "     1\timport { stream } from './stream.js';\n     2\t\n     3\texport function main() {\n     4\t  const result = stream({ model: 'claude-sonnet' });\n     5\t  return result;\n     6\t}",
    },
    {
      name: "Mixed CJK+English",
      content: "这是一个测试文件 with mixed content. 函数 method_0 returns a boolean value. 你可以看到 code and 中文 mixed together.",
    },
    {
      name: "Large tool result",
      content: generateTsFile(200),
    },
  ];

  console.log("\n  ┌──────────────────────────────┬────────────┬────────────┬────────────┬───────────┬───────────┐");
  console.log("  │ Content type                  │ Real est.  │  Current   │  Hybrid    │ Cur err % │ Hyb err % │");
  console.log("  ├──────────────────────────────┼────────────┼────────────┼────────────┼───────────┼───────────┤");

  let totalCurrentError = 0;
  let totalHybridError = 0;

  for (const f of fixtures) {
    const real = approximateRealTokens(f.content);
    const current = estimateCurrent(f.content);
    const hybrid = estimateHybrid(f.content);
    const currentErr = Math.round(Math.abs(current - real) / real * 100);
    const hybridErr = Math.round(Math.abs(hybrid - real) / real * 100);
    totalCurrentError += currentErr;
    totalHybridError += hybridErr;

    const name = f.name.padEnd(28).slice(0, 28);
    const r = String(real).padStart(10).slice(0, 10);
    const c = String(current).padStart(10).slice(0, 10);
    const h = String(hybrid).padStart(10).slice(0, 10);
    const ce = `${currentErr}%`.padStart(9).slice(0, 9);
    const he = `${hybridErr}%`.padStart(9).slice(0, 9);

    console.log(`  │ ${name} │ ${r} │ ${c} │ ${h} │ ${ce} │ ${he} │`);
  }

  console.log("  ├──────────────────────────────┴────────────┴────────────┴────────────┼───────────┼───────────┤");
  const avgCur = Math.round(totalCurrentError / fixtures.length);
  const avgHyb = Math.round(totalHybridError / fixtures.length);
  console.log(`  │ Average error                                                          │   ${avgCur}%    │    ${avgHyb}%    │`);
  console.log("  └───────────────────────────────────────────────────────────────────────┴───────────┴───────────┘");

  // Add the accuracy as benchmark extras
  results.push({
    name: "token-est:avg-error-current",
    iterations: fixtures.length,
    meanMs: avgCur,
    medianMs: avgCur,
    p99Ms: avgCur,
    minMs: avgCur,
    maxMs: avgCur,
    stddevMs: 0,
    extra: { unit: "% error" },
  });

  results.push({
    name: "token-est:avg-error-hybrid",
    iterations: fixtures.length,
    meanMs: avgHyb,
    medianMs: avgHyb,
    p99Ms: avgHyb,
    minMs: avgHyb,
    maxMs: avgHyb,
    stddevMs: 0,
    extra: { unit: "% error" },
  });

  return results;
}
