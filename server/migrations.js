// Ordered, append-only migrations. Applied by migrate() below, tracked in
// schema_migrations. Works against both pg.Pool (Supabase) and PGlite (tests)
// through the same `query(sql, params)` interface.

export const MIGRATIONS = [
  {
    id: "001-initial",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        taste_profile jsonb NOT NULL DEFAULT '{}',
        plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
        stripe_customer_id text,
        stripe_subscription_id text,
        video_cap int NOT NULL DEFAULT 10000,
        free_quota int NOT NULL DEFAULT 100,
        free_used int NOT NULL DEFAULT 0,
        videos_classified int NOT NULL DEFAULT 0,
        input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS videos (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        video_id text NOT NULL,
        title text NOT NULL DEFAULT '',
        channel text NOT NULL DEFAULT '',
        duration_seconds int,
        playlist_position int,
        published_text text,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        category text CHECK (category IN ('learn','watch','music','entertainment','outdated')),
        reasoning text,
        confidence real,
        topics jsonb,
        classified_at timestamptz,
        status text NOT NULL DEFAULT 'unscanned'
          CHECK (status IN ('unscanned','scanned','done','dismissed')),
        manual_override boolean NOT NULL DEFAULT false,
        override_from text,
        override_at timestamptz,
        override_seq bigint,
        PRIMARY KEY (user_id, video_id)
      );
      CREATE SEQUENCE IF NOT EXISTS override_seq;
      CREATE INDEX IF NOT EXISTS idx_videos_user_status ON videos(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_videos_user_overrides
        ON videos(user_id, override_at DESC) WHERE manual_override;

      CREATE TABLE IF NOT EXISTS imports (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source text NOT NULL CHECK (source IN ('console','extension','file')),
        received_count int NOT NULL DEFAULT 0,
        new_count int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS classify_jobs (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'queued'
          CHECK (state IN ('queued','running','awaiting_batch','completed','failed','cancelled')),
        mode text CHECK (mode IN ('sync','batch')),
        tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro')),
        total int NOT NULL DEFAULT 0,
        processed int NOT NULL DEFAULT 0,
        failed int NOT NULL DEFAULT 0,
        anthropic_batch_id text,
        input_tokens bigint NOT NULL DEFAULT 0,
        output_tokens bigint NOT NULL DEFAULT 0,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_active ON classify_jobs(state)
        WHERE state IN ('queued','running','awaiting_batch');

      CREATE TABLE IF NOT EXISTS app_config (
        key text PRIMARY KEY,
        value jsonb NOT NULL
      );
    `,
  },
  {
    // Serverless support: chunk-failure tracking must survive across
    // invocations (no process memory), and jobs need a lease so concurrent
    // poll-driven advancers never work the same job twice.
    id: "002-serverless",
    sql: `
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS classify_attempts int NOT NULL DEFAULT 0;
      ALTER TABLE classify_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    `,
  },
  {
    id: "003-api-tokens",
    sql: `
      CREATE TABLE api_tokens (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        scope text NOT NULL CHECK (scope IN ('imports','bridge')),
        label text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );
    `,
  },
  {
    id: "004-transcripts",
    sql: `
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript text;
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript_available boolean NOT NULL DEFAULT false;
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript_source text;
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript_fetched_at timestamptz;
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS upload_date text;
      ALTER TABLE videos ADD COLUMN IF NOT EXISTS description text;

      ALTER TABLE users ADD COLUMN IF NOT EXISTS summaries_used int NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS summaries (
        user_id uuid NOT NULL,
        video_id text NOT NULL,
        summary jsonb NOT NULL,
        model text,
        input_tokens int,
        output_tokens int,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, video_id),
        FOREIGN KEY (user_id, video_id)
          REFERENCES videos (user_id, video_id) ON DELETE CASCADE
      );
    `,
  },
];

export async function migrate(q) {
  await q.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  const { rows } = await q.query("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.id));
  // Multi-statement blocks need exec() on PGlite; pg.Pool runs them via query().
  const runScript = (sql) => (typeof q.exec === "function" ? q.exec(sql) : q.query(sql));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await runScript(m.sql);
    await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
  }
}
