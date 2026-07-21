// The published Chrome Web Store listing. The extension's own ID is configured
// separately (VITE_EXTENSION_ID) because detection and installation are different
// concerns: this URL is where a user without the extension goes.
export const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/watch-later-librarian-syn/iggeklmapgdaknfdblkhefnfaflbojeg";

export const SORTS = {
  "added-new": { label: "Added: newest", fn: (a, b) => (a.playlist_position ?? 1e9) - (b.playlist_position ?? 1e9) },
  "added-old": { label: "Added: oldest", fn: (a, b) => (b.playlist_position ?? -1) - (a.playlist_position ?? -1) },
  confident: { label: "AI most confident", fn: (a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) },
  uncertain: { label: "AI least confident", fn: (a, b) => (a.confidence ?? 2) - (b.confidence ?? 2) },
  shortest: { label: "Shortest first", fn: (a, b) => (a.duration_seconds ?? 1e9) - (b.duration_seconds ?? 1e9) },
  longest: { label: "Longest first", fn: (a, b) => (b.duration_seconds ?? -1) - (a.duration_seconds ?? -1) },
};

export function formatDuration(seconds) {
  if (seconds == null) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// The topbar shows how long ago the list was last refreshed. Relative reads as
// freshness at a glance; past a week it falls back to a plain date, since "9w
// ago" tells you less than the date itself would. Returns null on bad input so
// the caller can skip rendering. `now` is injectable for tests.
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// The exact stamp behind the relative label, surfaced on hover.
export function absoluteTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  return new Date(then).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const parseTopics = (v) => {
  if (Array.isArray(v.topics)) return v.topics;
  try {
    return JSON.parse(v.topics) ?? [];
  } catch {
    return [];
  }
};

// The onboarding quiz shares the classifier's topic vocabulary (server/classify.js
// TOPICS, minus the "other" catch-all). General YouTube genres, not one person's.
export const INTEREST_OPTIONS = [
  "music", "gaming", "comedy", "movies & tv", "sports",
  "news & politics", "learning & how-to", "tech", "science", "food & cooking",
  "travel", "health & fitness", "beauty & fashion", "money & business",
  "vlogs & daily life", "cars",
];
