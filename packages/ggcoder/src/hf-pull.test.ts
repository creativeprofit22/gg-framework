import { describe, expect, it } from "vitest";
import {
  advancesPhase,
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
      toHfSearchRow({
        id: "a/b",
        downloads: 123456,
        likes: 7,
        lastModified: "2026-01-02",
        gguf: { total: 1 },
      }),
    ).toEqual({ id: "a/b", downloads: 123456, likes: 7, updatedAt: "2026-01-02" });
  });
  it("drops entries without a usable id", () => {
    expect(toHfSearchRow({ downloads: 5, gguf: {} })).toBeNull();
    expect(toHfSearchRow({ id: "no-slash", gguf: {} })).toBeNull();
  });
  it("drops repos with no parsed GGUF metadata (safetensors-only base repos)", () => {
    expect(toHfSearchRow({ id: "Qwen/Qwen3-8B", downloads: 99 })).toBeNull();
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
  it("finds quants inside per-quant subfolders", () => {
    const files = [f("Q4_K_M/model-Q4_K_M.gguf", 4), f("Q8_0/model-Q8_0.gguf", 8)];
    expect(pickGgufQuant(files)?.file.path).toBe("Q4_K_M/model-Q4_K_M.gguf");
  });
  it("never installs a vision projector or imatrix blob as the model", () => {
    // Real shape of xtuner/llava-llama-3-8b-v1_1-gguf: no preferred quant, and
    // the projector is the smallest file, so it used to win the size fallback.
    const files = [
      f("llava-llama-3-8b-v1_1-mmproj-f16.gguf", 624),
      f("llava-llama-3-8b-v1_1-int4.gguf", 5000),
    ];
    expect(pickGgufQuant(files)?.file.path).toBe("llava-llama-3-8b-v1_1-int4.gguf");
    expect(pickGgufQuant([f("imatrix_unsloth.gguf", 10), f("m-Q4_K_M.gguf", 900)])?.file.path).toBe(
      "m-Q4_K_M.gguf",
    );
    expect(pickGgufQuant([f("llama-3.2-11B-vision_f16_projector.gguf", 1)])).toBeNull();
  });
  it("ignores a speculative-decoding draft that carries a better quant tag", () => {
    // unsloth/gemma-4-12B-it-qat-GGUF: the MTP draft is Q4_0 (preferred) while
    // the real weights are UD-Q4_K_XL (not in the preference list).
    const files = [
      f("MTP/mtp-gemma-4-12B-it-Q4_0.gguf", 0.25e9),
      f("MTP/mtp-gemma-4-12B-it-Q8_0.gguf", 0.47e9),
      f("gemma-4-12B-it-qat-UD-Q4_K_XL.gguf", 6.72e9),
    ];
    const pick = pickGgufQuant(files);
    expect(pick?.file.path).toBe("gemma-4-12B-it-qat-UD-Q4_K_XL.gguf");
    expect(pick?.tag).toBe("Q4_K_XL"); // resolves on the Hub's Ollama registry
  });
  it("keeps small-but-real quants and MTP-in-the-middle model names", () => {
    // Drafts overlap IQ1/IQ2 quants on size, so only the name may decide.
    expect(pickGgufQuant([f("m-IQ1_S.gguf", 1.7e9), f("m-BF16.gguf", 16e9)])?.file.path).toBe(
      "m-IQ1_S.gguf",
    );
    const real = "DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf"; // antirez/deepseek-v4-gguf
    expect(pickGgufQuant([f(real, 4e9)])?.file.path).toBe(real);
  });
  it("ignores split shards Ollama cannot pull", () => {
    const shards = [
      f("DeepSeek-R1-Q4_K_M/DeepSeek-R1-Q4_K_M-00001-of-00009.gguf", 40),
      f("DeepSeek-R1-Q4_K_M/DeepSeek-R1-Q4_K_M-00002-of-00009.gguf", 40),
    ];
    expect(pickGgufQuant(shards)).toBeNull();
    expect(pickGgufQuant([...shards, f("single-Q4_K_M.gguf", 90)])?.file.path).toBe(
      "single-Q4_K_M.gguf",
    );
  });
});

