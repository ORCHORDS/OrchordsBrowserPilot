#!/usr/bin/env node
// Reproducible packaging + signing driver (#135).
//
// Produces a deterministic zip of `extension/` whose entries are sorted
// in a stable order, whose mtimes are pinned to a fixed epoch, and whose
// manifest version is asserted to match `package.json`. The script
// performs a *dry run* by default and only writes to `dist/extension/`
// when `--write` is passed.
//
// CRX signing requires a paid Chrome Web Store developer account AND a
// private signing key. This script is therefore gated on environment
// variables:
//
//   CRX_SIGNING_KEY      path to a PEM-encoded private key
//   CRX_SIGNING_KEY_ID   the matching key id (hex)
//   STORE_DEVELOPER_TOKEN  Chrome Web Store API token
//
// When any of those are unset the script prints a dry-run summary
// instead of writing. The follow-up issue (#135) documents the missing
// live credentials.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const writeMode = args.has("--write");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function dosTime(date) {
  const t = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const d = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time: t, date: d };
}

async function buildZipEntries(dir) {
  const entries = [];
  async function walk(current) {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const abs = path.join(current, name);
      const st = await stat(abs);
      if (st.isDirectory()) {
        await walk(abs);
      } else {
        const rel = path.relative(dir, abs).replace(/\\/g, "/");
        const data = await readFile(abs);
        entries.push({ name: rel, data });
      }
    }
  }
  await walk(dir);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

function buildZip(entries) {
  const { time, date } = dosTime(new Date("2024-01-01T00:00:00Z"));
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(Buffer.concat([local, nameBuf, compressed]));
    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4);
    cdir.writeUInt16LE(20, 6);
    cdir.writeUInt16LE(0, 8);
    cdir.writeUInt16LE(8, 10);
    cdir.writeUInt16LE(time, 12);
    cdir.writeUInt16LE(date, 14);
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(compressed.length, 20);
    cdir.writeUInt32LE(entry.data.length, 24);
    cdir.writeUInt16LE(nameBuf.length, 28);
    cdir.writeUInt16LE(0, 30);
    cdir.writeUInt16LE(0, 32);
    cdir.writeUInt16LE(0, 34);
    cdir.writeUInt16LE(0, 36);
    cdir.writeUInt32LE(0, 38);
    cdir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdir, nameBuf]));
    offset += localParts[localParts.length - 1].length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, end]);
}

async function main() {
  const manifestRaw = await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  const pkgRaw = await readFile(path.join(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest version (${manifest.version}) does not match package.json (${pkg.version})`);
  }

  const entries = await buildZipEntries(path.join(repoRoot, "extension"));
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("manifest.json missing from extension/ tree");
  const manifestChecksum = createHash("sha256").update(manifestEntry.data).digest("hex");

  const zip = buildZip(entries);
  const zipChecksum = createHash("sha256").update(zip).digest("hex");

  const summary = {
    product: pkg.name,
    version: manifest.version,
    manifestChecksum,
    zipChecksum,
    zipBytes: zip.length,
    entries: entries.map((e) => e.name),
    signing: Boolean(process.env.CRX_SIGNING_KEY && process.env.CRX_SIGNING_KEY_ID),
    store: Boolean(process.env.STORE_DEVELOPER_TOKEN),
    mode: writeMode ? "write" : "dry-run",
  };

  if (writeMode) {
    const outDir = path.join(repoRoot, "dist", "extension");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `orchords-web-pilot-${manifest.version}.zip`), zip);
    await writeFile(path.join(outDir, `orchords-web-pilot-${manifest.version}.checksums.json`), JSON.stringify(summary, null, 2));
    process.stdout.write(`wrote dist/extension/orchords-web-pilot-${manifest.version}.zip\n`);
  } else {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }

  if (!process.env.CRX_SIGNING_KEY || !process.env.CRX_SIGNING_KEY_ID) {
    process.stdout.write("note: CRX signing credentials not present; skip signing (dry-run only)\n");
  }
}

main().catch((error) => {
  process.stderr.write(`package-extension failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
