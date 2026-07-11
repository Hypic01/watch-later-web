// Core Watch Later collector. Runs inside the user's own logged-in browser
// (console snippet today, Chrome extension later). Strategy validated 2026-07-10
// against a real 2,796-video Watch Later: scroll-driven pagination with Polymer
// `.data` harvesting and aggressive DOM pruning (unpruned pages OOM-crash the
// tab past ~2,000 rendered items). 100% of available videos captured.

export const PAYLOAD_VERSION = 1;

export function isWatchLaterPage(loc) {
  try {
    const url = new URL(String(loc));
    return (
      /(^|\.)youtube\.com$/.test(url.hostname) &&
      url.pathname === "/playlist" &&
      url.searchParams.get("list") === "WL"
    );
  } catch {
    return false;
  }
}

// Normalize one playlistVideoRenderer data object (Polymer node `.data`).
export function extractVideoData(d) {
  if (!d || typeof d.videoId !== "string" || !d.videoId) return null;
  const runsText = (r) => (r && Array.isArray(r.runs) ? r.runs.map((x) => x.text).join("") : "");
  const duration = Number(d.lengthSeconds);
  const position = d.index && d.index.simpleText ? Number(d.index.simpleText) : null;
  return {
    id: d.videoId,
    title: runsText(d.title).slice(0, 300),
    channel: runsText(d.shortBylineText).trim().slice(0, 120),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    position: Number.isFinite(position) ? position : null,
    publishedText: d.videoInfo && Array.isArray(d.videoInfo.runs)
      ? d.videoInfo.runs.map((r) => r.text).join("").slice(0, 60)
      : null,
  };
}

// Scroll/harvest/prune loop. Everything injected for tests.
export function createCollector({ doc, win, sleep, scrollDelayMs = 1600, stallDelayMs = 1400, maxRounds = 150, keepNodes = 12 }) {
  const nodes = () => Array.from(doc.querySelectorAll("ytd-playlist-video-renderer"));

  async function collectAll({ onProgress } = {}) {
    const seen = new Map();
    const harvest = () => {
      for (const n of nodes()) {
        const v = extractVideoData(n.data);
        if (v && !seen.has(v.id)) seen.set(v.id, v);
      }
    };
    const prune = () => {
      const list = nodes();
      for (let i = 0; i < list.length - keepNodes; i++) list[i].remove();
    };

    let stall = 0;
    let rounds = 0;
    harvest();
    while (stall < 4 && rounds < maxRounds) {
      const before = seen.size;
      prune();
      win.scrollTo(0, doc.documentElement.scrollHeight);
      await sleep(scrollDelayMs);
      harvest();
      rounds++;
      if (onProgress) onProgress({ count: seen.size, rounds });
      if (seen.size === before) {
        stall++;
        await sleep(stallDelayMs);
        harvest();
      } else {
        stall = 0;
      }
    }

    const videos = Array.from(seen.values());
    return {
      videos,
      rounds,
      truncated: rounds >= maxRounds,
    };
  }

  return { collectAll };
}

export function buildPayload(videos, source) {
  return {
    v: PAYLOAD_VERSION,
    source: source || "console",
    collectedAt: new Date().toISOString(),
    videos,
  };
}
