// Data layer. createDb takes anything with query(sql, params) → {rows}:
// pg.Pool in production (Supabase), PGlite in tests. Interface shape mirrors
// the original localhost app's db.js, with user_id threaded through every
// statement. All critical writes are single statements, so no cross-call
// transactions are needed (pool-safe).

export const CATEGORIES = ["learn", "watch", "music", "entertainment", "outdated"];

const LIST_COLUMNS =
  "video_id AS id, title, channel, duration_seconds, playlist_position, published_text, category, reasoning, confidence, topics, status, manual_override, override_from";

export function createDb(q) {
  return {
    // ---- users ----
    async upsertUser({ id, email }) {
      const { rows } = await q.query(
        `INSERT INTO users (id, email, last_seen_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), email = EXCLUDED.email
         RETURNING *`,
        [id, email]
      );
      return rows[0];
    },

    async getUser(id) {
      const { rows } = await q.query("SELECT * FROM users WHERE id = $1", [id]);
      return rows[0] || null;
    },

    async setTasteProfile(id, profile) {
      await q.query("UPDATE users SET taste_profile = $2 WHERE id = $1", [id, JSON.stringify(profile)]);
    },

    async setPlan(id, plan, { customerId, subscriptionId } = {}) {
      await q.query(
        `UPDATE users SET plan = $2,
           stripe_customer_id = COALESCE($3, stripe_customer_id),
           stripe_subscription_id = $4
         WHERE id = $1`,
        [id, plan, customerId ?? null, subscriptionId ?? null]
      );
    },

    async getUserByStripeCustomer(customerId) {
      const { rows } = await q.query("SELECT * FROM users WHERE stripe_customer_id = $1", [customerId]);
      return rows[0] || null;
    },

    async setStripeCustomer(id, customerId) {
      await q.query("UPDATE users SET stripe_customer_id = $2 WHERE id = $1", [id, customerId]);
    },

    async deleteUser(id) {
      await q.query("DELETE FROM users WHERE id = $1", [id]);
    },

    // ---- api tokens ----
    async createApiToken(userId, { tokenHash, scope, label = "" }) {
      const { rows } = await q.query(
        `INSERT INTO api_tokens (user_id, token_hash, scope, label)
         VALUES ($1, $2, $3, $4)
         RETURNING id, scope, label, created_at, last_used_at`,
        [userId, tokenHash, scope, label]
      );
      return rows[0];
    },

    async getApiTokenByHash(tokenHash) {
      const { rows } = await q.query(
        "SELECT id, user_id, scope, revoked_at FROM api_tokens WHERE token_hash = $1",
        [tokenHash]
      );
      return rows[0] || null;
    },

    async listApiTokens(userId) {
      const { rows } = await q.query(
        `SELECT id, scope, label, created_at, last_used_at FROM api_tokens
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`,
        [userId]
      );
      return rows;
    },

    async revokeApiToken(userId, id) {
      const { rows } = await q.query(
        `UPDATE api_tokens SET revoked_at = now()
         WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [userId, id]
      );
      return rows.length > 0;
    },

    async touchApiToken(id) {
      const { rows } = await q.query(
        `UPDATE api_tokens SET last_used_at = now()
         WHERE id = $1 AND revoked_at IS NULL
           AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
         RETURNING id`,
        [id]
      );
      return rows.length > 0;
    },

    // ---- videos ----
    async upsertFromImport(userId, videos, cap) {
      let added = 0;
      let capped = 0;
      const { rows: countRows } = await q.query(
        "SELECT count(*)::int AS n FROM videos WHERE user_id = $1",
        [userId]
      );
      let existing = countRows[0].n;
      for (const v of videos) {
        if (existing >= cap) {
          const { rows } = await q.query(
            "SELECT 1 FROM videos WHERE user_id = $1 AND video_id = $2",
            [userId, v.id]
          );
          if (!rows.length) {
            capped++;
            continue;
          }
        }
        const { rows } = await q.query(
          `INSERT INTO videos (user_id, video_id, title, channel, duration_seconds, playlist_position, published_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, video_id)
             DO UPDATE SET playlist_position = EXCLUDED.playlist_position
           RETURNING (xmax = 0) AS inserted`,
          [userId, v.id, v.title || "", v.channel || "", v.durationSeconds ?? null, v.position ?? null, v.publishedText ?? null]
        );
        if (rows[0]?.inserted) {
          added++;
          existing++;
        }
      }
      return { added, duplicates: videos.length - added - capped, capped };
    },

    async counts(userId) {
      const { rows } = await q.query(
        "SELECT status, count(*)::int AS n FROM videos WHERE user_id = $1 GROUP BY status",
        [userId]
      );
      const out = { unscanned: 0, scanned: 0, done: 0, dismissed: 0 };
      for (const r of rows) out[r.status] = r.n;
      return out;
    },

    async getBoard(userId) {
      const { rows } = await q.query(
        `SELECT ${LIST_COLUMNS} FROM videos
         WHERE user_id = $1 AND status = 'scanned'
         ORDER BY playlist_position NULLS LAST, first_seen_at`,
        [userId]
      );
      const board = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
      for (const r of rows) if (board[r.category]) board[r.category].push(r);
      return board;
    },

    async getCleanup(userId) {
      const { rows } = await q.query(
        `SELECT ${LIST_COLUMNS}, override_at FROM videos
         WHERE user_id = $1 AND status IN ('done','dismissed')
         ORDER BY override_seq DESC NULLS LAST, first_seen_at DESC`,
        [userId]
      );
      return rows;
    },

    async getVideo(userId, videoId) {
      const { rows } = await q.query(
        `SELECT ${LIST_COLUMNS} FROM videos WHERE user_id = $1 AND video_id = $2`,
        [userId, videoId]
      );
      return rows[0] || null;
    },

    async setCategory(userId, videoId, category) {
      const { rows } = await q.query(
        `UPDATE videos SET
           override_from = CASE WHEN manual_override THEN override_from ELSE category END,
           category = $3, manual_override = true, override_at = clock_timestamp(),
           override_seq = nextval('override_seq'),
           status = CASE WHEN status = 'unscanned' THEN 'scanned' ELSE status END
         WHERE user_id = $1 AND video_id = $2
         RETURNING video_id`,
        [userId, videoId, category]
      );
      return rows.length > 0;
    },

    async dismiss(userId, videoId) {
      const { rows } = await q.query(
        "UPDATE videos SET status = 'dismissed', override_at = clock_timestamp(), override_seq = nextval('override_seq') WHERE user_id = $1 AND video_id = $2 RETURNING video_id",
        [userId, videoId]
      );
      return rows.length > 0;
    },

    async markDone(userId, ids) {
      const { rows } = await q.query(
        `UPDATE videos SET status = 'done', override_at = clock_timestamp(), override_seq = nextval('override_seq')
         WHERE user_id = $1 AND video_id = ANY($2) AND status = 'scanned'
         RETURNING video_id`,
        [userId, ids]
      );
      return rows.length;
    },

    // Videos that failed classification twice are excluded permanently
    // (classify_attempts >= 2) so a broken chunk can never wedge a job.
    async getUnscanned(userId, limit) {
      const { rows } = await q.query(
        `SELECT video_id AS id, title, channel, duration_seconds, playlist_position, published_text
         FROM videos WHERE user_id = $1 AND status = 'unscanned' AND classify_attempts < 2
         ORDER BY classify_attempts, playlist_position NULLS LAST, first_seen_at
         LIMIT $2`,
        [userId, limit]
      );
      return rows;
    },

    async countUnscanned(userId) {
      const { rows } = await q.query(
        "SELECT count(*)::int AS n FROM videos WHERE user_id = $1 AND status = 'unscanned' AND classify_attempts < 2",
        [userId]
      );
      return rows[0].n;
    },

    // Returns how many of the incremented videos just went permanently dead.
    async incrementAttempts(userId, ids) {
      const { rows } = await q.query(
        `UPDATE videos SET classify_attempts = classify_attempts + 1
         WHERE user_id = $1 AND video_id = ANY($2) AND status = 'unscanned'
         RETURNING (classify_attempts >= 2) AS dead`,
        [userId, ids]
      );
      return rows.filter((r) => r.dead).length;
    },

    // The idempotency guard: only unscanned, never overridden rows accept
    // classification results. Re-running a job can never stomp user actions.
    async saveScanResult(userId, videoId, { category, reasoning, confidence, topics }) {
      const { rows } = await q.query(
        `UPDATE videos SET category = $3, reasoning = $4, confidence = $5, topics = $6,
           classified_at = now(), status = 'scanned'
         WHERE user_id = $1 AND video_id = $2 AND status = 'unscanned' AND NOT manual_override
         RETURNING video_id`,
        [userId, videoId, category, reasoning || "", confidence ?? null, JSON.stringify(topics || [])]
      );
      return rows.length > 0;
    },

    async getRecentOverrides(userId, n) {
      const { rows } = await q.query(
        `SELECT video_id AS id, title, channel, duration_seconds, override_from, category
         FROM videos WHERE user_id = $1 AND manual_override
         ORDER BY override_seq DESC NULLS LAST LIMIT $2`,
        [userId, n]
      );
      return rows;
    },

    // ---- imports ----
    async createImport(userId, source, receivedCount, newCount) {
      const { rows } = await q.query(
        "INSERT INTO imports (user_id, source, received_count, new_count) VALUES ($1,$2,$3,$4) RETURNING *",
        [userId, source, receivedCount, newCount]
      );
      return rows[0];
    },

    async countRecentImports(userId, windowMinutes) {
      const { rows } = await q.query(
        `SELECT count(*)::int AS n FROM imports
         WHERE user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
        [userId, String(windowMinutes)]
      );
      return rows[0].n;
    },

    // ---- jobs ----
    async createJob(userId, { mode, tier, total }) {
      const { rows } = await q.query(
        "INSERT INTO classify_jobs (user_id, mode, tier, total) VALUES ($1,$2,$3,$4) RETURNING *",
        [userId, mode, tier, total]
      );
      return rows[0];
    },

    async getJob(id) {
      const { rows } = await q.query("SELECT * FROM classify_jobs WHERE id = $1", [id]);
      return rows[0] || null;
    },

    async getActiveJob(userId) {
      const { rows } = await q.query(
        `SELECT * FROM classify_jobs
         WHERE user_id = $1 AND state IN ('queued','running','awaiting_batch')
         ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      return rows[0] || null;
    },

    async getLatestJob(userId) {
      const { rows } = await q.query(
        "SELECT * FROM classify_jobs WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
        [userId]
      );
      return rows[0] || null;
    },

    // Atomic claim — safe under concurrent workers via SKIP LOCKED. Takes a
    // lease so poll-driven serverless advancers never double-work a job.
    async claimNextJob(leaseSeconds = 60) {
      const { rows } = await q.query(
        `UPDATE classify_jobs SET state = 'running', started_at = COALESCE(started_at, now()),
           lease_until = now() + ($1 || ' seconds')::interval
         WHERE id = (
           SELECT id FROM classify_jobs WHERE state = 'queued'
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [String(leaseSeconds)]
      );
      return rows[0] || null;
    },

    // Re-acquire the right to work an in-flight job. Succeeds only when the
    // previous lease expired (crashed invocation) or was never taken. force
    // is for single-instance boot adoption only.
    async leaseJob(id, leaseSeconds = 60, { force = false } = {}) {
      const { rows } = await q.query(
        `UPDATE classify_jobs SET lease_until = now() + ($2 || ' seconds')::interval
         WHERE id = $1 AND state IN ('running','awaiting_batch')
           AND ($3 OR lease_until IS NULL OR lease_until < now())
         RETURNING *`,
        [id, String(leaseSeconds), force]
      );
      return rows[0] || null;
    },

    async renewLease(id, leaseSeconds = 60) {
      await q.query(
        `UPDATE classify_jobs SET lease_until = now() + ($2 || ' seconds')::interval WHERE id = $1`,
        [id, String(leaseSeconds)]
      );
    },

    async releaseLease(id) {
      await q.query("UPDATE classify_jobs SET lease_until = NULL WHERE id = $1", [id]);
    },

    async getJobsInState(states) {
      const { rows } = await q.query(
        "SELECT * FROM classify_jobs WHERE state = ANY($1) ORDER BY id",
        [states]
      );
      return rows;
    },

    async updateJobProgress(id, { processed, failed }) {
      await q.query(
        "UPDATE classify_jobs SET processed = processed + $2, failed = failed + $3 WHERE id = $1",
        [id, processed || 0, failed || 0]
      );
    },

    async setJobProgress(id, { processed, failed }) {
      await q.query(
        "UPDATE classify_jobs SET processed = $2, failed = $3 WHERE id = $1",
        [id, processed, failed]
      );
    },

    async setJobBatch(id, batchId) {
      await q.query(
        "UPDATE classify_jobs SET state = 'awaiting_batch', anthropic_batch_id = $2 WHERE id = $1",
        [id, batchId]
      );
    },

    async finishJob(id, state, error) {
      await q.query(
        "UPDATE classify_jobs SET state = $2, error = $3, finished_at = now() WHERE id = $1",
        [id, state, error || null]
      );
    },

    async cancelJob(userId, id) {
      const { rows } = await q.query(
        `UPDATE classify_jobs SET state = 'cancelled', finished_at = now()
         WHERE id = $1 AND user_id = $2 AND state IN ('queued','running','awaiting_batch')
         RETURNING id`,
        [id, userId]
      );
      return rows.length > 0;
    },

    // ---- usage accounting ----
    async addUsage({ userId, jobId, inputTokens, outputTokens, videosClassified, costUsd }) {
      await q.query(
        "UPDATE classify_jobs SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3 WHERE id = $1",
        [jobId, inputTokens, outputTokens]
      );
      await q.query(
        `UPDATE users SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3,
           videos_classified = videos_classified + $4
         WHERE id = $1`,
        [userId, inputTokens, outputTokens, videosClassified]
      );
      await q.query(
        `INSERT INTO app_config (key, value) VALUES ('global_usage',
           jsonb_build_object('input_tokens', $1::bigint, 'output_tokens', $2::bigint, 'est_cost_usd', $3::numeric))
         ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object(
           'input_tokens',  (app_config.value->>'input_tokens')::bigint  + $1::bigint,
           'output_tokens', (app_config.value->>'output_tokens')::bigint + $2::bigint,
           'est_cost_usd',  round(((app_config.value->>'est_cost_usd')::numeric + $3::numeric)::numeric, 6))`,
        [inputTokens, outputTokens, costUsd]
      );
    },

    async incrementFreeUsed(userId, n) {
      await q.query("UPDATE users SET free_used = free_used + $2 WHERE id = $1", [userId, n]);
    },

    // ---- config ----
    async getConfig(key) {
      const { rows } = await q.query("SELECT value FROM app_config WHERE key = $1", [key]);
      return rows[0]?.value ?? null;
    },

    async setConfig(key, value) {
      await q.query(
        "INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [key, JSON.stringify(value)]
      );
    },

    // ---- admin ----
    async adminStats() {
      const [users, videos, jobs, usage] = await Promise.all([
        q.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE plan = 'pro')::int AS pro FROM users"),
        q.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'scanned')::int AS scanned FROM videos"),
        q.query("SELECT state, count(*)::int AS n FROM classify_jobs GROUP BY state"),
        q.query("SELECT value FROM app_config WHERE key = 'global_usage'"),
      ]);
      return {
        users: users.rows[0],
        videos: videos.rows[0],
        jobs: Object.fromEntries(jobs.rows.map((r) => [r.state, r.n])),
        usage: usage.rows[0]?.value ?? { input_tokens: 0, output_tokens: 0, est_cost_usd: 0 },
      };
    },
  };
}
