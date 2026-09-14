/**
 * A local inference server (llama.cpp, vLLM, Ollama, LM Studio) can spend
 * minutes prefilling a large prompt before it emits its first token. The
 * first-event watchdog that protects hosted streams turns that into an abort
 * → retry → cold-prefill loop that never converges, so it is disabled for
 * loopback backends.
 */
export function isLocalBackendUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  // URL normalises IPv6 hosts to bracketed form.
  if (host === "[::1]" || host === "::1") return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;

  // 127.0.0.0/8
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    return octets[0] === 127;
  }

  return false;
}
