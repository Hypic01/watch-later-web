import { describe, it, expect, beforeEach } from "vitest";
import { testDb, seedUser, vids, U1 } from "./helpers.js";
import { createWorker } from "../server/worker.js";
import { createFakeLlm } from "../server/anthropic.js";
import { loadConfig } from "../server/config.js";

let db;
const config = loadConfig({ CHUNK_SIZE: "10", BATCH_THRESHOLD: "50", BUDGET_USD: "100", FREE_VIDEO_QUOTA: "100" });

function makeWorker(llm = createFakeLlm(), overrides = {}) {
  return createWorker({ db, llm, config: { ...config, ...overrides }, batchPollMs: 0 });
}

beforeEach(async () => {
  ({ db } = await testDb());
  await seedUser(db, U1);
});

describe("sync jobs", () => {
  it("classifies a whole job in chunks and completes", async () => {
    await db.upsertFromImport(U1, vids(23), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 23 });
    await makeWorker().tick();
    const done = await db.getJob(job.id);
    expect(done.state).toBe("completed");
    expect(done.processed).toBe(23);
    expect(await db.countUnscanned(U1)).toBe(0);
    const board = await db.getBoard(U1);
    const total = Object.values(board).reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(23);
    const user = await db.getUser(U1);
    expect(user.free_used).toBe(23);
    expect(Number(user.input_tokens)).toBeGreaterThan(0);
    const usage = await db.getConfig("global_usage");
    expect(Number(usage.est_cost_usd)).toBeGreaterThan(0);
  });

  it("respects job.total — the freemium boundary", async () => {
    await db.upsertFromImport(U1, vids(10), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 3 });
    await makeWorker().tick();
    expect((await db.getJob(job.id)).state).toBe("completed");
    expect(await db.countUnscanned(U1)).toBe(7);
    expect((await db.getUser(U1)).free_used).toBe(3);
  });

  it("pro tier does not consume free quota", async () => {
    await db.upsertFromImport(U1, vids(5), 10000);
    await db.createJob(U1, { mode: "sync", tier: "pro", total: 5 });
    await makeWorker().tick();
    expect((await db.getUser(U1)).free_used).toBe(0);
    expect((await db.getUser(U1)).videos_classified).toBe(5);
  });

  it("kill switch fails the job with a friendly message", async () => {
    await db.setConfig("kill_switch", { on: true, reason: "test" });
    await db.upsertFromImport(U1, vids(5), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 5 });
    await makeWorker().tick();
    const j = await db.getJob(job.id);
    expect(j.state).toBe("failed");
    expect(j.error).toMatch(/temporarily paused/);
    expect(await db.countUnscanned(U1)).toBe(5);
  });

  it("budget ceiling flips the kill switch", async () => {
    await db.setConfig("global_usage", { input_tokens: 1, output_tokens: 1, est_cost_usd: 101 });
    await db.upsertFromImport(U1, vids(5), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 5 });
    await makeWorker().tick();
    expect((await db.getJob(job.id)).state).toBe("failed");
    expect((await db.getConfig("kill_switch")).on).toBe(true);
  });

  it("a chunk that fails twice is skipped, job still completes", async () => {
    await db.upsertFromImport(U1, vids(4), 10000);
    const bad = { classifyChunk: async () => { throw new Error("boom"); } };
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 4 });
    await makeWorker(bad).tick();
    const j = await db.getJob(job.id);
    expect(j.state).toBe("completed");
    expect(j.failed).toBe(4);
    expect(await db.countUnscanned(U1)).toBe(4); // stay unscanned for a future retry
  });

  it("cancelled jobs are never picked up", async () => {
    await db.upsertFromImport(U1, vids(4), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 4 });
    await db.cancelJob(U1, job.id);
    await makeWorker().tick();
    expect((await db.getJob(job.id)).state).toBe("cancelled");
    expect(await db.countUnscanned(U1)).toBe(4);
  });

  it("feeds recent overrides into the prompt (taste flywheel)", async () => {
    await db.upsertFromImport(U1, vids(6), 10000);
    const [a] = vids(1);
    await db.setCategory(U1, a.id, "music"); // override → also scanned now
    const prompts = [];
    const fake = createFakeLlm();
    const spy = {
      classifyChunk: async (prompt, schema) => {
        prompts.push(prompt);
        return fake.classifyChunk(prompt, schema);
      },
    };
    await db.createJob(U1, { mode: "sync", tier: "free", total: 5 });
    await makeWorker(spy).tick();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("TASTE CALIBRATION");
    expect(prompts[0]).toContain("they filed it as music");
  });
});

describe("batch jobs", () => {
  it("submits, awaits, applies unordered results, completes", async () => {
    await db.upsertFromImport(U1, vids(60), 10000);
    const job = await db.createJob(U1, { mode: "batch", tier: "pro", total: 60 });
    const worker = makeWorker();
    await worker.tick(); // claims + submits
    let j = await db.getJob(job.id);
    expect(j.state).toBe("awaiting_batch");
    expect(j.anthropic_batch_id).toMatch(/^fakebatch_/);
    await worker.tick(); // polls fake batch (already ended) + applies
    j = await db.getJob(job.id);
    expect(j.state).toBe("completed");
    expect(await db.countUnscanned(U1)).toBe(0);
    expect(j.processed).toBe(60);
  });

  it("re-adopts an awaiting_batch job after a restart", async () => {
    await db.upsertFromImport(U1, vids(55), 10000);
    const job = await db.createJob(U1, { mode: "batch", tier: "pro", total: 55 });
    const llm = createFakeLlm();
    const w1 = makeWorker(llm);
    await w1.tick(); // submit, then "crash"
    const w2 = makeWorker(llm); // same llm holds the fake batch store
    await w2.tick();
    expect((await db.getJob(job.id)).state).toBe("completed");
  });

  it("re-adopts an orphaned running sync job on boot", async () => {
    await db.upsertFromImport(U1, vids(8), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 8 });
    await db.claimNextJob(); // simulate crash right after claiming
    const worker = makeWorker();
    await worker.adoptOrphans();
    expect((await db.getJob(job.id)).state).toBe("completed");
    expect(await db.countUnscanned(U1)).toBe(0);
  });
});
