import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { loadConfig } from "../server/config.js";

let db, app, config;

const asUser = (r, email = "user@test.dev") => r.set("Authorization", `Bearer dev:${email}`);
const payload = (n, opts = {}) => ({ v: 1, source: "console", videos: vids(n), ...opts });

function build(configOverrides = {}) {
  config = loadConfig({ CHUNK_SIZE: "10", BATCH_THRESHOLD: "500", FREE_VIDEO_CAP: "120", ...configOverrides });
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: ["boss@test.dev"] });
  const importer = createImporter({ db, config });
  app = createApp({ db, auth, importer, config });
}

beforeEach(async () => {
  ({ db } = await testDb());
  build();
});

describe("auth coverage", () => {
  it("every /api route except health 401s without a token", async () => {
    await request(app).get("/api/health").expect(200);
    for (const [method, path] of [
      ["get", "/api/me"], ["put", "/api/me/taste"], ["delete", "/api/me"],
      ["post", "/api/tokens"], ["get", "/api/tokens"], ["delete", "/api/tokens/1"],
      ["post", "/api/imports"], ["get", "/api/jobs/current"], ["post", "/api/jobs/1/cancel"],
      ["post", "/api/jobs/classify-remaining"], ["get", "/api/board"], ["get", "/api/status"],
      ["get", "/api/cleanup"], ["post", "/api/videos/x/category"], ["post", "/api/videos/x/dismiss"],
      ["get", "/api/videos/x"], ["post", "/api/videos/x/transcript"],
      ["post", "/api/videos/x/transcript/fetch"], ["post", "/api/videos/x/summary"],
      ["post", "/api/videos/done"], ["get", "/api/admin/stats"], ["post", "/api/admin/kill-switch"],
    ]) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("imports & plan caps", () => {
  it("free imports cap at the plan limit and everything stored classifies", async () => {
    const res = await asUser(request(app).post("/api/imports")).send(payload(150)).expect(200);
    expect(res.body.added).toBe(120); // FREE_VIDEO_CAP in this config
    expect(res.body.capped).toBe(30);
    expect(res.body.willClassify).toBe(120);
    expect(res.body.locked).toBe(0);
    expect(res.body.jobId).toBeTruthy();
  });

  it("pro users store past the free cap", async () => {
    const me = await asUser(request(app).get("/api/me"));
    await db.setPlan(me.body.id, "pro", {});
    const res = await asUser(request(app).post("/api/imports")).send(payload(150)).expect(200);
    expect(res.body.added).toBe(150);
    expect(res.body.capped).toBe(0);
    expect(res.body.willClassify).toBe(150);
  });

  it("re-import of the same payload adds nothing and starts no job", async () => {
    await asUser(request(app).post("/api/imports")).send(payload(20)).expect(200);
    const me = await asUser(request(app).get("/api/me"));
    const job = await db.getActiveJob(me.body.id);
    await db.finishJob(job.id, "completed");
    // simulate the first job having classified everything
    for (const v of vids(20)) await db.saveScanResult(me.body.id, v.id, { category: "learn", reasoning: "", confidence: 0.6, topics: [] });
    const res = await asUser(request(app).post("/api/imports")).send(payload(20)).expect(200);
    expect(res.body.added).toBe(0);
    expect(res.body.duplicates).toBe(20);
    expect(res.body.willClassify).toBe(0);
    expect(res.body.jobId).toBeNull();
  });

  it("rejects malformed payloads and junk ids", async () => {
    await asUser(request(app).post("/api/imports")).send({ source: "console" }).expect(400);
    await asUser(request(app).post("/api/imports")).send({ source: "hax", videos: vids(2) }).expect(400);
    const res = await asUser(request(app).post("/api/imports"))
      .send({ source: "console", videos: [{ id: "<script>" }, { id: "ok12345678" , title: "t"}] })
      .expect(200);
    expect(res.body.added).toBe(1);
  });

  it("409s while a job is active", async () => {
    await asUser(request(app).post("/api/imports")).send(payload(10)).expect(200);
    await asUser(request(app).post("/api/imports")).send(payload(10)).expect(409);
  });

  it("rate-limits imports per hour", async () => {
    build({ IMPORTS_PER_HOUR: "2" });
    for (let i = 0; i < 2; i++) {
      await asUser(request(app).post("/api/imports")).send(payload(1, { videos: [vids(30)[i + 20]] })).expect(200);
      const me = await asUser(request(app).get("/api/me"));
      const job = await db.getActiveJob(me.body.id);
      if (job) await db.finishJob(job.id, "completed");
    }
    await asUser(request(app).post("/api/imports")).send(payload(1)).expect(429);
  });

  it("enforces the beta allowlist (admins exempt)", async () => {
    build({ BETA_ALLOWLIST: "vip@test.dev" });
    await asUser(request(app).post("/api/imports"), "rando@test.dev").send(payload(2)).expect(403);
    await asUser(request(app).post("/api/imports"), "vip@test.dev").send(payload(2)).expect(200);
    await asUser(request(app).post("/api/imports"), "boss@test.dev").send(payload(2)).expect(200);
  });

  it("classify-remaining works for free users (the 402 paywall is gone)", async () => {
    await asUser(request(app).post("/api/imports")).send(payload(120)).expect(200);
    const me = await asUser(request(app).get("/api/me"));
    await db.finishJob((await db.getActiveJob(me.body.id)).id, "completed");
    const ok = await asUser(request(app).post("/api/jobs/classify-remaining")).expect(200);
    expect(ok.body.willClassify).toBe(120);
  });
});

describe("board & actions", () => {
  let meId;
  beforeEach(async () => {
    const me = await asUser(request(app).get("/api/me"));
    meId = me.body.id;
    await db.upsertFromImport(meId, vids(3), 10000);
    for (const v of vids(2)) await db.saveScanResult(meId, v.id, { category: "learn", reasoning: "", confidence: 0.7, topics: [] });
  });

  it("board returns five buckets; users are isolated", async () => {
    const res = await asUser(request(app).get("/api/board")).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(["entertainment", "learn", "music", "outdated", "watch"]);
    expect(res.body.learn).toHaveLength(2);
    const other = await asUser(request(app).get("/api/board"), "other@test.dev").expect(200);
    expect(other.body.learn).toHaveLength(0);
  });

  it("category override validates input and feeds cleanup flow", async () => {
    const id = vids(1)[0].id;
    await asUser(request(app).post(`/api/videos/${id}/category`)).send({ category: "bogus" }).expect(400);
    await asUser(request(app).post(`/api/videos/${id}/category`)).send({ category: "music" }).expect(200);
    await asUser(request(app).post(`/api/videos/nope123456/category`)).send({ category: "music" }).expect(404);
    await asUser(request(app).post("/api/videos/done")).send({ ids: [id] }).expect(200);
    const cleanup = await asUser(request(app).get("/api/cleanup")).expect(200);
    expect(cleanup.body.map((v) => v.id)).toContain(id);
  });

  it("user B cannot mutate user A's videos", async () => {
    const id = vids(1)[0].id;
    await asUser(request(app).post(`/api/videos/${id}/dismiss`), "b@test.dev").expect(404);
    expect((await db.getVideo(meId, id)).status).not.toBe("dismissed");
  });

  it("status reports counts and pause state", async () => {
    const res = await asUser(request(app).get("/api/status")).expect(200);
    expect(res.body.counts.scanned).toBe(2);
    expect(res.body.paused).toBe(false);
    await db.setConfig("kill_switch", { on: true, reason: "x" });
    expect((await asUser(request(app).get("/api/status"))).body.paused).toBe(true);
  });
});

describe("me & admin", () => {
  it("/api/me returns quota info; taste round-trips; delete empties", async () => {
    let me = await asUser(request(app).get("/api/me")).expect(200);
    expect(me.body.plan).toBe("free");
    expect(me.body.videoCap).toBe(120); // FREE_VIDEO_CAP in this config
    expect(me.body.summaryQuota).toBe(100);
    expect(me.body.summariesUsed).toBe(0);
    expect(me.body.freeQuota).toBeUndefined();
    expect(me.body.freeUsed).toBeUndefined();
    await asUser(request(app).put("/api/me/taste")).send({ interests: ["design"], note: "hi" }).expect(200);
    me = await asUser(request(app).get("/api/me"));
    expect(me.body.tasteProfile.interests).toEqual(["design"]);
    expect(me.body.hasTaste).toBe(true);
    await db.upsertFromImport(me.body.id, vids(4), 10000);
    await asUser(request(app).delete("/api/me")).expect(200);
    const fresh = await asUser(request(app).get("/api/me"));
    expect(fresh.body.counts.unscanned).toBe(0);
    expect(fresh.body.tasteProfile).toEqual({});
  });

  it("admins read stats and flip the kill switch; plebs cannot", async () => {
    await asUser(request(app).get("/api/admin/stats"), "user@test.dev").expect(403);
    const stats = await asUser(request(app).get("/api/admin/stats"), "boss@test.dev").expect(200);
    expect(stats.body.users.n).toBeGreaterThanOrEqual(1);
    await asUser(request(app).post("/api/admin/kill-switch"), "boss@test.dev").send({ on: true, reason: "test" }).expect(200);
    expect((await db.getConfig("kill_switch")).on).toBe(true);
  });

  it("admin plan reads as pro in /api/me", async () => {
    const me = await asUser(request(app).get("/api/me"), "boss@test.dev");
    expect(me.body.plan).toBe("pro");
    expect(me.body.isAdmin).toBe(true);
  });
});
