// Long-running entrypoint (local dev, Railway). Vercel uses api/index.js.
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { buildApp, repoRoot } from "./boot.js";

const { app, worker, config } = await buildApp();

// ---- static site (landing at /, app at /app) ----
const webDist = path.join(repoRoot, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(["/app", "/app/*path"], (req, res) => res.sendFile(path.join(webDist, "app", "index.html")));
} else {
  app.get("/", (req, res) => res.type("text/plain").send("watch-later-web API. Frontend not built — run: npm run build:web"));
}

app.listen(config.port, () => {
  console.log(`watch-later-web listening on http://localhost:${config.port}`);
});
worker?.start();
