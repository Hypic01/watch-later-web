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
