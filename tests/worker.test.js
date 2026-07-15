import { describe, it, expect, beforeEach } from "vitest";
import { testDb, seedUser, vids, U1 } from "./helpers.js";
import { createWorker } from "../server/worker.js";
import { createFakeLlm, createLlm } from "../server/anthropic.js";
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
    // dead videos keep their unscanned status but leave the work queue
    expect((await db.counts(U1)).unscanned).toBe(4);
    expect(await db.countUnscanned(U1)).toBe(0);
  });

  it("a chunk that fails once retries and succeeds on the next pass", async () => {
    await db.upsertFromImport(U1, vids(3), 10000);
    const real = createFakeLlm();
    let calls = 0;
    const flaky = {
      classifyChunk: async (prompt, schema) => {
        if (++calls === 1) throw new Error("transient");
        return real.classifyChunk(prompt, schema);
      },
    };
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 3 });
    await makeWorker(flaky).tick();
    const j = await db.getJob(job.id);
    expect(j.state).toBe("completed");
    expect(j.failed).toBe(0);
    expect(await db.countUnscanned(U1)).toBe(0);
  });

  it("a live lease blocks other advancers; an expired one does not", async () => {
    await db.upsertFromImport(U1, vids(4), 10000);
    const job = await db.createJob(U1, { mode: "sync", tier: "free", total: 4 });
    await db.claimNextJob(60);
    expect(await db.leaseJob(job.id, 60)).toBeNull(); // held
    await db.releaseLease(job.id);
    expect((await db.leaseJob(job.id, 60))?.id).toBe(job.id); // free again
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
  it("submits, awaits while processing, applies unordered results, completes", async () => {
    await db.upsertFromImport(U1, vids(60), 10000);
    const job = await db.createJob(U1, { mode: "batch", tier: "pro", total: 60 });
    const inner = createFakeLlm();
    let ready = false;
    const slowBatch = {
      ...inner,
      classifyChunk: inner.classifyChunk.bind(inner),
      getBatch: async (id) => (ready ? inner.getBatch(id) : { id, processing_status: "in_progress" }),
    };
    const worker = makeWorker(slowBatch);
    await worker.tick(); // claims + submits; batch still processing
    let j = await db.getJob(job.id);
    expect(j.state).toBe("awaiting_batch");
    expect(j.anthropic_batch_id).toMatch(/^fakebatch_/);
    ready = true;
    await worker.tick(); // polls the now-ended batch + applies
    j = await db.getJob(job.id);
    expect(j.state).toBe("completed");
    expect(await db.countUnscanned(U1)).toBe(0);
    expect(j.processed).toBe(60);
  });

  it("a batch that cannot be submitted fails the job with the reason, not a silent spin", async () => {
    // The regression that shipped a stuck-at-0 sort: submit threw (beta-only
    // output_config on the stable endpoint), the poll swallowed it, and the job
    // spun forever. Now the reason lands on the job so the UI can show it.
    await db.upsertFromImport(U1, vids(60), 10000);
    const job = await db.createJob(U1, { mode: "batch", tier: "pro", total: 60 });
    const badBatch = { ...createFakeLlm(), submitBatch: async () => { throw new Error("invalid x-api-key"); } };
    await makeWorker(badBatch).tick();
    const j = await db.getJob(job.id);
    expect(j.state).toBe("failed");
    expect(j.error).toMatch(/could not start/);
    expect(j.error).toMatch(/invalid x-api-key/);
    expect(j.anthropic_batch_id).toBeNull();
  });

  it("the real adapter forces tool-based JSON, never the beta output_config path", () => {
    const llm = createLlm({ apiKey: "sk-ant-test", model: "claude-haiku-4-5" });
    const req = llm.buildBatchRequest("job:1:chunk:0", "prompt text", { type: "object" });
    expect(req.custom_id).toBe("job:1:chunk:0");
    expect(req.params.tool_choice).toEqual({ type: "tool", name: "emit_classification" });
    expect(req.params.tools[0].input_schema).toEqual({ type: "object" });
    expect(req.params.output_config).toBeUndefined();
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
