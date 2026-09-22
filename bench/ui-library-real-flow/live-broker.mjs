import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Budget, verifyApproval } from './budget.mjs';

const UPSTREAM = "https://api.z.ai/api/coding/paas/v4";
const MAX_BYTES = 3 * 1024 * 1024;
// Per-request worst-case reservation: peak in-flight is ~3 (agent + compaction
// + review), so 3x this must fit inside the approved token ceiling.
const RESERVE_TOKENS = 400_000;

/** Extract the last reported usage object from an OpenAI-compatible response
 *  body (SSE stream or plain JSON). Returns undefined when none was reported. */
function extractUsage(bodyText) {
  let usage;
  const consider = (value) => {
    if (!value || typeof value !== "object" || !value.usage) return;
    const u = value.usage;
    if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.input_tokens)) usage = u;
  };
  for (const line of bodyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try { consider(JSON.parse(payload)); } catch { /* partial chunk boundary */ }
  }
  if (!usage) { try { consider(JSON.parse(bodyText)); } catch { /* not JSON */ } }
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  return { input: Number(input), cacheRead: Number(cacheRead), output: Number(output) };
}

/** Loopback GLM proxy. The real API key never leaves this supervising process;
 *  workers authenticate to the broker with a per-launch token only. */
export async function startLiveBroker({ approvalPath, apiKey, ledgerPath, reserveTokens = RESERVE_TOKENS, runId, upstream = UPSTREAM, enabled = true, budget: sharedBudget }) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const records = JSON.parse(await readFile(approvalPath, "utf8")).records;
  const budget = sharedBudget ?? (enabled ? new Budget(records) : undefined);
  if (runId === undefined && budget) runId = budget.startRun({ maxRequests: 120, timeoutMs: 15 * 60_000 });
  const token = randomBytes(32).toString("hex");
  let halted = false;
  const stats = { hits: 0, unauthorized: 0 };
  let persistChain = Promise.resolve();
  const persist = (ledger) => {
    persistChain = persistChain.then(() => writeFile(ledgerPath, JSON.stringify(ledger, null, 2))).catch(() => {});
  };

  const server = createServer(async (request, response) => {
    request.setTimeout(900_000, () => request.destroy());
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== "POST" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      stats.unauthorized++;
      response.writeHead(403).end();
      return;
    }
    stats.hits++;
    if (halted || !budget) { response.writeHead(503).end("halted"); return; }
    let reservation;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error("Payload limit");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      reservation = budget.reserve(runId, reserveTokens);
      persist(budget.ledger);
      const upstreamResponse = await fetch(upstream + request.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: request.headers.accept ?? "text/event-stream" },
        body,
        signal: AbortSignal.timeout(14 * 60_000),
      });
      const text = await upstreamResponse.text();
      let usage;
      try { usage = extractUsage(text); } catch { usage = undefined; }
      try { budget.settle(reservation, usage); } catch (error) { halted = true; }
      persist(budget.ledger);
      response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" });
      response.end(text);
    } catch (error) {
      if (reservation && reservation.state === "in-flight") reservation.state = "interrupted";
      persist(budget.ledger);
      // Never leak upstream error bodies (they can echo headers) to workers.
      response.writeHead(502).end("upstream unavailable");
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const persistLedger = () => persist(enabled && budget ? budget.ledger : { disabled: true });
  return {
    budget, runId, stats,
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
