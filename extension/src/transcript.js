import {
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

// Runs INSIDE the watch page (MAIN world), fully self-contained — injected
// functions are serialized, so nothing here may reference module scope.
//
// Layer findings that shaped this (2026-07-15, verified in a live browser):
// - Raw timedtext URLs return an EMPTY 200 everywhere without the player's
//   `pot` proof token — even same-origin from inside the page. Dead end.
// - get_transcript 400s ("Precondition check failed") without the SAPISID
//   Authorization header YouTube's own JS attaches, and needs the params blob
//   the page embeds in ytInitialData — hand-built params are not accepted.
// - The most reliable source is the player itself: enable captions on the
//   muted player and capture its own token-bearing timedtext response.
export const runTranscriptProbe = async (arg) => {
  const out = { panelBody: null, captionBody: null, detail: [] };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    // ---- Layer A: the transcript panel API, requested the way the page would.
    try {
      let params = null;
      const walk = (value, seen) => {
        if (!value || typeof value !== "object" || seen.has(value) || params) return;
        seen.add(value);
        if (value.getTranscriptEndpoint && typeof value.getTranscriptEndpoint.params === "string") {
          params = value.getTranscriptEndpoint.params;
          return;
        }
        for (const child of Object.values(value)) walk(child, seen);
      };
      walk(window.ytInitialData || {}, new WeakSet());
      const cfg = window.ytcfg && typeof window.ytcfg.get === "function" ? window.ytcfg : null;
      const apiKey = cfg ? cfg.get("INNERTUBE_API_KEY") : null;
      const context = cfg ? cfg.get("INNERTUBE_CONTEXT") : null;
      if (params && apiKey && context) {
        const cookieValue = (name) => (document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)")) || [])[1] || null;
        const sapisid = cookieValue("SAPISID") || cookieValue("__Secure-3PAPISID");
        const headers = { "content-type": "application/json", "x-youtube-client-name": "1" };
        if (context.client && context.client.clientVersion) headers["x-youtube-client-version"] = context.client.clientVersion;
        if (context.client && context.client.visitorData) headers["x-goog-visitor-id"] = context.client.visitorData;
        if (sapisid && window.crypto && window.crypto.subtle) {
          const ts = Math.floor(Date.now() / 1000);
          const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(ts + " " + sapisid + " " + location.origin));
          const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
          headers.authorization = "SAPISIDHASH " + ts + "_" + hex;
          headers["x-origin"] = location.origin;
        }
        const response = await fetch("/youtubei/v1/get_transcript?key=" + encodeURIComponent(apiKey) + "&prettyPrint=false", {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ context, params }),
        });
        const body = await response.text();
        out.detail.push("panel " + response.status + " " + body.length + "b" + (headers.authorization ? " authed" : " anon"));
        if (response.ok && body) {
          out.panelBody = body;
          return out;
        }
      } else {
        out.detail.push("panel skipped (" + [params ? "" : "no params", apiKey ? "" : "no key", context ? "" : "no context"].filter(Boolean).join(", ") + ")");
      }
    } catch (error) {
      out.detail.push("panel error " + String((error && error.message) || error).slice(0, 60));
    }

    // ---- Layer B: make the player fetch captions itself and capture them.
    const captured = { url: null, body: null };
    const origFetch = window.fetch;
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    window.fetch = function (input, init) {
      const result = origFetch.apply(this, arguments);
      try {
        const url = String(typeof input === "object" && input !== null ? input.url : input);
        if (url.indexOf("/api/timedtext") >= 0) {
          captured.url = url;
          result.then((res) => res.clone().text()).then((text) => {
            if (text) captured.body = text;
          }).catch(() => {});
        }
      } catch { /* capture must never break the page */ }
      return result;
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__wllUrl = String(url);
      return OrigOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__wllUrl && this.__wllUrl.indexOf("/api/timedtext") >= 0) {
        captured.url = this.__wllUrl;
        this.addEventListener("load", () => {
          if (this.responseText) captured.body = this.responseText;
        });
      }
      return OrigSend.apply(this, arguments);
    };
    try {
      const player = document.getElementById("movie_player");
      if (!player) {
        out.detail.push("no player");
      } else {
        try { if (player.mute) player.mute(); } catch { /* keep going */ }
        try { if (player.loadModule) player.loadModule("captions"); } catch { /* keep going */ }
        try { if (player.setOption) player.setOption("captions", "reload", true); } catch { /* keep going */ }
        try { if (player.playVideo) player.playVideo(); } catch { /* keep going */ }
        try {
          const ccButton = document.querySelector(".ytp-subtitles-button");
          if (ccButton && ccButton.getAttribute("aria-pressed") !== "true") ccButton.click();
        } catch { /* keep going */ }
        const ticks = Number(arg && arg.playerWaitTicks) || 24;
        for (let i = 0; i < ticks; i += 1) {
          if (captured.body) break;
          await sleep(500);
        }
        if (!captured.body && captured.url) {
          try {
            const refetch = await origFetch(captured.url, { credentials: "include" });
            const text = await refetch.text();
            out.detail.push("captured-url refetch " + refetch.status + " " + text.length + "b");
            if (text) captured.body = text;
          } catch {
            out.detail.push("captured-url refetch failed");
          }
        }
        try { if (player.pauseVideo) player.pauseVideo(); } catch { /* done anyway */ }
      }
    } finally {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = OrigOpen;
      XMLHttpRequest.prototype.send = OrigSend;
    }
    if (captured.body) {
      out.captionBody = captured.body;
      out.detail.push("player captured " + captured.body.length + "b");
    } else {
      out.detail.push(captured.url ? "player url seen, body empty" : "player capture empty");
    }
    return out;
  } catch (error) {
    out.detail.push("probe crashed " + String((error && error.message) || error).slice(0, 60));
    return out;
  }
};

