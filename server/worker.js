// The classification job engine, restructured to run in two modes:
//
//   1. Long-running (local dev, Railway): start() ticks on an interval.
//   2. Serverless (Vercel): no interval exists. Each user status poll calls
//      tick({ budgetMs }) and advances whatever work is due by a few chunks.
//
// Everything is resumable: chunk failures persist in videos.classify_attempts
// (a chunk that fails twice is skipped forever), and jobs carry a lease so
// concurrent poll-driven invocations never work the same job twice. A crashed
// invocation's lease simply expires. Budget/kill-switch checks run before
// every chunk. Lifecycle patterns descend from the original app's syncEngine.

import { buildClassificationPrompt, validateResults, RESULT_SCHEMA } from "./classify.js";
import { estimateCostUsd } from "./config.js";

export function createWorker({ db, llm, config, log = () => {}, tickMs = 2000, batchPollMs = 60000, leaseSeconds = 60 }) {
  let timer = null;
  let ticking = false;
  const lastBatchPoll = new Map();

  async function killSwitchOn() {
    const kill = await db.getConfig("kill_switch");
    return kill?.on ? kill : null;
  }

  // All classification runs on the house key, so the budget ceiling applies
  // to every tier; with subscribers, revenue >> cost keeps it theoretical.
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

  // One chunk of a sync job. Returns "done" | "continue" | "stop".
  async function processOneChunk(job) {
    const fresh = await db.getJob(job.id);
    if (!fresh || fresh.state !== "running") return "stop"; // cancelled
    if (!(await guard(fresh))) return "stop";

    const remaining = fresh.total - fresh.processed;
    if (remaining <= 0) {
      await db.finishJob(job.id, "completed");
      log(`job ${job.id} completed`);
      return "done";
    }
    const chunk = await db.getUnscanned(job.user_id, Math.min(config.chunkSize, remaining));
    if (!chunk.length) {
      await db.finishJob(job.id, "completed");
      log(`job ${job.id} completed (queue drained)`);
      return "done";
    }

    const opts = await promptOptsFor(job.user_id);
    const prompt = buildClassificationPrompt(chunk, opts);
    const ids = chunk.map((v) => v.id);
    try {
      const { data, usage } = await llm.classifyChunk(prompt, RESULT_SCHEMA);
      const results = validateResults(data, ids);
      const saved = await applyResults(job, results, usage, { batch: false });
      await db.updateJobProgress(job.id, { processed: chunk.length, failed: chunk.length - saved });
    } catch (e) {
      // Persist the failure; a chunk that fails twice is skipped forever so a
      // poison chunk can never wedge the job (attempts survive restarts).
      const newlyDead = await db.incrementAttempts(job.user_id, ids);
      if (newlyDead) {
        await db.updateJobProgress(job.id, { processed: newlyDead, failed: newlyDead });
        log(`chunk failed twice, skipping ${newlyDead} videos: ${e.message}`);
      } else {
        log(`chunk failed, will retry: ${e.message}`);
      }
    }
    await db.renewLease(job.id, leaseSeconds);
    return "continue";
  }

  // Work a leased sync job until it finishes or the deadline hits.
  async function runSyncJob(job, deadline) {
    while (Date.now() < deadline) {
      const status = await processOneChunk(job);
      if (status !== "continue") return;
    }
    await db.releaseLease(job.id); // out of budget — let the next invocation take over
  }

  async function submitBatchJob(job) {
    if (!(await guard(job))) return;
    try {
      const videos = await db.getUnscanned(job.user_id, job.total);
      if (!videos.length) {
        await db.finishJob(job.id, "completed");
        return;
      }
      const opts = await promptOptsFor(job.user_id);
      const requests = [];
      for (let i = 0; i < videos.length; i += config.chunkSize) {
        const chunk = videos.slice(i, i + config.chunkSize);
        // custom_id must match ^[a-zA-Z0-9_-]{1,64}$ — colons get the whole
        // batch rejected with a 400 before anything runs.
        requests.push(
          llm.buildBatchRequest(`job-${job.id}-chunk-${i / config.chunkSize}`, buildClassificationPrompt(chunk, opts), RESULT_SCHEMA)
        );
      }
      const batchId = await llm.submitBatch(requests);
      await db.setJobBatch(job.id, batchId);
      await db.releaseLease(job.id); // nothing to do until the batch ends
      log(`job ${job.id} submitted as batch ${batchId} (${requests.length} chunks)`);
    } catch (e) {
      // The submit call already retried transient errors (SDK maxRetries), so a
      // throw here is a real fault (bad key, permission, malformed request).
      // Fail the job with the reason instead of leaving it spinning at 0 — the
      // poll endpoint swallows the throw, so an unrecorded error is invisible.
      // Prefer the API's own message over the SDK's status-line + JSON blob;
      // this string is shown to the user.
      const detail = e?.error?.error?.message || e?.message || "unknown error";
      log(`batch submit failed for job ${job.id}: ${detail}`);
      await db.finishJob(job.id, "failed", `sorting could not start: ${detail}`.slice(0, 300));
    }
  }

  // Apply batch results until done or deadline. Fully resumable: results are
  // re-streamed on the next attempt, and chunks whose videos are no longer
  // unscanned are skipped up front. The skip matters at scale: a 2,700-video
  // job is ~110 chunks and one chunk costs ~27 DB round trips to apply, so
  // naively re-applying from entry 0 on every 8s poll bite goes quadratic and
  // stalls around chunk 5 (it also re-records token usage on each pass).
  // Returns "waiting" while Anthropic is still processing, "applied" otherwise.
  async function pollBatchJob(job, deadline) {
    const batch = await llm.getBatch(job.anthropic_batch_id);
    if (batch.processing_status !== "ended") {
      await db.releaseLease(job.id);
      return "waiting";
    }

    const seen = new Set();
    const pending = new Set(await db.unscannedIds(job.user_id));
    for await (const entry of llm.batchResults(job.anthropic_batch_id)) {
      const fresh = await db.getJob(job.id);
      if (!fresh || fresh.state !== "awaiting_batch") return; // cancelled
      if (Date.now() >= deadline) {
        await db.releaseLease(job.id); // resume on a later invocation
        log(`batch job ${job.id}: deadline mid-apply, will resume`);
        return;
      }
      if (!entry.ok) {
        log(`batch chunk ${entry.customId} errored: ${entry.error}`);
        continue;
      }
      let results;
      try {
        results = validateResults(entry.data, (entry.data?.results || []).map((r) => r.id));
      } catch (e) {
        log(`batch chunk ${entry.customId} invalid: ${e.message}`);
        continue;
      }
      for (const r of results) seen.add(r.id);
      const unapplied = results.filter((r) => pending.has(r.id));
      if (!unapplied.length) continue; // a previous attempt already applied this chunk
      await applyResults(job, unapplied, entry.usage, { batch: true });
      await db.updateJobProgress(job.id, { processed: results.length, failed: 0 });
      await db.renewLease(job.id, leaseSeconds);
    }
    const failed = Math.max(job.total - seen.size, 0);
    await db.setJobProgress(job.id, { processed: job.total, failed });
    await db.finishJob(job.id, "completed", failed ? `${failed} videos could not be classified` : null);
    log(`batch job ${job.id} completed: ${seen.size} covered, ${failed} failed`);
    return "applied";
  }

  // One unit of schedulable work. Returns true if something was advanced.
  async function advanceOnce(deadline, { force = false } = {}) {
    // 1) in-flight sync jobs whose lease is free (or expired after a crash)
    for (const job of await db.getJobsInState(["running"])) {
      if (job.mode === "batch" && job.anthropic_batch_id) continue;
      const leased = await db.leaseJob(job.id, leaseSeconds, { force });
      if (!leased) continue;
      if (job.mode === "batch") await submitBatchJob(leased);
      else await runSyncJob(leased, deadline);
      return true;
    }
    // 2) finished batches waiting for their results. A batch that is still
    // processing does NOT count as work — otherwise the tick loop would spin
    // on it until the budget ran out.
    for (const job of await db.getJobsInState(["awaiting_batch"])) {
      const last = lastBatchPoll.get(job.id) || 0;
      if (!force && Date.now() - last < batchPollMs) continue;
      const leased = await db.leaseJob(job.id, leaseSeconds, { force });
      if (!leased) continue;
      lastBatchPoll.set(job.id, Date.now());
      try {
        if ((await pollBatchJob(leased, deadline)) === "applied") return true;
      } catch (e) {
        await db.releaseLease(job.id);
        log(`batch poll failed for job ${job.id}: ${e.message}`);
        return true;
      }
    }
    // 3) fresh queued jobs
    const job = await db.claimNextJob(leaseSeconds);
    if (job) {
      if (job.mode === "batch") await submitBatchJob(job);
      else await runSyncJob(job, deadline);
      return true;
    }
    return false;
  }

  // Advance all due work within a time budget. Serverless entrypoint.
  async function tick({ budgetMs = 120000, force = false } = {}) {
    if (ticking) return;
    ticking = true;
    const deadline = Date.now() + budgetMs;
    try {
      while (Date.now() < deadline) {
        const worked = await advanceOnce(deadline, { force });
        if (!worked) break;
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    // Boot-time re-adoption for the single-process mode: force through any
    // lease a crashed run left behind. Never call with force in serverless.
    async adoptOrphans() {
      await tick({ force: true });
    },
    start() {
      this.adoptOrphans().catch((e) => log(`adopt failed: ${e.message}`));
      timer = setInterval(() => tick().catch((e) => log(`tick failed: ${e.message}`)), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
