import {
  collectInitial,
  createCollector,
  parseInitialData,
  readInitialContinuationToken,
  readPlaylistTotal,
} from "../../collector/collector.js";
import { parseBrowseResponse } from "../../collector/continuations.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_PROGRESS,
  COLLECT_START,
} from "./messages.js";

const DEFAULT_MINIMUM_HARVEST_RATIO = 0.5;
const DEFAULT_CAPTURE_DRAIN_TIMEOUT_MS = 10000;
const LISTENER_KEY = Symbol.for("wll.collector-driver.listener");

class CollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollectionError";
    this.code = code;
  }
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  try {
    return String(input || "");
  } catch {
    return "";
  }
}

function isBrowseRequest(input, win) {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const base = win?.location?.href || "https://www.youtube.com/";
    return new URL(raw, base).pathname === "/youtubei/v1/browse";
  } catch {
    return false;
  }
}

function mergeVideos(...groups) {
  const videos = new Map();
  for (const group of groups) {
    for (const video of group || []) {
      if (video?.id && !videos.has(video.id)) videos.set(video.id, video);
    }
  }
  return Array.from(videos.values());
}

export function isMateriallyShort(
  count,
  expectedTotal,
  { minimumHarvestRatio = DEFAULT_MINIMUM_HARVEST_RATIO } = {},
) {
  const expected = Number(expectedTotal);
  const harvested = Number(count);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(harvested)) return false;
  const threshold = Number(minimumHarvestRatio);
  const ratio = Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? threshold
    : DEFAULT_MINIMUM_HARVEST_RATIO;
  return harvested < expected * ratio;
}

