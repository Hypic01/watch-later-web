# plan.md — Watch Later Librarian v2: Extension-First Sync + Feature Parity

**Handoff contract.** Author: Fable (product/architecture, with Joon). Implementer: Sol.
Reviewer: Fable. Execute one milestone at a time, stop, report; do not batch milestones.
This file is the single source of truth. If reality contradicts it, stop and say so rather
than improvising around it.

---

## 0. Read this first (hard-won facts — do NOT rediscover these, they cost a full day)

1. **YouTube killed server-side Watch Later access on 2026-07-12.** yt-dlp 404s on WL/LL.
   A cookie-authenticated headless Chromium reports `LOGGED_IN=true` and still gets "No
   videos in this playlist yet." Root cause is PO Token / BotGuard attestation: cookies alone
   no longer grant personal-feed content. **Do not attempt any server-side, headless, or
   cookie-replay fetch of Watch Later. It is a dead end. It is why this whole plan exists.**
2. **Polymer `.data` is a MAIN-world property.** Chrome content scripts run in an ISOLATED
   world where it is invisible. The extension **must** inject the collector with
   `world: "MAIN"` via `chrome.scripting.executeScript` and relay results out via
   `window.postMessage` → an isolated-world relay. A plain content script silently harvests
   **zero videos** and looks like it works.
3. **Watch Later is newest-first and `ytInitialData` server-renders the first ~100 items.**
   So the routine "find my new videos" sync needs **no scrolling at all**: parse
   `ytInitialData`, harvest once, done in ~2s. Only first-import/full-sync scrolls. This is
   what makes silent background sync viable.
4. **Full sync must use a VISIBLE tab.** Playlist continuation loading is visibility-driven;
   a hidden tab may never grow the list. Do not fight the throttler.
5. **Vercel serverless request bodies cap at 4.5MB** (the Express limit of 12MB is a lie in
   prod). Chunk the migration below 3.5MB.
6. **Public single-video caption fetch still works** from a real browser session. Only
   personal feeds were locked down. Server-side caption fetch from Vercel is best-effort and
   mostly fails (datacenter IP) — treat as a degraded fallback, never the primary path.
7. **Repo conventions you must follow:** every module is a `createX({deps})` factory with
   dependency injection; tests are vitest with fakes injected (PGlite for DB, `supertest` for
   routes, fake `chrome` APIs for the extension). 84 tests currently pass; keep them passing.
   `FAKE_LLM=1` + `DEV_FAKE_AUTH=1` must keep running the whole product with zero keys.
8. **Never break the console snippet.** `collector/collector.js` is served at
   `GET /collector.js` and is the zero-install onboarding path + non-Chrome fallback. It also
   gets bundled into the extension at build time (MV3 forbids remote code). Changes must be
   backward-compatible.
9. **Never use `output_config` / json_schema structured outputs.** It is a BETA Anthropic
   feature (needs an `anthropic-beta: structured-outputs-*` header); on the stable endpoint
   every call 400s — this exact bug meant classification never worked in prod until
   2026-07-15. The proven pattern is a forced tool call: `tools` + `tool_choice:
   {type:"tool", name}`, then read `tool_use.input` — exactly as `server/anthropic.js` does
   now, in both single and batch calls. A regression test guards this; keep it green.
10. **Batch API `custom_id` must match `^[a-zA-Z0-9_-]{1,64}$`.** Colons reject the whole
   batch with a 400 (second never-ran-in-prod bug). Ids are `job-<id>-chunk-<n>`; a test
   guards the pattern.
11. **The DB is cross-country from Vercel (~65ms per query).** Never loop per-row queries for
   multi-hundred-row work — 2,700 sequential INSERTs blew the 60s function limit; a resumed
   batch apply that re-ran per-row no-ops went quadratic and froze. Batch multi-row
   statements (`upsertFromImport`) or set-based skips (`pollBatchJob`'s pending set).
12. **Small jobs finish inside the very request that first fetches them** (the serverless
   tick piggybacks `GET /api/jobs/current`), so the client can never rely on observing an
   active job. Give feedback optimistically — see `adoptJob` plus the ref-guarded
   completion/failure announcer effects in `web/src/App.jsx`. Any new async feature
   (transcript fetch, summary generation) must show its state immediately on click.
13. **YouTube captions are locked behind the player's `pot` token (verified live 2026-07-15).**
   Raw timedtext URLs return an EMPTY 200 without it — even same-origin from inside a real
   page. `get_transcript` 400s ("Precondition check failed") for plain JSON POSTs; it needs
   the SAPISID Authorization hash AND the `params` blob the page embeds in `ytInitialData`
   (hand-built protobuf params are rejected). The working last resort is driving the muted
   player itself and capturing its own caption response — see `runTranscriptProbe` in
   `extension/src/transcript.js`. Never re-attempt raw caption fetches.

Repos: hosted `~/Projects/watch-later-web` (live at watch-later-web.vercel.app; Vercel
serverless; there is **no interval worker in prod** — jobs advance via leased,
budget-bounded bites piggybacked on the client's 3s `GET /api/jobs/current` poll, see
`server/worker.js`). Archived reference only, do not deploy: `~/Projects/watch-later-librarian`
(`VideoDetail.jsx`, `mentor.js`, `LearnView.jsx`, `beats.jsx`, `ingestQueue.js`, `library.db`).

---

## 1. Why (context, so you make good judgment calls)

The product sorts a user's YouTube Watch Later backlog into 5 rows (learn / watch / music /
entertainment / outdated) with claude-haiku-4-5. Freemium (revised 2026-07-16, see M8): Free =
newest 1,000 videos all sorted + 100 TL;DRs per calendar month; Pro = $4/mo or $40/yr, no video
limit (fair-use 25,000), unlimited TL;DR, Learn. It is live and working.

YouTube's 07-12 lockdown means the user's own real browser is now the **only** viable data
plane. That converts the Chrome extension from a nice-to-have into the core architecture, and
it is also our moat: anyone can paste a script once, but a reviewed extension that keeps a
library silently in sync is a real product with real switching cost.

Locked product decisions (do not relitigate):
- Extension is core. **Auto-sync ON by default, daily** (popup control: 6h / daily / off).
- Feature parity with the owner's beloved personal app, tier-gated: in-app **VideoDetail**;
  **TL;DR** (free = 100 per calendar month since M8; the original "taste of 7" is superseded);
  **Learn** mentor (Pro, but **visible-and-locked from day one** so free users know what they
  would be buying); **bulk-remove from real WL** later as **Pro**.
