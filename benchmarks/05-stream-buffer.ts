/**
 * Benchmark 05: StreamResult Event Buffer — Memory & Throughput
 *
 * Measures: event throughput and buffer memory under different
 * consumer speeds. The key finding: unbounded buffer growth with
 * a slow consumer.
 */
import { bench, fmtBytes } from "./harness.js";

// Import from compiled package
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { StreamResult } = require("../packages/gg-ai/dist/index.cjs") as {
  StreamResult: new <T>(gen: AsyncGenerator<T, unknown>, signal?: AbortSignal) => AsyncIterable<T>;
};

/** Generate N mock stream events at a given rate. */
function mockGenerator(
  count: number,
  payloadSize = 50,
): AsyncGenerator<{ type: string; text: string }, void> {
  let i = 0;
  const payload = "x".repeat(payloadSize);
  return (async function* () {
    while (i < count) {
      yield { type: "text_delta", text: payload };
      i++;
    }
  })();
}

/** Eager-consume all events (measures pure throughput). */
async function drainAll(stream: AsyncIterable<{ type: string; text: string }>): Promise<number> {
  let count = 0;
  for await (const _ of stream) {
    count++;
  }
  return count;
}

/** Slow consumer: process events with a delay between each. */
async function slowConsume(
  stream: AsyncIterable<{ type: string; text: string }>,
  delayMs: number,
): Promise<number> {
  let count = 0;
  for await (const _ of stream) {
    count++;
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return count;
}

export async function runStreamBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  // Throughput: how fast can we pump and consume 10K events?
  results.push(
    await bench("stream:throughput-10k-events", async () => {
      const gen = mockGenerator(10_000, 50);
      const stream = new StreamResult(gen);
      const count = await drainAll(stream);
      if (count !== 10_000) throw new Error(`Expected 10000, got ${count}`);
    }, 10),
  );

  results.push(
    await bench("stream:throughput-50k-events", async () => {
      const gen = mockGenerator(50_000, 50);
      const stream = new StreamResult(gen);
      const count = await drainAll(stream);
      if (count !== 50_000) throw new Error(`Expected 50000, got ${count}`);
    }, 5),
  );

  // Memory: measure buffer growth when consumer is slower than producer
  const memResult = await bench("stream:buffer-growth-slow-consumer", async () => {
    const gen = mockGenerator(5_000, 200);
    const stream = new StreamResult(gen);
    await slowConsume(stream, 0.01); // 10μs delay per event
  }, 5);
  results.push(memResult);

  // Memory snapshot: how much memory does an unbounded buffer hold?
  const beforeHeap = process.memoryUsage().heapUsed;
  const gen = mockGenerator(50_000, 200);
  const stream = new StreamResult(gen);
  // Don't consume — just let the buffer fill
  await new Promise((r) => setTimeout(r, 100)); // let pump finish
  const peakHeap = process.memoryUsage().heapUsed;
  const bufferMem = peakHeap - beforeHeap;
  results.push({
    ...memResult,
    name: "stream:peak-buffer-memory-50k-unconsumed",
    extra: { heapGrowth: fmtBytes(bufferMem) },
  });

  return results;
}
