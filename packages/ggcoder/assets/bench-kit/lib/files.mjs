// @ts-check
// Small file helpers shared by the report, ledger and rating modules.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { err, ok } from "./result.mjs";

/**
 * Write a file atomically: temp file in the same folder, then rename. Text
 * must already use LF line endings (study files are hashed byte for byte).
 * @param {string} file
 * @param {string | Uint8Array} content
 * @returns {Promise<import("./result.mjs").Result<string>>}
 */
export async function writeAtomic(file, content) {
  if (typeof content === "string" && content.includes("\r"))
    return err("CRLF_REJECTED", `refusing to write CR characters to ${file}`);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temp, content);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    return err(
      "WRITE_FAILED",
      `cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ok(file);
}

/**
 * Read a text file; a missing file is `undefined`, not an error.
 * @param {string} file
 * @returns {Promise<import("./result.mjs").Result<string | undefined>>}
 */
export async function readOptional(file) {
  try {
    return ok(await readFile(file, "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return ok(undefined);
    return err(
      "READ_FAILED",
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read and parse a JSON file.
 * @param {string} file
 * @returns {Promise<import("./result.mjs").Result<any>>}
 */
export async function readJson(file) {
  const text = await readOptional(file);
  if (!text.ok) return text;
  if (text.value === undefined) return err("NOT_FOUND", `${file} does not exist`);
  try {
    return ok(JSON.parse(text.value));
  } catch (error) {
    return err(
      "JSON_INVALID",
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Pretty JSON with a trailing newline. @param {unknown} value */
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
