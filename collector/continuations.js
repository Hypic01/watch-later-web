import { parseInitialData, readInitialContinuationToken } from "./collector.js";

// Browse continuation responses contain the same playlistVideoRenderer and
// lockupViewModel JSON shapes as ytInitialData. Route them through the same
// extractor path so a YouTube shape fix cannot drift between delta and full
// collection.
export function parseBrowseResponse(json) {
  let body = json;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { videos: [], continuationToken: null };
    }
  }
  if (!body || typeof body !== "object") {
    return { videos: [], continuationToken: null };
  }
  const win = { ytInitialData: body };
  return {
    videos: parseInitialData(win, { fallbackLockupPosition: false }),
    continuationToken: readInitialContinuationToken(win),
  };
}
