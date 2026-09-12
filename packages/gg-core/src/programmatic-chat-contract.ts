/** Browser-safe display projections. Authoritative domain records stay in ggcoder. */
export const PROGRAMMATIC_CHAT_VERSION = 1 as const;
export const PROGRAMMATIC_CHAT_PAGE_LIMIT = 50;
export const PROGRAMMATIC_CHAT_EVIDENCE_LIMIT = 50;
export const PROGRAMMATIC_CHAT_ERROR_LIMIT = 1_000;

export type ProgrammaticChatAction =
  | "report"
  | "detail"
  | "inspect-setup"
  | "approve-setup"
  | "scan"
  | "dismiss";
export type ProgrammaticChatRequest =
  | { version: 1; action: "report"; offset: number }
  | { version: 1; action: "detail"; id: string }
  | { version: 1; action: "inspect-setup" | "scan" }
  | { version: 1; action: "approve-setup"; proposalHandle: string }
  | { version: 1; action: "dismiss"; id: string; snapshot: string };

export interface ProgrammaticChatRoute {
  available: boolean;
  command: "research" | "setup-sweep" | "setup-tauri-package" | null;
  reason: string;
  machineLocal: boolean;
}
export interface ProgrammaticChatAvailability {
  available: boolean;
  reason: string;
}
export interface ProgrammaticChatSummary {
  /** Snapshot eligibility, including conflicts anywhere in the project. Not execution approval. */
  actions: { run: ProgrammaticChatAvailability; dismiss: ProgrammaticChatAvailability };
  id: string;
  expectedOutput: string;
  state: "discovered" | "queued" | "running" | "completed" | "dismissed";
  presence: "present" | "disappeared";
  route: ProgrammaticChatRoute;
  mutationPaths: string[];
}
export interface ProgrammaticChatEvidence {
  basis: "observed" | "inferred" | "assumed";
  message: string;
  location: { path: string; startLine?: number; endLine?: number } | null;
}
export interface ProgrammaticChatDetail {
  summary: ProgrammaticChatSummary;
  trigger: string;
  verification: string;
  risks: string[];
  evidence: ProgrammaticChatEvidence[];
  evidenceTruncated: boolean;
}
export interface ProgrammaticChatReport {
  status: "setup-required" | "current" | "stale" | "recovered";
  reason: string;
  /** Current profile validation and project conflicts, independent of scan freshness. */
  scan: ProgrammaticChatAvailability;
  snapshot: string | null;
  fingerprint: string | null;
  offset: number;
  total: number;
  rows: ProgrammaticChatSummary[];
}
export interface ProgrammaticChatProposal {
  handle: string;
  fingerprint: string;
  /** Exact canonical profile JSON, not an editable command or route envelope. */
  profileJson: string;
  routes: { id: string; route: ProgrammaticChatRoute }[];
  exclusions: string[];
  configurationInputs: { path: string; sha256: string }[];
}
export type ProgrammaticChatResponse =
  | { version: 1; action: "report"; ok: true; report: ProgrammaticChatReport }
  | {
      version: 1;
      action: "detail";
      ok: true;
      snapshot: string | null;
      detail: ProgrammaticChatDetail | null;
    }
  | { version: 1; action: "inspect-setup"; ok: true; proposal: ProgrammaticChatProposal }
  | { version: 1; action: "approve-setup" | "scan" | "dismiss"; ok: true; changed: boolean }
  | {
      version: 1;
      action: ProgrammaticChatAction;
      ok: false;
      error: string;
      reconcile: boolean;
      /** Only a pre-consumption setup rejection may preserve this exact handle.
       * Absence on setup failure means reinspection is required, independently of reconcile. */
      approvableProposalHandle?: string;
    };

type Guard = (value: unknown) => boolean;
const text =
  (max: number): Guard =>
  (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((character) =>
      character.charCodeAt(0) >= 32 || "\t\n\r".includes(character),
    );
const hash: Guard = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bool: Guard = (value) => typeof value === "boolean";
const integer =
  (max: number): Guard =>
  (value) =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const oneOf =
  (...values: unknown[]): Guard =>
  (value) =>
    values.includes(value);
const nullable =
  (guard: Guard): Guard =>
  (value) =>
    value === null || guard(value);
const list =
  (guard: Guard, max: number): Guard =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(guard);
function object(
  value: unknown,
  fields: Record<string, Guard>,
  optional: Record<string, Guard> = {},
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      (key) => Object.hasOwn(fields, key) || Object.hasOwn(optional, key),
    ) &&
    Object.entries(fields).every(
      ([key, guard]) => Object.hasOwn(record, key) && guard(record[key]),
    ) &&
    Object.entries(optional).every(
      ([key, guard]) => !Object.hasOwn(record, key) || guard(record[key]),
    )
  );
}
/** Reject absolute, drive-relative, traversal and non-normalized locations without node:path. */
export function isProgrammaticChatRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    text(500)(value) &&
    !/[\\:]/.test(value) &&
    Array.from(value).every((character) => character.charCodeAt(0) >= 32) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
const commands = oneOf("research", "setup-sweep", "setup-tauri-package");
const route: Guard = (value) =>
  object(value, {
    available: bool,
    command: nullable(commands),
    reason: text(4_000),
    machineLocal: bool,
  }) &&
  (!(value as ProgrammaticChatRoute).available ||
    (value as ProgrammaticChatRoute).command !== null);
