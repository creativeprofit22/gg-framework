import { open, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const archive = "C:/Users/SPARTAN PC/AppData/Local/Programs/yaatuber/resources/app.asar";
const allowed = ["package.json", "onboarding.html", "dist/renderer/styles/onboarding.css", "dist/renderer/styles/tokens.css", "dist/renderer/styles/fonts.css"];
const out = fileURLToPath(new URL("../../../.gg/reference-ui/yaatuber-chat-light/", import.meta.url));
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const handle = await open(archive, "r");
try {
  const stat = await handle.stat();
  const prefix = Buffer.alloc(16);
  await handle.read(prefix, 0, 16, 0);
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  if (headerSize > 32 * 1024 * 1024 || jsonSize > headerSize || jsonSize < 2) throw new Error("Invalid archive header bounds");
  const header = Buffer.alloc(jsonSize);
  await handle.read(header, 0, jsonSize, 16);
  const tree = JSON.parse(header.toString("utf8"));
  await mkdir(out, { recursive: true });
  const members = [];
  for (const name of allowed) {
    let entry = tree;
    for (const part of name.split("/")) entry = entry.files?.[part];
    if (!entry || entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size > 1024 * 1024) throw new Error(`Unsupported member: ${name}`);
    const start = 8 + headerSize + Number(entry.offset);
    if (!Number.isSafeInteger(start) || start < 8 + headerSize || start + entry.size > stat.size) throw new Error("Invalid member range");
    const data = Buffer.alloc(entry.size);
    const result = await handle.read(data, 0, data.length, start);
    if (result.bytesRead !== data.length) throw new Error("Truncated member");
    const output = resolve(out, name.replaceAll("/", "__"));
    await writeFile(output, data, { flag: "wx" });
    members.push({ path: name, size: data.length, sha256: hash(data), extracted: output });
  }
  const archiveHash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) archiveHash.update(chunk);
  const metadata = JSON.parse(await readFile(resolve(out, "package.json"), "utf8"));
  const source = { kind: "installed-local-archive", archive, archiveSha256: archiveHash.digest("hex"), version: metadata.version,
    provenance: { origin: "User-identified installed Yaatuber archive", inspection: "Five allowlisted members read without executing bundled code; identities recorded below" },
    license: "Redistribution rights not established. Local inspection and selected-trait adaptation authorized by user; no archive, third-party assets or application logic distributed.",
    checked: new Date().toISOString(), members, rights: "Local inspection and adaptation of selected CSS surface traits requested by user; redistribution license not established. No bundled JS executed or profile accessed. No third-party assets to be shipped." };
  await writeFile(resolve(out, "source.json"), JSON.stringify(source, null, 2), { flag: "wx" });
  console.log(JSON.stringify(source, null, 2));
} finally { await handle.close(); }
