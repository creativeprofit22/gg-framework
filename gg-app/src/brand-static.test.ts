import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import installerHtml from "../installer/dmg.html?raw";
import viteConfigSource from "../vite.config.ts?raw";

describe("static Supah Coder branding", () => {
  it("brands the web document and installer surfaces", () => {
    expect(indexHtml).toContain("<title>Supah Coder</title>");
    expect(installerHtml).toContain("Supah Coder · the coding agent");
  });

  it("brands local fork build identity", () => {
    expect(viteConfigSource).toContain('const customBuildLabel = "Supah Coder Local Fork"');
  });
});
