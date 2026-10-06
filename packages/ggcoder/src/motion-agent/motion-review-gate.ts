import { z } from "zod";

export const productionDepthSchema = z.enum(["quick", "standard", "production"]);
export type ProductionDepth = z.infer<typeof productionDepthSchema>;
const findingSchema = z
  .object({
    time: z.number().finite().min(0).max(3600),
    criterion: z.string().min(1).max(500),
    problem: z.string().min(1).max(1000),
    correction: z.string().min(1).max(1000),
  })
  .strict();
export const motionVerdictSchema = z
  .object({
    status: z.enum(["ready", "revise", "unverified"]),
    findings: z.array(findingSchema).max(20),
  })
  .strict()
  .refine((v) => v.status !== "ready" || v.findings.length === 0)
  .refine((v) => v.status !== "revise" || v.findings.length > 0);
export type MotionVerdict = z.infer<typeof motionVerdictSchema>;
export interface MotionEvidenceIdentity {
  artifactHash: string;
  sourceHash: string;
  images: number;
  technical: boolean;
}
export function parseMotionVerdict(value: unknown): MotionVerdict {
  const parsed = motionVerdictSchema.safeParse(value);
  return parsed.success ? parsed.data : { status: "unverified", findings: [] };
}

/** No provider or filesystem access: deterministic, bounded completion decisions. */
export class MotionReviewGate {
  private touched = false;
  private injections = 0;
  private evidence: MotionEvidenceIdentity | undefined;
  private verdict: MotionVerdict = { status: "unverified", findings: [] };
  private closed = false;
  constructor(private depth: ProductionDepth = "standard") {}
  get status(): MotionVerdict["status"] {
    return this.verdict.status;
  }
  get armed(): boolean {
    return this.touched && this.status !== "ready" && !this.closed;
  }
  get revisionLimit(): number {
    return this.depth === "quick" ? 1 : 2;
  }
  begin(): void {
    this.injections = 0;
    this.closed = false;
    this.touched = false;
  }
  setDepth(depth: ProductionDepth): void {
    this.depth = depth;
  }
  work(): void {
    this.touched = true;
    this.evidence = undefined;
    this.verdict = { status: "unverified", findings: [] };
  }
  noDelivery(): void {
    this.touched = false;
  }
  submit(evidence: MotionEvidenceIdentity, value: unknown): void {
    this.touched = true;
    this.evidence = evidence;
    this.verdict = parseMotionVerdict(value);
    if (
      evidence.images < 3 ||
      !evidence.technical ||
      !/^[a-f0-9]{64}$/.test(evidence.artifactHash) ||
      !/^[a-f0-9]{64}$/.test(evidence.sourceHash)
    ) {
      this.verdict = { status: "unverified", findings: this.verdict.findings };
    }
  }
  validate(current: MotionEvidenceIdentity): void {
    if (
      !this.evidence ||
      current.artifactHash !== this.evidence.artifactHash ||
      current.sourceHash !== this.evidence.sourceHash ||
      !current.technical
    )
      this.work();
  }
  followUp(): string | null {
    if (!this.armed) return null;
    this.injections++;
    if (this.injections > this.revisionLimit) {
      this.closed = true;
      return `Motion review budget spent. Deliver only an honest draft/blocked response, never an approved final. Status: ${this.status}. Report unresolved findings and missing evidence. ${JSON.stringify(this.verdict.findings)}`;
    }
    return `Motion completion is ${this.status}. Use motion_review to register the output and submit current rendered evidence for independent review; correct these concrete findings, then rerender and recheck changed work. For shell-only non-delivery work explicitly register no_delivery. ${JSON.stringify(this.verdict.findings)}`;
  }
}
