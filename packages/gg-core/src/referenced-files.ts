/** Shared wire format for desktop file-reference chips and backend input policy. */
const REF_HEADING = "Referenced files:";

/** Append referenced file paths without changing prompts that have no chips. */
export function appendReferencedFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const block = `${REF_HEADING}\n${paths.map((p) => `- ${p}`).join("\n")}`;
  return text ? `${text}\n\n${block}` : block;
}

/** The existing chip parser, shared rather than duplicated at daemon admission. */
export function parseReferencedFiles(full: string): { text: string; files: string[] } {
  const idx = full.lastIndexOf(`\n\n${REF_HEADING}\n`);
  const headOnly = idx < 0 && full.startsWith(`${REF_HEADING}\n`);
  if (idx < 0 && !headOnly) return { text: full, files: [] };
  const blockStart = headOnly ? 0 : idx + 2;
  const text = headOnly ? "" : full.slice(0, idx);
  const lines = full.slice(blockStart).split("\n").slice(1);
  const files: string[] = [];
  for (const line of lines) {
    const m = /^- (.+)$/.exec(line);
    if (m && m[1]) files.push(m[1]);
    else break;
  }
  return files.length > 0 ? { text, files } : { text: full, files: [] };
}
