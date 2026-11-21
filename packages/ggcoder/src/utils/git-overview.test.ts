import { describe, expect, it } from "vitest";
import { parseChanges, parseGitHubItems } from "./git-overview.js";

describe("parseGitHubItems", () => {
  it("keeps well-formed GitHub items", () => {
    const out = parseGitHubItems(
      JSON.stringify([
        {
          number: 12,
          title: "Drive import times out",
          url: "https://github.com/acme/studio/issues/12",
          author: { login: "sam" },
          updatedAt: "2026-10-12T09:00:00Z",
        },
        {
          number: 7,
          title: "Resumable uploads",
          url: "https://github.com/acme/studio/pull/7",
          author: null,
          updatedAt: "2026-10-13T09:00:00Z",
          isDraft: true,
        },
      ]),
    );
    expect(out).toEqual([
      {
        number: 12,
        title: "Drive import times out",
        url: "https://github.com/acme/studio/issues/12",
        author: "sam",
        updatedAt: "2026-10-12T09:00:00Z",
      },
      {
        number: 7,
        title: "Resumable uploads",
        url: "https://github.com/acme/studio/pull/7",
        author: "",
        updatedAt: "2026-10-13T09:00:00Z",
        draft: true,
      },
    ]);
  });

  it("drops anything off-shape or not a GitHub link", () => {
    const out = parseGitHubItems(
      JSON.stringify([
        { number: "12", title: "x", url: "https://github.com/a/b/issues/12", updatedAt: "" },
        { number: 3, title: "x", url: "javascript:alert(1)", updatedAt: "" },
        { number: 4, title: "x", url: "https://evil.example/a/b/issues/4", updatedAt: "" },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("returns nothing for output that isn't a JSON list", () => {
    expect(parseGitHubItems("gh: not logged in")).toEqual([]);
    expect(parseGitHubItems('{"message":"x"}')).toEqual([]);
  });
});

describe("parseChanges", () => {
  it("joins line counts with status, including untracked and binary files", () => {
    const numstat = [
      "86\t4\tsrc/drive/import.ts",
      "-\t-\tassets/logo.png",
      "2\t0\tsrc/{old => new}.ts",
    ].join("\n");
    const porcelain = [
      " M src/drive/import.ts",
      " M assets/logo.png",
      "R  src/old.ts -> src/new.ts",
      "?? src/drive/stream-file.ts",
      " D src/legacy.ts",
    ].join("\n");
    expect(parseChanges(numstat, porcelain)).toEqual([
      { path: "src/drive/import.ts", status: "M", added: 86, removed: 4 },
      { path: "assets/logo.png", status: "M", added: null, removed: null },
      { path: "src/new.ts", status: "R", added: 2, removed: 0 },
      { path: "src/drive/stream-file.ts", status: "A", added: null, removed: null },
      { path: "src/legacy.ts", status: "D", added: null, removed: null },
    ]);
  });
});
