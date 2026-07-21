import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const manifest = JSON.parse(await readFile(path.join(here, "manifest.json"), "utf8"));
const zipPath = path.join(here, `laterlist-sync-${manifest.version}.zip`);
const iconSizes = [16, 48, 128];

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

async function requireIcons() {
  const missing = [];
  for (const size of iconSizes) {
    const icon = path.join(here, "icons", `${size}.png`);
    try {
      await access(icon);
    } catch {
      missing.push(`icons/${size}.png`);
    }
  }
  if (missing.length) {
    throw new Error(`Missing required extension icon${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
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

await requireIcons();
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
  ...iconSizes.map((size) => copyFile(
    path.join(here, "icons", `${size}.png`),
    path.join(dist, "icons", `${size}.png`),
  )),
]);

await rm(zipPath, { force: true });
if (devBuild) {
  console.log(`extension bundled (DEV: localhost enabled, do not ship) -> ${path.relative(process.cwd(), dist)}`);
  console.log("store zip skipped (never zip a dev build)");
} else {
  // The Web Store rejects manifests containing "key" — the store assigns the
  // published extension its own ID; key only pins the UNPACKED dev ID. Zip a
  // keyless manifest, then restore the keyed one so dist stays loadable with
  // the stable dev ID.
  const { key: _key, ...storeManifest } = distManifest;
  await writeFile(path.join(dist, "manifest.json"), JSON.stringify(storeManifest, null, 2));
  execFileSync("/usr/bin/zip", ["-qr", zipPath, "."], { cwd: dist });
  await writeFile(path.join(dist, "manifest.json"), JSON.stringify(distManifest, null, 2));
  console.log(`extension bundled -> ${path.relative(process.cwd(), dist)}`);
  console.log(`store zip -> ${path.relative(process.cwd(), zipPath)} (keyless manifest; the store assigns the public ID)`);
}
console.log(`unpacked dev extension ID -> ${extensionId(manifest.key)}`);