- Monetization (2026-07-16, M8): provider = **Polar** (merchant of record; sandbox until the
  owner's visa/OPT clearance); **$4/mo or $40/yr**; Free = newest 1,000 videos all sorted;
  Pro fair-use cap 25,000, marketed unlimited. Downgrades never delete anything.
- Owner parity: one-time migration of his `library.db` into his hosted admin account; a local
  vault-ingest bridge that reuses the archived app's `ingestQueue` + `claude` CLI.
- Paste-collector stays forever as onboarding + fallback.

---

## 2. Milestones (execute in order; stop after each for review)

| M | Goal | Blocked by |
|---|---|---|
| M1 | API tokens + CORS + collector core v2 | nothing — **start here** |
| M2 | Extension MVP + site integration (Sync button, connect, live progress) | M1 |
| **M2.5** | **Collection hardening: API-driven pagination (see below). Scroll-scraping caps at ~500-600, this is the real fix.** | M2 |
| M3 | Auto-sync (alarms) + edge cases + Web Store submission | M2.5 |
| M4 | Transcript pipeline + VideoDetail + TL;DR + Learn-locked upsell | M2 |
| M5 | Owner library migration | M4 schema |
| M6 | Learn mentor real port (Pro) | M4, M5 |
| M7 | Vault-ingest bridge | M5 |
| M8 | Monetization: Polar subscriptions + new Free/Pro tiers | M4 (summaries table) |

(Joon runs a manual check of the live collector against post-07-12 YouTube in parallel; its
result only tells us which DOM extractor is live, and M1's extractor registry handles either.
Do not block on it.)

---

## M2.5 — Collection hardening (the scroll cap is the real problem)

**Confirmed failure (2026-07-14, real run on Joon's ~2,824-video WL):** both the console paste
(scroll + DOM harvest) AND the extension full sync stall at ~500-600 videos. The console path
has no service worker and cannot "time out," so this is not our code timing out — **YouTube
throttles rapid playlist pagination and stops serving continuation batches after a few hundred.**
The extension correctly failed loud (the M2.5 completeness guard held: it refused to import a
partial list), but a loud failure is still a failure. Fix the collection itself.

**Root cause + cure (researched, documented):** YouTube's continuation pages get throttled on
large lists, and per yt-dlp/youtube-dl the documented cure is "retry the SAME continuation token,
it eventually returns." Also: YouTube rotates its InnerTube client version weekly, which kills a
fixed scraper but is a non-issue for us because we run inside the real page and read the live
version from `ytcfg`.

**The fix — drive YouTube's own data feed directly instead of scraping the scrolled DOM:**
1. **Primary loader = explicit InnerTube pagination**, in the MAIN-world driver:
   - Seed: first batch + first continuation token from `ytInitialData` (reuse
     `readInitialContinuationToken`). Read `INNERTUBE_API_KEY` + `INNERTUBE_CONTEXT` from
     `window.ytcfg`.
   - Loop: POST `/youtubei/v1/browse` with `{context, continuation: token}` → parse via
     `parseBrowseResponse` (already returns `{videos, continuationToken}`) → append → advance to
     the next token. Continue until a response returns **no** token (true end of list).
   - **Auth without re-deriving it:** the driver's existing fetch/XHR patch already intercepts
     `/youtubei/v1/browse`. Capture the page's FIRST real continuation request (url + headers +
     body) and **replay it with the token swapped** for subsequent pages. This inherits the
     exact auth (SAPISIDHASH), client headers, and context the page used, correct by
     construction. Fallback only if no request can be captured: build the request from `ytcfg`
     and compute the SAPISIDHASH.
2. **Backoff + retry is the core of the fix.** On an empty `continuationItems`, an HTTP error, or
   a throttle, WAIT (exponential: ~1.5s, 3s, 6s, capped ~20-30s) and **retry the same token**,
   up to ~8 attempts, before giving up. Pace successful pages ~300-600ms apart so we do not trip
   the throttle in the first place. This is the documented cure; it is not optional polish.
3. **Completeness stays structural (keep M2's guard):** done only when a response has no
   continuation token; TRUNCATED only after retries are exhausted with a token still outstanding.
   Report `unavailable = total - collected` (private/deleted) as information, never as an error.
4. **Background tab becomes viable.** `fetch` works in a background tab regardless of visibility,
   so API-driven full sync should NOT require a visible tab the user must babysit. Aim for
   background full sync; only fall back to a brief visible phase if capturing the first request
   genuinely needs a foreground scroll. This is a real UX win, call it out.
5. **Keep the SW alive across a multi-minute sync:** the driver emits a progress heartbeat at
   least every ~10s INCLUDING during backoff waits (or the SW uses a `chrome.alarms` keepalive
   while a sync is active). A 30s backoff must not let the MV3 worker die mid-sync.
6. **Share the core.** Put the pagination loop in a pure, injected, unit-testable module (extend
   `collector/continuations.js` or a new `collector/pagination.js`). The extension driver is the
   priority consumer; the console snippet runs in-page too and should be able to adopt the same
   loader so the paste fallback stops truncating.
7. **Keep DOM harvest as a supplementary union source + last-resort fallback**, but the InnerTube
   loop is authoritative for completeness.

**UX fix (folded in): when the extension is connected, stop luring users onto the weak path.**
The Import panel currently shows the console-paste flow right next to the extension, so Joon
grabbed the paste method and got a truncated 600. When the extension is connected, hide or
collapse the console-snippet instructions behind a "no extension? paste manually" disclosure, and
make Sync the single obvious primary action.

**Acceptance (extend tests/extension-driver.test.js, tests/continuations.test.js):**
- Paginates to a token-less end and returns the full set (fake a 2,800-item list across ~28 mocked
  browse responses).
- **Backoff-retry: a mocked browse response that is empty/throttled twice then succeeds on the
  same token yields the complete list, NOT a truncation.** This is the decisive case.
- TRUNCATED only after retries are exhausted with a token still outstanding.
- A heartbeat/progress event is emitted during a long backoff wait (assert cadence).
- Request-replay: the captured first-request headers are reused and only the continuation token in
  the body changes.
- `unavailable` count is reported on a fully-walked list; it is never treated as an error.

**Cannot be validated from here** (headless gets the empty WL); final proof is a real run in
Joon's Chrome reaching his true total minus private/deleted.

---

## M1 — Tokens, CORS, collector v2

**Migration `003-api-tokens`** in `server/migrations.js`:
```sql
CREATE TABLE api_tokens (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,     -- sha256 hex. Plaintext is "wll_" + 32 random bytes
                                       -- base64url, returned exactly once, never stored.
  scope text NOT NULL CHECK (scope IN ('imports','bridge')),
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
```

**`server/auth.js`**: add `hashToken(plain)` (node:crypto sha256 hex) and an
`importToken(scope)` middleware factory: read `X-Import-Token` → hash → look up → reject if
missing/revoked/wrong-scope → load user → set `req.user = {id, email, isAdmin, viaToken:true}`
→ touch `last_used_at` (throttle to once per 5 min). Export `jwtOrToken(scope)` that accepts
either a Supabase JWT or a token. Mount `jwtOrToken("imports")` **only** on
`POST /api/imports`. `bridge` scope is mintable by admins only (enforce server-side). A token
can **never** mint another token: `POST /api/tokens` is JWT-only.

**Routes** in `server/app.js`: `POST /api/tokens` (JWT; body `{scope, label}`; returns the
plaintext once), `GET /api/tokens` (list, no secrets), `DELETE /api/tokens/:id` (revoke).
`server/db.js` gains: `createApiToken`, `getApiTokenByHash`, `listApiTokens`,
`revokeApiToken`, `touchApiToken`.

**CORS** (Express middleware, before routes; no `vercel.json` change needed — rewrites already
forward OPTIONS): new env `EXTENSION_IDS` (comma list, so the unpacked dev ID and the store ID
both work) → `config.extensionOrigins` = `chrome-extension://<id>` list. If `Origin` matches
one exactly: echo that exact origin (**never `*`**), `Vary: Origin`, allow headers
`content-type, x-import-token`, methods `POST, OPTIONS`, answer OPTIONS with 204. Applies to
`/api/imports` only.

**`collector/collector.js` v2** — must stay backward compatible with the served snippet:
- Replace the hardcoded selector with an extractor registry so a YouTube redesign is a
  one-line fix:
  `EXTRACTORS = [{selector:"ytd-playlist-video-renderer", extract: extractVideoData},
  {selector:"yt-lockup-view-model", extract: extractLockupData}]`. `nodes()` scans the
  registry and uses the first selector that returns anything.
- New pure functions: `parseInitialData(win)` (walk `window.ytInitialData` for BOTH the
  `playlistVideoRenderer` and `lockupViewModel` JSON shapes → normalized video objects),
  `readPlaylistTotal(win)` (the playlist header's total, for honest progress and a
  completeness cross-check), `collectInitial({doc, win})` (harvest with **no** scrolling).
- Keep `isWatchLaterPage`, `extractVideoData`, `createCollector`, `buildPayload` exported and
  behaviorally unchanged.

**Settings UI** (`web/src/components/Settings.jsx`): a "Connected apps" block listing tokens
(label, created, last used) with revoke buttons. Token creation is normally invisible (the
site mints it for the extension in M2), but expose a manual "generate token" for the bridge.

**Acceptance:** `tests/tokens.test.js` (supertest + PGlite): plaintext returned exactly once
and never retrievable again; hash lookup authenticates; revoked token 401s; `bridge` scope
refused to non-admins; a token cannot mint a token; CORS preflight echoes the exact extension
origin and never `*`; a non-listed origin gets no CORS headers. Extend
`tests/collector.test.js`: `parseInitialData` on both JSON shapes (build a synthetic
`lockupViewModel` fixture), registry falls through when the old selector finds nothing,
`collectInitial` does not scroll, `readPlaylistTotal`. All 84 existing tests still green.

---

## M2 — Extension MVP (MV3) + site integration

**Create `extension/`:**
```
extension/
├── manifest.json
├── build-extension.js        # esbuild; mirror collector/build-snippet.js. Outputs dist/
│                             # (loadable unpacked) and a store zip. Bundles collector core.
├── popup.html
└── src/
    ├── background.js         # service worker shell: listeners registered TOP-LEVEL, delegates
    ├── sync.js               # createSyncController({tabs, scripting, storage, api, now})
    │                         # PURE + DI. All logic lives here so it is unit-testable.
    ├── api.js                # POST /api/imports with X-Import-Token; error mapping
    ├── messages.js           # ALL message-type constants (web/ imports this same file)
    ├── collector-driver.main.js  # MAIN-world entry (see fact #2)
    ├── relay.js              # ISOLATED world: window.postMessage <-> chrome.runtime
    ├── transcript.js         # M4 (stub in M2)
    └── popup.js              # vanilla JS, no React
```

**manifest.json** (minimal on purpose; every permission must survive review):
```json
{
  "manifest_version": 3,
  "name": "Watch Later Librarian Sync",
  "version": "0.1.0",
  "description": "One click sync of your own YouTube Watch Later into Watch Later Librarian.",
  "permissions": ["scripting", "storage", "alarms"],
  "host_permissions": ["https://www.youtube.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "externally_connectable": { "matches": ["https://watch-later-web.vercel.app/*"] },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```
Do **not** add: `tabs` (host permission already grants URL access to youtube.com tabs),
`cookies`, `identity`, `notifications`, `offscreen`, or any host permission for our own API
(we do CORS instead — one fewer thing to justify). Pin a `"key"` in the dev manifest so the
unpacked extension ID is stable across reloads.

**Sync flow** (in `sync.js`, driven by background.js):
1. Trigger: popup click, site message, or alarm. Single-flight guard in `chrome.storage.session`.
2. `chrome.tabs.query({url: "https://www.youtube.com/playlist*"})` → reuse an open WL tab, else
   `chrome.tabs.create({url: WL, active: mode === "full"})` (delta = background, full = visible;
   see fact #4).
3. On tab load: `chrome.scripting.executeScript` **twice** — `relay.js` (ISOLATED) and
   `collector-driver.main.js` (**MAIN**, args `{mode}`).
4. Driver: check sign-in via `window.ytcfg?.get("LOGGED_IN")` → if false emit
   `COLLECT_ERROR {code:"SIGNED_OUT"}`. Then **delta** = `parseInitialData` + one harvest, no
   scroll; **full** = existing `createCollector` loop + `readPlaylistTotal` for honest progress
   ("2,724 of 2,796 — the rest are private or deleted").
5. Driver emits `COLLECT_PROGRESS {count, expectedTotal}` / `COLLECT_DONE {videos, truncated}` /
   `COLLECT_ERROR` via `window.postMessage` (envelope `{__wll:true}`); relay forwards to the SW.
   These periodic events also keep the MV3 service worker alive; still persist enough state in
   `storage.session` to recover if it is killed.
6. SW: `buildPayload(videos, "extension")` → `POST /api/imports` with `X-Import-Token` → close
   the tab **only if we created it** → badge (`setBadgeText` live count, `✓` on success, `!` on
   error).

**Site integration** — create `web/src/extension.js`; import message constants from
`extension/src/messages.js` (one source of truth, so the protocol cannot drift):

| Direction | Type | Payload → Reply |
|---|---|---|
| site → ext | `WLL_PING` | `{}` → `{ok, version}` (throws/absent ⇒ no extension) |
| site → ext | `WLL_SET_TOKEN` | `{token, apiUrl, email}` → `{ok}` |
| site → ext | `WLL_GET_STATUS` | `{}` → `{connected, email, lastSyncAt, lastResult, syncing, autoSync}` |
| site → ext | `WLL_SYNC` | `{mode:"delta"\|"full"}` → `{started}` |
| site → ext | `WLL_FETCH_TRANSCRIPT` | `{videoId}` → `{ok, transcript, ...}` (M4) |
| ext → site (Port `wll-sync`) | `WLL_SYNC_PHASE` / `_PROGRESS` / `_DONE` / `_ERROR` | streamed |

- Topbar gains a **Sync** button when the extension is connected (Import button stays).
  Click → `WLL_SYNC {mode:"delta"}`. Render collection progress in the **existing**
  `JobProgress` slot; on `WLL_SYNC_DONE` the existing 3s `/api/jobs/current` poll takes over
  classification progress — **write no new progress code**.
- Connect flow (one click, no copy-paste): if `WLL_PING` succeeds but status is unconnected,
  Settings/ImportPanel shows "Connect the extension" → site calls
  `POST /api/tokens {scope:"imports", label:"Chrome extension"}` → sends `WLL_SET_TOKEN`.
- Guard: if `status.email !== me.email`, show "This extension is connected to a different
  account" + reconnect.
- No extension → **exactly today's behavior** (ImportPanel + console snippet), plus a card:
  "Get the Chrome extension for one-click sync" (hide on non-Chromium user agents).

### M2 CRITICAL — the full-sync lockup gap (found in M1 review; do not skip)

M1 shipped `extractLockupData`, which reads `node.data` off `yt-lockup-view-model` DOM
elements. **That may harvest zero.** Two facts collide:

1. `yt-lockup-view-model` is one of YouTube's newer, non-Polymer components. Polymer elements
   expose page state as a `.data` expando; the newer view-model components **may not expose
   `.data` at all**. Unverified, and unverifiable until YouTube actually serves lockups on WL.
2. **`window.ytInitialData` does NOT update when you scroll.** It is the server-rendered first
   batch, frozen. Continuation batches arrive over the network and are rendered straight into
   the DOM; they never mutate `ytInitialData`.

Consequence: if YouTube switches WL to lockups, **delta sync still works** (it reads
`ytInitialData`, which is JSON and needs no DOM property), but **full sync silently collects
only the first ~100 videos and reports success.** A user's 2,700-video first import would
quietly become 100. Tests cannot catch this; only real YouTube can.

**Required in M2 — network-level harvest as the full-sync backstop.** In
`collector-driver.main.js` (MAIN world), before scrolling, monkey-patch `window.fetch` (and
`XMLHttpRequest`) to capture responses from `/youtubei/v1/browse`. Feed each captured body
through the **same** JSON extractors `parseInitialData` already uses (both
`playlistVideoRenderer` and `lockupViewModel` shapes). Then:
- Harvest = union of (DOM `.data` path, which is proven and stays primary) and (captured
  continuation JSON). Dedupe by video id.
- This makes full sync independent of whether any DOM property exists, and immune to DOM
  churn entirely. It is strictly more robust than scraping rendered elements.
- Cross-check the final count against `readPlaylistTotal`. If the harvest is materially short
  of the playlist total, **fail loudly** rather than importing a truncated library. Silent
  truncation is the worst possible failure mode here: the user's board looks fine and is wrong.
- Restore the original `fetch`/`XHR` in a `finally` so we never leave the page patched.

Factor the capture as a pure function (`collector/continuations.js`:
`parseBrowseResponse(json)`) so it is unit-testable with a fixture, per repo convention.

**Acceptance:** `tests/extension-sync.test.js` drives `createSyncController` with fake
`{tabs, scripting, storage, api}` exactly like `createCollector` is driven with fake pages
today: reuse-vs-create tab, delta vs full mode, `SIGNED_OUT` propagation, single-flight
(second trigger while syncing is a no-op), SW-restart recovery from `storage.session`, import
409/429 treated as benign skips. Plus `tests/continuations.test.js`: `parseBrowseResponse` on
both renderer and lockup fixtures, and a full-sync path that harvests correctly when the DOM
yields **nothing** (simulating lockups without `.data`), and one that fails loudly when the
harvest falls materially short of `readPlaylistTotal`. Manual: Joon loads `extension/dist`
unpacked and one-click syncs against prod — **this is the moment his daily driver becomes the
hosted product, and it happens before any store review.**

### M2 auth guard rail (carry forward from M1)

`importToken` sets `isAdmin` on token-authenticated requests, so an admin's `imports` token
carries admin identity. This is contained today only because scope is enforced
(`token.scope !== scope` rejects) and every admin route uses `auth.admin` → `auth.required`,
which is JWT-only. **Never mount `jwtOrToken` on an admin-gated route, and never widen
`auth.required` to accept tokens.** If that invariant breaks, a leaked imports token becomes
an admin credential. Bridge routes (M7) must use the `bridge` scope, never `imports`.

---

## M3 — Auto-sync + Web Store

`chrome.alarms.create("wll-auto-sync", {periodInMinutes: 1440})`, **default ON, daily**; popup
select 6h / daily / off. Alarms never fire while Chrome is closed → on
`chrome.runtime.onStartup`, if last sync is older than the interval, run a catch-up. Auto-sync
is **always delta** and **never** opens a visible tab. Treat import 409 ("a sort is already
running") and 429 as benign skips, not errors.

Store submission: single purpose = "sync your own YouTube Watch Later into your Watch Later
Librarian library." Justify each permission with the sentences in M2. Privacy policy is already
live at `/privacy.html` — add one line covering the extension (reads your Watch Later only when
you sync; sends titles and metadata to your own account; token stored locally). All code is
bundled, no remote code. **Exclude bulk-remove from this first submission** to keep a clean
read-only story for review.

---

## M4 — Transcripts, VideoDetail, TL;DR, Learn-locked

**Migration `004`:** `videos` gains `transcript text`, `transcript_available boolean NOT NULL
DEFAULT false`, `transcript_source text`, `transcript_fetched_at timestamptz`,
`upload_date text`, `description text`. **Keep `LIST_COLUMNS` transcript-free** (board payloads
must never carry tens of MB — the archived app learned this the hard way). New table
`summaries (user_id uuid, video_id text, summary jsonb NOT NULL, model text, input_tokens int,
output_tokens int, created_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, video_id),
FOREIGN KEY (user_id, video_id) REFERENCES videos ON DELETE CASCADE)`. `users.summaries_used int
NOT NULL DEFAULT 0` (mirror the existing `free_used` pattern). New env `FREE_SUMMARY_QUOTA=7`.

**Transcript flow:** VideoDetail TL;DR click → if `!transcript_available` and the extension is
present → `WLL_FETCH_TRANSCRIPT {videoId}` → extension SW does
`fetch("https://www.youtube.com/watch?v=<id>", {credentials:"include"})` → regex out
`ytInitialPlayerResponse` → `captions.playerCaptionsTracklistRenderer.captionTracks` → pick
track (manual `en`/`ko` **before** ASR, mirroring the archived `--sub-langs en.*,ko.*`) → fetch
`baseUrl + "&fmt=json3"` → parse → return to the **page** → page does
`POST /api/videos/:id/transcript` with its own JWT (same-origin: no new CORS, no new token
scope) → then `POST /api/videos/:id/summary`. If the watch-page HTML comes back as an
attestation wall, fall back to opening a background tab and reading
`window.ytInitialPlayerResponse` in MAIN world.

New pure module **`collector/captions.js`** shared by extension and server:
`extractPlayerResponse(html)`, `pickCaptionTrack(tracks, prefLangs)`, `parseJson3(raw)` —
**port `parseJson3` verbatim from the archived `server/ytdlp.js`.**

**Endpoints:** `POST /api/videos/:id/transcript` (JWT; ownership check; reject >1MB raw; store
≤250K chars with a truncated flag; COALESCE-update optional `description` ≤5000 / `upload_date`
/ `duration_seconds` / `channel` harvested from the same playerResponse — these feed the mentor
and vault prompts). `POST /api/videos/:id/transcript/fetch` (JWT; server best-effort via a new
`server/transcripts.js`, 8s timeout; expected to usually fail from Vercel — honest copy, house
style, **no dashes**: "YouTube would not hand captions to our server. With the Chrome extension
we fetch them straight from your browser instead."). `POST /api/videos/:id/summary` (JWT;
return cache if present with `{cached:true}` and spend nothing; else require a transcript (400
with a fetch hint); gate on Pro/admin OR `summaries_used < FREE_SUMMARY_QUOTA`; generate; cache;
increment; 402 `{upgrade:true}` at the wall). `GET /api/videos/:id` (detail payload incl.
`transcript_available`, `vault_note_path`, `description` — **never** the raw transcript).

**`server/mentor.js` (new):** port the archived app's summary prompt shape
(`{tldr, points[], watchIf}`) with a **generic, taste-profile-aware persona** (not "Joon"),
via a **forced tool call** (fact #9 — NOT `output_config` structured outputs, which is beta
and 400s; mirror how `classifyChunk` does it in `server/anthropic.js`), so the parser shrinks
to a validator. `server/anthropic.js` gains
`completeJson(prompt, schema, {model, maxTokens})` (tools + `tool_choice`, reads
`tool_use.input`) and `completeText(...)` plus fake-LLM
equivalents (deterministic fake summary/lesson) so the whole feature runs under `FAKE_LLM=1`.
`db.addUsage` must make `jobId` **optional** (skip the `classify_jobs` update when null) so
summary/Learn spend still lands in user + global accounting under the same `BUDGET_USD` kill
switch.

**UI:** port `web/src/components/VideoDetail.jsx` from the archived app nearly verbatim (same
CSS dialect; hero thumb with `maxresdefault→hqdefault` fallback, meta line, pills, reasoning
block, actions row, summary blocks) adapted to the hosted five categories (`learn` not
`ingest`). `VideoCard` thumb/title click opens the detail again (App.jsx focus state, no
router); keep "Open on YouTube" as an overlay/menu action. TL;DR button is **always visible**
with a free meter ("2 of 7 free summaries used") and an inline upgrade card at the wall. Learn
button is **always visible with a lock** for free users → modal ("Learn is a Pro superpower.
The librarian teaches you the video so you never have to watch it.") → existing checkout flow.
Every async click gives feedback the moment it lands (fact #12): TL;DR shows "Fetching the
transcript… / Summarizing…" states immediately, never a dead button waiting on a poll.

**Acceptance:** `tests/captions.test.js` (extractPlayerResponse on a trimmed HTML fixture, track
preference order, parseJson3 — port the archived cases). `tests/transcripts.test.js` (ownership,
size caps, COALESCE metadata, honest fallback failure body). `tests/summaries.test.js` (cache
hit spends nothing, meter boundary exactly at 7, 402 upsell, pro/admin bypass, fake-LLM
determinism, usage recorded with a null jobId).

---

## M5 — Owner library migration (2,720 videos, 7 overrides, 2,129 transcripts / 54MB)

**STATUS UPDATE 2026-07-15 — this milestone SHRANK.** The owner's library is already in prod
and freshly classified (2,745 sorted via a real extension sync + batch job; $0.86). Do NOT
migrate videos or classifications — they would be stale duplicates of better data. What
remains of M5: carry over the **2,129 transcripts** (`transcript_source='migration'`, feeds
TL;DR/Learn at $0 fetch cost) and the **7 manual overrides** (mapped per the rules below,
`override_seq` server-side in `override_at` order, for the taste flywheel). The idempotency
rules below still bind: never stomp `manual_override` rows, never downgrade `done`/`dismissed`,
COALESCE-only updates. The chunking/mapping/endpoint design below stands otherwise.

Local script → admin bulk endpoint. **Do not** do direct SQL via MCP: 54MB of transcripts as
SQL literals bypasses every sanitizer and cannot be tested.

- Hosted: `POST /api/admin/migrate` (admin JWT or `bridge` token) body `{rows:[...]}` → upsert
  `ON CONFLICT (user_id, video_id)` with COALESCE. `user_id` always comes from the
  authenticated admin, **never** from the body.
- Script: **`scripts/migrate-to-hosted.js` in the ARCHIVED repo** (it already has
  better-sqlite3; the hosted repo must never grow a sqlite dependency). Read `library.db`
  read-only, map, chunk each request **under 3.5MB** (fact #5), retry, print a reconciliation
  table, safe to re-run.
- Mappings: `category ingest → learn` (also inside `override_from`); `status ingested → done`
  (carry `vault_note_path`); `scanned_at → classified_at`; topics old-15 → new-16
  (`design|ai-tools|camera-photo → tech`, `career|finance → money & business`,
  `dj-production → music`, `self-improvement → learning & how-to`,
  `korean-life → vlogs & daily life`, `relationships → other`, rest 1:1), dedupe, cap 2.
  **`override_seq` must be assigned server-side via `nextval('override_seq')` in ascending
  `override_at` order** so the taste flywheel (`getRecentOverrides`) preserves his 7
  corrections in true chronological order. Transcripts ride along with
  `transcript_source='migration'` — **this is what unlocks his TL;DR and Learn on day one.**
  Skip the archived `learn_sessions` and `summaries` (stale; regenerating costs pennies).
- Idempotent: re-running never downgrades `done`/`dismissed` and never stomps a row with
  `manual_override = true`.
- ~~Run the migration BEFORE his first full extension sync~~ — OBE: the full sync and fresh
  classification already happened (see status update above). Transcripts + overrides only.

**Acceptance:** `tests/migrate.test.js` — category/status/topic mappings, `override_seq`
ordering by `override_at`, idempotent replay, chunk replay safety.

---

## M6 — Learn (Pro) · M7 — Vault bridge

**M6:** port `LearnView.jsx` + `beats.jsx` + `flattenLesson`/`conceptSegments` (into
`web/src/lib.js`) nearly as-is. Routes `POST /api/learn/:id/start|reply|position`,
`DELETE /api/learn/:id`. Migration `005`: `learn_sessions (user_id, video_id) PK, lesson jsonb,
position int, messages jsonb`. Prompts from the archived `mentor.js` with a generic persona,
lesson via a forced tool call (fact #9), `LEARN_MODEL` env (default haiku 4.5). Pro/admin gate.

**M7:** migration `006`: `ingest_requests (id bigserial, user_id, video_id, state CHECK
('queued','processing','done','failed'), error text, lease_until timestamptz, created_at,
updated_at)` — reuse the **exact lease pattern** from `classify_jobs` so a crashed bridge run
self-heals. Hosted: `POST /api/videos/:id/ingest` (admin) enqueues (409 if already queued);
`POST /api/bridge/claim` (`bridge`-scope token; `FOR UPDATE SKIP LOCKED`; 10-min lease) returns
the full video row incl. transcript (exactly the fields `buildIngestPrompt` consumes); 204 when
empty; `POST /api/bridge/requests/:id/complete {vaultNotePath}` → request done, video
`status='done'` + `vault_note_path` set (renders an "in vault" pill on the cleanup list);
`.../fail {error}`. VideoDetail gets a "Send to vault" action (admin-only) with queued /
failed+retry / "in vault · <path>" states.

Local: **`scripts/vault-bridge.js` in the ARCHIVED repo** — a ~80-line poll loop (15s): claim →
`buildIngestPrompt(video)` (import **unchanged** from its `server/ingestQueue.js`) →
`runClaude(prompt, {cwd: VAULT_PATH, extraArgs:['--permission-mode','acceptEdits']})` (import
**unchanged** from its `server/claude.js`; runs on Joon's Max plan, $0 API) → parse the trailing
`CREATED: <path>` line → complete/fail. `UsageLimitError` → back off 30 min. Env:
`WLL_API_URL`, `WLL_BRIDGE_TOKEN`, `VAULT_PATH`. **Add no edits to existing archived modules** —
both functions are already exported.

**Acceptance:** `tests/learn.test.js` (start/reply/position persistence, Pro gate);
`tests/bridge.test.js` (lease + SKIP LOCKED, expiry reclaim, complete sets video done + path,
admin-scope gate); `tests/vault-bridge.test.js` in the archived repo mirroring its existing
`ingestQueue.test.js` style (fake fetch + fake runClaude; CREATED-line parse, fail path,
usage-limit backoff).

---

## M8 — Monetization: Polar subscriptions + new Free/Pro tiers (approved 2026-07-16)

**Why.** The product works end to end; this milestone turns on the business. New tiers:
**Free** = newest 1,000 videos stored and ALL of them classified free (replaces the old
"first 100 classified" free_quota model) + 100 TL;DRs per calendar month (replaces lifetime 7)
+ Learn locked. **Pro** = $4/month or $40/year via Polar hosted checkout, no video limit
(fair-use 25,000, marketed unlimited), unlimited TL;DR, Learn access (M6 ships Learn itself).

**HARD GUARDRAIL:** build fully against Polar's SANDBOX. Production billing stays OFF (no
`POLAR_*` env vars in Vercel) until the owner's visa/OPT clearance. The boot gate
(billing=null when env missing → checkout 404 → "Pro isn't open yet" toast) is the off-switch
and must keep exactly that behavior. `FAKE_LLM=1 DEV_FAKE_AUTH=1` with no Polar env must keep
running the whole product.

**Why this is tractable:** billing is wired at exactly 3 seams — `server/config.js` (env) →
`server/boot.js` (construct-if-configured gate) → `server/app.js` (raw-body webhook mount
before express.json; checkout/portal routes inside `if (billing)`) + the `server/billing.js`
adapter. Webhooks → `db.setPlan` is the single source of truth for plan state. Keep every
route/interface shape; swap the adapter internals from Stripe to Polar.

### Locked design decisions
- **Caps computed from plan at request time** (`config.freeVideoCap` 1000 /
  `config.proVideoCap` 25000 via the existing `isPro()`), NOT the per-user `video_cap`
  column. Admins get pro caps automatically; webhooks never maintain caps; downgrade
  grandfathering falls out of `upsertFromImport`'s existing behavior (existing rows always
  pass; only new rows beyond headroom drop — nothing is ever deleted on downgrade).
- **`video_cap`, `free_quota`, `free_used`, `summaries_used` become vestigial columns** —
  leave them, remove the gates. `worker.js`'s `incrementFreeUsed` for free-tier jobs stays as
  a harmless stat (keeps worker tests untouched).
- **TL;DR meter = count of `summaries` rows this UTC calendar month**
  (`created_at >= date_trunc('month', now())`) — no new bookkeeping column; resets on the
  1st; cached hits already cost nothing. Note in a comment: a downgraded pro's same-month
  rows count against the free 100 (accepted fair-use behavior).
- **Stripe columns stay dormant** (they never held data); add provider-neutral columns.
- **Free users can now use classify-remaining** (the 402 "needs Pro" gate dies).
- **Keep `locked: 0` in the import response** so the shipped extension (which forwards it
  numerically, extension/src/sync.js) needs no coordinated release. No extension changes.

### Migration `005-polar-tiers` (server/migrations.js, append)
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_customer_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_subscription_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_ends_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_users_billing_customer ON users(billing_customer_id);
ALTER TABLE users ALTER COLUMN video_cap SET DEFAULT 1000;
UPDATE users SET video_cap = 1000 WHERE plan = 'free';
```
(`billing_ends_at` powers Settings' "Pro until {date}" for scheduled cancels. The video_cap
default/backfill is cosmetic documentation — the column is vestigial after this milestone.)

### server/db.js
- `setPlan(id, plan, {customerId, subscriptionId, endsAt})` writes the `billing_*` columns
  (COALESCE keeps the first-seen customer id, mirroring today's shape).
- `getUserByBillingCustomer(customerId)` replaces `getUserByStripeCustomer`.
- DELETE `setStripeCustomer` (Polar keys customers by our user id via `external_customer_id`;
  no pre-created customer step exists).
- NEW `countSummariesThisMonth(userId)`:
  `SELECT count(*)::int FROM summaries WHERE user_id=$1 AND created_at >= date_trunc('month', now())`.
- DELETE `incrementSummariesUsed` (no callers remain after app.js changes).

### server/billing.js — full rewrite on `@polar-sh/sdk`
`createBilling({db, config, polarClient})` keeping the exported handler interface
(`createCheckout(req,res)`, `createPortal(req,res)`, `handleWebhook(req,res)`) so app.js
routes need zero changes. `polarClient` injectable for tests; prod:
`new Polar({accessToken: config.polarAccessToken, server: config.polarServer})`.
- **Checkout**: `polar.checkouts.create({ products: [config.polarProductMonthlyId,
  config.polarProductAnnualId], successUrl: config.appUrl + "/app?upgraded=1",
  externalCustomerId: user.id, customerEmail: user.email, metadata: {userId: user.id} })` →
  `res.json({url: checkout.url})`. The buyer picks monthly vs annual in Polar's hosted
  checkout. There is no cancel_url concept in Polar.
- **Portal**: 400 `{error:"no billing profile yet"}` when `!user.billing_customer_id` (the
  contract Settings already expects); else
  `polar.customerSessions.create({externalCustomerId: user.id})` →
  `res.json({url: session.customerPortalUrl})`.
- **Webhook**: verify with `validateEvent(req.body, req.headers, config.polarWebhookSecret)`
  from `@polar-sh/sdk/webhooks` (Standard Webhooks HMAC; express.raw preserves the exact
  bytes — keep the mount order in app.js and `bodyParser: false` in api/index.js untouched).
  400 `{error:"bad signature"}` on `WebhookVerificationError`. One status-derived
  `applySubscription(sub)` serves every `subscription.*` event idempotently. Resolve the user
  by `sub.customer.externalId` → `sub.metadata.userId` → `db.getUserByBillingCustomer(
  sub.customerId)`, with each id guarded by a UUID regex before hitting `db.getUser` (the
  users.id column is uuid-typed and throws on garbage). Unknown-but-verified event types get
  a 2xx ack (never retry-loop). Missing user → 2xx ack too.

| Polar event | Payload state | Action |
|---|---|---|
| `subscription.active` | status=active | setPlan pro {customerId, subscriptionId, endsAt:null} — the fast path `?upgraded=1` polls for |
| `subscription.updated` | catch-all; status authoritative | active/trialing/past_due → pro; anything else → free (covers monthly↔annual switches, payment recovery) |
| `subscription.canceled` | status=active, cancelAtPeriodEnd=true | STAYS pro; endsAt = sub.endsAt ?? sub.currentPeriodEnd |
| `subscription.uncanceled` | status=active, cancelAtPeriodEnd=false | pro; endsAt null |
| `subscription.revoked` | access actually ended | setPlan free {customerId, subscriptionId:null, endsAt:null} — nothing deleted |

### server/config.js
- REMOVE `freeVideoQuota` (zero consumers — the old gate read the DB column) and
  `stripeSecretKey` / `stripeWebhookSecret` / `stripePriceId`.
- `freeSummaryQuota` default 7 → **100** (env knob `FREE_SUMMARY_QUOTA` survives).
- ADD `freeVideoCap: Number(env.FREE_VIDEO_CAP) || 1000`,
  `proVideoCap: Number(env.PRO_VIDEO_CAP) || 25000`,
  `polarAccessToken/polarWebhookSecret/polarProductMonthlyId/polarProductAnnualId` (strings),
  `polarServer: env.POLAR_SERVER === "production" ? "production" : "sandbox"`.

### server/boot.js
Billing gate becomes: all four of `polarAccessToken`, `polarWebhookSecret`,
`polarProductMonthlyId`, `polarProductAnnualId` set → `createBilling({db, config})`; else
`billing = null` + console note `"[billing] Polar env not set — upgrade flow disabled (free
tier still works)"`.

### server/importer.js
- `handleImport`: `const cap = isPro(user, dbUser) ? config.proVideoCap :
  config.freeVideoCap;` passed to `upsertFromImport`. The freemium split DIES: `willClassify
  = unscanned` for everyone; respond `{added, duplicates, capped, jobId, willClassify,
  locked: 0}`. Rewrite the stale header comment.
- `classifyRemaining`: delete the free-user 402 block; tier = `isPro(...) ? "pro" : "free"`.
  Keep llmReady 503, active-job 409, nothing-left 400 guards.

### server/app.js
- `/api/me`: drop `freeQuota`/`freeUsed` from the payload. `summariesUsed =
  await db.countSummariesThisMonth(...)`; `summaryQuota = config.freeSummaryQuota`;
  `videoCap = (isAdmin || plan==="pro") ? config.proVideoCap : config.freeVideoCap`;
  ADD `proEndsAt: u.billing_ends_at`.
- Summary route: fetch `monthlyUsed = countSummariesThisMonth` alongside detail+user; the
  meter helper returns `{summariesUsed, summaryQuota}` from it; gate
  `if (!bypass && monthlyUsed >= config.freeSummaryQuota)` → 402
  `"You've used all ${quota} free TL;DRs this month. They reset on the 1st."` + upgrade:true;
  on fresh generation respond `summariesUsed: monthlyUsed + 1`; cached-hit and
  concurrent-winner paths return the unchanged count; DELETE the `incrementSummariesUsed`
  call.

### Frontend
- **UpgradeBand.jsx**: props `{me, waitingCount, atCap, onToast, onJobStarted}`. Two
  independent surfaces: SORT action (any plan) when `waitingCount > 0` (headline
  "{N} videos are waiting to be sorted", button "Sort now", existing sortRemaining handler);
  UPGRADE CTA when `atCap && me.plan !== "pro"` ("Your library is at the free limit — the
  newest {me.videoCap} videos. Pro imports your whole backlog, with unlimited TL;DRs.",
  existing upgrade handler). 404 toast → "Pro isn't open yet, you're early! Everything you
  have stays free."
- **App.jsx**: rename lockedCount → `waitingCount` (= unscanned when no active job);
  `atCap = me.plan !== "pro" && totalVideos >= me.videoCap`; render the band when
  `waitingCount > 0 || atCap`; `onImported` toast drops the `locked` bit and adds
  `capped` → "{N} older videos skipped — you're at your plan's limit"; `?upgraded=1` poll
  tries 15 → 30 (60s; sandbox webhooks can lag); AuthGate copy (line ~57) and empty-hero
  copy lose "first 100" → "your newest 1,000 videos, free" phrasing via `me.videoCap` where
  a number is shown.
- **Settings.jsx** (the upgrade/manage/cancel surface): Free →
  "Free. Your newest {videoCap} videos, {summariesUsed} of {summaryQuota} TL;DRs used this
  month." + PRIMARY "Upgrade to Pro" button (same checkout flow as UpgradeBand incl. 404
  toast). Pro → "Pro. Your whole backlog, unlimited TL;DRs." or, when `me.proEndsAt`,
  "Pro until {formatDate(proEndsAt)}. Your library stays sorted after that." + "Manage
  subscription" (portal; still hidden for admins). Cancel and monthly↔annual switching
  happen inside Polar's portal.
- **VideoDetail.jsx**: quota fallback `|| 7` → `|| 100`; meter "{used} of {quota} TL;DRs
  used this month"; wall panel "Your monthly TL;DRs are used" / "They reset on the 1st. Pro
  is unlimited, across your whole library."; 404 checkout toast loses stale copy.
- **web/index.html**: Free card → "Your newest 1,000 videos, all sorted" / "100 TL;DR
  summaries every month" / taste learning / cleanup checklist. Pro card → **$4**/month +
  small line "or $40/year — two months free" / "Everything in Free" / "Your entire backlog —
  no video limit" / "Unlimited TL;DR summaries" / "Learn mode: the librarian teaches you the
  video". beta-note → "beta pricing · cancel anytime · fair use: 25,000 videos". Meta
  description (line ~7) + hero fine print (line ~125) lose "first 100". Also
  `web/public/terms.html` (~line 29): newest 1,000 free, 100 TL;DRs per calendar month,
  Pro fair-use 25,000.
- **No changes**: extension/, web/src/api.js (checkout/portal URLs unchanged), VideoCard,
  Row.

### Dependencies
package.json: REMOVE `stripe`; ADD `@polar-sh/sdk` (dependencies) and `standardwebhooks`
(devDependencies — it is the same Standard-Webhooks crypto `validateEvent` verifies, used to
sign test fixtures; signatures are compatible by construction).

### Implementation-time verification flags (check these, fallbacks specified)
- VERIFY-1: `validateEvent` body input type — Buffer vs string
  (`req.body.toString("utf8")` if needed).
- VERIFY-2: `validateEvent` zod strictness against hand-built fixtures + camelCase field
  names (`data.customer.externalId`, `data.customerId`, `data.cancelAtPeriodEnd`,
  `data.currentPeriodEnd`, `data.endsAt`). FALLBACK (fully acceptable): use
  `standardwebhooks`' `new Webhook(secret).verify(rawString, headers)` + `JSON.parse` and
  read snake_case fields, confined to `applySubscription`/`resolveUser` — the seam and tests
  are unchanged either way.
- VERIFY-3: monthly↔annual switching appears in the customer portal when the subscription's
  product has a sibling (if unsupported: the portal still covers cancel; document switch =
  cancel + re-checkout and soften the Settings copy).
- VERIFY-4: `customerEmail` alongside `externalCustomerId` in checkouts.create (drop the
  email if it 422s against an existing external customer).
- VERIFY-5: checkout `metadata` propagating onto the subscription (fallback resolution only;
  externalId is primary).

### Acceptance (tests)
- **tests/billing.test.js rewrite** — fake Polar client (`checkouts.create`,
  `customerSessions.create` echoing their inputs) + REAL Standard-Webhooks signing via the
  `standardwebhooks` `Webhook` class (mirror the existing fake-Stripe + real-crypto
  pattern): checkout returns url and passes products [monthly, annual] +
  externalCustomerId + successUrl containing `?upgraded=1`; portal 400 without a billing
  profile, 200 after a subscription webhook; garbage signature → 400 and plan stays free;
  `subscription.active` → pro with billing ids recorded, idempotent on replay;
  `subscription.canceled` (status active, cancel_at_period_end) → STILL pro +
  `/api/me.proEndsAt` set; `subscription.revoked` → free, board intact, import beyond
  `FREE_VIDEO_CAP` reports capped>0, classify-remaining 200s for the free user;
  `subscription.updated` active/unpaid transitions.
- **tests/routes.test.js** — freemium-split tests become cap tests (`FREE_VIDEO_CAP="120"`:
  import 150 → added 120 / capped 30 / willClassify 120 / locked 0, job created; after
  `setPlan(pro)` import 150 → added 150 / capped 0); "classify-remaining 402 for free" →
  "works for free users" (200 + willClassify); `/api/me` new contract: summaryQuota 100,
  summariesUsed 0, videoCap 1000 free / 25000 for the admin fixture, freeQuota and freeUsed
  `toBeUndefined()`.
- **tests/summaries.test.js** — keep the `FREE_SUMMARY_QUOTA: "7"` override so the wall
  test stays 8 videos; replace `summaries_used` assertions with `countSummariesThisMonth` /
  response meters; NEW monthly-reset boundary test: fill the quota → 402 → backdate the
  rows (`UPDATE summaries SET created_at = date_trunc('month', now()) - interval '1 day'
  WHERE user_id = $1`) → next summary 200s with `summariesUsed: 1`.
- **tests/db.test.js** — setPlan round-trips billing columns + endsAt;
  `getUserByBillingCustomer`; `countSummariesThisMonth` counts 2 fresh rows as 2 and ignores
  a backdated one; users default `video_cap === 1000`.
- **tests/video-detail.test.js** — meter copy fixtures ("N of 100 TL;DRs used this month").
- **Untouched**: tests/worker.test.js (free_used stat kept), transcript/caption/extension
  tests.
- FAKE mode boots with the "[billing] Polar env not set" note; checkout 404s; all existing
  suites stay green.

### Rollout (Fable runs after review)
1. Prod migration (`npm run migrate` — additive-only, safe while billing env is unset).
2. Deploy: this ships the new free tier immediately (newest-1,000 cap, classify-everything,
   100 TL;DR/month) with billing OFF — the intended pre-clearance state.
3. Sandbox end-to-end on local/preview env only (products $4/$40, webhook endpoint with the
   five subscription events, test card 4242… full loop: checkout → upgraded=1 flips pro →
   portal cancel → "Pro until {date}" → dashboard revoke → free with board intact).
4. Production billing stays OFF until the owner's OPT clearance (go-live = approved
   production org + prod products/webhook + four POLAR_* vars + POLAR_SERVER=production +
   redeploy + Vercel Hobby → Pro).

## 3. Definition of done (whole plan)

`npm test` green in both repos. `FAKE_LLM=1 DEV_FAKE_AUTH=1 npm start` still runs the entire
product with zero credentials. The console snippet still works untouched. On prod: connect the
extension → delta sync finds new videos → full sync count matches the console-snippet count →
TL;DR works on one video per category → migration reconciliation is clean → the bridge writes
one real vault note round-trip → auto-sync fires the next day and new videos are already sorted
when Joon opens the board.

## 4. Risks (and the intended mitigation, so you don't invent a different one)

- **YouTube DOM churn** → the extractor registry + `readPlaylistTotal` cross-check; the snippet
  is server-served and hot-fixable same-day while a store update crawls review.
- **Store rejection** → minimal permissions, no static content scripts, single purpose; the
  product still works via the console path, so rejection is a delay, not an outage.
- **Alarms unreliability** → `onStartup` catch-up. Manual Sync is the promise; auto is a bonus.
- **Multi-account YouTube** → popup states which account; site warns on email mismatch.
- **Token leakage** → sha256 at rest, imports-only scope, existing 5/hr + free-quota + 10K cap
  bound the blast radius, one-click revoke with `last_used_at` visible.
