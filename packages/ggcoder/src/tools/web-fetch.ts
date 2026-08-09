import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { sliceHead } from "@kenkaiiii/gg-ai";
import { extractToMarkdown } from "./html-extract.js";
import { extractPdfText, PdfExtractorUnavailable } from "./pdf-extract.js";
import { checkUrlPolicy, type GetNetworkPolicy } from "../core/network-guard.js";

/**
 * Block requests to private/internal network addresses to prevent SSRF.
 * Checks the hostname against known private IP ranges and reserved domains.
 */
export function isBlockedUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true; // Malformed URLs are blocked
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block non-HTTP(S) schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }

  // Block localhost and loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  // Block 0.0.0.0
  if (hostname === "0.0.0.0") {
    return true;
  }

  // Block private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;

  // Block link-local (169.254.x.x — includes AWS metadata endpoint)
  if (/^169\.254\./.test(hostname)) return true;

  // Block IPv6 private/link-local
  if (hostname.startsWith("[fe80:") || hostname.startsWith("[fd") || hostname.startsWith("[fc")) {
    return true;
  }

  // Block cloud metadata endpoints
  if (hostname === "metadata.google.internal") return true;

  return false;
}

const BOILERPLATE_SELECTOR_PATTERNS = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "nav",
  "footer",
  "header",
  "aside",
  "dialog",
  "cookie",
  "consent",
  "banner",
  "modal",
  "popup",
  "newsletter",
  "subscribe",
  "social",
  "share",
  "sidebar",
  "advert",
  "ads",
  "ad-",
  "-ad",
  "sponsor",
  "promo",
  "tracking",
  "analytics",
];

const BOILERPLATE_LINE_PATTERNS = [
  /^(advertisement|sponsored|promoted|ad)\b/i,
  /^skip to (main content|content|search|navigation)$/i,
  /^open (main )?menu$/i,
  /\b(cookie|privacy) (settings|preferences|policy)\b/i,
  /\b(accept|reject|manage) (all )?(cookies|preferences)\b/i,
  /\bsubscribe (to|for)\b/i,
  /\bsign up for (our )?(newsletter|emails?)\b/i,
  /^share (this|on)\b/i,
];

function removeElementsByTag(html: string, tagName: string): string {
  return html.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "gi"), " ");
}

