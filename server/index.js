// Composition root. With DATABASE_URL + Supabase + Anthropic + Stripe env
// set, this is production. With nothing set, it boots in dev mode: embedded
// PGlite storage, DEV_FAKE_AUTH tokens, deterministic FAKE_LLM — the whole
// product runs locally with zero accounts.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./migrations.js";
import { createDb } from "./db.js";
import { createAuth, supabaseVerifier, fakeVerifier } from "./auth.js";
import { createLlm, createFakeLlm } from "./anthropic.js";
import { createImporter } from "./importer.js";
import { createWorker } from "./worker.js";
import { createBilling } from "./billing.js";
import { createApp } from "./app.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig();
const isProd = process.env.NODE_ENV === "production";

// ---- database ----
let queryable;
if (config.databaseUrl) {
  queryable = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
} else {
  if (isProd) {
    console.error("DATABASE_URL is required in production");
    process.exit(1);
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR || path.join(root, "dev-pgdata");
  queryable = new PGlite(dir);
  console.log(`[dev] embedded PGlite at ${dir} (set DATABASE_URL for real Postgres)`);
}
await migrate(queryable);
const db = createDb(queryable);

// ---- auth ----
let verify;
if (config.devFakeAuth) {
  if (isProd) {
    console.error("DEV_FAKE_AUTH must never be enabled in production");
    process.exit(1);
  }
  verify = fakeVerifier();
  console.log("[dev] fake auth enabled — sign in with any email");
} else if (config.supabaseUrl) {
  verify = supabaseVerifier({ supabaseUrl: config.supabaseUrl, jwtSecret: config.supabaseJwtSecret });
} else {
  console.error("Set SUPABASE_URL (+ optionally SUPABASE_JWT_SECRET) or DEV_FAKE_AUTH=1");
  process.exit(1);
}
const auth = createAuth({ verify, db, adminEmails: config.adminEmails });

// ---- llm ----
let llm;
if (config.anthropicApiKey && !config.fakeLlm) {
  llm = createLlm({ apiKey: config.anthropicApiKey, model: config.classifyModel });
} else {
  if (isProd && !config.fakeLlm) {
    console.error("ANTHROPIC_API_KEY is required in production");
    process.exit(1);
  }
  llm = createFakeLlm();
  console.log("[dev] FAKE_LLM — deterministic heuristic classification, zero API cost");
}

// ---- modules ----
const importer = createImporter({ db, config });
const worker = createWorker({ db, llm, config, log: (m) => console.log(`[worker] ${m}`) });
let billing = null;
if (config.stripeSecretKey && config.stripeWebhookSecret && config.stripePriceId) {
  billing = createBilling({ db, config });
} else {
  console.log("[billing] Stripe env not set — upgrade flow disabled (free tier still works)");
}

const app = createApp({
  db,
  auth,
  importer,
  worker,
  billing,
  config,
  collectorPath: path.join(root, "collector", "dist", "collector.js"),
});

// ---- static site (landing at /, app at /app) ----
const webDist = path.join(root, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(["/app", "/app/*path"], (req, res) => res.sendFile(path.join(webDist, "app", "index.html")));
} else {
  app.get("/", (req, res) => res.type("text/plain").send("watch-later-web API. Frontend not built — run: npm run build:web"));
}

app.listen(config.port, () => {
  console.log(`watch-later-web listening on http://localhost:${config.port}`);
});
worker.start();
