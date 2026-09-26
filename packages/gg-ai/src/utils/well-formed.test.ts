import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  hasLoneSurrogate,
  sanitizeMessagesForWire,
  sliceHead,
  sliceTail,
  toWellFormedText,
} from "./well-formed.js";

const HIGH = "\uD83D"; // lone high surrogate (first half of 😀)
const LOW = "\uDE00"; // lone low surrogate (second half of 😀)
const EMOJI = "\uD83D\uDE00";

/** Collect every raw string in a value. Asserting on these — not on
 *  `JSON.stringify` output — is what actually proves the scrub ran:
 *  well-formed `JSON.stringify` escapes a lone surrogate to ASCII `\ud83d`,
 *  so a surrogate check against the serialized form passes either way. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  return out;
}

describe("hasLoneSurrogate", () => {
  it("accepts well-formed text including full surrogate pairs", () => {
    expect(hasLoneSurrogate("")).toBe(false);
    expect(hasLoneSurrogate(`hello ${EMOJI} world`)).toBe(false);
  });

  it("flags unpaired high and low surrogates", () => {
    expect(hasLoneSurrogate(`hello ${HIGH}`)).toBe(true);
    expect(hasLoneSurrogate(`${LOW} hello`)).toBe(true);
  });
});

describe("toWellFormedText", () => {
  it("returns the same string when already valid", () => {
    const text = `ok ${EMOJI}`;
    expect(toWellFormedText(text)).toBe(text);
  });

  it("replaces lone surrogates with U+FFFD and stays JSON-encodable", () => {
    const fixed = toWellFormedText(`a${HIGH}b${LOW}c`);
    expect(fixed).toBe("a\uFFFDb\uFFFDc");
    expect(JSON.parse(JSON.stringify(fixed))).toBe(fixed);
    expect(Buffer.from(JSON.stringify(fixed), "utf8").includes(0xed)).toBe(false);
  });
});

describe("sliceHead / sliceTail", () => {
  it("never splits a surrogate pair", () => {
    const text = `ab${EMOJI}cd`;
    expect(sliceHead(text, 3)).toBe("ab");
    expect(sliceHead(text, 4)).toBe(`ab${EMOJI}`);
    expect(sliceTail(text, 3)).toBe("cd");
    expect(sliceTail(text, 4)).toBe(`${EMOJI}cd`);
    expect(hasLoneSurrogate(sliceHead(text, 3))).toBe(false);
    expect(hasLoneSurrogate(sliceTail(text, 3))).toBe(false);
  });

  it("handles degenerate bounds", () => {
    expect(sliceHead("abc", 0)).toBe("");
    expect(sliceTail("abc", 0)).toBe("");
    expect(sliceHead("abc", 99)).toBe("abc");
    expect(sliceTail("abc", 99)).toBe("abc");
  });
});

describe("sanitizeMessagesForWire", () => {
  it("returns the identical array when nothing needs fixing", () => {
    const messages: Message[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: `hi ${EMOJI}` }] },
    ];
    expect(sanitizeMessagesForWire(messages)).toBe(messages);
  });

  it("scrubs lone surrogates from text, tool-call args and tool results", () => {
    const messages: Message[] = [
      { role: "system", content: `sys ${HIGH}` },
      { role: "user", content: `ask ${LOW}` },
      {
        role: "assistant",
        content: [
          { type: "text", text: `say ${HIGH}` },
          { type: "tool_call", id: "1", name: "bash", args: { command: `echo ${HIGH}` } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "1", content: `out ${HIGH}` },
          {
            type: "tool_result",
            toolCallId: "2",
            content: [{ type: "text", text: `block ${LOW}` }],
          },
        ],
      },
    ];

    const sanitized = sanitizeMessagesForWire(messages);
    expect(collectStrings(sanitized).filter(hasLoneSurrogate)).toEqual([]);
    expect(collectStrings(messages).filter(hasLoneSurrogate)).toHaveLength(6); // input untouched
    expect(sanitized[0]!.content).toBe("sys \uFFFD");
    const call = (sanitized[2]!.content as { type: string; args?: Record<string, string> }[])[1]!;
    expect(call.args!.command).toBe("echo \uFFFD");
    expect(messages[0]!.content).toBe(`sys ${HIGH}`); // input untouched
  });

  it("leaves base64 media payloads untouched", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `look ${HIGH}` },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    ];
    const sanitized = sanitizeMessagesForWire(messages);
    const parts = sanitized[0]!.content as { type: string; data?: string }[];
    expect(parts[1]!.data).toBe("aGVsbG8=");
  });
});