// Installed only while a full collection is running. It observes the browser's
// own continuation requests and never consumes the response object YouTube sees.
export function installBrowseCapture({
  win,
  onVideos = () => {},
  onResponse = () => {},
  parse = parseBrowseResponse,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
}) {
  const pending = new Set();
  const originalFetch = typeof win?.fetch === "function" ? win.fetch : null;
  const xhrPrototype = win?.XMLHttpRequest?.prototype || null;
  const originalOpen = typeof xhrPrototype?.open === "function" ? xhrPrototype.open : null;
  const originalSend = typeof xhrPrototype?.send === "function" ? xhrPrototype.send : null;
  const xhrRequests = new WeakMap();
  let wrappedFetch = null;
  let wrappedOpen = null;
  let wrappedSend = null;
  let requestSequence = 0;
  let nextDelivery = 1;
  const completed = new Map();

  const deliver = (sequence, result) => {
    if (sequence < nextDelivery || completed.has(sequence)) return;
    completed.set(sequence, result);
    while (completed.has(nextDelivery)) {
      const next = completed.get(nextDelivery);
      completed.delete(nextDelivery);
      nextDelivery++;
      if (!next) continue;
      try {
        if (next.videos.length) onVideos(next.videos);
        onResponse(next);
      } catch {
        // Collection callbacks are observers. YouTube's own response flow must
        // never fail because an observer disappeared or rejected a payload.
      }
    }
  };

  const acceptBody = (body, sequence) => {
    if (typeof body === "string") {
      try {
        JSON.parse(body);
      } catch {
        deliver(sequence, null);
        return;
      }
    } else if (!body || typeof body !== "object") {
      deliver(sequence, null);
      return;
    }
    try {
      const parsed = parse(body);
      const videos = Array.isArray(parsed?.videos)
        ? parsed.videos
        : Array.isArray(parsed)
          ? parsed
          : [];
      const continuationToken = typeof parsed?.continuationToken === "string"
        && parsed.continuationToken
        ? parsed.continuationToken
        : null;
      deliver(sequence, { videos, continuationToken });
    } catch {
      deliver(sequence, null);
    }
  };

  const track = (promise) => {
    const task = Promise.resolve(promise).catch(() => {});
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };

  const captureFetchResponse = async (response, sequence) => {
    try {
      const copy = typeof response?.clone === "function" ? response.clone() : null;
      if (!copy) {
        deliver(sequence, null);
        return;
      }
      if (typeof copy.json === "function") {
        acceptBody(await copy.json(), sequence);
      } else if (typeof copy.text === "function") {
        acceptBody(await copy.text(), sequence);
      } else {
        deliver(sequence, null);
      }
    } catch {
      deliver(sequence, null);
      // YouTube must still receive its untouched response. Completeness checks
      // below turn a meaningful capture failure into a loud collection error.
    }
  };

  const captureXhrResponse = (xhr, sequence) => {
    try {
      const body = xhr.responseType === "json"
        ? xhr.response
        : typeof xhr.responseText === "string"
          ? xhr.responseText
          : xhr.response;
      acceptBody(body, sequence);
    } catch {
      deliver(sequence, null);
      // Accessing responseText can throw for non-text response types. Those
      // bodies are ignored and the final total check remains authoritative.
    }
  };

  const restore = () => {
    if (originalFetch) win.fetch = originalFetch;
    if (xhrPrototype && originalOpen) xhrPrototype.open = originalOpen;
    if (xhrPrototype && originalSend) xhrPrototype.send = originalSend;
  };

  try {
    if (originalFetch) {
      wrappedFetch = function wllCapturedFetch(...args) {
        const responsePromise = Reflect.apply(originalFetch, this, args);
        if (isBrowseRequest(args[0], win)) {
          const sequence = ++requestSequence;
          track(Promise.resolve(responsePromise).then(
            (response) => captureFetchResponse(response, sequence),
            () => deliver(sequence, null),
          ));
        }
        return responsePromise;
      };
      win.fetch = wrappedFetch;
    }

    if (xhrPrototype && originalOpen && originalSend) {
      wrappedOpen = function wllCapturedOpen(method, url, ...rest) {
        xhrRequests.set(this, { browse: isBrowseRequest(url, win), listening: false });
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
      };
      wrappedSend = function wllCapturedSend(...args) {
        const request = xhrRequests.get(this);
        if (request?.browse && !request.listening && typeof this.addEventListener === "function") {
          request.listening = true;
          request.sequence = ++requestSequence;
          let finish;
          track(new Promise((resolve) => { finish = resolve; }));
          this.addEventListener("loadend", () => {
            try {
              captureXhrResponse(this, request.sequence);
            } finally {
              finish();
            }
          }, { once: true });
          try {
            return Reflect.apply(originalSend, this, args);
          } catch (error) {
            deliver(request.sequence, null);
            finish();
            throw error;
          }
        }
        return Reflect.apply(originalSend, this, args);
      };
      xhrPrototype.open = wrappedOpen;
      xhrPrototype.send = wrappedSend;
    }
  } catch (error) {
    restore();
    throw error;
  }

  return {
    async drain({ timeoutMs = DEFAULT_CAPTURE_DRAIN_TIMEOUT_MS } = {}) {
      if (!pending.size) return;
      const waitForPending = async () => {
        while (pending.size) {
          await Promise.allSettled(Array.from(pending));
        }
      };
      let timer = null;
      try {
        await Promise.race([
          waitForPending(),
          new Promise((_, reject) => {
            timer = setTimer(() => reject(new CollectionError(
              "CAPTURE_TIMEOUT",
              "YouTube did not finish exposing the playlist data in time. Nothing was imported.",
            )), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== null) clearTimer(timer);
      }
    },
    restore,
  };
}

export function createCollectorDriver({
  doc,
  win,
  sleep,
  postMessage,
  createCollectorImpl = createCollector,
  collectInitialImpl = collectInitial,
  parseInitialDataImpl = parseInitialData,
  readInitialContinuationTokenImpl = readInitialContinuationToken,
  readPlaylistTotalImpl = readPlaylistTotal,
  installBrowseCaptureImpl = installBrowseCapture,
  collectorOptions = {},
  completeness = {},
  captureDrainTimeoutMs = DEFAULT_CAPTURE_DRAIN_TIMEOUT_MS,
}) {
  const emit = (type, runId, payload = {}) => {
    postMessage({ __wll: true, type, runId, ...payload });
  };

  async function collect({ mode = "delta", runId } = {}) {
    try {
      if (mode !== "delta" && mode !== "full") {
        throw new CollectionError("INVALID_MODE", "Choose either delta or full sync.");
      }
      if (win?.ytcfg?.get?.("LOGGED_IN") === false) {
        throw new CollectionError("SIGNED_OUT", "Sign in to YouTube, then try syncing again.");
      }

      const expectedTotal = readPlaylistTotalImpl(win);
      if (mode === "delta") {
        const videos = collectInitialImpl({ doc, win });
        emit(COLLECT_PROGRESS, runId, { count: videos.length, expectedTotal });
        emit(COLLECT_DONE, runId, { videos, truncated: false });
        return { ok: true, videos, truncated: false, expectedTotal };
      }
      if (
        expectedTotal === null ||
        expectedTotal === undefined ||
        expectedTotal === "" ||
        !Number.isFinite(Number(expectedTotal)) ||
        Number(expectedTotal) < 0
      ) {
        throw new CollectionError(
          "PLAYLIST_TOTAL_UNKNOWN",
          "YouTube did not expose the playlist total, so completeness could not be verified. Nothing was imported.",
        );
      }

      const initialVideos = parseInitialDataImpl(win);
      const initialHasMore = readInitialContinuationTokenImpl(win) !== null;
      let hasMore = initialHasMore;
      let capturedResponseCount = 0;
      const supplemental = new Map(initialVideos.map((video) => [video.id, video]));
      let supplementalPosition = Math.max(
        supplemental.size,
        ...initialVideos.map((video) => {
          const position = Number(video.position);
          return Number.isFinite(position) && position > 0 ? position : 0;
        }),
      );
      const capture = installBrowseCaptureImpl({
        win,
        onResponse({ videos, continuationToken }) {
          capturedResponseCount++;
          hasMore = continuationToken !== null;
          for (const video of videos) {
            if (!video?.id || supplemental.has(video.id)) continue;
            const position = Number(video.position);
            const hasForwardPosition = Number.isFinite(position)
              && position > supplementalPosition;
            const normalized = hasForwardPosition
              ? { ...video, position }
              : { ...video, position: supplementalPosition + 1 };
            supplemental.set(video.id, normalized);
            supplementalPosition = normalized.position;
          }
        },
      });

      let result;
      let videos;
      try {
        const collector = createCollectorImpl({
          doc,
          win,
          sleep,
          ...collectorOptions,
          getSupplementalVideos: () => supplemental.values(),
        });
        result = await collector.collectAll({
          onProgress({ count }) {
            emit(COLLECT_PROGRESS, runId, { count, expectedTotal });
          },
        });
        await capture.drain({ timeoutMs: captureDrainTimeoutMs });
        videos = mergeVideos(result.videos, supplemental.values());

        const structurallyTruncated = capturedResponseCount > 0 && hasMore;
        const needsFallback = initialHasMore && capturedResponseCount === 0;
        const catastrophicallyShort = needsFallback
          && isMateriallyShort(videos.length, expectedTotal, completeness);
        if (structurallyTruncated || catastrophicallyShort) {
          throw new CollectionError(
            "TRUNCATED",
            "We could not read the whole Watch Later list. Try again and keep the YouTube tab visible.",
          );
        }
      } finally {
        capture.restore();
      }

      const paginationComplete = !initialHasMore || capturedResponseCount > 0;
      const unavailable = paginationComplete
        ? Math.max(0, Number(expectedTotal) - videos.length)
        : null;
      emit(COLLECT_DONE, runId, {
        videos,
        truncated: false,
        unavailable,
      });
      return { ok: true, videos, truncated: false, expectedTotal, unavailable };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "COLLECT_FAILED";
      const message = error instanceof Error ? error.message : String(error || "Collection failed.");
      emit(COLLECT_ERROR, runId, { code, error: message });
      return { ok: false, code, error: message };
    }
  }

  return { collect };
}

export function registerMainWorldListener(
  win,
  { createDriverImpl = createCollectorDriver } = {},
) {
  if (!win?.addEventListener || win[LISTENER_KEY]) return;
  let activeRunId = null;
  let lastTerminalMessage = null;
  const targetOrigin = win.location?.origin || "*";
  const sendToRelay = (message) => {
    if (message?.type === COLLECT_DONE || message?.type === COLLECT_ERROR) {
      lastTerminalMessage = message;
    }
    win.postMessage(message, targetOrigin);
  };
  const driver = createDriverImpl({
    doc: win.document,
    win,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    postMessage: sendToRelay,
  });

  win.addEventListener("message", (event) => {
    const message = event.data;
    const runId = message?.runId ?? "";
    if (
      event.source !== win ||
      !message?.__wll ||
      message.type !== COLLECT_START ||
      activeRunId !== null
    ) {
      return;
    }
    if (lastTerminalMessage?.runId === runId) {
      sendToRelay(lastTerminalMessage);
      return;
    }
    activeRunId = runId;
    void driver.collect({ mode: message.mode, runId: message.runId }).finally(() => {
      activeRunId = null;
    });
  });
  win[LISTENER_KEY] = true;
}

if (typeof window !== "undefined") registerMainWorldListener(window);
