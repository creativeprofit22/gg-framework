import { ENHANCE_PROMPT_MAX_CHARS } from "@kenkaiiii/gg-core/desktop-session-ux";

export { ENHANCE_PROMPT_MAX_CHARS };

export type EnhancePromptRouteResult<T> =
  | { status: 200; body: T }
  | { status: 400; body: { error: string } };

export async function runEnhancePromptRequest<T>(
  body: unknown,
  enhance: (text: string) => Promise<T>,
): Promise<EnhancePromptRouteResult<T>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "text must be a string" } };
  }
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string") {
    return { status: 400, body: { error: "text must be a string" } };
  }
  if (!text.trim()) return { status: 400, body: { error: "empty prompt" } };
  if (text.length > ENHANCE_PROMPT_MAX_CHARS) {
    return {
      status: 400,
      body: { error: `prompt exceeds ${ENHANCE_PROMPT_MAX_CHARS} characters` },
    };
  }
  return { status: 200, body: await enhance(text) };
}
