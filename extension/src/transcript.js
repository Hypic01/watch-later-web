import {
  extractPlayerResponse,
  parseJson3,
  pickCaptionTrack,
} from "../../collector/captions.js";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const DEFAULT_TAB_TIMEOUT_MS = 20000;

export class TranscriptFetchError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "TranscriptFetchError";
    this.code = code;
  }
}

function watchUrl(videoId) {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  return url.href;
}

function captionTracks(playerResponse) {
  const tracks = playerResponse?.captions
    ?.playerCaptionsTracklistRenderer
    ?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

function needsMainWorldFallback(playerResponse) {
  if (!playerResponse) return true;
  if (captionTracks(playerResponse).length > 0) return false;
  const status = String(playerResponse?.playabilityStatus?.status || "").toUpperCase();
  return Boolean(status && status !== "OK");
}

function captionUrl(baseUrl) {
  const separator = String(baseUrl).includes("?") ? "&" : "?";
  return `${baseUrl}${separator}fmt=json3`;
}

function textFromRuns(value) {
  if (typeof value?.simpleText === "string") return value.simpleText;
  if (!Array.isArray(value?.runs)) return null;
  const text = value.runs.map((run) => run?.text || "").join("").trim();
  return text || null;
}

function transcriptMetadata(playerResponse, track) {
  const details = playerResponse?.videoDetails || {};
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const seconds = Number(details.lengthSeconds);
  return {
    source: "extension",
    captionKind: track?.kind === "asr" ? "asr" : "manual",
    language: track?.languageCode || null,
    description: details.shortDescription || textFromRuns(microformat.description) || null,
    uploadDate: microformat.uploadDate || microformat.publishDate || null,
    durationSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds) : null,
    channel: details.author || null,
  };
}

export function createTranscriptController({
  fetch: fetchImpl = globalThis.fetch,
  tabs,
  scripting,
  extractPlayerResponseImpl = extractPlayerResponse,
  pickCaptionTrackImpl = pickCaptionTrack,
  parseJson3Impl = parseJson3,
  setTimeout: setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  tabTimeoutMs = DEFAULT_TAB_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function" || !tabs || !scripting) {
    throw new Error("fetch, tabs, and scripting are required");
  }

  const tabWaiters = new Map();

  function settleTab(tabId, method, value) {
    const waiter = tabWaiters.get(tabId);
    if (!waiter) return false;
    tabWaiters.delete(tabId);
    if (waiter.timer && typeof clearTimeoutImpl === "function") {
      clearTimeoutImpl(waiter.timer);
    }
    waiter[method](value);
    return true;
  }

  function waitForTab(tab) {
    if (tab?.status === "complete") return Promise.resolve(tab);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      tabWaiters.set(tab.id, waiter);
      if (typeof setTimeoutImpl === "function") {
        waiter.timer = setTimeoutImpl(() => {
          settleTab(tab.id, "reject", new TranscriptFetchError(
            "TAB_LOAD_TIMEOUT",
            "YouTube took too long to open the video.",
          ));
        }, tabTimeoutMs);
      }
      // The load event may land between tabs.create resolving and this waiter
      // being installed. Reconcile the current state after registration so a
      // fast background navigation cannot be missed.
      if (typeof tabs.get === "function") {
        Promise.resolve(tabs.get(tab.id)).then((current) => {
          if (current?.status === "complete") {
            settleTab(tab.id, "resolve", current);
          }
        }).catch(() => {});
      }
    });
  }

  async function playerResponseFromTab(videoId) {
    let tab = null;
    try {
      tab = await tabs.create({ url: watchUrl(videoId), active: false });
      if (!tab?.id) {
        throw new TranscriptFetchError("TAB_OPEN_FAILED", "YouTube could not be opened for captions.");
      }
      await waitForTab(tab);
      const results = await scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => window.ytInitialPlayerResponse || null,
      });
      return (results || []).find((entry) => entry?.result)?.result || null;
    } catch (error) {
      if (error instanceof TranscriptFetchError) throw error;
      throw new TranscriptFetchError(
        "PLAYER_RESPONSE_UNAVAILABLE",
        "YouTube did not expose captions for this video.",
        error,
      );
    } finally {
      if (tab?.id) {
        settleTab(tab.id, "reject", new TranscriptFetchError(
          "TAB_CLOSED",
          "The YouTube tab closed before captions were ready.",
        ));
        try {
          await tabs.remove(tab.id);
        } catch {
          // The user may have closed the temporary tab first.
        }
      }
    }
  }

  async function directPlayerResponse(videoId) {
    try {
      const response = await fetchImpl(watchUrl(videoId), { credentials: "include" });
      if (!response?.ok) return null;
      return extractPlayerResponseImpl(await response.text());
    } catch {
      return null;
    }
  }

  async function fetchTranscript(videoId) {
    const normalizedId = String(videoId || "").trim();
    if (!VIDEO_ID_RE.test(normalizedId)) {
      throw new TranscriptFetchError("INVALID_VIDEO_ID", "The video ID is invalid.");
    }

    let playerResponse = await directPlayerResponse(normalizedId);
    if (needsMainWorldFallback(playerResponse)) {
      playerResponse = await playerResponseFromTab(normalizedId);
    }
    if (!playerResponse) {
      throw new TranscriptFetchError(
        "PLAYER_RESPONSE_UNAVAILABLE",
        "YouTube did not expose captions for this video.",
      );
    }

    const track = pickCaptionTrackImpl(captionTracks(playerResponse), ["en", "ko"]);
    if (!track?.baseUrl) {
      throw new TranscriptFetchError("NO_CAPTIONS", "This video has no captions available.");
    }

    let response;
    try {
      response = await fetchImpl(captionUrl(track.baseUrl), { credentials: "include" });
    } catch (error) {
      throw new TranscriptFetchError(
        "CAPTION_FETCH_FAILED",
        "YouTube did not return captions for this video.",
        error,
      );
    }
    if (!response?.ok) {
      throw new TranscriptFetchError(
        "CAPTION_FETCH_FAILED",
        "YouTube did not return captions for this video.",
      );
    }

    let transcript;
    try {
      transcript = parseJson3Impl(await response.text());
    } catch (error) {
      throw new TranscriptFetchError(
        "CAPTION_PARSE_FAILED",
        "YouTube returned captions we could not read.",
        error,
      );
    }
    if (!transcript) {
      throw new TranscriptFetchError("EMPTY_TRANSCRIPT", "YouTube returned empty captions for this video.");
    }

    return {
      ok: true,
      transcript,
      ...transcriptMetadata(playerResponse, track),
    };
  }

  function handleTabUpdated(tabId, changeInfo = {}, tab = null) {
    if (changeInfo.status !== "complete" && tab?.status !== "complete") return false;
    return settleTab(tabId, "resolve", tab || { id: tabId, status: "complete" });
  }

  function handleTabRemoved(tabId) {
    return settleTab(tabId, "reject", new TranscriptFetchError(
      "TAB_CLOSED",
      "The YouTube tab closed before captions were ready.",
    ));
  }

  return {
    fetchTranscript,
    handleTabUpdated,
    handleTabRemoved,
  };
}
