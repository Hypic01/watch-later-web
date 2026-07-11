// The classification job engine. One in-process worker: claims queued jobs
// (SKIP LOCKED — correct if we ever scale out), processes sync jobs in chunks
// of 25, ships big jobs to the Batches API and polls them, re-adopts orphaned
// jobs on boot. Budget/kill-switch checks run before every chunk or submit.
// Lifecycle patterns carried over from the original app's syncEngine.

import { buildClassificationPrompt, validateResults, RESULT_SCHEMA, ClassificationError } from "./classify.js";
import { estimateCostUsd } from "./config.js";

export function createWorker({ db, llm, config, log = () => {}, tickMs = 2000, batchPollMs = 60000 }) {
  let timer = null;
  let ticking = false;
  const lastBatchPoll = new Map();

  async function killSwitchOn() {
    const kill = await db.getConfig("kill_switch");
    return kill?.on ? kill : null;
  }

  // Budget guards Joon's spend. All classification runs on the house key, so
  // the ceiling applies to every tier; revenue >> cost keeps it theoretical.
  async function budgetExceeded() {
    const usage = await db.getConfig("global_usage");
    return usage && Number(usage.est_cost_usd || 0) >= config.budgetUsd;
  }

  async function guard(job) {
    const kill = await killSwitchOn();
    if (kill) {
      await db.finishJob(job.id, "failed", "classification is temporarily paused — the team has been notified");
      return false;
    }
    if (await budgetExceeded()) {
      await db.setConfig("kill_switch", { on: true, reason: "budget ceiling reached" });
      await db.finishJob(job.id, "failed", "classification is temporarily paused — the team has been notified");
      log("BUDGET CEILING REACHED — kill switch engaged");
      return false;
    }
    return true;
  }

  async function promptOptsFor(userId) {
    const user = await db.getUser(userId);
    return {
      tasteProfile: user?.taste_profile || {},
      examples: await db.getRecentOverrides(userId, 8),
    };
  }

  async function applyResults(job, results, usage, { batch }) {
    let saved = 0;
    for (const r of results) {
      if (await db.saveScanResult(job.user_id, r.id, r)) saved++;
    }
    await db.addUsage({
      userId: job.user_id,
      jobId: job.id,
      inputTokens: usage.input,
      outputTokens: usage.output,
      videosClassified: saved,
      costUsd: estimateCostUsd({ inputTokens: usage.input, outputTokens: usage.output, batch }),
    });
    if (job.tier === "free" && saved) await db.incrementFreeUsed(job.user_id, saved);
    return saved;
  }

  async function processSyncJob(job) {
    const skip = new Set();
    const attempts = new Map();
    let processed = job.processed;

    while (processed < job.total) {
      const fresh = await db.getJob(job.id);
      if (!fresh || fresh.state !== "running") return; // cancelled mid-flight
      if (!(await guard(job))) return;

      const fetchN = Math.min(config.chunkSize + skip.size, job.total - processed + skip.size);
      const candidates = await db.getUnscanned(job.user_id, fetchN);
      const chunk = candidates.filter((v) => !skip.has(v.id)).slice(0, Math.min(config.chunkSize, job.total - processed));
      if (!chunk.length) break;

      const opts = await promptOptsFor(job.user_id);
      const prompt = buildClassificationPrompt(chunk, opts);
      const ids = chunk.map((v) => v.id);
      try {
        const { data, usage } = await llm.classifyChunk(prompt, RESULT_SCHEMA);
        const results = validateResults(data, ids);
        const saved = await applyResults(job, results, usage, { batch: false });
        processed += chunk.length;
        await db.updateJobProgress(job.id, { processed: chunk.length, failed: chunk.length - saved });
      } catch (e) {
        const key = ids.join(",");
        const n = (attempts.get(key) || 0) + 1;
        attempts.set(key, n);
        if (n >= 2) {
          for (const id of ids) skip.add(id);
          processed += chunk.length;
          await db.updateJobProgress(job.id, { processed: chunk.length, failed: chunk.length });
          log(`chunk failed twice, skipping ${chunk.length} videos: ${e.message}`);
        }
      }
    }
    await db.finishJob(job.id, "completed");
    log(`job ${job.id} completed`);
  }

  async function submitBatchJob(job) {
    if (!(await guard(job))) return;
    const videos = await db.getUnscanned(job.user_id, job.total);
    if (!videos.length) {
      await db.finishJob(job.id, "completed");
      return;
    }
    const opts = await promptOptsFor(job.user_id);
    const requests = [];
    for (let i = 0; i < videos.length; i += config.chunkSize) {
      const chunk = videos.slice(i, i + config.chunkSize);
      requests.push(
        llm.buildBatchRequest(`job:${job.id}:chunk:${i / config.chunkSize}`, buildClassificationPrompt(chunk, opts), RESULT_SCHEMA)
      );
    }
    const batchId = await llm.submitBatch(requests);
    await db.setJobBatch(job.id, batchId);
    log(`job ${job.id} submitted as batch ${batchId} (${requests.length} chunks)`);
  }

  async function pollBatchJob(job) {
    const batch = await llm.getBatch(job.anthropic_batch_id);
    if (batch.processing_status !== "ended") return;

    let saved = 0;
    let received = 0;
    for await (const entry of llm.batchResults(job.anthropic_batch_id)) {
      const fresh = await db.getJob(job.id);
      if (!fresh || fresh.state !== "awaiting_batch") return; // cancelled
      if (!entry.ok) {
        log(`batch chunk ${entry.customId} errored: ${entry.error}`);
        continue;
      }
      let results;
      try {
        // Batch results validate per-entry without expected-ids (chunk
        // composition isn't persisted); the saveScanResult guard plus the
        // schema-enforced shape carry the safety.
        results = validateResults(entry.data, (entry.data?.results || []).map((r) => r.id));
      } catch (e) {
        log(`batch chunk ${entry.customId} invalid: ${e.message}`);
        continue;
      }
      received += results.length;
      saved += await applyResults(job, results, entry.usage, { batch: true });
    }
    const failed = Math.max(job.total - saved, 0);
    await db.updateJobProgress(job.id, { processed: job.total - job.processed, failed: failed - job.failed });
    await db.finishJob(job.id, "completed", failed ? `${failed} videos could not be classified` : null);
    log(`batch job ${job.id} completed: ${saved} saved, received ${received}`);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      // 1) poll awaiting batches (rate-limited per job)
      for (const job of await db.getJobsInState(["awaiting_batch"])) {
        const last = lastBatchPoll.get(job.id) || 0;
        if (Date.now() - last < batchPollMs) continue;
        lastBatchPoll.set(job.id, Date.now());
        try {
          await pollBatchJob(job);
        } catch (e) {
          log(`batch poll failed for job ${job.id}: ${e.message}`);
        }
      }
      // 2) run one claimable job to completion
      const job = await db.claimNextJob();
      if (job) {
        if (job.mode === "batch") await submitBatchJob(job);
        else await processSyncJob(job);
      }
    } finally {
      ticking = false;
    }
  }

  async function adoptOrphans() {
    // 'running' jobs left by a crash: processing is idempotent, just resume.
    for (const job of await db.getJobsInState(["running"])) {
      log(`re-adopting orphaned job ${job.id}`);
      try {
        if (job.mode === "batch" && !job.anthropic_batch_id) await submitBatchJob(job);
        else if (job.mode === "batch") await db.setJobBatch(job.id, job.anthropic_batch_id);
        else await processSyncJob(job);
      } catch (e) {
        log(`orphan ${job.id} failed: ${e.message}`);
      }
    }
  }

  return {
    tick,
    adoptOrphans,
    processSyncJob,
    submitBatchJob,
    pollBatchJob,
    start() {
      adoptOrphans().catch((e) => log(`adopt failed: ${e.message}`));
      timer = setInterval(() => tick().catch((e) => log(`tick failed: ${e.message}`)), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
