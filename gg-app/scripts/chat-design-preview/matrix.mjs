import { capturePreview } from "./run.mjs";
import { layoutNames } from "./layouts.mjs";
import { writeFile } from "node:fs/promises";

const cases = [
  ...layoutNames.map((layout) => ({ layout, width: 2560, height: 1400 })),
  { layout: "six", width: 2048, height: 1120 },
  { layout: "six", width: 1280, height: 800 },
  { layout: "one", width: 1280, height: 800 },
  { layout: "one", width: 390, height: 844 },
];
const results = [];
for (const variant of ["original", "reading", "light"]) {
  for (const dimensions of cases) {
    const start = performance.now();
    try {
      const evidence = await capturePreview({ ...dimensions, variant, interactions: dimensions.layout === "six" && dimensions.width === 2560 });
      results.push({ variant, ...dimensions, status: "passed", elapsedMs: Math.round(performance.now() - start), evidence });
    } catch (error) {
      results.push({ variant, ...dimensions, status: "failed", error: String(error) });
      console.error(String(error));
    }
  }
}
const output = new URL(`../../../.gg/eyes/out/chat-workspace-preview/matrix-${Date.now()}.json`, import.meta.url);
await writeFile(output, JSON.stringify({ cases: results, limits: ["Wall time includes launch/capture, not a UI performance score", "390px tests one pane; invalid six-pane geometries are not forced", "Native IPC and assistive technology unverified"] }, null, 2));
console.log(JSON.stringify({ output: output.href, passed: results.filter((r) => r.status === "passed").length, failed: results.filter((r) => r.status === "failed").length }));
if (results.some((r) => r.status === "failed")) process.exitCode = 1;