function removeBoilerplateElements(html: string): string {
  let cleaned = html;

  for (const pattern of BOILERPLATE_SELECTOR_PATTERNS) {
    cleaned = cleaned.replace(
      new RegExp(
        `<([a-z][a-z0-9]*)\\b[^>]*(?:id|class|role|aria-label|data-testid|data-test|data-component)=["'][^"']*${pattern}[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
        "gi",
      ),
      " ",
    );
  }

  for (const tagName of [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "iframe",
    "form",
    "nav",
    "footer",
    "header",
    "aside",
  ]) {
    cleaned = removeElementsByTag(cleaned, tagName);
  }

  return cleaned;
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

export function htmlToCleanText(html: string): string {
  const withUsefulBreaks = removeBoilerplateElements(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|section|article|main|h[1-6]|li|tr|blockquote)\s*>/gi, "\n");

  return decodeHTMLEntities(withUsefulBreaks.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Fetch configuration ──────────────────────────────────────

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_URLS = 10;
const MAX_CONCURRENCY = 5;
const PER_URL_MIN_BUDGET = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_CONCURRENCY = 3;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "ggcoder/1.0 (+https://github.com/KenKaiii/gg-coder)";

const DOC_PATH_PATTERNS = [/\/docs?\b/i, /\/reference\b/i, /\/api\b/i, /\/guide/i, /\/learn\b/i];
const DOC_ROOT_SEGMENTS = new Set(["docs", "doc", "reference", "api", "guide", "learn"]);
const LONG_LLMS_THRESHOLD = 20000;
const DEFAULT_LLMS_CANDIDATE_LIMIT = 6;

type FetchFormat = "markdown" | "text" | "html";
type LlmsCandidateKind = "llms" | "llms-full" | "llms-ctx" | "page-md";

interface LlmsCandidate {
  url: string;
  label: string;
  kind: LlmsCandidateKind;
  priority: number;
}

interface FetchOptions {
  maxLength: number;
  format: FetchFormat;
  preferLlmsTxt: boolean;
  /** Network allowlist policy, read lazily (undefined = unrestricted). */
  getNetworkPolicy?: GetNetworkPolicy;
}

interface RawResponse {
  status: number;
  statusText: string;
  contentType: string;
  contentLength: number | null;
  body: Response;
  finalUrl: string;
}

/** Result of a single-fetch attempt: either a usable response or an error string. */
type FetchOneResult = { ok: true; response: RawResponse } | { ok: false; error: string };

/**
 * Fetch a URL, transparently following safe redirects up to `MAX_REDIRECTS`.
 * Each hop's target is re-validated with `isBlockedUrl` (SSRF) and the abort
 * signal is honored throughout. Returns the final non-redirect response or an
 * error string describing why the fetch could not complete.
 */
function headersForFormat(format: FetchFormat, honestUserAgent = false): Record<string, string> {
  const accept =
    format === "html"
      ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"
      : format === "markdown"
        ? "text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.5"
        : "text/plain,text/html;q=0.9,*/*;q=0.5";
  return {
    "User-Agent": honestUserAgent ? HONEST_USER_AGENT : BROWSER_USER_AGENT,
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function requestHop(
  url: string,
  signal: AbortSignal,
  format: FetchFormat,
  honestUserAgent = false,
): Promise<Response> {
  return await fetch(url, {
    headers: headersForFormat(format, honestUserAgent),
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
}

async function fetchOne(
  url: string,
  signal: AbortSignal,
  format: FetchFormat,
  getNetworkPolicy?: GetNetworkPolicy,
): Promise<FetchOneResult> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Every hop — the initial request and each redirect target — is checked, so
    // a redirect can never carry the fetch to a disallowed host.
    const blocked = checkUrlPolicy(currentUrl, getNetworkPolicy);
    if (blocked) return { ok: false, error: `Error: ${blocked}` };

    let response = await requestHop(currentUrl, signal, format);
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      response.body?.cancel().catch(() => undefined);
      response = await requestHop(currentUrl, signal, format, true);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          error: `Error: HTTP ${response.status} redirect without Location header`,
        };
      }
      const redirectUrl = new URL(location, currentUrl).toString();
      if (isBlockedUrl(redirectUrl)) {
        return {
          ok: false,
          error: "Error: Redirect blocked — target URL is private/internal or unsupported.",
        };
      }
      currentUrl = redirectUrl;
      continue;
    }

    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
    const contentType = response.headers.get("content-type") ?? "";
    const responseByteLimit = byteLimitForResponse(contentType, currentUrl);
    if (
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength > responseByteLimit
    ) {
      response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        error: `Error: response too large (${contentLength} bytes; limit ${responseByteLimit}).`,
      };
    }
    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        contentType,
        contentLength:
          contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
        body: response,
        finalUrl: currentUrl,
      },
    };
  }

  return { ok: false, error: `Error: too many redirects (>${MAX_REDIRECTS})` };
}

export async function readBoundedBody(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("response too large");
        throw new Error(`response too large (${totalBytes} bytes; limit ${maxBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  // Surrogate-safe: a mid-emoji cut strands a lone surrogate that makes the
  // provider request body invalid JSON on the next turn.
  return sliceHead(content, maxLength) + "\n\n[Content truncated]";
}

function byteLimitForResponse(contentType: string, url: string): number {
  const path = url.toLowerCase().split("?")[0];
  return contentType.includes("application/pdf") || path.endsWith(".pdf")
    ? MAX_PDF_BYTES
    : MAX_RESPONSE_BYTES;
}

function looksLikePdf(contentType: string, url: string, head: Uint8Array): boolean {
  if (contentType.includes("application/pdf")) return true;
  const magic =
    head.length >= 4 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46;
  if (url.toLowerCase().split("?")[0].endsWith(".pdf") && magic) return true;
  return false;
}

/** Process a fetched PDF body into extracted text or an explanatory error. */
async function processPdf(response: RawResponse, maxLength: number): Promise<string> {
  if (response.contentLength !== null && response.contentLength > MAX_PDF_BYTES) {
    return `Error: PDF too large (${response.contentLength} bytes; limit ${MAX_PDF_BYTES}).`;
  }
  const buffer = await response.body.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return `Error: PDF too large (${buffer.byteLength} bytes; limit ${MAX_PDF_BYTES}).`;
  }
  try {
    const { text, pages } = await extractPdfText(new Uint8Array(buffer));
    return `[PDF · ${pages} page${pages === 1 ? "" : "s"}]\n\n${truncate(text.trim(), maxLength)}`;
  } catch (err) {
    if (err instanceof PdfExtractorUnavailable) {
      return "PDF detected but the optional 'unpdf' dependency is not installed. Add it: pnpm add -w unpdf";
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `Error extracting PDF text: ${msg}`;
  }
}

/** Process a fetched HTML/text body into the requested format. */
async function processHtmlOrText(
  response: RawResponse,
  text: string,
  opts: FetchOptions,
): Promise<string> {
  const prefix = text.trimStart().slice(0, 512);
  const genericContentType =
    !response.contentType ||
    /application\/octet-stream|binary\/octet-stream|text\/plain/i.test(response.contentType);
  const isHtml =
    response.contentType.includes("html") ||
    (genericContentType && /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix));

  if (opts.format === "html") {
    return truncate(text, opts.maxLength);
  }
  if (!isHtml) {
    return truncate(text, opts.maxLength);
  }

  if (opts.format === "text") {
    return truncate(htmlToCleanText(text), opts.maxLength);
  }

  try {
    const extracted = await extractToMarkdown(text, response.finalUrl);
    if (extracted) {
      const heading = extracted.title ? `# ${extracted.title}\n\n` : "";
      return truncate(heading + extracted.markdown, opts.maxLength);
    }
  } catch {
    // Extractor unavailable or failed — fall through to the plain-text path.
  }

  return truncate(htmlToCleanText(text), opts.maxLength);
}

/**
 * Run the full per-URL pipeline (SSRF check → redirects → PDF/HTML/text →
 * format). Never throws: returns content or an `Error: …` string so one bad
 * URL in a multi-URL call doesn't fail the whole call.
 */
async function fetchAndProcess(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string> {
  if (isBlockedUrl(url)) {
    return "Error: URL blocked — requests to private/internal network addresses are not allowed.";
  }

  try {
    const result = await fetchOne(url, signal, opts.format, opts.getNetworkPolicy);
    if (!result.ok) return result.error;

    const { response } = result;
    if (!(response.status >= 200 && response.status < 300)) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const bytes = await readBoundedBody(
      response.body,
      byteLimitForResponse(response.contentType, response.finalUrl),
    );
    const head = bytes.slice(0, 4);

    if (looksLikePdf(response.contentType, response.finalUrl, head)) {
      const pdfResponse: RawResponse = {
        ...response,
        body: new Response(bytes.slice().buffer),
        contentLength: bytes.byteLength,
      };
      return await processPdf(pdfResponse, opts.maxLength);
    }

    const text = new TextDecoder().decode(bytes);
    return await processHtmlOrText(response, text, opts);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error fetching ${url}: ${msg}`;
  }
}

/** Heuristic: does this URL look like a documentation page worth probing for llms.txt? */
function isDocish(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase().startsWith("docs.")) return true;
  return DOC_PATH_PATTERNS.some((p) => p.test(parsed.pathname));
}

function addLlmsFileCandidates(
  candidates: LlmsCandidate[],
  baseUrl: string,
  host: string,
  maxLength: number,
  priorityBase: number,
): void {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  candidates.push({
    url: `${base}llms.txt`,
    label: `llms.txt for ${host}`,
    kind: "llms",
    priority: priorityBase,
  });
  candidates.push({
    url: `${base}llms-ctx.txt`,
    label: `llms-ctx.txt for ${host}`,
    kind: "llms-ctx",
    priority: priorityBase + 2,
  });
  if (maxLength >= LONG_LLMS_THRESHOLD) {
    candidates.push({
      url: `${base}llms-full.txt`,
      label: `llms-full.txt for ${host}`,
      kind: "llms-full",
      priority: priorityBase + 3,
    });
    candidates.push({
      url: `${base}llms-ctx-full.txt`,
      label: `llms-ctx-full.txt for ${host}`,
      kind: "llms-ctx",
      priority: priorityBase + 4,
    });
  }
}

export function buildLlmsCandidates(url: string, maxLength: number): LlmsCandidate[] {
  const parsed = new URL(url);
  const candidates: LlmsCandidate[] = [];
  addLlmsFileCandidates(candidates, parsed.origin, parsed.host, maxLength, 10);

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const docRootIndex = pathSegments.findIndex((segment) =>
    DOC_ROOT_SEGMENTS.has(segment.toLowerCase()),
  );
  if (docRootIndex >= 0) {
    const rootPath = pathSegments
      .slice(0, docRootIndex + 1)
      .map(encodeURIComponent)
      .join("/");
    addLlmsFileCandidates(candidates, `${parsed.origin}/${rootPath}/`, parsed.host, maxLength, 20);
  }

  const pageMarkdownUrl = new URL(parsed.href);
  pageMarkdownUrl.hash = "";
  if (pageMarkdownUrl.pathname.endsWith("/")) {
    pageMarkdownUrl.pathname += "index.html.md";
  } else if (!pageMarkdownUrl.pathname.endsWith(".md")) {
    pageMarkdownUrl.pathname += ".md";
  }
  candidates.push({
    url: pageMarkdownUrl.href,
    label: `Markdown source for ${pageMarkdownUrl.host}${pageMarkdownUrl.pathname}`,
    kind: "page-md",
    priority: 15,
  });

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.priority - b.priority)
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
}

function looksLikeHtmlErrorPage(text: string): boolean {
  const trimmed = text.trim().slice(0, 4000).toLowerCase();
  if (/^(<!doctype html|<html\b)/i.test(trimmed)) return true;
  if (/<title>\s*(404|not found|error)\b/i.test(trimmed)) return true;
  const tagMatches = trimmed.match(/<\/?[a-z][^>]*>/g) ?? [];
  return tagMatches.length > 20 && tagMatches.join("").length > trimmed.length * 0.25;
}

function looksLikeMarkdownDocument(
  text: string,
  contentType: string,
  candidate: LlmsCandidate,
): boolean {
  const trimmed = text.trim();
  const minimumLength = candidate.kind === "page-md" ? 80 : 120;
  if (trimmed.length <= minimumLength) return false;
  if (looksLikeHtmlErrorPage(trimmed)) return false;
  if (/text\/plain|text\/markdown|markdown/i.test(contentType)) return true;
  if (/^---\s*[\s\S]{0,1200}?---\s*\n#\s+/m.test(trimmed)) return true;
  if (/^#\s+\S+/m.test(trimmed)) return true;
  const markdownLinks = trimmed.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
  const listItems = trimmed.match(/^\s*[-*]\s+\S+/gm) ?? [];
  return candidate.kind !== "page-md" && markdownLinks.length + listItems.length >= 3;
}

async function tryLlmsResource(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string | null> {
  let candidates: LlmsCandidate[];
  try {
    candidates = buildLlmsCandidates(url, opts.maxLength);
  } catch {
    return null;
  }

  const limit =
    opts.maxLength >= LONG_LLMS_THRESHOLD ? candidates.length : DEFAULT_LLMS_CANDIDATE_LIMIT;
  const eligibleCandidates = candidates
    .slice(0, limit)
    .filter((candidate) => !isBlockedUrl(candidate.url));
  const probes = await runPool(eligibleCandidates, PROBE_CONCURRENCY, async (candidate) => {
    try {
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const result = await fetchOne(candidate.url, probeSignal, "markdown", opts.getNetworkPolicy);
      if (!result.ok) return null;
      const { response } = result;
      if (response.status !== 200) return null;
      const bytes = await readBoundedBody(response.body);
      const text = new TextDecoder().decode(bytes);
      if (!looksLikeMarkdownDocument(text, response.contentType, candidate)) return null;
      return `[${candidate.label}]\nSource: ${response.finalUrl}\n\n${truncate(text.trim(), opts.maxLength)}`;
    } catch {
      return null;
    }
  });

  return probes.find((probe): probe is string => probe !== null) ?? null;
}

async function fetchWithPreferredDocs(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<string> {
  if (opts.format !== "html" && opts.preferLlmsTxt && !isBlockedUrl(url) && isDocish(url)) {
    const llms = await tryLlmsResource(url, opts, signal);
    if (llms) return llms;
  }
  return await fetchAndProcess(url, opts, signal);
}

export function createWebFetchTool(
  getNetworkPolicy?: GetNetworkPolicy,
): AgentTool<typeof parameters> {
  return {
    name: "web_fetch",
    description:
      "Fetch and read web page content. Accepts a single `url` or a `urls` array (up to 10, " +
      "fetched concurrently). Returns clean Markdown by default (`format`: markdown|text|html) via " +
      "main-content extraction. Extracts text from PDFs, follows safe redirects automatically, and " +
      "prefers a site's curated /llms.txt for docs pages when available.",
    parameters,
    async execute(args, context: ToolContext) {
      const maxLength = args.max_length ?? 10000;
      const format: FetchFormat = args.format ?? "markdown";
      const preferLlmsTxt = args.prefer_llms_txt !== false;

      // Multi-URL path: bounded-concurrency pool, per-URL budget, ordered output.
      if (args.urls && args.urls.length > 0) {
        const urls = args.urls;
        const perUrlBudget = Math.max(PER_URL_MIN_BUDGET, Math.floor(maxLength / urls.length));
        const opts: FetchOptions = {
          maxLength: perUrlBudget,
          format,
          preferLlmsTxt,
          getNetworkPolicy,
        };
        const sections = await runPool(urls, MAX_CONCURRENCY, (u) =>
          fetchWithPreferredDocs(u, opts, context.signal),
        );
        return urls.map((u, i) => `## ${u}\n${sections[i]}`).join("\n\n");
      }

      const url = args.url;
      if (!url) {
        return "Error: provide either `url` or `urls`.";
      }

      const opts: FetchOptions = { maxLength, format, preferLlmsTxt, getNetworkPolicy };
      return await fetchWithPreferredDocs(url, opts, context.signal);
    },
  };
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the returned results array.
 */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function runner(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}

const parameters = z
  .object({
    url: z.string().optional().describe("The URL to fetch"),
    urls: z
      .array(z.string())
      .max(MAX_URLS)
      .optional()
      .describe(`Fetch multiple URLs concurrently (up to ${MAX_URLS}); returns a sectioned digest`),
    max_length: z.number().optional().describe("Maximum characters to return (default: 10000)"),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe("Output format: markdown (default, main-content extraction), text, or html"),
    prefer_llms_txt: z
      .boolean()
      .optional()
      .describe("Prefer a site's curated /llms.txt for documentation pages (default: true)"),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.urls && v.urls.length > 0), {
    message: "Provide exactly one of `url` or `urls`.",
  });