describe("advancesPhase", () => {
  it("never lets a redrawn manifest line drag progress backwards", () => {
    expect(advancesPhase("downloading", "preparing")).toBe(false);
    expect(advancesPhase("verifying", "downloading")).toBe(false);
    expect(advancesPhase("preparing", "downloading")).toBe(true);
    expect(advancesPhase("downloading", "downloading")).toBe(true); // percent updates
    expect(advancesPhase("downloading", "error")).toBe(true);
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
      detail: "Contacting Ollama…",
    });
  });
  it("reads percent lines and strips the blob sha", () => {
    expect(parseOllamaPullLine("pulling 8f4b3c1d2e5a: 45% 1.2 GB/2.7 GB 30 MB/s")).toEqual({
      phase: "downloading",
      percent: 45,
      detail: "1.2 GB / 2.7 GB · 30 MB/s",
    });
  });
  it("drops the ASCII bar and the next frame glued onto the same line", () => {
    // Verbatim from a piped pull: ollama redraws with cursor-up, so the next
    // frame's text lands on this line and the bar glyphs render as "||".
    const frame =
      "pulling ed5fa30c487b:  13% ▕██                ▏  13 MB/105 MB   13 MB/s      6spulling manifest";
    expect(parseOllamaPullLine(frame)).toEqual({
      phase: "downloading",
      percent: 13,
      detail: "13 MB / 105 MB · 13 MB/s · 6s",
    });
  });
  it("omits rate and ETA until ollama reports them", () => {
    expect(parseOllamaPullLine("pulling ed5fa30c487b:   0% ▕  ▏ 505 KB/105 MB")).toEqual({
      phase: "downloading",
      percent: 0,
      detail: "505 KB / 105 MB",
    });
  });
  it("keeps a multi-unit ETA intact", () => {
    expect(
      parseOllamaPullLine("pulling abc123def456:   1% ▕▏ 161 MB/ 18 GB  11 MB/s  26m8s")?.detail,
    ).toBe("161 MB / 18 GB · 11 MB/s · 26m8s");
  });
  it("maps the status verbs", () => {
    expect(parseOllamaPullLine("pulling manifest")).toEqual({
      phase: "preparing",
      percent: 0,
      detail: "Contacting Ollama…",
    });
    expect(parseOllamaPullLine("verifying sha256 digest")).toMatchObject({
      phase: "verifying",
      percent: 100,
    });
    expect(parseOllamaPullLine("success")).toEqual({ phase: "success", percent: 100 });
  });
  it("never flashes a failure line into the progress text", () => {
    // The exit handler explains the failure; showing it as progress made the
    // download area read `Error: 429:` for one frame first.
    expect(
      parseOllamaPullLine('Error: pull model manifest: 429: {"error":"rate limit"}'),
    ).toBeNull();
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
    expect(
      explainPullFailure(
        'Error: 400: {"error":"This repository only contains sharded GGUF files"}',
      ),
    ).toMatch(/split GGUF shards/);
    expect(explainPullFailure("Error: 429: rate limited")).toMatch(/rate-limited this machine/);
  });
  it("shows the readable sentence, not the raw TUI frame", () => {
    // Verbatim tail of a real failed pull: bar glyphs, cursor codes, redraws.
    const noisy =
      "pulling ed5fa30c487b:  99% ▕███ ▏ 104 MB/105 MB\u001b[K\u001b[?25h\u001b[A" +
      "\u001b[1Gpulling manifest \u001b[K Error: something broke";
    const message = explainPullFailure(noisy);
    expect(message).toBe("Ollama pull failed: Error: something broke");
    expect(message.includes("\u001b")).toBe(false);
    expect(message).not.toMatch(/[\u2580-\u259f]|%/);
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
