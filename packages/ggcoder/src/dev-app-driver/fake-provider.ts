import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import type { IsolatedProfile } from "./profile.js";

/** The model the daemon picks when the fake provider is configured. */
export const FAKE_PROVIDER_MODEL = "azure:fixture";
const FAKE_PROVIDER_PATH = "/openai/v1/responses";
const MAX_BODY_BYTES = 2_000_000;
const ECHO_CHARS = 80;

export interface FakeProvider {
  /** Loopback Responses endpoint the daemon wrapper redirects Azure traffic to. */
  readonly url: string;
  /** Model requests answered so far. */
  requests(): number;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && typeof Reflect.get(part, "text") === "string"
        ? String(Reflect.get(part, "text"))
        : "",
    )
    .join(" ");
}

/** Text of the last user message in a Responses request; empty when it has none. */
export function lastUserText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const input = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "input") : [];
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item: unknown = input[index];
    if (typeof item !== "object" || item === null || Reflect.get(item, "role") !== "user") continue;
    const text = textOf(Reflect.get(item, "content")).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/** The canned reply for a request: numbered, and echoing the start of the user's message. */
export function fakeReply(count: number, userText: string): string {
  const echo = userText.length > ECHO_CHARS ? `${userText.slice(0, ECHO_CHARS)}…` : userText;
  return `Fake reply ${count}: ${echo || "(no message)"}`;
}

/** A local stand-in for the Azure Responses API: every request streams one canned reply. */
export function startFakeProvider(): Promise<FakeProvider> {
  let count = 0;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "POST" || request.url !== FAKE_PROVIDER_PATH) {
          response.writeHead(404).end("Not the fake provider endpoint");
          return;
        }
        const body = await readBody(request);
        count += 1;
        const events = [
          { type: "response.output_text.delta", delta: fakeReply(count, lastUserText(body)) },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 4 } },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } catch {
        if (!response.headersSent) response.writeHead(400);
        response.end("Fake provider rejected the request");
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("fake provider has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}${FAKE_PROVIDER_PATH}`,
        requests: () => count,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Makes the isolated profile's daemon use the fake provider by default. The identity folder
 * matches the Local Fork app the dev app runs as.
 */
export function configureFakeProvider(profile: IsolatedProfile, identity: string): void {
  const agentDir = join(profile.home, ".gg", "identities", identity);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "azure",
        defaultModel: FAKE_PROVIDER_MODEL,
        autoCompact: false,
        idealReviewEnabled: false,
      },
      null,
      2,
    )}\n`,
  );
}
