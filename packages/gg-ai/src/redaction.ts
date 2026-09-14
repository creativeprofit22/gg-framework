const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";

const SENSITIVE_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|auth(?:orization)?|bearer|cookie|credential|private[_-]?key|password|passwd|secret)(?:$|[_-])/i;
const SENSITIVE_ASSIGNMENT =
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|auth(?:orization)?|bearer|cookie|credential|private[_-]?key|password|passwd|secret))\b(\s*[=:]\s*)(["']?)([^\s,"';}]+)\3/gi;

export interface RedactionOptions {
  /** Exact secret values to remove in addition to high-confidence formats. */
  secrets?: Iterable<string>;
  /** Maximum recursive object depth before a stable truncation marker is emitted. */
  maxDepth?: number;
  /** Maximum total array/object entries cloned before truncation markers are emitted. */
  maxEntries?: number;
  /** Maximum retained string length after sanitization. */
  maxStringLength?: number;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedSecrets(secrets: Iterable<string> | undefined): string[] {
  if (!secrets) return [];
  return [...new Set([...secrets].filter((value) => value.length >= 8 && value !== REDACTED))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Collect sufficiently distinctive secrets from security-sensitive environment variables. */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || value === REDACTED || !SENSITIVE_NAME.test(name)) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Redact credentials from arbitrary text without mutating its source. */
export function redactText(text: string, options: RedactionOptions = {}): string {
  let result = text;

  // PEM private keys, including multiline payloads.
  result = result.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    REDACTED,
  );
  // Credentials embedded in URLs.
  result = result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  // Authorization headers and inline auth values.
  result = result.replace(
    /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
    `$1${REDACTED}`,
  );
  result = result.replace(/\b(bearer|basic)\s+[A-Za-z0-9+/_.=-]{8,}/gi, `$1 ${REDACTED}`);
  // Cookie headers are security-sensitive as a whole; avoid trying to infer safe cookie names.
  result = result.replace(/\b(cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, `$1$2${REDACTED}`);
  // JWTs and well-known provider/repository token prefixes.
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    REDACTED,
  );
  result = result.replace(
    /\b(?:sk-(?:ant-|proj-)?|xox[baprs]-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{12,}\b/g,
    REDACTED,
  );
  result = result.replace(
    SENSITIVE_ASSIGNMENT,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
  );

  for (const secret of normalizedSecrets(options.secrets)) {
    result = result.replace(new RegExp(escaped(secret), "g"), REDACTED);
  }

  const maxStringLength = options.maxStringLength ?? 1_000_000;
  if (result.length > maxStringLength) {
    result = `${result.slice(0, maxStringLength)}${TRUNCATED}`;
  }
  return result;
}

function isBinary(value: object): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

function isMediaObject(value: Record<string, unknown>): boolean {
  return (
    (value.type === "image" || value.type === "video") &&
    (typeof value.data === "string" || typeof value.url === "string")
  );
}

/**
 * Recursively clone and sanitize transport/persistence payloads.
 * Cycles, excessive depth, and excessive collection sizes become stable markers.
 */
export function redactValue<T>(value: T, options: RedactionOptions = {}): T {
  const maxDepth = options.maxDepth ?? 20;
  const maxEntries = options.maxEntries ?? 10_000;
  const seen = new WeakSet<object>();
  let entries = 0;

  const visit = (current: unknown, depth: number, sensitive = false): unknown => {
    if (typeof current === "string") {
      if (sensitive && current.length > 0 && current !== REDACTED) return REDACTED;
      return redactText(current, options);
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      return current;
    }
    if (typeof current !== "object") return current;
    if (isBinary(current)) return current;
    if (current instanceof Date) return new Date(current.getTime());
    if (depth >= maxDepth) return TRUNCATED;
    if (seen.has(current)) return CIRCULAR;
    seen.add(current);

    if (current instanceof Error) {
      const error: Record<string, unknown> = {
        name: current.name,
        message: visit(current.message, depth + 1),
        stack: visit(current.stack, depth + 1),
      };
      for (const [key, child] of Object.entries(current)) {
        error[key] = visit(child, depth + 1, SENSITIVE_NAME.test(key));
      }
      return error;
    }

    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      for (const child of current) {
        if (++entries > maxEntries) {
          clone.push(TRUNCATED);
          break;
        }
        clone.push(visit(child, depth + 1));
      }
      return clone;
    }

    const record = current as Record<string, unknown>;
    if (isMediaObject(record)) return { ...record };
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (++entries > maxEntries) {
        clone[TRUNCATED] = true;
        break;
      }
      clone[key] = visit(child, depth + 1, SENSITIVE_NAME.test(key));
    }
    return clone;
  };

  return visit(value, 0) as T;
}

export { REDACTED as REDACTION_MARKER };
