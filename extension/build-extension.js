import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const manifest = JSON.parse(await readFile(path.join(here, "manifest.json"), "utf8"));
const zipPath = path.join(here, `watch-later-librarian-sync-${manifest.version}.zip`);

// externally_connectable ships to real users. localhost must NEVER be in the
// store build, or any page on the user's machine could message the extension and
// hijack a sync (set its own token, exfiltrate the Watch Later). It is injected
// only for opt-in local development (build:extension -- --dev, or WLL_DEV=1), and
// a dev build never produces the store zip.
const devBuild = process.argv.includes("--dev") || process.env.WLL_DEV === "1";
const distManifest = devBuild
  ? {
      ...manifest,
      externally_connectable: {
        matches: [...manifest.externally_connectable.matches, "http://localhost/*"],
      },
    }
  : manifest;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function insideRoundRect(x, y, size, radius) {
  const px = x + 0.5;
  const py = y + 0.5;
  const cx = Math.max(radius, Math.min(size - radius, px));
  const cy = Math.max(radius, Math.min(size - radius, py));
  return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
}

function onLine(x, y, size, start, end, row, width) {
  const px = x + 0.5;
  const py = y + 0.5;
  const clampedX = Math.max(start * size, Math.min(end * size, px));
  return (px - clampedX) ** 2 + (py - row * size) ** 2 <= (width * size / 2) ** 2;
}

function iconPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const offset = row + 1 + x * 4;
      if (!insideRoundRect(x, y, size, size * 0.22)) continue;
      const white = onLine(x, y, size, 0.27, 0.73, 0.31, 0.085)
        || onLine(x, y, size, 0.27, 0.73, 0.50, 0.085)
        || onLine(x, y, size, 0.27, 0.59, 0.69, 0.085);
      raw[offset] = white ? 255 : 236;
      raw[offset + 1] = white ? 255 : 72;
      raw[offset + 2] = white ? 255 : 153;
      raw[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

function extensionId(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "icons"), { recursive: true });

const shared = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  minify: false,
  legalComments: "none",
};

await build({
  ...shared,
  entryPoints: [path.join(here, "src", "background.js")],
  format: "esm",
  outfile: path.join(dist, "background.js"),
});
for (const name of ["collector-driver.main", "relay", "popup"]) {
  await build({
    ...shared,
    entryPoints: [path.join(here, "src", `${name}.js`)],
    format: "iife",
    outfile: path.join(dist, `${name}.js`),
  });
}

await Promise.all([
  writeFile(path.join(dist, "manifest.json"), JSON.stringify(distManifest, null, 2)),
  copyFile(path.join(here, "popup.html"), path.join(dist, "popup.html")),
  ...[16, 48, 128].map((size) => writeFile(path.join(dist, "icons", `${size}.png`), iconPng(size))),
]);

await rm(zipPath, { force: true });
if (devBuild) {
  console.log(`extension bundled (DEV: localhost enabled, do not ship) -> ${path.relative(process.cwd(), dist)}`);
  console.log("store zip skipped (never zip a dev build)");
} else {
  execFileSync("/usr/bin/zip", ["-qr", zipPath, "."], { cwd: dist });
  console.log(`extension bundled -> ${path.relative(process.cwd(), dist)}`);
  console.log(`store zip -> ${path.relative(process.cwd(), zipPath)}`);
}
console.log(`extension ID -> ${extensionId(manifest.key)}`);
