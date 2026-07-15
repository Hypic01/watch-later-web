import { parseBrowseResponse as parseBrowseResponseDefault } from "./continuations.js";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_BASE_MS = 1500;
const DEFAULT_BACKOFF_CAP_MS = 24000;
const DEFAULT_SUCCESS_PACE_MS = 450;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 9000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export class ContinuationPaginationError extends Error {
  constructor(message, { continuationToken = null, attempts = 0, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContinuationPaginationError";
    this.code = "TRUNCATED";
    this.continuationToken = continuationToken;
    this.attempts = attempts;
  }
}

class RetryablePaginationError extends Error {}

function cloneHeaders(headers) {
  if (!headers) return headers;
  if (typeof Headers === "function" && headers instanceof Headers) return new Headers(headers);
  if (Array.isArray(headers)) return headers.map((entry) => [...entry]);
  if (typeof headers === "object") return { ...headers };
  return headers;
}

function requestParts(requestTemplate) {
  if (!requestTemplate || typeof requestTemplate !== "object") {
    throw new TypeError("A continuation request template is required.");
  }
  const url = requestTemplate.url;
  if (typeof url !== "string" || !url) {
    throw new TypeError("The continuation request URL is missing.");
  }
  if (requestTemplate.init && typeof requestTemplate.init === "object") {
    return { url, init: requestTemplate.init };
  }
  const { url: _url, ...init } = requestTemplate;
  return { url, init };
}

function parseTemplateBody(body) {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // The error below is more useful to the caller than JSON's parser detail.
    }
  } else if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  throw new TypeError("The continuation request body must be a JSON object.");
}

// Build a fresh request for each attempt. The URL and every captured init field
// are preserved. Within the JSON body, only continuation is replaced.
export function buildContinuationRequest(requestTemplate, continuationToken) {
  const { url, init: templateInit } = requestParts(requestTemplate);
  const templateBody = parseTemplateBody(templateInit.body);
  const body = JSON.stringify({ ...templateBody, continuation: continuationToken });
  return {
    url,
    init: {
      ...templateInit,
      headers: cloneHeaders(templateInit.headers),
      body,
    },
  };
}

async function responseJson(response) {
  if (!response || typeof response !== "object") {
    throw new RetryablePaginationError("YouTube returned no continuation response.");
  }
  const status = Number(response.status);
  if (response.ok === false || (Number.isFinite(status) && status >= 400)) {
    throw new RetryablePaginationError("YouTube temporarily rejected the continuation request.");
  }
  try {
    if (typeof response.json === "function") return await response.json();
    if (typeof response.text === "function") return JSON.parse(await response.text());
    if ("body" in response) return response.body;
  } catch (error) {
    throw new RetryablePaginationError("YouTube returned an unreadable continuation response.", {
      cause: error,
    });
  }
  throw new RetryablePaginationError("YouTube returned an unreadable continuation response.");
}

// A continuation page can contain private or deleted entries that do not
// normalize into videos. The raw array is still a valid page and, when it has
// no next token, a deterministic end marker. Only a missing or actually empty
// continuationItems array is a retry signal.
export function hasContinuationItems(json) {
  let body = json;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (!body || typeof body !== "object") return false;
  const visited = new WeakSet();
  let found = false;
  const walk = (value) => {
    if (found || !value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "appendContinuationItemsAction" || key === "reloadContinuationItemsCommand") &&
        Array.isArray(child?.continuationItems) &&
        child.continuationItems.length > 0
      ) {
        found = true;
        return;
      }
      walk(child);
    }
  };
  walk(body);
  return found;
}

function normalizedResult(parsed, currentToken, body) {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.videos) ||
    !("continuationToken" in parsed)
  ) {
    throw new RetryablePaginationError("YouTube returned an unexpected continuation response.");
  }
  const continuationToken = parsed.continuationToken;
  if (continuationToken !== null && (typeof continuationToken !== "string" || !continuationToken)) {
    throw new RetryablePaginationError("YouTube returned an unexpected continuation response.");
  }
  // An actually empty page is a throttle signal, not the end of the playlist.
  // A repeated token cannot advance pagination and is retried for the same reason.
  if (!hasContinuationItems(body) || continuationToken === currentToken) {
    throw new RetryablePaginationError("YouTube returned no new continuation items.");
  }
  return { videos: parsed.videos, continuationToken };
}

