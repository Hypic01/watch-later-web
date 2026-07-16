const PLAYER_RESPONSE_PATTERNS = [
  /\bytInitialPlayerResponse\s*=\s*/g,
  /\[\s*["']ytInitialPlayerResponse["']\s*\]\s*=\s*/g,
  /["']ytInitialPlayerResponse["']\s*:\s*/g,
];

function parseObjectAt(source, start) {
  let cursor = start;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  if (source[cursor] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = cursor; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(cursor, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

export function extractPlayerResponse(html) {
  if (typeof html !== "string" || !html) return null;

  for (const pattern of PLAYER_RESPONSE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const response = parseObjectAt(html, match.index + match[0].length);
      if (response) return response;
    }
  }

  return null;
}

function normalizedLanguage(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "-") : "";
}

function findPreferredTrack(tracks, preferredLanguages) {
  for (const preferred of preferredLanguages) {
    const exact = tracks.find((track) => normalizedLanguage(track?.languageCode) === preferred);
    if (exact) return exact;

    const regional = tracks.find((track) => {
      const language = normalizedLanguage(track?.languageCode);
      return language.startsWith(`${preferred}-`) || preferred.startsWith(`${language}-`);
    });
    if (regional) return regional;
  }
  return null;
}

export function pickCaptionTrack(tracks, prefLangs = ["en", "ko"]) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const usable = tracks.filter((track) => track && typeof track === "object");
  if (usable.length === 0) return null;

  const preferredLanguages = (Array.isArray(prefLangs) ? prefLangs : [prefLangs])
    .map(normalizedLanguage)
    .filter(Boolean);
  const manual = usable.filter((track) => String(track.kind || "").toLowerCase() !== "asr");
  const automatic = usable.filter((track) => String(track.kind || "").toLowerCase() === "asr");

  return findPreferredTrack(manual, preferredLanguages)
    || findPreferredTrack(automatic, preferredLanguages)
    || manual[0]
    || automatic[0]
    || null;
}

export function parseJson3(raw) {
  const data = JSON.parse(raw)
  const parts = []
  for (const ev of data.events ?? []) {
    if (!ev.segs) continue
    const text = ev.segs.map(s => s.utf8 ?? '').join('').trim()
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);
}

// Timedtext responses arrive as json3, as legacy XML, or — when YouTube
// distrusts the request — as an EMPTY 200. An empty body must read as "no
// captions served", never as a parse crash.
export function parseTimedtext(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").replace(/^\)\]\}'\n?/, "").trim();
  if (!text) return null;
  if (text[0] === "{") {
    try {
      return parseJson3(text) || null;
    } catch {
      return null;
    }
  }
  if (text[0] === "<") {
    const parts = [];
    for (const match of text.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)) {
      const cue = decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim();
      if (cue) parts.push(cue);
    }
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    return joined || null;
  }
  return null;
}


// Walk the get_transcript response for its cue segments, in order.
export function parseGetTranscript(json) {
  const parts = [];
  const visited = new WeakSet();
  const cueText = (snippet) => {
    if (typeof snippet?.simpleText === "string") return snippet.simpleText;
    if (Array.isArray(snippet?.runs)) return snippet.runs.map((run) => run?.text || "").join("");
    return "";
  };
  const walk = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.transcriptSegmentRenderer) {
      const cue = cueText(value.transcriptSegmentRenderer.snippet).trim();
      if (cue) parts.push(cue);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(json);
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  return joined || null;
}
