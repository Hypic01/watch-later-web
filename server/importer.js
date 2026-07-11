// Import handling + the freemium split. An import stores everything (up to
// the per-user cap), then only min(free quota remaining, unscanned) gets a
// classify job on the free tier; the rest stays locked behind the paywall.
// classifyRemaining is the Pro unlock.

const VIDEO_ID_RE = /^[\w-]{5,20}$/;
const CONTROL_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");

function sanitizeVideos(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const v of raw.slice(0, 20000)) {
    if (!v || typeof v.id !== "string" || !VIDEO_ID_RE.test(v.id) || seen.has(v.id)) continue;
    seen.add(v.id);
    const clean = (s, max) =>
      String(s ?? "")
        .replace(CONTROL_RE, " ")
        .trim()
        .slice(0, max);
    out.push({
      id: v.id,
      title: clean(v.title, 300),
      channel: clean(v.channel, 120),
      durationSeconds: Number.isFinite(Number(v.durationSeconds)) && Number(v.durationSeconds) > 0 ? Math.floor(Number(v.durationSeconds)) : null,
      position: Number.isFinite(Number(v.position)) ? Math.floor(Number(v.position)) : null,
      publishedText: v.publishedText ? clean(v.publishedText, 60) : null,
    });
  }
  return out;
}

export function createImporter({ db, config }) {
  function isPro(user, dbUser) {
    return user.isAdmin || dbUser.plan === "pro";
  }

  async function startJob(user, dbUser, tier, total) {
    const mode = total > config.batchThreshold ? "batch" : "sync";
    return db.createJob(user.id, { mode, tier, total });
  }

  return {
    async handleImport(user, body) {
      if (config.betaAllowlist.length && !config.betaAllowlist.includes(user.email.toLowerCase()) && !user.isAdmin) {
        return { status: 403, body: { error: "the beta is invite-only right now — ask for an invite!" } };
      }
      const source = ["console", "extension", "file"].includes(body?.source) ? body.source : null;
      const videos = sanitizeVideos(body?.videos);
      if (!source || !videos) return { status: 400, body: { error: "malformed payload" } };
      if (!videos.length) return { status: 400, body: { error: "no valid videos in payload" } };

      const recent = await db.countRecentImports(user.id, 60);
      if (recent >= config.importsPerHour) {
        return { status: 429, body: { error: "too many imports — try again in an hour" } };
      }
      if (await db.getActiveJob(user.id)) {
        return { status: 409, body: { error: "a sort is already running — let it finish first" } };
      }

      const dbUser = await db.getUser(user.id);
      const { added, duplicates, capped } = await db.upsertFromImport(user.id, videos, dbUser.video_cap);
      await db.createImport(user.id, source, videos.length, added);

      const unscanned = await db.countUnscanned(user.id);
      let tier, willClassify;
      if (isPro(user, dbUser)) {
        tier = "pro";
        willClassify = unscanned;
      } else {
        tier = "free";
        willClassify = Math.min(Math.max(dbUser.free_quota - dbUser.free_used, 0), unscanned);
      }

      let job = null;
      if (willClassify > 0) job = await startJob(user, dbUser, tier, willClassify);

      return {
        status: 200,
        body: {
          added,
          duplicates,
          capped,
          jobId: job?.id ?? null,
          willClassify,
          locked: unscanned - willClassify,
        },
      };
    },

    async classifyRemaining(user) {
      const dbUser = await db.getUser(user.id);
      if (!isPro(user, dbUser)) {
        return { status: 402, body: { error: "sorting beyond your first 100 videos needs Pro", upgrade: true } };
      }
      if (await db.getActiveJob(user.id)) {
        return { status: 409, body: { error: "a sort is already running — let it finish first" } };
      }
      const unscanned = await db.countUnscanned(user.id);
      if (!unscanned) return { status: 400, body: { error: "nothing left to sort" } };
      const job = await startJob(user, dbUser, "pro", unscanned);
      return { status: 200, body: { jobId: job.id, willClassify: unscanned } };
    },
  };
}
