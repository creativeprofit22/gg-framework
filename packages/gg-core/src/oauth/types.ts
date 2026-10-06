export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  /** Original token lifetime in seconds (the provider's `expires_in`). Used to
   *  scale the proactive-refresh threshold: short-lived tokens (e.g. Kimi's
   *  15-min access token) must refresh well before expiry, not 60s prior. */
  expiresIn?: number;
  accountId?: string; // OpenAI chatgpt_account_id from JWT
  projectId?: string; // Google Cloud/Code Assist project ID for Gemini OAuth
  baseUrl?: string; // Custom API base URL (e.g. Xiaomi token plan endpoint)
  /** ms timestamp until which this credential's usage window is exhausted.
   *  Set by AuthStorage.markUsageExhausted() when the provider rejects with a
   *  usage/quota stop; while in the future, resolution may skip this credential
   *  in favor of a configured fallback (e.g. Kimi OAuth → Moonshot API key). */
  usageExhaustedUntil?: number;
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  /**
   * Collect a pasted authorization code or callback URL.
   *
   * `signal` aborts when the code already arrived another way (the local
   * callback listener won the race) and the prompt should be torn down.
   * Implementations may ignore it — an abandoned promise is simply never
   * awaited — but a terminal prompt should honour it so the line does not
   * linger after login already succeeded.
   */
  onPromptCode: (message: string, signal?: AbortSignal) => Promise<string>;
  onStatus: (message: string) => void;
}
