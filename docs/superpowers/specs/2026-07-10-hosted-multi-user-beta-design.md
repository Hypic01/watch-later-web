# Watch Later Librarian → Hosted Multi-User Free Beta

## Context

Joon's Watch Later Librarian (localhost, `~/Projects/watch-later-librarian`) solved his own 2,700-video Watch Later backlog. He wants to extend it so other people can use it, with future monetization potential. During brainstorming we locked these decisions:

- **Promise**: "Connect your own YouTube Watch Later → AI sorts your backlog → you clean it up." Triage only.
- **Ambition**: freemium beta for 10–50 strangers.
- **Cost model — freemium + subscription** (Joon's call, 2026-07-10): each user's first **100 videos** are classified free (`FREE_VIDEO_QUOTA` env, default 100, per-user overridable). Beyond that, users **pay a subscription** to unlock classification up to **10,000 videos** — all classification runs on Joon's Anthropic key; subscribers pay Joon, Joon pays Anthropic. Exact pricing deliberately deferred: the mechanism ships now (Stripe), the price is a Stripe-dashboard knob set at launch (working default **$5/mo Pro**, Joon decides). A maxed 10,000-video subscriber costs ≈ $1.90 in AI (batch), so margin is comfortable at any sane price.
- **Cut from beta** (become future Pro features): Obsidian ingest, Learn/mentor, TL;DR summaries.
- **Acquisition = browser-side** (YouTube's official API cannot read Watch Later — removed 2016): week 1 a guided console-snippet importer; a Chrome MV3 extension right after; extension bulk-remove from the real WL is a later phase.
- **Classification**: metadata-only (title/channel/duration/age/position), claude-haiku-4-5, Batches API for big jobs.
- The local app stays Joon's daily driver, untouched. The hosted product is a **new repo**.

Key codebase facts (verified): everything is factory/DI (`createApp`, `createDb`, `createClassifier`…), so the seams are clean. `server/claude.js` is the only LLM abstraction; `server/ytdlp.js` is the only acquisition path; five categories `['ingest','watch','music','entertainment','outdated']`; manual-override "taste flywheel" (`getRecentOverrides(8)` as few-shots); SSE is a single global emitter; tests are vitest+supertest with DI fakes.

## Architecture (settled)

- **New repo `~/Projects/watch-later-web`**. Copy/adapt reusable pieces; local app untouched.
- **One long-running Node/Express service** on Railway (~$5/mo) serving API + built SPA. Not serverless (background classify worker needs a persistent process).
- **Supabase**: Google sign-in via Supabase Auth (frontend `supabase-js`; Express verifies JWT via `jose` + JWKS, HS256 legacy fallback; JIT user upsert) + free-tier Postgres (plain `pg`, hand-written SQL mirroring current style, `node-pg-migrate`).
- **Progress via polling** (`GET /api/jobs/current` every 3s), not SSE — EventSource can't send auth headers, progress is 3 integers, load is trivial. Drop `useEvents.js`.
- **Structured outputs** (`output_config.format` json_schema, supported on Haiku 4.5) replace the parse-and-retry path; slim validator remains (id-match, confidence clamp).
- **Categories renamed internally**: `['learn','watch','music','entertainment','outdated']`, precedence `music > outdated > watch > learn`. No legacy data, so no relabel-in-UI hack.
- **Collector is a build-time shared module**: bundled into the extension (MV3 forbids remote code), served fresh at `GET /collector.js` for the console snippet (hot-fixable server-side).
- **Billing via Stripe Checkout + Customer Portal + webhooks** — the minimal-surface path: `POST /api/billing/checkout` creates a hosted Checkout session (no card data ever touches our server), `/api/billing/webhook` (Stripe-signature verified, raw body parsed BEFORE express.json) flips `users.plan` on `checkout.session.completed` / `customer.subscription.updated` / `.deleted`, `GET /api/billing/portal` links to Stripe's hosted manage/cancel page. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`. Downgrade semantics: already-classified videos stay visible forever; only *future* classification re-locks.
- **Plan gating**: free = first `free_quota` (100) videos classified; pro = up to 10,000. Imports store up to 10,000 rows regardless of plan (storage is cheap; the locked remainder is the upsell). **Comp accounts**: emails in `ADMIN_EMAILS` (and any user whose `plan` is set manually) are treated as Pro with no Stripe subscription — Joon and invited friendlies never pay. Joon's personal daily driver remains the untouched local app on his Max subscription; the public service uses the API because consumer subscriptions cannot power a multi-user product. `BUDGET_USD` kill switch still guards total Anthropic spend (generous $100 + 50%/80% alert emails — it pauses new jobs with a friendly "temporarily paused, we've been notified" and must never fire under normal load since revenue >> AI cost).
- Name stays **Watch Later Librarian** for beta. Landing at `/`, app at `/app` (Vite multi-page).

## Phases

### Phase 0 — Collector spike (1–2 days) ← FIRST, go/no-go gate
1. On `youtube.com/playlist?list=WL`, confirm `ytInitialData` holds the first ~100 `playlistVideoRenderer` items + continuation token.
2. Prototype **InnerTube continuation loop** (primary): read `window.ytcfg` key+context, POST `/youtubei/v1/browse` same-origin with ~250ms delays until done. Avoids DOM virtualization; it's what YouTube's own frontend uses.
3. Prototype **DOM auto-scroll fallback** (plan B, same snippet).
4. **Ground truth**: diff collected IDs against Joon's `library.db` (`SELECT id FROM videos`, ~2,700 rows). Target >99% overlap; record field coverage.
5. Save 2–3 anonymized fixtures for unit tests. Document Chrome's `allow pasting` DevTools friction as UI copy.
6. Deliverable: `collector/collector.js` — pure `parseInitialData`, `parseBrowseResponse`, `collectAll({fetchImpl,doc})`, `normalize` → `{id,title,channel,durationSeconds,position,publishedText}`; console IIFE copies JSON to clipboard + file-download fallback for huge lists.

If both paths are flaky (unexpected): pause and revisit acquisition with Joon before building anything else.

### Phase 1 — Skeleton: repo, DB, auth, deploy (2–3 days)
1. Scaffold `~/Projects/watch-later-web` (layout below), Express+Vite+vitest wiring.
2. Supabase project: Google provider (GCP OAuth client), grab URL/anon key/JWKS.
3. `server/db.js`: `createDb(pool)`, same interface shape as current (`upsertFromImport`, `getBoard`, `setCategory`, `getRecentOverrides`, `counts`…) but per-user. DDL below via `node-pg-migrate`.
4. `server/auth.js`: JWT middleware + JIT provisioning, injected as `createAuth({verify})` for testable fakes.
5. `/api/health` + static serving; **deploy to Railway in week one** so hosting surprises surface early.

### Phase 2 — Import + classification pipeline (3–5 days)
1. `POST /api/imports`: sanitize (title ≤300 ch, channel ≤120, ≤10,000 videos/user stored), upsert `ON CONFLICT (user_id,video_id)` updating position only (never classification columns), enqueue `classify_jobs` row for the free-quota slice (remainder stays locked).
2. `server/classify.js` (adapt from existing): generic persona template + `taste_profile` (interests + free-text note) + per-user override few-shots; metadata-only video blocks; `learn` rules text; keep music/outdated/entertainment rules and game-guide carve-out verbatim; add "metadata-only, 0.6–0.7 confidence is normal" rubric line. Topics: keep 15-list, swap `dj-production`/`korean-life` → `music-production`/`diy-home`; quiz uses the same vocabulary.
3. `server/anthropic.js` (replaces `claude.js`): `classifyChunk(videos, opts)` via `messages.create` with json_schema output; returns `{results, usage}`.
4. `server/worker.js` (lifecycle patterns from `syncEngine.js`): in-process loop, claims jobs `FOR UPDATE SKIP LOCKED`, chunks of 25, per-chunk persistence + counters, checks kill switch / cap / cancel before every chunk. Classification write keeps the exact idempotency guard: `WHERE status='unscanned' AND NOT manual_override`.
5. `server/budget.js`: token accounting (job + user + global rows, transactional), `BUDGET_USD` kill switch on house-key spend (default $25 — exposure is tiny under freemium), import rate limit 5/hr/user, one active job per user.
6. Freemium split: an import auto-classifies `min(remaining free quota, unscanned)`; the rest stays `unscanned`/locked behind the paywall. `POST /api/jobs/classify-remaining` gated by `plan='pro'` (402 with upgrade info otherwise), classifies up to the 10,000 cap.

### Phase 3 — Batches path + billing + admin (3–4 days)
0. Stripe integration (`server/billing.js`): one Product/Price ("Pro", default $5/mo, changeable in dashboard), checkout-session endpoint, webhook endpoint (signature verify, raw-body route mounted before json middleware, idempotent event handling), portal link, plan-gating helper. Local testing via `stripe` CLI webhook forwarding.
1. Jobs >500 videos → `mode='batch'`: one Anthropic batch, requests = chunks of 25, `custom_id="job:{id}:chunk:{n}"`, persist `anthropic_batch_id`, state `awaiting_batch`.
2. Worker polls `batches.retrieve` every 60s; on `ended` streams results (unordered, keyed by custom_id), applies via same save path, sums usage at batch pricing. On boot, re-adopt `running` (re-queue unscanned remainder — idempotent) and `awaiting_batch` (resume polling). Results retained 29 days → crashed ingest replayable.
3. Admin: `GET /api/admin/stats`, `POST /api/admin/kill-switch`, gated by `ADMIN_EMAILS` check on verified JWT.

### Phase 4 — Frontend port (4–6 days)
1. `supabase.js` + sign-in screen; `api.js` adds Bearer header, refresh-on-401.
2. Onboarding quiz (one skippable screen → `PUT /api/me/taste`).
3. ImportPanel: snippet shown as actual code with copy button (not a remote-loader — honest + works even if our server is down), paste textarea + file upload, `allow pasting` instructions with screenshots.
4. Board: COPY `Row.jsx`, `CategoryView.jsx`, `icons.jsx`, `lib.js`, `styles.css` nearly verbatim; ADAPT `VideoCard.jsx` (drop learn/tl;dr/ingest_error, add "mark done") and `App.jsx` (drop ingest/learn/summary/SSE band; add auth/onboarding/import/JobProgress polling).
5. CleanupChecklist (adapt `History.jsx`): done+dismissed = "safe to remove from your real Watch Later", YouTube links, "bulk-remove extension coming soon".
6. Freemium UI: locked band under the board ("2,650 more videos waiting — upgrade to Pro to sort them all") → Stripe Checkout; Settings shows plan status + "Manage subscription" (Stripe portal); landing gets a simple pricing section ("Free: your first 100 videos · Pro: up to 10,000"). Post-checkout success page polls `/api/me` until the webhook lands, then offers "Sort the rest" one-click.

### Phase 5 — Landing, legal, dogfood, launch (3–4 days)
1. Landing page: pitch, 20-sec import→sorted-board GIF, "free beta, ~50 spots", Sign in with Google.
2. Privacy page (what's stored / what's never touched / delete-everything) + short Terms page (subscription, refunds, cancellation), `DELETE /api/me` cascade + Settings button, feedback link (mailto + form), Sentry free tier + uptime ping, budget alert emails at 50%/80%, `BETA_ALLOWLIST` env for first cohort. Set the real Pro price in Stripe; keep Stripe in TEST mode until the pricing decision is final — the free tier works for strangers either way.
3. Dogfood: Joon imports his real 2,700 videos on production (batch path test + the demo GIF source). Then 3–5 friendlies → fix → recruit (r/SideProject, r/productivity, r/youtube, r/DataHoarder, Show HN later, LinkedIn/X post).

### Phase 6 — Chrome MV3 extension (post-launch, ~1 week)
- `manifest.json`: MV3, `host_permissions: ["https://www.youtube.com/*"]`, `activeTab`, popup. Content script bundles collector; fetches WL page HTML with `credentials:'include'`, regex-extracts `ytInitialData`/`ytcfg`, runs same continuation loop.
- Auth: revocable **import token** (`wll_…`, hashed server-side, imports-only scope) generated in Settings — no Supabase session smuggling. `POST /api/imports` with `X-Import-Token`; CORS for `chrome-extension://<id>`.
- Store: single-purpose listing, privacy URL, bundled code only. Bulk-remove ships as a separate later reviewed update.

## New repo layout (copy/adapt/fresh)

```
watch-later-web/
├── server/  index.js(fresh root) app.js(adapt) auth.js(fresh) db.js(fresh, interface from old db.js)
│            classify.js(adapt) anthropic.js(fresh, replaces claude.js) worker.js(fresh, patterns from syncEngine.js)
│            budget.js(fresh) billing.js(fresh, Stripe) migrations/
├── collector/ collector.js(fresh, Phase 0) build-snippet.js(esbuild IIFE → GET /collector.js)
├── extension/ (Phase 6)
├── web/ vite.config.js(adapt, multi-page) index.html(landing) app/index.html
│    src/ App.jsx(adapt) api.js(adapt) supabase.js(fresh) lib.js(copy−lesson fns) styles.css(copy−learn)
│    components/ icons.jsx,Row.jsx(copy) VideoCard.jsx,CategoryView.jsx(adapt)
│                CleanupChecklist.jsx(adapt from History.jsx) Onboarding.jsx,ImportPanel.jsx,JobProgress.jsx(fresh)
└── tests/ (patterns from existing tests/)
```
CUT: ingestQueue.js, mentor.js, ytdlp.js, LearnView.jsx, beats.jsx, VideoDetail.jsx, useEvents.js, scripts/*, their tests.

## Data model (DDL sketch)

- **users**: `id uuid PK` (= Supabase sub), `email`, `taste_profile jsonb`, `plan text CHECK ('free','pro') default 'free'`, `stripe_customer_id`, `stripe_subscription_id`, `video_cap int default 10000`, `free_quota int default 100`, `free_used int default 0`, `videos_classified`, `input_tokens`, `output_tokens`, timestamps.
- **videos**: `PK (user_id, video_id)`; metadata (`title, channel, duration_seconds, playlist_position, published_text, first_seen_at`); classification (`category CHECK in 5, reasoning, confidence, topics jsonb, classified_at`); `status CHECK ('unscanned','scanned','done','dismissed')`; override cols (`manual_override, override_from, override_at`). Indexes: `(user_id,status)`, partial `(user_id, override_at DESC) WHERE manual_override`.
- **imports**: id, user_id, `source CHECK ('console','extension','file')`, received/new counts, created_at.
- **classify_jobs**: id, user_id, `state CHECK ('queued','running','awaiting_batch','completed','failed','cancelled')`, `mode ('sync','batch')`, `tier CHECK ('free','pro')`, total/processed/failed, `anthropic_batch_id`, token counters, error, timestamps. Partial index on active states.
- **app_config**: key/value jsonb (kill_switch, global_usage).

## API surface

| Route | Method | Auth |
|---|---|---|
| `/api/health`, `/collector.js` | GET | none |
| `/api/me` | GET/DELETE | JWT |
| `/api/me/taste` | PUT | JWT |
| `/api/imports` | POST | JWT (later: import token) |
| `/api/billing/checkout`, `/api/billing/portal` | POST/GET | JWT |
| `/api/billing/webhook` | POST | Stripe signature (no JWT) |
| `/api/jobs/classify-remaining` | POST | JWT + plan='pro' |
| `/api/jobs/current`, `/api/jobs/:id/cancel` | GET/POST | JWT |
| `/api/board`, `/api/status`, `/api/cleanup` | GET | JWT |
| `/api/videos/:id/category`, `/api/videos/:id/dismiss`, `/api/videos/done` | POST | JWT |
| `/api/admin/stats`, `/api/admin/kill-switch` | GET/POST | JWT + ADMIN_EMAILS |

Every query scoped `user_id = $1`. Same-origin only until the extension phase.

## Cost & margin (verified pricing: Haiku 4.5 $1/M in, $5/M out, Batches −50%)

- **Free tier**: 100 videos = 4 chunks ≈ 14.8K in + 4.5K out ≈ **$0.037/user**; 50 free users ≈ **$1.85 total**. Always sync path (~30s).
- **Pro subscriber**: 2,000-video backlog ≈ **$0.37** (batch); fully maxed 10,000 videos = 400 chunks ≈ 1.48M in + 450K out ≈ **$1.87** (batch). One-time cost per backlog (each video classified once, ever) — at a $5/mo working price, month one is already >2.5× margin on the worst case, and later months are nearly pure margin.
- Batches API for jobs >500 videos; `BUDGET_USD=$100` kill switch + 50%/80% alert emails as the catastrophic backstop.
- Prompt caching does NOT engage (Haiku min cacheable prefix 4096 tokens > our ~700-token preamble) — priced without it.

## Top risks

1. **YouTube changes ytInitialData/InnerTube** → InnerTube JSON preferred over DOM; snippet served from our server (hot-fix); `v` field in payload; fixtures make regressions testable.
2. **ToS optics** → user runs read-only code in their own session on their own data; politeness delays; no write-back; frame as "guided export"; official API offers no WL alternative (removed 2016).
3. **Free-classify abuse** → sign-in required, free tier hard-capped at 100 videos/user ever, 1 job/user, rate limit, allowlist for first cohort, global kill switch. Paid tier is self-limiting (they're paying).
4. **Prompt injection via titles** → enum-constrained structured output, no tools, length caps; blast radius = user's own rows.
5. **Restarts mid-job** → jobs are DB rows; sync path idempotent; batch path resumes from persisted batch id.
6. **Supabase free tier** → 500MB is plenty (~tens of MB); Supavisor pooled connection, `Pool max: 5`.
7. **Charging money raises the bar** → paying users expect reliability and refunds: keep Stripe's no-questions refund path, Sentry + uptime monitoring from day one, and don't oversell on the landing page. Webhook handling must be idempotent (Stripe retries).

## Testing & verification

- Carry DI-fake patterns from existing tests. DB tests against real Postgres (Docker locally, GH Actions service in CI); avoid pg-mem. Critical new case: **per-user isolation** (two users, same video_id).
- `classify.test.js`: persona/taste rendering, few-shots, metadata-only blocks, validator.
- `worker.test.js` (patterned on syncEngine.test.js): complete/fail/cancel/kill-switch/cap; batch submit + reboot-resume + unordered results; usage math; **freemium boundary** (user at 97/100 free imports 10 → 3 classified, 7 stay locked; pro user classifies up to 10,000 and not past).
- `billing.test.js`: webhook signature rejection; `checkout.session.completed` flips plan to pro (idempotent on replay); `subscription.deleted` re-locks future classification but leaves classified rows visible; `classify-remaining` 402s for free users.
- `auth.test.js`: fake JWKS keypair; expired/wrong-audience → 401; JIT provisioning.
- `routes.test.js`: 401 without token on everything; user A can't touch user B; validation; admin gating.
- `collector.test.js`: fixtures → parsers; continuation termination; truncation flag.
- **E2E gate before strangers** (run twice: Joon + one friendly): fresh account → quiz → snippet import → first 100 classified free, remainder locked behind upgrade band → Stripe test-mode checkout → webhook flips plan → classify-remaining (Joon's 2,700 = batch path) → board sane (spot-check 20) → override then import 25 more (flywheel visible in prompt log) → done/dismiss → cleanup list → re-paste same JSON = 0 new, $0 spent → cancel subscription in portal → future classification re-locks, board intact → `DELETE /api/me` truly empties → kill switch friendly-pauses → restart mid-batch still completes.

## Post-approval housekeeping (first execution steps)

1. Commit this design as the spec doc (`docs/superpowers/specs/2026-07-10-hosted-multi-user-beta-design.md`).
2. Produce a user-flow diagram of the signup → import → triage journey.
3. Then start Phase 0 (collector spike).
