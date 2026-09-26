import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtureResponses, fixtureScript } from "./fixtures.mjs";
import { previewCheckoutIdentity } from "./server-identity.mjs";
import { createLayout, parsePreviewOptions } from "./layouts.mjs";
import { WORKSPACE_LAYOUT_VERSION } from "../../src/workspace-layout.ts";

export function previewEnabled(command, env) {
  return command === "serve" && env.GG_CHAT_DESIGN_PREVIEW === "1";
}

export function chatDesignPreviewPlugin() {
  return {
    name: "chat-design-preview",
    apply: "serve",
    configureServer(server) {
      const checkoutIdentity = previewCheckoutIdentity(server.config.root);
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1:1420");
        if (url.pathname !== "/__chat-design-preview") return next();
        if (req.method !== "GET" || !["127.0.0.1:1420", "localhost:1420"].includes(req.headers.host ?? "")) {
          res.statusCode = 403; res.end("Preview requires local GET"); return;
        }
        try {
          const options = parsePreviewOptions(url.search);
          const payload = { responses: fixtureResponses(options.state), appVersion: "0.65.1", options,
            layout: createLayout(options.layout, WORKSPACE_LAYOUT_VERSION) };
          const original = await readFile(resolve(server.config.root, "index.html"), "utf8");
          const html = original.replace('<script type="module" src="/src/main.tsx"></script>',
            `<script>${fixtureScript(payload)}</script><script type="module" src="/src/dev/chat-design-preview/controller.ts"></script><script type="module" src="/src/main.tsx"></script>`);
          if (html === original) throw new Error("App entry seam changed");
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Chat-Preview", "synthetic-only-v1");
          res.setHeader("X-Chat-Preview-Checkout", checkoutIdentity);
          res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws://127.0.0.1:1420 ws://localhost:1420; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
          res.end(await server.transformIndexHtml(url.pathname, html));
        } catch {
          res.statusCode = 400; res.end("Invalid preview request or fixture entry");
        }
      });
    },
  };
}
