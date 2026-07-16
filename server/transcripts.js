import { extractPlayerResponse, pickCaptionTrack, parseJson3 } from "../collector/captions.js";

export class TranscriptFetchError extends Error {}

function json3Url(baseUrl) {
  return baseUrl.includes("?") ? `${baseUrl}&fmt=json3` : `${baseUrl}?fmt=json3`;
}

export function createTranscriptFetcher({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return {
    async fetchTranscript(videoId) {
      const controller = new AbortController();
      const timer = setTimer(() => controller.abort(), timeoutMs);
      try {
        const watch = await fetchImpl(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
          signal: controller.signal,
          headers: { "accept-language": "en-US,en;q=0.9,ko;q=0.8" },
        });
        if (watch && "ok" in watch && !watch.ok) {
          throw new TranscriptFetchError(`watch page returned ${watch.status}`);
        }
        const player = extractPlayerResponse(await watch.text());
        if (!player) throw new TranscriptFetchError("watch page did not contain player data");

        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const track = pickCaptionTrack(tracks, ["en", "ko"]);
        if (!track?.baseUrl) throw new TranscriptFetchError("no usable caption track");

        const captions = await fetchImpl(json3Url(track.baseUrl), { signal: controller.signal });
        if (captions && "ok" in captions && !captions.ok) {
          throw new TranscriptFetchError(`caption request returned ${captions.status}`);
        }
        const transcript = parseJson3(await captions.text());
        if (!transcript) throw new TranscriptFetchError("caption track was empty");

        const details = player.videoDetails || {};
        const microformat = player?.microformat?.playerMicroformatRenderer || {};
        const duration = Number(details.lengthSeconds);
        return {
          transcript,
          source: "server",
          description: details.shortDescription || null,
          uploadDate: microformat.uploadDate || null,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
          channel: details.author || null,
        };
      } catch (error) {
        if (error instanceof TranscriptFetchError) throw error;
        if (error?.name === "AbortError") throw new TranscriptFetchError("transcript request timed out");
        throw new TranscriptFetchError(error?.message || "transcript request failed");
      } finally {
        clearTimer(timer);
      }
    },
  };
}
