// Shared composition root. index.js wraps this for the long-running mode
// (local dev, Railway); api/index.js wraps it for Vercel serverless. With no
// env set it boots a zero-account dev mode (PGlite + fake auth + fake LLM).

import path from "node:path";
import { fileURLToPath } from "node:url";
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

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildApp(env = process.env) {
  const config = loadConfig(env);
  const isProd = env.NODE_ENV === "production" || config.serverless;

  // ---- database ----
  let queryable;
  if (config.databaseUrl) {
    queryable = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.serverless ? 1 : 5,
      idleTimeoutMillis: config.serverless ? 10000 : 30000,
    });
  } else {
    if (isProd) throw new Error("DATABASE_URL is required in production");
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = env.PGLITE_DIR || path.join(repoRoot, "dev-pgdata");
    queryable = new PGlite(dir);
    console.log(`[dev] embedded PGlite at ${dir} (set DATABASE_URL for real Postgres)`);
  }
  if (!config.serverless) {
    // Serverless deploys run migrations out-of-band (npm run migrate);
    // long-running mode migrates on boot for convenience.
    await migrate(queryable);
  }
  const db = createDb(queryable);

  // ---- auth ----
  let verify;
  if (config.devFakeAuth) {
    if (isProd) throw new Error("DEV_FAKE_AUTH must never be enabled in production");
    verify = fakeVerifier();
    console.log("[dev] fake auth enabled — sign in with any email");
  } else if (config.supabaseUrl) {
    verify = supabaseVerifier({ supabaseUrl: config.supabaseUrl, jwtSecret: config.supabaseJwtSecret });
  } else {
    throw new Error("Set SUPABASE_URL (+ optionally SUPABASE_JWT_SECRET) or DEV_FAKE_AUTH=1");
  }
  const auth = createAuth({ verify, db, adminEmails: config.adminEmails });

  // ---- llm (optional: without it the app runs but imports return 503) ----
  let llm = null;
  if (config.anthropicApiKey && !config.fakeLlm) {
    llm = createLlm({ apiKey: config.anthropicApiKey, model: config.classifyModel });
  } else if (!isProd || config.fakeLlm) {
    llm = createFakeLlm();
    console.log("[dev] FAKE_LLM — deterministic heuristic classification, zero API cost");
  } else {
    console.warn("[boot] no ANTHROPIC_API_KEY — sorting disabled until it is set");
  }
  config.llmReady = !!llm;

  // ---- modules ----
  const importer = createImporter({ db, config });
  const worker = llm ? createWorker({ db, llm, config, log: (m) => console.log(`[worker] ${m}`) }) : null;
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
    collectorPath: path.join(repoRoot, "collector", "dist", "collector.js"),
  });

  return { app, db, worker, config, queryable };
}
