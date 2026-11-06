// @ts-check
// scope: every file the agent added, changed or deleted must be inside the
// allowed paths (globs; "src/**", or "src" for everything under it). The
// allowed paths come from the gate's `allow`, else task.json allowedPaths.
// With neither, the gate cannot be checked: errored, never passed.
//
//   { "id": "in-scope", "type": "scope" }
//   { "id": "in-scope", "type": "scope", "allow": ["src/**", "CHANGELOG.md"] }
import { isContained, matchesAny, readEffects } from "../task.mjs";
import { errored, failed, pass, scopeOf, unknownKeys, withValue } from "./common.mjs";

/** @param {any} g */
export function validate(g) {
  const e = unknownKeys(g, ["allow"]);
  if (scopeOf(g) !== "sample")
    e.push('scope: scope gates check one agent sample at a time ("sample")');
  if (
    g.allow !== undefined &&
    !(
      Array.isArray(g.allow) &&
      g.allow.length > 0 &&
      g.allow.every((/** @type {unknown} */ p) => isContained(p))
    )
  )
    e.push("allow: expected a non-empty array of workspace-relative paths or globs");
  return e;
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const effects = await readEffects(ctx.studyDir, ctx.sample);
  if (!effects.ok) return errored(effects.error.message);
  const allow = ctx.gate.allow ?? effects.value?.allowedPaths;
  if (!Array.isArray(allow) || allow.length === 0)
    return errored("no allowed paths: set allow on the gate or allowedPaths in task.json");
  const changed = /** @type {string[]} */ (effects.value?.workspace?.changed ?? []);
  const outside = changed.filter((p) => !matchesAny(p, allow));
  if (outside.length)
    return withValue(
      failed(
        `changed ${outside.length} file(s) outside ${allow.join(", ")}: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""}`,
      ),
      outside.length,
    );
  return withValue(
    pass(
      changed.length
        ? `all ${changed.length} changed file(s) are inside ${allow.join(", ")}`
        : "no files changed",
    ),
    0,
  );
}
