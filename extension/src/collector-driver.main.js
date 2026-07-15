import {
  collectInitial,
  createCollector,
  isMateriallyShort,
  parseInitialData,
  readInitialContinuationToken,
  readPlaylistTotal,
} from "../../collector/collector.js";
import { parseBrowseResponse } from "../../collector/continuations.js";
import { createYtcfgRequestTemplate } from "../../collector/innertube.js";
import {
  createContinuationPaginator,
  hasContinuationItems,
} from "../../collector/pagination.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_PROGRESS,
  COLLECT_START,
} from "./messages.js";

const DEFAULT_CAPTURE_DRAIN_TIMEOUT_MS = 7000;
const DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS = 1500;
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
    const request = new URL(raw, base);
    const page = new URL(base);
    return request.origin === page.origin && request.pathname === "/youtubei/v1/browse";
  } catch {
    return false;
  }
}

function absoluteRequestUrl(input, win) {
  const raw = requestUrl(input);
  if (!raw) return "";
  try {
    return new URL(raw, win?.location?.href || "https://www.youtube.com/").href;
  } catch {
    return raw;
  }
}

function headerPairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .filter((entry) => Array.isArray(entry) && entry.length >= 2)
      .map(([name, value]) => [String(name), String(value)]);
  }
  if (typeof headers.forEach === "function") {
    const pairs = [];
    headers.forEach((value, name) => pairs.push([String(name), String(value)]));
    return pairs;
  }
  if (typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => [String(name), String(value)]);
  }
  return [];
}

