// Import handling. The plan decides how much a library can HOLD (free keeps
// the newest freeVideoCap videos, pro gets the fair-use proVideoCap) and
// everything stored gets classified — there is no per-video paywall anymore
// (M8). Caps derive from plan at request time, never from the vestigial
// video_cap column, so downgrades keep everything already stored and simply
// stop new imports beyond the free cap.

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
    return user.isAdmin || dbUser.plan === "pro" || config.betaProForAll;
  }

  async function startJob(user, dbUser, tier, total) {
    const mode = total > config.batchThreshold ? "batch" : "sync";
    return db.createJob(user.id, { mode, tier, total });
  }

  return {
    async handleImport(user, body) {
      if (config.llmReady === false) {
        return { status: 503, body: { error: "the sorting engine isn't configured yet — check back soon" } };
      }
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
      const pro = isPro(user, dbUser);
      const cap = pro ? config.proVideoCap : config.freeVideoCap;
      const { added, duplicates, capped } = await db.upsertFromImport(user.id, videos, cap);
      await db.createImport(user.id, source, videos.length, added);

      // Everything stored gets classified, on every plan.
      const unscanned = await db.countUnscanned(user.id);
      let job = null;
      if (unscanned > 0) job = await startJob(user, dbUser, pro ? "pro" : "free", unscanned);

      return {
        status: 200,
        body: {
          added,
          duplicates,
          capped,
          jobId: job?.id ?? null,
          willClassify: unscanned,
          // The shipped extension forwards this field numerically; nothing is
          // ever locked anymore, so it stays 0 to avoid a coordinated release.
          locked: 0,
        },
      };
    },

    async classifyRemaining(user) {
      if (config.llmReady === false) {
        return { status: 503, body: { error: "the sorting engine isn't configured yet — check back soon" } };
      }
      const dbUser = await db.getUser(user.id);
      if (await db.getActiveJob(user.id)) {
        return { status: 409, body: { error: "a sort is already running — let it finish first" } };
      }
      const unscanned = await db.countUnscanned(user.id);
      if (!unscanned) return { status: 400, body: { error: "nothing left to sort" } };
      const job = await startJob(user, dbUser, isPro(user, dbUser) ? "pro" : "free", unscanned);
      return { status: 200, body: { jobId: job.id, willClassify: unscanned } };
    },
  };
}
