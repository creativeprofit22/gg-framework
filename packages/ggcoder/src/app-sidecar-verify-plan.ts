import type { VerifyPlanApproveResult, VerifyPlanStatus } from "@kenkaiiii/gg-core/verify-plan";

export interface VerifyPlanSession {
  getVerifyPlanStatus(): Promise<VerifyPlanStatus | null>;
  approveVerifyPlan(descriptorSha256: string): Promise<VerifyPlanApproveResult>;
}

export interface VerifyPlanRouteResult {
  status: 200 | 400 | 500 | 503;
  body: VerifyPlanStatus | VerifyPlanApproveResult | { error: string };
}

const SHA256 = /^[a-f0-9]{64}$/;

export function parseVerifyPlanApproveBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const sha = (body as { descriptorSha256?: unknown }).descriptorSha256;
  return typeof sha === "string" && SHA256.test(sha) ? sha : null;
}

export async function runVerifyPlanStatusRequest(
  session: VerifyPlanSession,
): Promise<VerifyPlanRouteResult> {
  try {
    const status = await session.getVerifyPlanStatus();
    return status === null
      ? { status: 503, body: { error: "The verify plan is not loaded yet." } }
      : { status: 200, body: status };
  } catch (error) {
    return {
      status: 500,
      body: { error: `Could not read the verify plan: ${errorText(error)}` },
    };
  }
}

/** Approves only the descriptor hash the user was shown. A changed or missing
 *  descriptor is an expected outcome (`ok: false`), not an HTTP error. */
export async function runVerifyPlanApproveRequest(
  session: VerifyPlanSession,
  body: unknown,
): Promise<VerifyPlanRouteResult> {
  const sha = parseVerifyPlanApproveBody(body);
  if (sha === null)
    return { status: 400, body: { error: "descriptorSha256 must be 64 lowercase hex chars" } };
  try {
    const result = await session.approveVerifyPlan(sha);
    return { status: 200, body: result };
  } catch (error) {
    return {
      status: 500,
      body: { error: `Could not save the approval: ${errorText(error)}` },
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
