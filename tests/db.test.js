import { describe, it, expect, beforeEach } from "vitest";
import { testDb, seedUser, vids, U1, U2 } from "./helpers.js";

let db;
beforeEach(async () => {
  ({ db } = await testDb());
  await seedUser(db, U1);
  await seedUser(db, U2, "u2@test.dev");
});

describe("users", () => {
  it("upsert is idempotent and bumps last_seen", async () => {
    const a = await db.upsertUser({ id: U1, email: "u1@test.dev" });
    expect(a.id).toBe(U1);
    const b = await db.getUser(U1);
    expect(b.plan).toBe("free");
    expect(b.free_quota).toBe(100);
  });

  it("taste profile round-trips", async () => {
    await db.setTasteProfile(U1, { interests: ["design"], note: "I make music" });
    const u = await db.getUser(U1);
    expect(u.taste_profile.interests).toEqual(["design"]);
  });

  it("plan changes via stripe identifiers", async () => {
    await db.setStripeCustomer(U1, "cus_123");
    await db.setPlan(U1, "pro", { customerId: "cus_123", subscriptionId: "sub_9" });
    const u = await db.getUserByStripeCustomer("cus_123");
    expect(u.id).toBe(U1);
    expect(u.plan).toBe("pro");
    await db.setPlan(U1, "free", { subscriptionId: null });
    expect((await db.getUser(U1)).plan).toBe("free");
  });

  it("deleteUser cascades videos, imports, jobs", async () => {
    await db.upsertFromImport(U1, vids(3), 10000);
    await db.createImport(U1, "console", 3, 3);
    await db.createJob(U1, { mode: "sync", tier: "free", total: 3 });
    await db.deleteUser(U1);
    expect(await db.getUser(U1)).toBeNull();
    expect(await db.countUnscanned(U1)).toBe(0);
    expect(await db.getLatestJob(U1)).toBeNull();
  });
});

describe("imports & videos", () => {
  it("re-importing the same payload adds nothing", async () => {
    const first = await db.upsertFromImport(U1, vids(5), 10000);
    expect(first).toEqual({ added: 5, duplicates: 0, capped: 0 });
    const second = await db.upsertFromImport(U1, vids(5), 10000);
    expect(second.added).toBe(0);
    expect(second.duplicates).toBe(5);
  });

  it("re-import updates playlist position but never classification", async () => {
    await db.upsertFromImport(U1, vids(1), 10000);
    const [v] = vids(1);
    await db.saveScanResult(U1, v.id, { category: "learn", reasoning: "r", confidence: 0.8, topics: ["design"] });
    await db.upsertFromImport(U1, [{ ...v, position: 99 }], 10000);
    const row = await db.getVideo(U1, v.id);
    expect(row.playlist_position).toBe(99);
    expect(row.category).toBe("learn");
    expect(row.status).toBe("scanned");
  });

  it("caps stored videos per user but still counts existing as duplicates", async () => {
    await db.upsertFromImport(U1, vids(4), 4);
    const r = await db.upsertFromImport(U1, vids(6), 4); // 4 dup + 2 over cap
    expect(r.capped).toBe(2);
    expect(r.duplicates).toBe(4);
    expect(r.added).toBe(0);
  });

  it("imports a full library in bulk and dedupes on re-import across chunk boundaries", async () => {
    // 2,700 crosses the 500-row chunk boundary five times — the size that timed
    // out in prod when this wrote one row per query. Counts must stay exact.
    const big = vids(2700);
    const first = await db.upsertFromImport(U1, big, 10000);
    expect(first).toEqual({ added: 2700, duplicates: 0, capped: 0 });
    expect(await db.countUnscanned(U1)).toBe(2700);
    const second = await db.upsertFromImport(U1, big, 10000);
    expect(second.added).toBe(0);
    expect(second.duplicates).toBe(2700);
    expect(await db.countUnscanned(U1)).toBe(2700);
  });

  it("users are fully isolated", async () => {
    await db.upsertFromImport(U1, vids(2), 10000);
    await db.upsertFromImport(U2, vids(2), 10000); // same video ids
    await db.saveScanResult(U1, vids(1)[0].id, { category: "music", reasoning: "", confidence: 0.9, topics: [] });
    expect((await db.getVideo(U1, vids(1)[0].id)).category).toBe("music");
    expect((await db.getVideo(U2, vids(1)[0].id)).category).toBeNull();
    expect(await db.countUnscanned(U2)).toBe(2);
  });
});

