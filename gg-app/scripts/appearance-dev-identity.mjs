import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const appearanceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export function checkoutIdentity(root = appearanceRoot) {
  return createHash("sha256").update(resolve(root).replaceAll("\\", "/").toLowerCase()).digest("hex");
}
export function appearanceDevIdentityPlugin() {
  return {
    name: "appearance-dev-identity",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/__gg-app-dev-identity") return next();
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({ checkout: checkoutIdentity(), preview: process.env.GG_CHAT_DESIGN_PREVIEW === "1" }));
      });
    },
  };
}
