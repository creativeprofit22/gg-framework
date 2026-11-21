// @ts-check
// Split a command string into argv without a shell, so study.json commands
// never pass through shell expansion. Supports "double" and 'single' quotes
// and backslash escapes inside double quotes only (Windows paths keep their
// backslashes everywhere else).
import { err, ok } from "./result.mjs";

/**
 * @param {string | string[]} command
 * @returns {import("./result.mjs").Result<string[]>}
 */
export function splitCommand(command) {
  if (Array.isArray(command)) {
    if (command.length === 0 || !command.every((a) => typeof a === "string"))
      return err("ARGV_INVALID", "command array must be non-empty strings");
    return ok([...command]);
  }
  if (typeof command !== "string")
    return err("ARGV_INVALID", "command must be a string or an array of strings");
  /** @type {string[]} */
  const out = [];
  let current = "";
  let started = false;
  /** @type {'"' | "'" | null} */
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = /** @type {string} */ (command[i]);
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\"))
        current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return err("ARGV_QUOTE", `unclosed ${quote} quote in command: ${command}`);
  if (started) out.push(current);
  if (out.length === 0) return err("ARGV_INVALID", "command is empty");
  return ok(out);
}

const SLOT = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Slot names used in a template (sorted, unique). @param {string[]} argv */
export function slotsIn(argv) {
  const names = new Set();
  for (const arg of argv)
    for (const m of arg.matchAll(SLOT)) names.add(/** @type {string} */ (m[1]));
  return [...names].sort();
}

/**
 * Replace `{name}` slots inside each argv element. A slot that is unknown or
 * has no value for this sample is an error, never an empty string. Slots are
 * filled after splitting, so a path with spaces stays one argument.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} values
 * @returns {import("./result.mjs").Result<string[]>}
 */
export function fillSlots(argv, values) {
  /** @type {string[]} */
  const out = [];
  for (const arg of argv) {
    /** @type {string | undefined} */
    let missing;
    const filled = arg.replace(SLOT, (match, /** @type {string} */ name) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined) {
        missing ??= name;
        return match;
      }
      return value;
    });
    if (missing !== undefined)
      return err(
        "SLOT_UNAVAILABLE",
        `slot {${missing}} has no value here (available: ${Object.keys(values)
          .filter((k) => values[k] !== undefined)
          .sort()
          .join(", ")})`,
      );
    out.push(filled);
  }
  return ok(out);
}
