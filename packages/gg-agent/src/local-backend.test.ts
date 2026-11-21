import { describe, expect, it } from "vitest";
import { isLocalBackendUrl } from "./local-backend.js";

describe("isLocalBackendUrl", () => {
  it.each([
    "http://localhost:8080/v1",
    "http://127.0.0.1:11434/v1",
    "http://127.5.4.3:1234",
    "http://[::1]:8000/v1",
    "http://0.0.0.0:8080",
    "http://my-mac.local:1234/v1",
    "https://LOCALHOST:443/v1",
  ])("treats %s as local", (url) => {
    expect(isLocalBackendUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "not a url",
    "https://api.openai.com/v1",
    "https://127.0.0.1.evil.com/v1",
    "https://localhost.evil.com/v1",
    "https://128.0.0.1/v1",
    "https://999.0.0.1/v1",
  ])("treats %s as remote", (url) => {
    expect(isLocalBackendUrl(url)).toBe(false);
  });
});
