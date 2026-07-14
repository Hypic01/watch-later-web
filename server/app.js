// Route factory. Everything injected: db, auth, importer (import + freemium
// split), worker (job engine), billing (Stripe; optional until configured).
// Billing webhook mounts BEFORE express.json so Stripe signature verification
// sees the raw body.

import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { CATEGORIES } from "./db.js";
import { hashToken } from "./auth.js";

function publicApiToken(row) {
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

export function createApp({ db, auth, importer, worker, billing, config, collectorPath, randomBytes = crypto.randomBytes }) {
  const app = express();

  if (billing) {
    app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) =>
      billing.handleWebhook(req, res)
    );
  }

  const extensionOrigins = new Set(config.extensionOrigins || []);
  app.use((req, res, next) => {
    if (req.path !== "/api/imports") return next();
    res.vary("Origin");
    const origin = req.get("Origin");
    if (origin && extensionOrigins.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "content-type, x-import-token");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.get("/collector.js", (req, res) => {
    if (!collectorPath || !fs.existsSync(collectorPath)) return res.status(404).send("// collector not built");
    res.type("application/javascript").send(fs.readFileSync(collectorPath, "utf8"));
  });

  // ---- me ----
  app.get("/api/me", auth.required, async (req, res) => {
    const u = await db.getUser(req.user.id);
    const counts = await db.counts(req.user.id);
    res.json({
      id: u.id,
      email: u.email,
      plan: req.user.isAdmin ? "pro" : u.plan,
      isAdmin: req.user.isAdmin,
      tasteProfile: u.taste_profile,
      freeQuota: u.free_quota,
      freeUsed: u.free_used,
      videoCap: u.video_cap,
      counts,
      hasTaste: u.taste_profile && Object.keys(u.taste_profile).length > 0,
    });
  });

  app.put("/api/me/taste", auth.required, async (req, res) => {
    const { interests, note } = req.body || {};
    if (interests && !Array.isArray(interests)) return res.status(400).json({ error: "interests must be an array" });
    const profile = {
      interests: (interests || []).map(String).slice(0, 15),
      note: String(note || "").slice(0, 280),
    };
    await db.setTasteProfile(req.user.id, profile);
    res.json({ ok: true });
  });

  app.delete("/api/me", auth.required, async (req, res) => {
    await db.deleteUser(req.user.id);
    res.json({ ok: true });
  });

  // ---- api tokens ----
  app.post("/api/tokens", auth.required, async (req, res) => {
    const scope = String(req.body?.scope || "");
    if (!["imports", "bridge"].includes(scope)) return res.status(400).json({ error: "unknown token scope" });
    if (scope === "bridge" && !req.user.isAdmin) return res.status(403).json({ error: "admin only" });
    const label = String(req.body?.label || "").trim().slice(0, 100);
    const token = "wll_" + randomBytes(32).toString("base64url");
    const row = await db.createApiToken(req.user.id, {
      tokenHash: hashToken(token),
      scope,
      label,
    });
    res.json({ token, ...publicApiToken(row) });
  });

  app.get("/api/tokens", auth.required, async (req, res) => {
    const tokens = await db.listApiTokens(req.user.id);
    res.json(tokens.map(publicApiToken));
  });

  app.delete("/api/tokens/:id", auth.required, async (req, res) => {
    const id = req.params.id;
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      return res.status(404).json({ error: "unknown token" });
    }
    const ok = await db.revokeApiToken(req.user.id, id);
    if (!ok) return res.status(404).json({ error: "unknown token" });
    res.json({ ok: true });
  });

  // ---- imports & jobs ----
  app.post("/api/imports", auth.jwtOrToken("imports"), async (req, res) => {
    const result = await importer.handleImport(req.user, req.body);
    res.status(result.status).json(result.body);
  });

  app.post("/api/jobs/classify-remaining", auth.required, async (req, res) => {
    const result = await importer.classifyRemaining(req.user);
    res.status(result.status).json(result.body);
  });

  app.get("/api/jobs/current", auth.required, async (req, res) => {
    // Serverless mode: the user's own poll is what advances their job.
    if (worker && config.serverless && (await db.getActiveJob(req.user.id))) {
      await worker.tick({ budgetMs: config.pollAdvanceBudgetMs }).catch(() => {});
    }
    const job = (await db.getActiveJob(req.user.id)) || (await db.getLatestJob(req.user.id));
    if (!job) return res.json({ job: null });
    res.json({
      job: {
        id: job.id,
        state: job.state,
        mode: job.mode,
        tier: job.tier,
        total: job.total,
        processed: job.processed,
        failed: job.failed,
        error: job.error,
      },
    });
  });

  app.post("/api/jobs/:id/cancel", auth.required, async (req, res) => {
    const ok = await db.cancelJob(req.user.id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "no cancellable job" });
    res.json({ ok: true });
  });

  // ---- board & video actions ----
  app.get("/api/board", auth.required, async (req, res) => {
    res.json(await db.getBoard(req.user.id));
  });

  app.get("/api/status", auth.required, async (req, res) => {
    const counts = await db.counts(req.user.id);
    const job = await db.getActiveJob(req.user.id);
    const kill = await db.getConfig("kill_switch");
    res.json({
      counts,
      job: job ? { id: job.id, state: job.state, total: job.total, processed: job.processed } : null,
      paused: !!kill?.on,
    });
  });

  app.get("/api/cleanup", auth.required, async (req, res) => {
    res.json(await db.getCleanup(req.user.id));
  });

  app.post("/api/videos/:id/category", auth.required, async (req, res) => {
    const { category } = req.body || {};
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "unknown category" });
    const ok = await db.setCategory(req.user.id, req.params.id, category);
    if (!ok) return res.status(404).json({ error: "unknown video" });
    res.json({ ok: true });
  });

  app.post("/api/videos/:id/dismiss", auth.required, async (req, res) => {
    const ok = await db.dismiss(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: "unknown video" });
    res.json({ ok: true });
  });

  app.post("/api/videos/done", auth.required, async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });
    const n = await db.markDone(req.user.id, ids.map(String).slice(0, 500));
    res.json({ ok: true, marked: n });
  });

  // ---- billing (mounted when configured) ----
  if (billing) {
    app.post("/api/billing/checkout", auth.required, (req, res) => billing.createCheckout(req, res));
    app.get("/api/billing/portal", auth.required, (req, res) => billing.createPortal(req, res));
  }

  // Cron backstop (Vercel sends Authorization: Bearer CRON_SECRET): catches
  // abandoned batch jobs when nobody is polling.
  app.get("/api/cron/advance", async (req, res) => {
    if (!config.cronSecret || req.headers.authorization !== `Bearer ${config.cronSecret}`) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (worker) await worker.tick({ budgetMs: 50000 }).catch(() => {});
    res.json({ ok: true });
  });

  // ---- admin ----
  app.get("/api/admin/stats", auth.admin, async (req, res) => {
    res.json(await db.adminStats());
  });

  app.post("/api/admin/kill-switch", auth.admin, async (req, res) => {
    const { on, reason } = req.body || {};
    await db.setConfig("kill_switch", { on: !!on, reason: String(reason || "") });
    res.json({ ok: true, on: !!on });
  });

  return app;
}
