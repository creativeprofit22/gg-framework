import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/model-registry.ts",
    "src/paths.ts",
    "src/plan-review.ts",
    "src/project-notes.ts",
    "src/project-task-contract.ts",
    "src/project-notes-diagnostics.ts",
    "src/manual-completion-approval-protocol.ts",
    "src/phase-binding-protocol.ts",
    "src/phase-start-protocol.ts",
    "src/roadmap-workflow.ts",
    "src/slash-command-contract.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep heavy optional, dynamic-imported deps external so they are resolved at
  // runtime by the consuming app (and stay genuinely optional) rather than
  // bundled into gg-core's published tarball.
  external: ["@huggingface/transformers", "ogg-opus-decoder"],
});
