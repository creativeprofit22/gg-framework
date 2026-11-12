import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FORMAT_VERSION = 1;

function listingKey(packages, lockfile) {
  const hash = createHash("sha256");
  hash.update(`installed-layout-listing:${FORMAT_VERSION}\n`);
  for (const { name, root } of packages) {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    hash.update(JSON.stringify([name, root, version]) + "\n");
  }
  hash.update(createHash("sha256").update(readFileSync(lockfile)).digest("hex"));
  return hash.digest("hex");
}

function walk(root) {
  const entries = [];
  const visit = (relativePath) => {
    for (const entry of readdirSync(join(root, relativePath), { withFileTypes: true })) {
      // Production removes source maps before applying immutable inventories.
      if (entry.name.endsWith(".map")) continue;
      const path = join(relativePath, entry.name);
      const isDirectory = entry.isDirectory();
      entries.push({ path, isDirectory, isFile: entry.isFile() });
      if (isDirectory) visit(path);
    }
  };
  visit("");
  return entries;
}

function readCached(file, key) {
  try {
    const listing = JSON.parse(readFileSync(file, "utf8"));
    return listing?.key === key ? listing : undefined;
  } catch {
    return undefined;
  }
}

function writeCached(file, listing) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(listing));
    renameSync(temporary, file);
  } catch {
    // The cache is only a speed-up; a racing writer or locked file is harmless.
    rmSync(temporary, { force: true });
  }
}

// Walks installed package trees once per cache folder; the key covers each
// package's version and the lockfile bytes, so reinstalls rebuild the listing.
export function loadInstalledLayoutListing({ packages, lockfile, cacheDir }) {
  const key = listingKey(packages, lockfile);
  const file = cacheDir ? join(cacheDir, `installed-layout-${key}.json`) : undefined;
  const cached = file && readCached(file, key);
  if (cached) return cached;
  const listing = {
    key,
    packages: packages.map(({ name, root }) => ({ name, root, entries: walk(root) })),
  };
  if (file) writeCached(file, listing);
  return listing;
}