function bodyObject(body) {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

function requestContinuation(body) {
  const parsed = bodyObject(body);
  return typeof parsed?.continuation === "string" && parsed.continuation
    ? parsed.continuation
    : null;
}

function copiedFetchInit(input, init, body) {
  const source = init && typeof init === "object" ? init : {};
  const request = input && typeof input === "object" ? input : {};
  const copied = { ...source };
  delete copied.signal;
  copied.method = String(source.method || request.method || "POST").toUpperCase();
  copied.headers = headerPairs(source.headers ?? request.headers);
  copied.body = typeof body === "string" ? body : JSON.stringify(body);
  for (const key of [
    "cache",
    "credentials",
    "integrity",
    "keepalive",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
  ]) {
    if (copied[key] === undefined && request[key] !== undefined) copied[key] = request[key];
  }
  return copied;
}

async function fetchRequestTemplate(input, init, win) {
  let body = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : undefined;
  if (body === undefined && input && typeof input.clone === "function") {
    try {
      const copy = input.clone();
      if (typeof copy.text === "function") body = await copy.text();
    } catch {
      return null;
    }
  }
  const parsed = bodyObject(body);
  if (!parsed) return null;
  return {
    token: requestContinuation(parsed),
    template: {
      url: absoluteRequestUrl(input, win),
      init: copiedFetchInit(input, init, parsed),
    },
  };
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

function normalizeVideoOrder(...groups) {
  const merged = mergeVideos(...groups);
  let nextPosition = 0;
  return merged.map((video) => {
    const position = Number(video?.position);
    if (Number.isFinite(position) && position > 0) {
      nextPosition = Math.max(nextPosition, position);
      return video;
    }
    nextPosition++;
    return { ...video, position: nextPosition };
  });
}

export { isMateriallyShort };

// Installed only while a full collection is running. It observes the browser's
// own continuation requests and never consumes the response object YouTube sees.
export function installBrowseCapture({
  win,
  onVideos = () => {},
  onResponse = () => {},
  onRequest = () => {},
  expectedToken = null,
  parse = parseBrowseResponse,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
}) {
  const pending = new Set();
  const originalFetch = typeof win?.fetch === "function" ? win.fetch : null;
  const xhrPrototype = win?.XMLHttpRequest?.prototype || null;
  const originalOpen = typeof xhrPrototype?.open === "function" ? xhrPrototype.open : null;
  const originalSend = typeof xhrPrototype?.send === "function" ? xhrPrototype.send : null;
  const originalSetRequestHeader = typeof xhrPrototype?.setRequestHeader === "function"
    ? xhrPrototype.setRequestHeader
    : null;
  const xhrRequests = new WeakMap();
  let wrappedFetch = null;
  let wrappedOpen = null;
  let wrappedSend = null;
  let wrappedSetRequestHeader = null;
  let requestSequence = 0;
  let nextDelivery = 1;
  const completed = new Map();
  let firstRequest = null;
  let firstResponse = null;
  let resolveFirstRequest;
  const firstRequestPromise = new Promise((resolve) => { resolveFirstRequest = resolve; });

  const acceptRequest = (candidate) => {
    if (
      firstRequest ||
      !candidate?.template?.url ||
      (expectedToken !== null && candidate.token !== expectedToken)
    ) {
      return candidate;
    }
    firstRequest = candidate.template;
    resolveFirstRequest(firstRequest);
    try {
      onRequest(firstRequest);
    } catch {
      // Request capture is observational. Never disturb YouTube's request.
    }
    return candidate;
  };

  const deliver = (sequence, result) => {
    if (sequence < nextDelivery || completed.has(sequence)) return;
    completed.set(sequence, result);
    while (completed.has(nextDelivery)) {
      const next = completed.get(nextDelivery);
      completed.delete(nextDelivery);
      nextDelivery++;
      if (!next) continue;
      if (
        firstResponse === null &&
        expectedToken !== null &&
        next.requestToken === expectedToken
      ) {
        firstResponse = next;
      }
      try {
        if (next.videos.length) onVideos(next.videos);
        onResponse(next);
      } catch {
        // Collection callbacks are observers. YouTube's own response flow must
        // never fail because an observer disappeared or rejected a payload.
      }
    }
  };

  const acceptBody = (body, sequence, request = {}, response = {}) => {
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
      deliver(sequence, {
        videos,
        continuationToken,
        continuationItems: hasContinuationItems(body),
        requestToken: request?.token || null,
        status: Number.isFinite(Number(response?.status)) ? Number(response.status) : null,
        ok: response?.ok !== false,
      });
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

  const captureFetchResponse = async (response, sequence, requestPromise) => {
    try {
      const request = await requestPromise;
      const copy = typeof response?.clone === "function" ? response.clone() : null;
      if (!copy) {
        deliver(sequence, null);
        return;
      }
      if (typeof copy.json === "function") {
        acceptBody(await copy.json(), sequence, request, response);
      } else if (typeof copy.text === "function") {
        acceptBody(await copy.text(), sequence, request, response);
      } else {
        deliver(sequence, null);
      }
    } catch {
      deliver(sequence, null);
      // YouTube must still receive its untouched response. Completeness checks
      // below turn a meaningful capture failure into a loud collection error.
    }
  };

  const captureXhrResponse = (xhr, sequence, request) => {
    try {
      const body = xhr.responseType === "json"
        ? xhr.response
        : typeof xhr.responseText === "string"
          ? xhr.responseText
          : xhr.response;
      acceptBody(body, sequence, request, {
        status: xhr.status,
        ok: !Number.isFinite(Number(xhr.status)) || Number(xhr.status) < 400,
      });
    } catch {
      deliver(sequence, null);
      // Accessing responseText can throw for non-text response types. Those
      // bodies are ignored and the final total check remains authoritative.
    }
  };

  const restore = () => {
    try {
      if (xhrPrototype && originalSend && xhrPrototype.send === wrappedSend) {
        xhrPrototype.send = originalSend;
      }
    } catch { /* Continue restoring the remaining hooks. */ }
    try {
      if (
        xhrPrototype &&
        originalSetRequestHeader &&
        xhrPrototype.setRequestHeader === wrappedSetRequestHeader
      ) {
        xhrPrototype.setRequestHeader = originalSetRequestHeader;
      }
    } catch { /* Continue restoring the remaining hooks. */ }
    try {
      if (xhrPrototype && originalOpen && xhrPrototype.open === wrappedOpen) {
        xhrPrototype.open = originalOpen;
      }
    } catch { /* Continue restoring the remaining hooks. */ }
    try {
      if (originalFetch && win.fetch === wrappedFetch) win.fetch = originalFetch;
    } catch { /* The page may have made fetch read only during navigation. */ }
  };

  try {
    if (originalFetch) {
      wrappedFetch = function wllCapturedFetch(...args) {
        const browse = isBrowseRequest(args[0], win);
        // Clone a Request body before fetch marks the original as consumed.
        // This starts capture without delaying or replacing YouTube's promise.
        const requestPromise = browse
          ? Promise.resolve(fetchRequestTemplate(args[0], args[1], win)).then(acceptRequest)
          : null;
        const responsePromise = Reflect.apply(originalFetch, this, args);
        if (browse) {
          const sequence = ++requestSequence;
          track(Promise.resolve(responsePromise).then(
            (response) => captureFetchResponse(response, sequence, requestPromise),
            () => deliver(sequence, null),
          ));
        }
        return responsePromise;
      };
      win.fetch = wrappedFetch;
    }

    if (xhrPrototype && originalOpen && originalSend) {
      wrappedOpen = function wllCapturedOpen(method, url, ...rest) {
        xhrRequests.set(this, {
          browse: isBrowseRequest(url, win),
          listening: false,
          method: String(method || "POST").toUpperCase(),
          url: absoluteRequestUrl(url, win),
          headers: [],
        });
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
      };
      if (originalSetRequestHeader) {
        wrappedSetRequestHeader = function wllCapturedSetRequestHeader(name, value) {
          const request = xhrRequests.get(this);
          if (request?.browse) request.headers.push([String(name), String(value)]);
          return Reflect.apply(originalSetRequestHeader, this, [name, value]);
        };
      }
      wrappedSend = function wllCapturedSend(...args) {
        const request = xhrRequests.get(this);
        if (request?.browse && !request.listening && typeof this.addEventListener === "function") {
          request.listening = true;
          request.sequence = ++requestSequence;
          const parsedBody = bodyObject(args[0]);
          request.token = requestContinuation(parsedBody);
          request.template = parsedBody ? {
            url: request.url,
            init: {
              method: request.method,
              headers: request.headers.map((entry) => [...entry]),
              body: JSON.stringify(parsedBody),
              credentials: this.withCredentials ? "include" : "same-origin",
            },
          } : null;
          acceptRequest(request);
          let finish;
          track(new Promise((resolve) => { finish = resolve; }));
          this.addEventListener("loadend", () => {
            try {
              captureXhrResponse(this, request.sequence, request);
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
      if (wrappedSetRequestHeader) xhrPrototype.setRequestHeader = wrappedSetRequestHeader;
      xhrPrototype.send = wrappedSend;
    }
  } catch (error) {
    restore();
    throw error;
  }

  return {
    get requestTemplate() {
      return firstRequest;
    },
    get firstResponse() {
      return firstResponse;
    },
    async waitForRequest({ timeoutMs = DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS } = {}) {
      if (firstRequest) return firstRequest;
      let timer = null;
      try {
        return await Promise.race([
          firstRequestPromise,
          new Promise((resolve) => {
            timer = setTimer(() => resolve(null), Math.max(0, Number(timeoutMs) || 0));
          }),
        ]);
      } finally {
        if (timer !== null) clearTimer(timer);
      }
    },
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
  createContinuationPaginatorImpl = createContinuationPaginator,
  createYtcfgRequestTemplateImpl = createYtcfgRequestTemplate,
  collectorOptions = {},
  completeness = {},
  paginationOptions = {},
  captureRequestTimeoutMs = DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS,
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

      const initialToken = readInitialContinuationTokenImpl(win);
      let continuationToken = typeof initialToken === "string" && initialToken
        ? initialToken
        : null;
      let hasStructuralCompletion = false;
      let videos = normalizeVideoOrder(
        parseInitialDataImpl(win),
        collectInitialImpl({ doc, win }),
      );
      emit(COLLECT_PROGRESS, runId, { count: videos.length, expectedTotal });

      if (continuationToken !== null) {
        let capturedResponse = null;
        let requestTemplate = null;
        let capture = null;
        try {
          capture = installBrowseCaptureImpl({
            win,
            expectedToken: continuationToken,
            onResponse(response) {
              if (
                capturedResponse === null &&
                response?.requestToken === continuationToken
              ) {
                capturedResponse = response;
              }
            },
          });

          // This is a one-time request-template probe, not the pagination
          // loader. It can run in a background tab. If visibility prevents the
          // page from issuing a request, the live ytcfg fallback below takes over.
          const originalScrollY = Number(win?.scrollY);
          const canRestoreScroll = Number.isFinite(originalScrollY);
          try {
            if (
              typeof win?.scrollTo === "function" &&
              doc?.documentElement
            ) {
              win.scrollTo(0, doc.documentElement.scrollHeight);
            }
          requestTemplate = typeof capture?.waitForRequest === "function"
            ? await capture.waitForRequest({ timeoutMs: captureRequestTimeoutMs })
            : capture?.requestTemplate || null;
          if (requestTemplate && !isBrowseRequest(requestTemplate.url, win)) {
            requestTemplate = null;
          }
          } finally {
            if (canRestoreScroll && typeof win?.scrollTo === "function") {
              try {
                win.scrollTo(Number(win.scrollX) || 0, originalScrollY);
              } catch {
                // The page may have navigated while the probe was running.
              }
            }
          }
          if (requestTemplate && typeof capture?.drain === "function") {
            try {
              await capture.drain({ timeoutMs: captureDrainTimeoutMs });
            } catch {
              // The captured request metadata is sufficient. The paginator
              // will retry the same token if the page's natural response hung.
            }
          }
          capturedResponse = capture?.firstResponse || capturedResponse;
        } catch {
          requestTemplate = null;
          capturedResponse = null;
        } finally {
          capture?.restore?.();
        }

        const naturalPageComplete = (
          capturedResponse?.ok !== false &&
          capturedResponse?.continuationItems === true &&
          capturedResponse?.continuationToken !== continuationToken
        );
        if (naturalPageComplete) {
          hasStructuralCompletion = capturedResponse.continuationToken === null;
          videos = normalizeVideoOrder(videos, capturedResponse.videos);
          continuationToken = capturedResponse.continuationToken;
          emit(COLLECT_PROGRESS, runId, { count: videos.length, expectedTotal });
        }

        if (continuationToken !== null && !requestTemplate) {
          try {
            requestTemplate = await createYtcfgRequestTemplateImpl({ win, doc });
          } catch (setupError) {
            // DOM scrolling is retained only as a last-resort union source. It
            // is accepted without a structural end marker only when it reaches
            // the exact advertised total. Otherwise nothing is imported.
            let fallbackVideos = videos;
            try {
              const collector = createCollectorImpl({ doc, win, sleep, ...collectorOptions });
              const fallback = await collector.collectAll({
                onProgress({ count }) {
                  emit(COLLECT_PROGRESS, runId, {
                    count: Math.max(videos.length, Number(count) || 0),
                    expectedTotal,
                  });
                },
              });
              fallbackVideos = normalizeVideoOrder(videos, fallback.videos);
            } catch {
              // The structural failure below is the actionable result.
            }
            if (fallbackVideos.length < Number(expectedTotal)) {
              throw new CollectionError(
                "TRUNCATED",
                "We could not read the whole Watch Later list after repeated attempts. Try again.",
              );
            }
            videos = fallbackVideos;
            continuationToken = null;
          }
        }

        if (continuationToken !== null) {
          const fetchImpl = typeof win?.fetch === "function"
            ? (...args) => Reflect.apply(win.fetch, win, args)
            : undefined;
          const paginator = createContinuationPaginatorImpl({
            fetch: fetchImpl,
            sleep,
            ...paginationOptions,
          });
          const paginated = await paginator.paginate({
            initialVideos: videos,
            continuationToken,
            requestTemplate,
            onProgress({ count }) {
              emit(COLLECT_PROGRESS, runId, { count, expectedTotal });
            },
          });
          if (!paginated?.complete || paginated.continuationToken !== null) {
            throw new CollectionError(
              "TRUNCATED",
              "We could not read the whole Watch Later list after repeated attempts. Try again.",
            );
          }
          videos = normalizeVideoOrder(paginated.videos, collectInitialImpl({ doc, win }));
          continuationToken = null;
          hasStructuralCompletion = true;
        }
      }

      if (
        !hasStructuralCompletion &&
        isMateriallyShort(videos.length, expectedTotal, completeness)
      ) {
        throw new CollectionError(
          "TRUNCATED",
          "We could not read the whole Watch Later list after repeated attempts. Try again.",
        );
      }

      const unavailable = hasStructuralCompletion || videos.length >= Number(expectedTotal)
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