const availability: Guard = (value) =>
  object(value, { available: bool, reason: text(1_000) });
const summary: Guard = (value) =>
  object(value, {
    id: hash,
    expectedOutput: text(4_000),
    state: oneOf("discovered", "queued", "running", "completed", "dismissed"),
    presence: oneOf("present", "disappeared"),
    route,
    mutationPaths: list(isProgrammaticChatRelativePath, 200),
    actions: (value) => object(value, { run: availability, dismiss: availability }),
  });
const location: Guard = (value) => {
  if (
    !object(
      value,
      { path: isProgrammaticChatRelativePath },
      {
        startLine: (line) => integer(Number.MAX_SAFE_INTEGER)(line) && line !== 0,
        endLine: (line) => integer(Number.MAX_SAFE_INTEGER)(line) && line !== 0,
      },
    )
  )
    return false;
  const loc = value as { startLine?: number; endLine?: number };
  return loc.endLine === undefined || (loc.startLine !== undefined && loc.endLine >= loc.startLine);
};
const detail: Guard = (value) =>
  object(value, {
    summary,
    trigger: text(4_000),
    verification: text(4_000),
    risks: list(text(4_000), 50),
    evidence: list(
      (item) =>
        object(item, {
          basis: oneOf("observed", "inferred", "assumed"),
          message: text(4_000),
          location: nullable(location),
        }),
      PROGRAMMATIC_CHAT_EVIDENCE_LIMIT,
    ),
    evidenceTruncated: bool,
  });
const report: Guard = (value) => {
  if (
    !object(value, {
      status: oneOf("setup-required", "current", "stale", "recovered"),
      reason: text(4_000),
      scan: availability,
      snapshot: nullable(hash),
      fingerprint: nullable(hash),
      offset: integer(1_000),
      total: integer(1_000),
      rows: list(summary, PROGRAMMATIC_CHAT_PAGE_LIMIT),
    })
  )
    return false;
  const page = value as ProgrammaticChatReport;
  return (
    page.offset + page.rows.length <= page.total &&
    new Set(page.rows.map((row) => row.id)).size === page.rows.length &&
    (page.status !== "current" || (page.snapshot !== null && page.fingerprint !== null))
  );
};
const profileJson: Guard = (value) => {
  if (!text(32_000)(value)) return false;
  try {
    const profile: unknown = JSON.parse(value as string);
    if (
      !object(profile, {
        version: oneOf(1),
        scanners: list(
          (scanner) =>
            object(scanner, {
              version: oneOf(1),
              id: (id) => text(100)(id) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id as string),
              specialistCommand: commands,
            }),
          64,
        ),
      })
    )
      return false;
    const scanners = (
      profile as { scanners: { id: string; specialistCommand: string; version: 1 }[] }
    ).scanners;
    if (!scanners.every((scanner, index) => index === 0 || scanners[index - 1]!.id < scanner.id))
      return false;
    // Canonical object keys are lexically ordered, matching the backend canonicalJson helper.
    return (
      value ===
      `${JSON.stringify({ scanners: scanners.map(({ id, specialistCommand, version }) => ({ id, specialistCommand, version })), version: 1 }, null, 2)}\n`
    );
  } catch {
    return false;
  }
};
const proposal: Guard = (value) =>
  object(value, {
    handle: hash,
    fingerprint: hash,
    profileJson,
    routes: list((item) => object(item, { id: hash, route }), 1_000),
    exclusions: list(text(500), 200),
    configurationInputs: list(
      (item) => object(item, { path: isProgrammaticChatRelativePath, sha256: hash }),
      10_000,
    ),
  });
const action = oneOf("report", "detail", "inspect-setup", "approve-setup", "scan", "dismiss");

export function isProgrammaticChatRequest(value: unknown): value is ProgrammaticChatRequest {
  if (typeof value !== "object" || value === null) return false;
  const base = { version: oneOf(1), action };
  switch ((value as { action?: unknown }).action) {
    case "report":
      return object(value, { ...base, offset: integer(1_000) });
    case "detail":
      return object(value, { ...base, id: hash });
    case "inspect-setup":
    case "scan":
      return object(value, base);
    case "approve-setup":
      return object(value, { ...base, proposalHandle: hash });
    case "dismiss":
      return object(value, { ...base, id: hash, snapshot: hash });
    default:
      return false;
  }
}
export function isProgrammaticChatResponse(value: unknown): value is ProgrammaticChatResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { ok?: unknown; action?: unknown };
  if (response.ok === false)
    return object(value, {
      version: oneOf(1),
      action,
      ok: oneOf(false),
      error: text(PROGRAMMATIC_CHAT_ERROR_LIMIT),
      reconcile: bool,
    }, response.action === "approve-setup" || response.action === "inspect-setup"
      ? { approvableProposalHandle: hash }
      : {});
  const base = { version: oneOf(1), action, ok: oneOf(true) };
  switch (response.action) {
    case "report":
      return object(value, { ...base, report });
    case "detail":
      return object(value, { ...base, snapshot: nullable(hash), detail: nullable(detail) });
    case "inspect-setup":
      return object(value, { ...base, proposal });
    case "approve-setup":
    case "scan":
    case "dismiss":
      return object(value, { ...base, changed: bool });
    default:
      return false;
  }
}
