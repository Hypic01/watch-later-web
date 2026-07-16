import {
  buildGetTranscriptParams,
  extractPlayerResponse,
  parseGetTranscript,
  parseTimedtext,
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

function transcriptMetadata(playerResponse, track, captionKind) {
  const details = playerResponse?.videoDetails || {};
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const seconds = Number(details.lengthSeconds);
  return {
    source: "extension",
    captionKind: captionKind || (track?.kind === "asr" ? "asr" : "manual"),
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
  parseTimedtextImpl = parseTimedtext,
  buildGetTranscriptParamsImpl = buildGetTranscriptParams,
  parseGetTranscriptImpl = parseGetTranscript,
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

  async function inTab(tabId, func, args) {
    const results = await scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      ...(args ? { args } : {}),
    });
    return (results || []).find((entry) => entry && "result" in entry)?.result ?? null;
  }

  const readPlayerResponse = () => window.ytInitialPlayerResponse || null;

  // Runs inside the page, so the request is same-origin with full page
  // context — the timedtext endpoint returns an empty 200 to anything else.
  const fetchTextInPage = async (arg) => {
    try {
      const response = await fetch(arg.url, { credentials: "include" });
      return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, body: "", error: String(error) };
    }
  };

  // The transcript panel's own API, called with the page's live ytcfg.
  const fetchPanelTranscriptInPage = async (arg) => {
    try {
      const get = (key) => (window.ytcfg && typeof window.ytcfg.get === "function"
        ? window.ytcfg.get(key)
        : undefined);
      const apiKey = get("INNERTUBE_API_KEY");
      const context = get("INNERTUBE_CONTEXT");
      if (!apiKey || !context) return { ok: false, status: 0, body: "", error: "NO_YTCFG" };
      const response = await fetch(
        `/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, params: arg.params }),
        },
      );
      return { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      return { ok: false, status: 0, body: "", error: String(error) };
    }
  };

  async function directPlayerResponse(videoId) {
    try {
      const response = await fetchImpl(watchUrl(videoId), { credentials: "include" });
      if (!response?.ok) return null;
      return extractPlayerResponseImpl(await response.text());
    } catch {
      return null;
    }
  }

  // Fast path: fetch the caption file from the service worker. YouTube
  // increasingly answers this with an empty 200 (the request is cross-origin
  // from the extension), in which case the tab path below takes over.
  async function captionsViaWorker(track) {
    if (!track?.baseUrl) return null;
    try {
      const response = await fetchImpl(captionUrl(track.baseUrl), { credentials: "include" });
      if (!response?.ok) return null;
      return parseTimedtextImpl(await response.text());
    } catch {
      return null;
    }
  }

  async function fetchTranscript(videoId) {
    const normalizedId = String(videoId || "").trim();
    if (!VIDEO_ID_RE.test(normalizedId)) {
      throw new TranscriptFetchError("INVALID_VIDEO_ID", "The video ID is invalid.");
    }

    const directResponse = await directPlayerResponse(normalizedId);
    const directTrack = pickCaptionTrackImpl(captionTracks(directResponse), ["en", "ko"]);
    const workerTranscript = await captionsViaWorker(directTrack);
    if (workerTranscript) {
      return { ok: true, transcript: workerTranscript, ...transcriptMetadata(directResponse, directTrack) };
    }

    // Tab path: one background tab serves every remaining attempt — reading
    // the page's own player response, fetching captions with page context,
    // and finally YouTube's transcript-panel API.
    let tab = null;
    try {
      tab = await tabs.create({ url: watchUrl(normalizedId), active: false });
      if (!tab?.id) {
        throw new TranscriptFetchError("TAB_OPEN_FAILED", "YouTube could not be opened for captions.");
      }
      await waitForTab(tab);

      let pageResponse = null;
      try {
        pageResponse = await inTab(tab.id, readPlayerResponse);
      } catch {
        // The panel API below can still succeed without a player response.
      }
      const playerResponse = pageResponse || directResponse;
      const track = pickCaptionTrackImpl(captionTracks(playerResponse), ["en", "ko"]);

      if (track?.baseUrl) {
        const fetched = await inTab(tab.id, fetchTextInPage, [{ url: captionUrl(track.baseUrl) }]);
        const transcript = fetched?.ok ? parseTimedtextImpl(fetched.body) : null;
        if (transcript) {
          return { ok: true, transcript, ...transcriptMetadata(playerResponse, track) };
        }
      }

      const params = buildGetTranscriptParamsImpl(normalizedId);
      const panel = await inTab(tab.id, fetchPanelTranscriptInPage, [{ params }]);
      if (panel?.ok && panel.body) {
        let panelJson = null;
        try {
          panelJson = JSON.parse(panel.body);
        } catch {
          // Treated as no transcript below.
        }
        const transcript = panelJson ? parseGetTranscriptImpl(panelJson) : null;
        if (transcript) {
          return {
            ok: true,
            transcript,
            ...transcriptMetadata(playerResponse, track, track ? undefined : "panel"),
          };
        }
      }

      if (!track) {
        throw new TranscriptFetchError("NO_CAPTIONS", "This video has no captions available.");
      }
      throw new TranscriptFetchError(
        "EMPTY_TRANSCRIPT",
        "YouTube would not hand over captions for this video. Try again in a moment.",
      );
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