export function createContinuationPaginator({
  fetch: fetchImpl = globalThis.fetch,
  parseBrowseResponse = parseBrowseResponseDefault,
  sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  now = () => Date.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
  successPaceMs = DEFAULT_SUCCESS_PACE_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  setInterval: setIntervalImpl = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: clearIntervalImpl = (timer) => globalThis.clearInterval(timer),
  setTimeout: setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimeoutImpl = (timer) => globalThis.clearTimeout(timer),
  AbortController: AbortControllerImpl = globalThis.AbortController,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch function is required.");
  if (typeof parseBrowseResponse !== "function") {
    throw new TypeError("A browse response parser is required.");
  }
  if (typeof sleep !== "function") throw new TypeError("A sleep function is required.");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("Request timeout functions are required.");
  }

  const attemptsLimit = Math.max(1, Math.floor(Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  const retryBase = Math.max(0, Number(backoffBaseMs) || 0);
  const retryCap = Math.max(retryBase, Number(backoffCapMs) || DEFAULT_BACKOFF_CAP_MS);
  const pace = Math.max(0, Number(successPaceMs) || 0);
  const heartbeatEvery = Math.max(
    1,
    Math.min(10000, Number(heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS),
  );
  const requestTimeout = Math.max(
    1,
    Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS,
  );

  async function paginate({
    initialVideos = [],
    continuationToken = null,
    requestTemplate,
    onProgress = () => {},
  } = {}) {
    const videos = new Map();
    const addVideos = (items) => {
      for (const video of items || []) {
        if (video?.id && !videos.has(video.id)) videos.set(video.id, video);
      }
    };
    addVideos(initialVideos);

    let token = typeof continuationToken === "string" && continuationToken
      ? continuationToken
      : null;
    let pages = 0;
    let retries = 0;

    const report = (event) => onProgress({
      ...event,
      count: videos.size,
      pages,
      retries,
      at: now(),
    });

    const backoff = async (waitMs, details) => {
      let remainingMs = waitMs;
      report({ type: "backoff", heartbeat: true, remainingMs, ...details });
      while (remainingMs > 0) {
        const step = Math.min(remainingMs, heartbeatEvery);
        await sleep(step);
        remainingMs -= step;
        report({ type: "backoff", heartbeat: true, remainingMs, ...details });
      }
    };

    const waitForAttempt = async (attemptPromise, details) => {
      let timer = null;
      if (typeof setIntervalImpl === "function" && typeof clearIntervalImpl === "function") {
        timer = setIntervalImpl(() => {
          report({ type: "request", heartbeat: true, ...details });
        }, heartbeatEvery);
      }
      try {
        return await attemptPromise;
      } finally {
        if (timer !== null) clearIntervalImpl(timer);
      }
    };

    const runAttempt = async (details, operation) => {
      const controller = typeof AbortControllerImpl === "function"
        ? new AbortControllerImpl()
        : null;
      let timeout = null;
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeoutImpl(() => {
          try {
            controller?.abort?.();
          } catch {
            // The timeout still rejects even if this browser cannot abort.
          }
          reject(new RetryablePaginationError(
            "YouTube did not answer the continuation request in time.",
          ));
        }, requestTimeout);
      });
      try {
        return await waitForAttempt(Promise.race([
          operation(controller?.signal),
          timeoutPromise,
        ]), details);
      } finally {
        if (timeout !== null) clearTimeoutImpl(timeout);
      }
    };

    // No initial token means ytInitialData already contains the whole playlist.
    if (token === null) {
      report({ type: "complete", heartbeat: false, continuationToken: null });
      return {
        videos: Array.from(videos.values()),
        complete: true,
        continuationToken: null,
        pages,
        retries,
      };
    }

    // Validate before the first fetch so configuration failures are distinct
    // from a structurally truncated YouTube response.
    buildContinuationRequest(requestTemplate, token);

    while (token !== null) {
      let completedPage = null;
      let lastError = null;

      for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
        try {
          completedPage = await runAttempt({
            attempt,
            continuationToken: token,
          }, async (signal) => {
            const request = buildContinuationRequest(requestTemplate, token);
            if (signal) request.init.signal = signal;
            const response = await fetchImpl(request.url, request.init);
            const body = await responseJson(response);
            const parsed = parseBrowseResponse(body);
            return normalizedResult(parsed, token, body);
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= attemptsLimit) break;
          retries++;
          const waitMs = Math.min(retryCap, retryBase * (2 ** (attempt - 1)));
          await backoff(waitMs, {
            attempt,
            continuationToken: token,
          });
        }
      }

      if (!completedPage) {
        throw new ContinuationPaginationError(
          "We could not read the whole Watch Later list. Try again.",
          { continuationToken: token, attempts: attemptsLimit, cause: lastError },
        );
      }

      addVideos(completedPage.videos);
      pages++;
      token = completedPage.continuationToken;
      report({
        type: token === null ? "complete" : "page",
        heartbeat: false,
        continuationToken: token,
      });
      if (token !== null && pace > 0) await sleep(pace);
    }

    return {
      videos: Array.from(videos.values()),
      complete: true,
      continuationToken: null,
      pages,
      retries,
    };
  }

  return { paginate };
}
