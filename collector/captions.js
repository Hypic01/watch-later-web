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
