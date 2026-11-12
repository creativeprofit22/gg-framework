import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createRatingPack,
  importScores,
  keyFileFor,
  packDirFor,
  parseCsv,
} from "../../assets/bench-kit/lib/rating.mjs";

const study = {
  id: "video-engine",
  question: "Which export looks best?",
  seed: 5,
  candidates: [{ id: "engine-a" }, { id: "engine-b" }, { id: "engine-c" }],
};
const ITEMS = ["clip1", "clip2", "clip3", "clip4", "clip5", "clip6"];

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-rating-"));
  const entries = [];
  for (const item of ITEMS) {
    const outputs = {};
    for (const c of study.candidates) {
      const rel = path.join("runs", "r1", "out", `${c.id}-${item}.txt`);
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), `output ${ITEMS.indexOf(item)}`);
      outputs[c.id] = rel;
    }
    entries.push({ item, outputs });
  }
  return { dir, entries };
}

/** Every file name and text under a folder, recursively. */
async function walk(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push({ name: path.relative(root, full), text: await readFile(full, "utf8") });
  }
  return out;
}

describe("blind rating packs", () => {
  it("hides candidate identities and keeps the key outside the pack", async () => {
    const { dir, entries } = await setup();
    try {
      const r = await createRatingPack({ studyDir: dir, study, packId: "look-1", entries });
      assert.ok(r.ok, r.ok ? "" : r.error.message);
      assert.deepEqual(r.value.warnings, []);
      const files = await walk(packDirFor(dir, "look-1"));
      assert.ok(
        files.some((f) => f.name === "pack.json") &&
          files.some((f) => f.name === "scores.csv") &&
          files.some((f) => f.name === "README.md"),
      );
      for (const f of files)
        assert.ok(
          !/engine-/.test(f.name) && !/engine-/.test(f.text),
          `${f.name} leaks a candidate id`,
        );
      const key = JSON.parse(await readFile(keyFileFor(dir, "look-1"), "utf8"));
      assert.ok(
        !path.relative(packDirFor(dir, "look-1"), keyFileFor(dir, "look-1")).match(/^[^.]/),
        "key is not inside the pack folder",
      );
      assert.deepEqual(Object.keys(key.items), ITEMS);
      for (const item of ITEMS)
        assert.deepEqual(Object.values(key.items[item]).sort(), [
          "engine-a",
          "engine-b",
          "engine-c",
        ]);
      const mappings = new Set(ITEMS.map((i) => JSON.stringify(key.items[i])));
      assert.ok(mappings.size > 1, "letter order must vary between items");
      const csv = await readFile(path.join(packDirFor(dir, "look-1"), "scores.csv"), "utf8");
      assert.equal(csv.split("\n")[0], "rater,item,label,score,notes");
      assert.equal(csv.trim().split("\n").length, 1 + ITEMS.length * 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic for a seed and never overwrites a pack", async () => {
    const { dir, entries } = await setup();
    try {
      assert.ok((await createRatingPack({ studyDir: dir, study, packId: "p1", entries })).ok);
      assert.ok((await createRatingPack({ studyDir: dir, study, packId: "p2", entries })).ok);
      assert.ok(
        (await createRatingPack({ studyDir: dir, study, packId: "p3", entries, seed: 5 })).ok,
      );
      const key = async (id) => JSON.parse(await readFile(keyFileFor(dir, id), "utf8")).items;
      assert.notDeepEqual(await key("p1"), await key("p2"), "different packs get different orders");
      const again = await createRatingPack({ studyDir: dir, study, packId: "p1", entries });
      assert.equal(again.ok, false);
      assert.equal(again.error.code, "RATING_PACK_EXISTS");
      // same pack id + seed reproduces the same order in a fresh folder
      const { dir: dir2, entries: entries2 } = await setup();
      try {
        assert.ok(
          (await createRatingPack({ studyDir: dir2, study, packId: "p1", entries: entries2 })).ok,
        );
        assert.deepEqual(
          JSON.parse(await readFile(keyFileFor(dir2, "p1"), "utf8")).items,
          await key("p1"),
        );
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("validates inputs and warns when file types differ", async () => {
    const { dir, entries } = await setup();
    try {
      const outside = await createRatingPack({
        studyDir: dir,
        study,
        packId: "x",
        entries: [
          {
            item: "clip1",
            outputs: { "engine-a": "../evil.txt", "engine-b": entries[0].outputs["engine-b"] },
          },
        ],
      });
      assert.equal(outside.ok, false);
      assert.equal(outside.error.code, "RATING_OUTPUT");
      const stranger = await createRatingPack({
        studyDir: dir,
        study,
        packId: "y",
        entries: [
          {
            item: "clip1",
            outputs: { ...entries[0].outputs, "engine-z": entries[0].outputs["engine-a"] },
          },
        ],
      });
      assert.equal(stranger.ok, false);
      assert.equal(stranger.error.code, "RATING_CANDIDATE");
      const single = await createRatingPack({
        studyDir: dir,
        study,
        packId: "z",
        entries: [{ item: "clip1", outputs: { "engine-a": entries[0].outputs["engine-a"] } }],
      });
      assert.equal(single.ok, false);
      await writeFile(path.join(dir, "b.png"), "png");
      const mixed = await createRatingPack({
        studyDir: dir,
        study,
        packId: "w",
        entries: [
          {
            item: "clip1",
            outputs: { "engine-a": entries[0].outputs["engine-a"], "engine-b": "b.png" },
          },
        ],
      });
      assert.ok(mixed.ok);
      assert.match(mixed.value.warnings[0], /different file types/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("score import", () => {
  it("unblinds scores into decision-rule data, tolerating CRLF, quotes and blank rows", async () => {
    const { dir, entries } = await setup();
    try {
      assert.ok((await createRatingPack({ studyDir: dir, study, packId: "look", entries })).ok);
      const key = JSON.parse(await readFile(keyFileFor(dir, "look"), "utf8")).items;
      const labelOf = (item, cand) => Object.entries(key[item]).find(([, c]) => c === cand)[0];
      const rows = ["\uFEFFrater,item,label,score,notes"];
      for (const rater of ["ana", "bo"])
        for (const item of ["clip1", "clip2"]) {
          rows.push(`${rater},${item},${labelOf(item, "engine-a")},3,"fine, a bit soft"`);
          rows.push(`${rater},${item},${labelOf(item, "engine-b")},5,"crisp ""best"""`);
          rows.push(`${rater},${item},${labelOf(item, "engine-c")},,`);
        }
      const file = path.join(dir, "filled.csv");
      await writeFile(file, `${rows.join("\r\n")}\r\n`);
      const r = await importScores({ studyDir: dir, packId: "look", scoresFile: file });
      assert.ok(r.ok, r.ok ? "" : r.error.message);
      assert.deepEqual(r.value.raters, ["ana", "bo"]);
      assert.equal(r.value.rows, 8);
      assert.equal(r.value.skipped, 4);
      assert.deepEqual(r.value.data["engine-b"].rating, { clip1: [5, 5], clip2: [5, 5] });
      assert.deepEqual(r.value.data["engine-a"].rating.clip1, [3, 3]);
      assert.equal(r.value.data["engine-c"], undefined);
      assert.deepEqual(r.value.summary["engine-b"], { n: 4, mean: 5 });
      const saved = JSON.parse(await readFile(r.value.file, "utf8"));
      assert.equal(saved.rows, 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown labels, out-of-scale scores, duplicates and missing keys", async () => {
    const { dir, entries } = await setup();
    try {
      assert.ok((await createRatingPack({ studyDir: dir, study, packId: "look", entries })).ok);
      const file = path.join(dir, "bad.csv");
      await writeFile(
        file,
        "rater,item,label,score\nana,clip1,Z,3\nana,clip1,A,9\nana,clip2,A,2\nana,clip2,a,2\nana,nope,A,2\n",
      );
      const r = await importScores({ studyDir: dir, packId: "look", scoresFile: file });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "RATING_SCORES_INVALID");
      assert.deepEqual(r.error.details, [
        "line 2: item clip1 has no option Z",
        "line 3: score 9 is outside 1..5",
        "line 5: ana rated clip2 option A twice",
        "line 6: item nope is not in this pack",
      ]);
      await writeFile(file, "rater,item,score\nana,clip1,3\n");
      assert.equal(
        (await importScores({ studyDir: dir, packId: "look", scoresFile: file })).error.code,
        "RATING_SCORES_HEADER",
      );
      await writeFile(file, "rater,item,label,score\n,clip1,A,\n");
      assert.equal(
        (await importScores({ studyDir: dir, packId: "look", scoresFile: file })).error.code,
        "RATING_SCORES_EMPTY",
      );
      await rm(keyFileFor(dir, "look"));
      await writeFile(file, "rater,item,label,score\nana,clip1,A,3\n");
      assert.equal(
        (await importScores({ studyDir: dir, packId: "look", scoresFile: file })).error.code,
        "RATING_KEY_MISSING",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses CSV edge cases", () => {
    assert.deepEqual(parseCsv('a,"b,c","d""e"\n\n1,,3').value, [
      ["a", "b,c", 'd"e'],
      ["1", "", "3"],
    ]);
    assert.equal(parseCsv('a,"b').ok, false);
  });
});
