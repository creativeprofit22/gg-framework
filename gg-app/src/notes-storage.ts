import { isNotesDocumentV2 } from "./notes-types";
import type {
  NotesDocumentV2,
  NotesLoadDiagnostic,
  NotesLoadResult,
  NotesParseResult,
  NotesSaveResult,
} from "./notes-types";

const LEGACY_PREFIX = "gg-notes:";
const V2_PREFIX = "gg-notes-v2:";

/** Browser Notes are retained only for one-time migration and run-local fallback recovery. */
export interface NotesRepository {
  load(cwd: string): NotesLoadResult;
  save(cwd: string, document: NotesDocumentV2): NotesSaveResult;
}

export function canonicalProjectKey(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(normalized);

  if (driveMatch) {
    const drive = `${driveMatch[1].toLowerCase()}:`;
    const remainder = normalized.slice(driveMatch[0].length);
    const segments = resolveSegments(remainder.split("/"), true);
    return segments.length === 0 ? `${drive}/` : `${drive}/${segments.join("/")}`.toLowerCase();
  }

  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const rootParts = parts.slice(0, 2);
    const segments = resolveSegments(parts.slice(2), true);
    return `//${[...rootParts, ...segments].join("/")}`.toLowerCase();
  }

  const absolute = normalized.startsWith("/");
  const segments = resolveSegments(normalized.split("/"), absolute);
  const result = `${absolute ? "/" : ""}${segments.join("/")}`;
  return result || (absolute ? "/" : ".");
}

function resolveSegments(parts: string[], rooted: boolean): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") result.pop();
      else if (!rooted) result.push(part);
    } else {
      result.push(part);
    }
  }
  return result;
}

export function legacyNotesKey(cwd: string): string {
  return `${LEGACY_PREFIX}${cwd}`;
}

export function v2NotesKey(cwd: string): string {
  return `${V2_PREFIX}${canonicalProjectKey(cwd)}`;
}

export function createEmptyNotesDocument(now: string): NotesDocumentV2 {
  return {
    version: 2,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: now,
    legacyImportedAt: null,
  };
}

