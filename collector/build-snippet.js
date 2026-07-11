// Bundles snippet.js (+ collector.js) into a single self-contained IIFE at
// collector/dist/collector.js. The server serves it at GET /collector.js so
// the snippet can be hot-fixed without users reinstalling anything. The same
// collector.js module gets bundled INTO the Chrome extension at build time
// (MV3 forbids remote code, so the extension can't fetch this file).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "snippet.js")],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: false,
  legalComments: "none",
  outfile: path.join(here, "dist", "collector.js"),
});

console.log("collector snippet bundled → collector/dist/collector.js");
