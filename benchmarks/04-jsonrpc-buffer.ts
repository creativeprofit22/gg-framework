/**
 * Benchmark 04: JSON-RPC Buffer Concat (LSP)
 *
 * Measures: Buffer accumulation patterns for JSON-RPC message parsing.
 * Baseline: current Buffer.concat([this.buffer, chunk]) on every data event.
 * Improved: pre-allocated growable buffer with offset tracking.
 */
import { bench } from "./harness.js";

// ── Current implementation: Buffer.concat per chunk ──

class JsonRpcBufferConcat {
  private buffer = Buffer.alloc(0);

  onData(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    return this.extractMessages();
  }

  private extractMessages(): string[] {
    const SEP = "\r\n\r\n";
    const messages: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(SEP);
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + SEP.length);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + SEP.length;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString();
      messages.push(body);
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    return messages;
  }
}

// ── Improved: Growable buffer with manual offset tracking ──

class JsonRpcGrowableBuffer {
  private buf: Buffer;
  private writeOffset = 0;

  constructor(initialCapacity = 64 * 1024) {
    this.buf = Buffer.allocUnsafe(initialCapacity);
  }

  onData(chunk: Buffer): string[] {
    this.append(chunk);
    return this.extractMessages();
  }

  private append(chunk: Buffer): void {
    const needed = this.writeOffset + chunk.length;
    if (needed > this.buf.length) {
      // Grow geometrically
      let newCapacity = this.buf.length;
      while (newCapacity < needed) newCapacity *= 2;
      const newBuf = Buffer.allocUnsafe(newCapacity);
      this.buf.copy(newBuf, 0, 0, this.writeOffset);
      this.buf = newBuf;
    }
    chunk.copy(this.buf, this.writeOffset);
    this.writeOffset += chunk.length;
  }

  private compact(consumedUpTo: number): void {
    const remaining = this.writeOffset - consumedUpTo;
    if (remaining > 0) {
      this.buf.copy(this.buf, 0, consumedUpTo, this.writeOffset);
    }
    this.writeOffset = remaining;
  }

  private extractMessages(): string[] {
    const SEP = "\r\n\r\n";
    const messages: string[] = [];
    let searchFrom = 0;

    for (;;) {
      const headerEnd = this.buf.indexOf(SEP, searchFrom);
      if (headerEnd === -1) break;
      const header = this.buf.subarray(searchFrom, headerEnd).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        searchFrom = headerEnd + SEP.length;
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + SEP.length;
      if (this.writeOffset < bodyStart + length) break;
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString();
      messages.push(body);
      searchFrom = bodyStart + length;
    }

    if (searchFrom > 0) {
      this.compact(searchFrom);
    }
    return messages;
  }
}

// ── Fixture: simulate LSP diagnostic response chunks ──

function generateDiagnosticMessages(count: number, chunkSize: number): Buffer[] {
  const messages: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: `file:///project/src/module_${i}/service.ts`,
        diagnostics: Array.from({ length: 5 }, (_, j) => ({
          range: {
            start: { line: i * 3 + j, character: 0 },
            end: { line: i * 3 + j, character: 20 },
          },
          severity: j === 0 ? 1 : 2,
          message: `Type error ${i}-${j}: property 'foo' does not exist on type 'Bar'`,
          source: "tsserver",
        })),
      },
    });
    messages.push(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  const full = Buffer.from(messages.join(""));
  const chunks: Buffer[] = [];
  for (let i = 0; i < full.length; i += chunkSize) {
    chunks.push(full.subarray(i, Math.min(i + chunkSize, full.length)));
  }
  return chunks;
}

export async function runJsonRpcBench(): Promise<import("./harness.js").BenchResult[]> {
  const results: import("./harness.js").BenchResult[] = [];

  const configs = [
    { name: "50-msgs-1KB-chunks", count: 50, chunkSize: 1024 },
    { name: "100-msgs-512B-chunks", count: 100, chunkSize: 512 },
    { name: "200-msgs-4KB-chunks", count: 200, chunkSize: 4096 },
  ];

  for (const cfg of configs) {
    const chunks = generateDiagnosticMessages(cfg.count, cfg.chunkSize);

    // Baseline: Buffer.concat
    results.push(
      await bench(`jsonrpc:buffer.concat(${cfg.name})`, () => {
        const parser = new JsonRpcBufferConcat();
        for (const chunk of chunks) parser.onData(chunk);
      }, 200),
    );

    // Improved: growable buffer
    results.push(
      await bench(`jsonrpc:growable-buffer(${cfg.name})`, () => {
        const parser = new JsonRpcGrowableBuffer();
        for (const chunk of chunks) parser.onData(chunk);
      }, 200),
    );
  }

  return results;
}