export function parseNotesDocument(raw: string): NotesParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }

  if (!isRecord(value)) return { ok: false, reason: "invalid-shape" };
  if (value.version !== 2) return { ok: false, reason: "unsupported-version" };
  if (!isNotesDocumentV2(value)) return { ok: false, reason: "invalid-shape" };

  return { ok: true, document: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Open the migration/fallback browser repository; the sidecar is normal authority. */
export function createNotesRepository(
  storage: Storage,
  clock: () => string = () => new Date().toISOString(),
): NotesRepository {
  return {
    load(cwd) {
      const diagnostics: NotesLoadDiagnostic[] = [];
      const exactLegacyKey = legacyNotesKey(cwd);
      const canonicalV2Key = v2NotesKey(cwd);
      const legacyRecord = findLegacyRecord(storage, cwd, diagnostics);
      const v2Raw = readStorage(storage, canonicalV2Key, diagnostics);
      const now = clock();

      if (v2Raw === null && legacyRecord === null) {
        const document = createEmptyNotesDocument(now);
        writeStorage(storage, canonicalV2Key, JSON.stringify(document), diagnostics);
        return loadResult(document, "empty", null, diagnostics);
      }

      if (v2Raw === null && legacyRecord !== null) {
        const document = {
          ...createEmptyNotesDocument(now),
          reference: legacyRecord.value,
          legacyImportedAt: now,
        };
        const imported = writeStorage(
          storage,
          canonicalV2Key,
          JSON.stringify(document),
          diagnostics,
        );
        return {
          ...loadResult(document, "legacy", legacyRecord.key, diagnostics),
          v2ImportAttempted: true,
          v2ImportSucceeded: imported,
        };
      }

      const parsed = parseNotesDocument(v2Raw as string);
      if (!parsed.ok) {
        diagnostics.push({ kind: "v2-parse", reason: parsed.reason });
        const document = createEmptyNotesDocument(now);
        if (legacyRecord !== null) {
          document.reference = legacyRecord.value;
          return loadResult(document, "legacy-fallback", legacyRecord.key, diagnostics);
        }
        return loadResult(document, "v2", null, diagnostics);
      }

      // Once a valid v2 document exists it is authoritative. The legacy key is
      // a rollback mirror only: treating it as newer could undo a successful v2
      // save after a quota/error prevented the matching legacy write.
      if (legacyRecord !== null) {
        return loadResult(parsed.document, "v2", legacyRecord.key, diagnostics);
      }

      const recovered = writeStorage(
        storage,
        exactLegacyKey,
        parsed.document.reference,
        diagnostics,
      );
      return {
        ...loadResult(parsed.document, "v2", exactLegacyKey, diagnostics),
        legacyRecoveryAttempted: true,
        legacyRecoverySucceeded: recovered,
      };
    },

    save(cwd, document) {
      const legacyKey = legacyNotesKey(cwd);
      const v2Key = v2NotesKey(cwd);
      return {
        legacy: writeResult(storage, legacyKey, document.reference),
        v2: writeResult(storage, v2Key, JSON.stringify(document)),
      };
    },
  };
}

function loadResult(
  document: NotesDocumentV2,
  source: NotesLoadResult["source"],
  legacyKey: string | null,
  diagnostics: NotesLoadDiagnostic[],
): NotesLoadResult {
  return {
    document,
    value: document.reference,
    source,
    legacyKey,
    v2ImportAttempted: false,
    v2ImportSucceeded: null,
    legacyRecoveryAttempted: false,
    legacyRecoverySucceeded: null,
    diagnostics,
    migrationEligibility: migrationEligibility(source, diagnostics),
  };
}

function migrationEligibility(
  source: NotesLoadResult["source"],
  diagnostics: readonly NotesLoadDiagnostic[],
): NotesLoadResult["migrationEligibility"] {
  if (diagnostics.some((diagnostic) => diagnostic.kind === "storage-read")) {
    return "ineligible-unreadable";
  }
  if (source === "empty") return "empty";
  if (source === "legacy" || source === "legacy-fallback") return "valid-legacy";
  return diagnostics.some((diagnostic) => diagnostic.kind === "v2-parse")
    ? "ineligible-invalid-v2"
    : "valid-v2";
}

function findLegacyRecord(
  storage: Storage,
  cwd: string,
  diagnostics: NotesLoadDiagnostic[],
): { key: string; value: string } | null {
  const exactKey = legacyNotesKey(cwd);
  const exactValue = readStorage(storage, exactKey, diagnostics);
  if (exactValue !== null) return { key: exactKey, value: exactValue };

  const canonical = canonicalProjectKey(cwd);
  const matchingKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(LEGACY_PREFIX) &&
        canonicalProjectKey(key.slice(LEGACY_PREFIX.length)) === canonical
      ) {
        matchingKeys.push(key);
      }
    }
  } catch (error) {
    diagnostics.push({ kind: "storage-read", key: LEGACY_PREFIX, error });
    return null;
  }

  matchingKeys.sort();
  const selectedKey = matchingKeys[0];
  if (!selectedKey) return null;
  if (matchingKeys.length > 1) {
    diagnostics.push({ kind: "ambiguous-legacy", selectedKey, matchingKeys });
  }
  const value = readStorage(storage, selectedKey, diagnostics);
  return value === null ? null : { key: selectedKey, value };
}

function readStorage(
  storage: Storage,
  key: string,
  diagnostics: NotesLoadDiagnostic[],
): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    diagnostics.push({ kind: "storage-read", key, error });
    return null;
  }
}

function writeStorage(
  storage: Storage,
  key: string,
  value: string,
  diagnostics: NotesLoadDiagnostic[],
): boolean {
  const result = writeResult(storage, key, value);
  if (!result.ok) diagnostics.push({ kind: "storage-write", key, error: result.error });
  return result.ok;
}

function writeResult(storage: Storage, key: string, value: string): NotesSaveResult["legacy"] {
  try {
    storage.setItem(key, value);
    return { key, ok: true };
  } catch (error) {
    return { key, ok: false, error };
  }
}
