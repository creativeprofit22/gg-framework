import { z } from "zod";

export const inspectedLocalLocationSchema = z.object({
  path: z.string().min(1).max(4096),
  startLine: z.number().int().positive().safe(),
  endLine: z.number().int().positive().safe(),
}).strict().refine((value) => value.endLine >= value.startLine);
export type InspectedLocalLocation = z.infer<typeof inspectedLocalLocationSchema>;

/** Host tool result details only. Never decode this envelope from source content. */
export const retrievalMetadataSchema = z
  .object({
    kind: z.literal("host-retrieval-v1"),
    resources: z
      .array(
        z
          .object({
            outcome: z.enum(["retrieved", "failed", "unavailable", "cancelled"]),
            sourceUrl: z.string().max(2_000).optional(),
            localLocations: z.array(inspectedLocalLocationSchema).max(64).optional(),
            revision: z
              .string()
              .regex(/^[a-zA-Z0-9._/-]{1,200}$/)
              .optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type RetrievalResource = z.infer<typeof retrievalMetadataSchema>["resources"][number];

/** Do not store credentials, query strings or fragments, nor misidentify a redacted URL. */
export function safeRetrievalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.length > 2_000
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
