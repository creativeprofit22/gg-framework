import { describe, expect, it } from "vitest";
import {
  explainPullFailure,
  formatCount,
  isValidHfRepoId,
  parseOllamaPullLine,
  pickGgufQuant,
  quantFromFilename,
  toHfSearchRow,
} from "./hf-pull.js";

describe("isValidHfRepoId", () => {
  it("accepts org/repo with dots, dashes, digits", () => {
    expect(isValidHfRepoId("Qwen/Qwen3-Coder-480B-A35B-Instruct")).toBe(true);
    expect(isValidHfRepoId("bartowski/SmolLM2-135M-Instruct-GGUF")).toBe(true);
  });
  it("rejects traversal, tags, bare names", () => {
    expect(isValidHfRepoId("../etc/passwd")).toBe(false);
    expect(isValidHfRepoId("user/repo:Q4")).toBe(false);
    expect(isValidHfRepoId("solo")).toBe(false);
    expect(isValidHfRepoId("")).toBe(false);
  });
});

describe("toHfSearchRow", () => {
  it("maps a Hub entry defensively", () => {
    expect(
      toHfSearchRow({ id: "a/b", downloads: 123456, likes: 7, lastModified: "2026-01-02" }),
    ).toEqual({ id: "a/b", downloads: 123456, likes: 7, updatedAt: "2026-01-02" });
  });
  it("drops entries without a usable id", () => {
    expect(toHfSearchRow({ downloads: 5 })).toBeNull();
    expect(toHfSearchRow({ id: "no-slash" })).toBeNull();
  });
});

describe("quantFromFilename", () => {
  it("reads upper, lower, dot-separated quant tokens", () => {
    expect(quantFromFilename("model-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantFromFilename("model.q5_k_m.gguf")).toBe("Q5_K_M");
    expect(quantFromFilename("smollm2-135m-instruct-q4_k_m.gguf")).toBe("Q4_K_M");
  });
  it("returns null for unnamed or non-gguf files", () => {
    expect(quantFromFilename("model.gguf")).toBeNull();
    expect(quantFromFilename("README.md")).toBeNull();
  });
});

describe("pickGgufQuant", () => {
  const f = (path: string, sizeBytes = 1): { path: string; sizeBytes: number } => ({
    path,
    sizeBytes,
  });

  it("prefers Q4_K_M when present", () => {
    const files = [f("m-Q8_0.gguf", 9), f("m-q4_k_m.gguf", 4), f("m-Q3_K_M.gguf", 3)];
    expect(pickGgufQuant(files)).toEqual({ tag: "Q4_K_M", file: f("m-q4_k_m.gguf", 4) });
  });
  it("falls back to the smallest file, keeping its tag", () => {
    const files = [f("m-IQ2_XS.gguf", 90), f("m-TQ1_0.gguf", 40)];
    const pick = pickGgufQuant(files);
    expect(pick?.file.path).toBe("m-TQ1_0.gguf");
    expect(pick?.tag).toBe("TQ1_0");
  });
  it("is tagless for a single unnamed GGUF", () => {
    expect(pickGgufQuant([f("model.gguf", 5)])).toEqual({ tag: null, file: f("model.gguf", 5) });
  });
  it("returns null with no GGUFs", () => {
    expect(pickGgufQuant([f("README.md")])).toBeNull();
  });
});

describe("parseOllamaPullLine", () => {
  it("strips ollama's ANSI cursor/spinner noise before parsing", () => {
    // Raw bytes from a real piped pull: cursor-move + spinner + clear codes.
    const noisy =
      "\u001b[?2026h\u001b[?25l\u001b[1Gpulling manifest \u2819\u001b[K\u001b[?25h\u001b[?2026l";
    expect(parseOllamaPullLine(noisy)).toEqual({
      phase: "preparing",
      percent: 0,
      detail: "pulling manifest",
    });
  });
  it("reads percent lines and strips the blob sha", () => {
    expect(parseOllamaPullLine("pulling 8f4b3c1d2e5a: 45% 1.2 GB/2.7 GB 30 MB/s")).toEqual({
      phase: "downloading",
      percent: 45,
      detail: "45% 1.2 GB/2.7 GB 30 MB/s",
    });
  });
  it("maps the status verbs", () => {
    expect(parseOllamaPullLine("pulling manifest")).toEqual({
      phase: "preparing",
      percent: 0,
      detail: "pulling manifest",
    });
    expect(parseOllamaPullLine("verifying sha256 digest")).toMatchObject({
      phase: "verifying",
      percent: 100,
    });
    expect(parseOllamaPullLine("success")).toEqual({ phase: "success", percent: 100 });
  });
  it("surfaces unrecognized output instead of swallowing it", () => {
    expect(parseOllamaPullLine("something odd happened")).toEqual({
      phase: "downloading",
      detail: "something odd happened",
    });
    expect(parseOllamaPullLine("   ")).toBeNull();
  });
});

describe("explainPullFailure", () => {
  it("maps the known failure modes to their fix", () => {
    expect(explainPullFailure('Error: realm host "huggingface.co" does not match')).toMatch(
      /Upgrade Ollama/,
    );
    expect(explainPullFailure('Error: 401: {"error":"Invalid username or password."}')).toMatch(
      /HF token/,
    );
    expect(explainPullFailure("Error: 404: not found")).toMatch(/no GGUF file/);
  });
  it("passes unknown errors through with the tail", () => {
    expect(explainPullFailure("line1\nline2\nline3\nline4")).toBe(
      "Ollama pull failed: line2 line3 line4",
    );
    expect(explainPullFailure("")).toBe("Ollama pull failed.");
  });
});

describe("formatCount", () => {
  it("compacts large download counts", () => {
    expect(formatCount(2_400_000)).toBe("2.4M");
    expect(formatCount(45_000)).toBe("45K");
    expect(formatCount(712)).toBe("712");
  });
});
