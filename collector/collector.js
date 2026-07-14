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

function parseDurationText(text) {
  const parts = String(text || "").trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  return seconds > 0 ? seconds : null;
}

function metadataPartText(part) {
  const text = part?.text;
  if (typeof text === "string") return text;
  if (typeof text?.content === "string") return text.content;
  if (typeof text?.simpleText === "string") return text.simpleText;
  if (Array.isArray(text?.runs)) return text.runs.map((run) => run.text || "").join("");
  return "";
}

// Normalize one of YouTube's newer lockupViewModel objects. DOM `.data`
// sometimes wraps the model under the same key, while ytInitialData does.
export function extractLockupData(raw) {
  const d = raw?.lockupViewModel || raw;
  if (!d || typeof d !== "object") return null;
  if (d.contentType && d.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  const endpoint = d.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
  const id = typeof d.contentId === "string" && d.contentId ? d.contentId : endpoint?.videoId;
  if (typeof id !== "string" || !id) return null;

  const metadata = d.metadata?.lockupMetadataViewModel;
  const contentMetadata = metadata?.metadata?.contentMetadataViewModel;
  const rows = Array.isArray(contentMetadata?.metadataRows) ? contentMetadata.metadataRows : [];
  const channel = metadataPartText(rows[0]?.metadataParts?.[0]).trim().slice(0, 120);
  const publishedParts = Array.isArray(rows[1]?.metadataParts)
    ? rows[1].metadataParts.map(metadataPartText).filter(Boolean)
    : [];

  const overlays = Array.isArray(d.contentImage?.thumbnailViewModel?.overlays)
    ? d.contentImage.thumbnailViewModel.overlays
    : [];
  const durationTexts = [];
  for (const overlay of overlays) {
    const bottomBadges = overlay?.thumbnailBottomOverlayViewModel?.badges;
    const legacyBadges = overlay?.thumbnailOverlayBadgeViewModel?.thumbnailBadges;
    for (const badge of Array.isArray(bottomBadges) ? bottomBadges : []) {
      durationTexts.push(badge?.thumbnailBadgeViewModel?.text);
    }
    for (const badge of Array.isArray(legacyBadges) ? legacyBadges : []) {
      durationTexts.push(badge?.thumbnailBadgeViewModel?.text);
    }
  }
  const durationSeconds = durationTexts.map(parseDurationText).find((value) => value !== null) ?? null;

  const explicitPosition = Number(d.index?.simpleText ?? d.index);
  const endpointIndex = Number(endpoint?.index);
  const position = Number.isFinite(explicitPosition) && explicitPosition > 0
    ? explicitPosition
    : Number.isFinite(endpointIndex) && endpointIndex >= 0
      ? endpointIndex + 1
      : null;

  return {
    id,
    title: String(metadata?.title?.content || "").slice(0, 300),
    channel,
    durationSeconds,
    position,
    publishedText: publishedParts.length
      ? publishedParts.join(contentMetadata?.delimiter || " • ").slice(0, 60)
      : null,
  };
}

export const EXTRACTORS = [
  { selector: "ytd-playlist-video-renderer", extract: extractVideoData },
  { selector: "yt-lockup-view-model", extract: extractLockupData },
];

function selectedNodes(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return { nodes: [], extract: null };
  for (const entry of EXTRACTORS) {
    const nodes = Array.from(doc.querySelectorAll(entry.selector));
    if (nodes.length) return { nodes, extract: entry.extract };
  }
  return { nodes: [], extract: null };
}

export function parseInitialData(win, { fallbackLockupPosition = true } = {}) {
  const videos = new Map();
  const visited = new WeakSet();

  const add = (video, fallbackPosition = false) => {
    if (!video || videos.has(video.id)) return;
    videos.set(video.id, fallbackPosition && video.position === null
      ? { ...video, position: videos.size + 1 }
      : video);
  };

  const walk = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value.playlistVideoRenderer) add(extractVideoData(value.playlistVideoRenderer));
    if (value.lockupViewModel) {
      add(extractLockupData(value.lockupViewModel), fallbackLockupPosition);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "playlistVideoRenderer" && key !== "lockupViewModel") walk(child);
    }
  };

  walk(win?.ytInitialData);
  return Array.from(videos.values());
}

export function readInitialContinuationToken(win) {
  let token = null;
  const visited = new WeakSet();

  const tokenInside = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const candidates = [
      value.continuationCommand?.token,
      value.nextContinuationData?.continuation,
      value.reloadContinuationData?.continuation,
      value.continuationData?.continuation,
    ];
    const found = candidates.find((candidate) => typeof candidate === "string" && candidate);
    if (found) return found;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const nested = tokenInside(child, seen);
      if (nested) return nested;
    }
    return null;
  };

  const walk = (value) => {
    if (token !== null || !value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.continuationItemRenderer) {
      token = tokenInside(value.continuationItemRenderer);
      if (token !== null) return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };

  walk(win?.ytInitialData);
  return token;
}

function textValue(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  if (typeof value.simpleText === "string") return value.simpleText;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run.text || run.content || "").join("");
  return "";
}

function countValue(value) {
  const match = textValue(value).match(/\d[\d\s,.]*/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

export function readPlaylistTotal(win) {
  let total = null;
  const visited = new WeakSet();
  const walk = (value) => {
    if (total !== null || !value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const header = value.playlistHeaderRenderer;
    if (header) {
      for (const candidate of [header.numVideosText, header.briefStats?.[0], header.stats?.[0]]) {
        total = countValue(candidate);
        if (total !== null) return;
      }
    }
    const sidebar = value.playlistSidebarPrimaryInfoRenderer;
    if (sidebar) {
      total = countValue(sidebar.stats?.[0]);
      if (total !== null) return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(win?.ytInitialData);
  return total;
}

export function collectInitial({ doc, win }) {
  const videos = new Map(parseInitialData(win).map((video) => [video.id, video]));
  const selected = selectedNodes(doc);
  if (selected.extract) {
    for (const node of selected.nodes) {
      let video = selected.extract(node.data);
      if (!video || videos.has(video.id)) continue;
      if (selected.extract === extractLockupData && video.position === null) {
        video = { ...video, position: videos.size + 1 };
      }
      videos.set(video.id, video);
    }
  }
  return Array.from(videos.values());
}

// Scroll/harvest/prune loop. Everything injected for tests.
export function createCollector({
  doc,
  win,
  sleep,
  scrollDelayMs = 1600,
  stallDelayMs = 1400,
  maxRounds = 150,
  keepNodes = 12,
  getSupplementalVideos = () => [],
}) {
  const nodes = () => selectedNodes(doc);

  async function collectAll({ onProgress } = {}) {
    const seen = new Map();
    const harvest = () => {
      const selected = nodes();
      for (const n of selected.nodes) {
        const v = selected.extract(n.data);
        if (v && !seen.has(v.id)) seen.set(v.id, v);
      }
      for (const v of getSupplementalVideos() || []) {
        if (v?.id && !seen.has(v.id)) seen.set(v.id, v);
      }
    };
    const prune = () => {
      const list = nodes().nodes;
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