describe("classification results & overrides", () => {
  beforeEach(async () => {
    await db.upsertFromImport(U1, vids(3), 10000);
  });

  it("saveScanResult only writes unscanned rows", async () => {
    const id = vids(1)[0].id;
    expect(await db.saveScanResult(U1, id, { category: "watch", reasoning: "a", confidence: 0.7, topics: [] })).toBe(true);
    expect(await db.saveScanResult(U1, id, { category: "learn", reasoning: "b", confidence: 0.9, topics: [] })).toBe(false);
    expect((await db.getVideo(U1, id)).category).toBe("watch");
  });

  it("manual override wins forever and records override_from once", async () => {
    const id = vids(1)[0].id;
    await db.saveScanResult(U1, id, { category: "entertainment", reasoning: "", confidence: 0.6, topics: [] });
    await db.setCategory(U1, id, "learn");
    let row = await db.getVideo(U1, id);
    expect(row.override_from).toBe("entertainment");
    await db.setCategory(U1, id, "music");
    row = await db.getVideo(U1, id);
    expect(row.category).toBe("music");
    expect(row.override_from).toBe("entertainment"); // first correction preserved
    expect(await db.saveScanResult(U1, id, { category: "outdated", reasoning: "", confidence: 1, topics: [] })).toBe(false);
  });

  it("override on an unscanned row promotes it to scanned", async () => {
    const id = vids(1)[0].id;
    await db.setCategory(U1, id, "watch");
    expect((await db.getVideo(U1, id)).status).toBe("scanned");
  });

  it("recent overrides feed the taste flywheel, newest first", async () => {
    const [a, b] = vids(2);
    await db.saveScanResult(U1, a.id, { category: "watch", reasoning: "", confidence: 0.6, topics: [] });
    await db.setCategory(U1, a.id, "learn");
    await db.setCategory(U1, b.id, "music");
    const ov = await db.getRecentOverrides(U1, 8);
    expect(ov.map((o) => o.id)).toEqual([b.id, a.id]);
    expect(ov[1].override_from).toBe("watch");
  });

  it("board groups scanned by category; cleanup lists done+dismissed", async () => {
    const [a, b, c] = vids(3);
    await db.saveScanResult(U1, a.id, { category: "learn", reasoning: "", confidence: 0.7, topics: [] });
    await db.saveScanResult(U1, b.id, { category: "music", reasoning: "", confidence: 0.7, topics: [] });
    await db.saveScanResult(U1, c.id, { category: "learn", reasoning: "", confidence: 0.7, topics: [] });
    let board = await db.getBoard(U1);
    expect(board.learn.map((v) => v.id)).toEqual([a.id, c.id]);
    expect(board.music).toHaveLength(1);
    expect(await db.markDone(U1, [a.id])).toBe(1);
    await db.dismiss(U1, b.id);
    board = await db.getBoard(U1);
    expect(board.learn).toHaveLength(1);
    const cleanup = await db.getCleanup(U1);
    expect(cleanup.map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("markDone ignores unscanned rows", async () => {
    expect(await db.markDone(U1, [vids(3)[2].id])).toBe(0);
  });
});

describe("jobs", () => {
  it("full lifecycle: create → claim → progress → finish", async () => {
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 10 });
    expect(job.state).toBe("queued");
    const claimed = await db.claimNextJob();
    expect(claimed.id).toBe(job.id);
    expect(claimed.state).toBe("running");
    expect(await db.claimNextJob()).toBeNull();
    await db.updateJobProgress(job.id, { processed: 7, failed: 1 });
    await db.finishJob(job.id, "completed");
    const done = await db.getJob(job.id);
    expect(done.processed).toBe(7);
    expect(done.state).toBe("completed");
    expect(done.finished_at).toBeTruthy();
  });

  it("active job blocks; cancel only touches own active jobs", async () => {
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 5 });
    expect((await db.getActiveJob(U1)).id).toBe(job.id);
    expect(await db.cancelJob(U2, job.id)).toBe(false);
    expect(await db.cancelJob(U1, job.id)).toBe(true);
    expect(await db.getActiveJob(U1)).toBeNull();
    expect(await db.cancelJob(U1, job.id)).toBe(false);
  });

  it("batch bookkeeping and reboot re-adoption query", async () => {
    const job = await db.createJob(U1, { mode: "batch", tier: "pro", total: 600 });
    await db.claimNextJob();
    await db.setJobBatch(job.id, "msgbatch_abc");
    const waiting = await db.getJobsInState(["awaiting_batch"]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].anthropic_batch_id).toBe("msgbatch_abc");
  });
});

describe("usage & config", () => {
  it("addUsage accumulates job, user, and global counters", async () => {
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 25 });
    await db.addUsage({ userId: U1, jobId: job.id, inputTokens: 1000, outputTokens: 200, videosClassified: 25, costUsd: 0.002 });
    await db.addUsage({ userId: U1, jobId: job.id, inputTokens: 500, outputTokens: 100, videosClassified: 25, costUsd: 0.001 });
    const j = await db.getJob(job.id);
    expect(Number(j.input_tokens)).toBe(1500);
    const u = await db.getUser(U1);
    expect(Number(u.output_tokens)).toBe(300);
    expect(u.videos_classified).toBe(50);
    const g = await db.getConfig("global_usage");
    expect(Number(g.input_tokens)).toBe(1500);
    expect(Number(g.est_cost_usd)).toBeCloseTo(0.003, 6);
  });

  it("free_used increments", async () => {
    await db.incrementFreeUsed(U1, 40);
    await db.incrementFreeUsed(U1, 60);
    expect((await db.getUser(U1)).free_used).toBe(100);
  });

  it("kill switch config round-trips and adminStats aggregates", async () => {
    await db.setConfig("kill_switch", { on: true, reason: "budget" });
    expect((await db.getConfig("kill_switch")).on).toBe(true);
    await db.upsertFromImport(U1, vids(2), 10000);
    const stats = await db.adminStats();
    expect(stats.users.n).toBe(2);
    expect(stats.videos.n).toBe(2);
  });
});
