export const PACKAGE_COMMAND_TEMPLATE = `<!--__GG_MARKER__-->
Load the deferred \`tauri_package\` tool. Read the configured target ID from \`scripts/package-tauri.config.json\`, then call \`tauri_package\` with \`action: "package"\` and that exact target ID. Report only the tool result; do not invent commands, paths, hashes, or validation outcomes.
`;
