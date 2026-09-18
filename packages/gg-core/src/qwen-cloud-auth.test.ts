import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage, readStoredBaseUrlSync } from "./auth-storage.js";

const key = "sk-sp-fake-runtime-only";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "qwen-auth-"));
  dirs.push(dir);
  const file = path.join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      "qwen-cloud": {
        accessToken: key,
        refreshToken: "",
        expiresAt: 9999999999999,
        baseUrl: "https://forbidden.example",
      },
    }),
  );
  return { file, auth: new AuthStorage(file, env) };
}
describe("Qwen runtime auth isolation", () => {
  it("ignores plaintext records at every credential and endpoint read boundary", async () => {
    const { auth, file } = await fixture({ OPENAI_API_KEY: key, DASHSCOPE_API_KEY: key });
    expect(await auth.listProviders()).toEqual([]);
    expect(await auth.hasCredentials("qwen-cloud")).toBe(false);
    expect(await auth.hasProviderAuth("qwen-cloud")).toBe(false);
    expect(await auth.getCredentials("qwen-cloud")).toBeUndefined();
    expect(await auth.pickStorageKey(["qwen-cloud"])).toBeUndefined();
    expect(auth.getStoredBaseUrl("qwen-cloud")).toBeUndefined();
    expect(readStoredBaseUrlSync(file, "qwen-cloud")).toBeUndefined();
    await expect(
      auth.resolveCredentials("qwen-cloud", { storageKeys: ["openai"] }),
    ).rejects.toThrow("Not logged in");
  });
  it("resolves only dedicated valid runtime auth without persisting it", async () => {
    const env = { QWEN_CLOUD_TOKEN_PLAN_KEY: key };
    const { auth, file } = await fixture(env);
    await writeFile(file, "{}");
    expect(await auth.hasProviderAuth("qwen-cloud")).toBe(true);
    expect(await auth.resolveToken("qwen-cloud")).toBe(key);
    expect(
      await auth.resolveCredentials("qwen-cloud", { forceRefresh: true, storageKeys: ["openai"] }),
    ).toMatchObject({ accessToken: key });
    expect(await auth.isStaticApiKey("qwen-cloud")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("{}");
    for (const invalid of ["", "sk-payg-fake", "sk-sp-bad key", "sk-sp-bad\n"]) {
      env.QWEN_CLOUD_TOKEN_PLAN_KEY = invalid;
      expect(await auth.hasProviderAuth("qwen-cloud")).toBe(false);
      await expect(auth.resolveToken("qwen-cloud")).rejects.toThrow("Not logged in");
    }
  });
  it("rejects generic writes even when a Token Plan key is submitted as another provider", async () => {
    const { auth, file } = await fixture();
    await writeFile(file, "{}");
    for (const provider of ["qwen-cloud", "openai", "glm", "local:custom"]) {
      await expect(
        auth.setCredentials(provider, { accessToken: key, refreshToken: "", expiresAt: 0 }),
      ).rejects.toThrow("managed natively");
      expect(await readFile(file, "utf8")).toBe("{}");
    }
    await expect(
      auth.setCredentials("qwen-cloud", {
        accessToken: "ordinary",
        refreshToken: "",
        expiresAt: 0,
      }),
    ).rejects.toThrow("managed natively");
  });
});
