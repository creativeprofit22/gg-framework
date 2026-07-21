import { environmentSecrets, formatError, redactText } from "@kenkaiiii/gg-ai";

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SidecarErrorDetails {
  logFields: Record<string, string>;
  event: {
    headline: string;
    message?: string;
    guidance: string;
    provider?: string;
    statusCode?: number;
    resetsAt?: number;
  };
}

export function sidecarSensitiveValues(env: Record<string, string | undefined>): string[] {
  const values = new Set(environmentSecrets(env));
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/(?:BASE_URL|ENDPOINT|HOST)$/i.test(name)) continue;
    values.add(value);
    try {
      const hostname = new URL(value).hostname;
      if (hostname) values.add(hostname);
    } catch {
      // Non-URL endpoint values are still redacted in full above.
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function formatSidecarError(
  err: unknown,
  transform: (value: string) => string = (value) => value,
  sensitiveValues: Iterable<string> = [],
): SidecarErrorDetails {
  const formatted = formatError(err);
  const clean = (value: string): string =>
    redactText(transform(value), { secrets: sensitiveValues, maxStringLength: 2_000 });
  const headline = clean(formatted.headline);
  const message = formatted.message ? clean(formatted.message) : undefined;
  const guidance = clean(formatted.guidance);
  const requestId = safeRequestId(formatted.requestId);

  return {
    logFields: {
      headline,
      source: formatted.source,
      ...(message ? { message } : {}),
      ...(formatted.provider ? { provider: formatted.provider } : {}),
      ...(formatted.statusCode != null ? { statusCode: String(formatted.statusCode) } : {}),
      ...(requestId ? { requestId } : {}),
      ...(formatted.resetsAt != null ? { resetsAt: String(formatted.resetsAt) } : {}),
    },
    event: {
      headline,
      ...(message ? { message } : {}),
      guidance,
      ...(formatted.provider ? { provider: formatted.provider } : {}),
      ...(formatted.statusCode != null ? { statusCode: formatted.statusCode } : {}),
      ...(formatted.resetsAt != null ? { resetsAt: formatted.resetsAt } : {}),
    },
  };
}

function safeRequestId(value: string | undefined): string | undefined {
  return value && SAFE_REQUEST_ID.test(value) ? value : undefined;
}