export function createTranscriptController({
  fetch: fetchImpl = globalThis.fetch,
  tabs,
  scripting,
  extractPlayerResponseImpl = extractPlayerResponse,
  pickCaptionTrackImpl = pickCaptionTrack,
  parseTimedtextImpl = parseTimedtext,
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
  // usually answers this with an empty 200 now, but it is one cheap request
  // and the parser treats emptiness as "not served".
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

    // Tab path: one background tab, one in-page probe that first asks the
    // transcript-panel API the way the page itself would, then drives the
    // muted player into fetching captions and captures its response.
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
        // The probe below can still succeed without a player response.
      }
      const playerResponse = pageResponse || directResponse;
      const track = pickCaptionTrackImpl(captionTracks(playerResponse), ["en", "ko"]);

      const probe = (await inTab(tab.id, runTranscriptProbe, [{ playerWaitTicks: 24 }])) || { detail: ["probe returned nothing"] };

      if (probe.panelBody) {
        let panelJson = null;
        try {
          panelJson = JSON.parse(probe.panelBody);
        } catch { /* fall through to the caption body */ }
        const transcript = panelJson ? parseGetTranscriptImpl(panelJson) : null;
        if (transcript) {
          return {
            ok: true,
            transcript,
            ...transcriptMetadata(playerResponse, track, track ? undefined : "panel"),
          };
        }
      }
      if (probe.captionBody) {
        const transcript = parseTimedtextImpl(probe.captionBody);
        if (transcript) {
          return { ok: true, transcript, ...transcriptMetadata(playerResponse, track) };
        }
      }

      const detail = Array.isArray(probe.detail) && probe.detail.length ? probe.detail.join("; ") : "no detail";
      if (!track) {
        throw new TranscriptFetchError("NO_CAPTIONS", "This video has no captions available.");
      }
      throw new TranscriptFetchError(
        "EMPTY_TRANSCRIPT",
        `YouTube would not hand over captions for this video (${detail}).`,
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
