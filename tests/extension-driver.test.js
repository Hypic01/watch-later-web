import { describe, expect, it } from "vitest";
import {
  createCollectorDriver,
  installBrowseCapture,
  isMateriallyShort,
  registerMainWorldListener,
} from "../extension/src/collector-driver.main.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_PROGRESS,
  COLLECT_START,
} from "../extension/src/messages.js";

function renderer(id, position) {
  return {
    videoId: id,
    title: { runs: [{ text: `Video ${id}` }] },
    shortBylineText: { runs: [{ text: "Channel" }] },
    lengthSeconds: "60",
    index: { simpleText: String(position) },
  };
}

function lockup(id) {
  return {
    contentId: id,
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    metadata: {
      lockupMetadataViewModel: {
        title: { content: `Lockup ${id}` },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [{ metadataParts: [{ text: { content: "Lockup Channel" } }] }],
          },
        },
      },
    },
    rendererContext: {
      commandContext: {
        onTap: { innertubeCommand: { watchEndpoint: { videoId: id } } },
      },
    },
  };
}

function continuationItem(token) {
  return {
    continuationItemRenderer: {
      continuationEndpoint: {
        continuationCommand: { token },
      },
    },
  };
}

function browseBody(videos = [], continuationToken = null, extraItems = []) {
  const continuationItems = videos.map((video) => ({
    playlistVideoRenderer: renderer(video.id, video.position),
  }));
  continuationItems.push(...extraItems);
  if (continuationToken) continuationItems.push(continuationItem(continuationToken));
  return {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: { continuationItems },
    }],
  };
}

function initialData(total, videos = [], continuationToken = null) {
  const contents = videos.map((video) => ({
    playlistVideoRenderer: renderer(video.id, video.position),
  }));
  if (continuationToken) contents.push(continuationItem(continuationToken));
  return {
    header: {
      playlistHeaderRenderer: {
        numVideosText: { simpleText: `${total} videos` },
      },
    },
    contents,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    clone() {
      return {
        async json() {
          return body;
        },
      };
    },
  };
}

function requestTemplate() {
  return {
    url: "https://www.youtube.com/youtubei/v1/browse?key=live-key&prettyPrint=false",
    init: {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: "SAPISIDHASH live-page-auth",
        "content-type": "application/json",
        "x-youtube-client-version": "live-version",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "live-version" } },
        clickTracking: { clickTrackingParams: "tracking-value" },
      }),
    },
  };
}

function noCapture() {
  return {
    requestTemplate: null,
    firstResponse: null,
    async waitForRequest() { return null; },
    async drain() {},
    restore() {},
  };
}

function emptyDoc() {
  return {
    documentElement: { scrollHeight: 10000 },
    querySelectorAll: () => [],
  };
}

function driverPage({ total, initialVideos, token, fetch }) {
  let scrollCount = 0;
  return {
    doc: emptyDoc(),
    win: {
      location: {
        origin: "https://www.youtube.com",
        href: "https://www.youtube.com/playlist?list=WL",
      },
      ytcfg: { get: (key) => key === "LOGGED_IN" ? true : null },
      ytInitialData: initialData(total, initialVideos, token),
      fetch,
      scrollTo() { scrollCount++; },
    },
    get scrollCount() { return scrollCount; },
  };
}

function explicitDriver({ page, messages, paginationOptions = {} }) {
  return createCollectorDriver({
    doc: page.doc,
    win: page.win,
    sleep: async () => {},
    postMessage: (message) => messages.push(message),
    installBrowseCaptureImpl: noCapture,
    createYtcfgRequestTemplateImpl: async () => requestTemplate(),
    paginationOptions: {
      successPaceMs: 0,
      backoffBaseMs: 0,
      ...paginationOptions,
    },
  });
}

describe("explicit InnerTube full collection", () => {
  it("paginates a 2,800 item list to a tokenless end and returns the full set", async () => {
    const initialVideos = Array.from({ length: 100 }, (_, index) => ({
      id: `video-${index + 1}`,
      position: index + 1,
    }));
    const calls = [];
    const fetch = async (_url, init) => {
      const token = JSON.parse(init.body).continuation;
      calls.push(token);
      const pageNumber = Number(token.slice("page-".length));
      const start = (pageNumber - 1) * 100;
      const videos = Array.from({ length: 100 }, (_, index) => ({
        id: `video-${start + index + 1}`,
        position: start + index + 1,
      }));
      return response(browseBody(videos, pageNumber < 28 ? `page-${pageNumber + 1}` : null));
    };
    const page = driverPage({ total: 2800, initialVideos, token: "page-2", fetch });
    const messages = [];
    const driver = explicitDriver({ page, messages });

    const result = await driver.collect({ mode: "full", runId: "large-list" });

    expect(result).toMatchObject({ ok: true, unavailable: 0, expectedTotal: 2800 });
    expect(result.videos).toHaveLength(2800);
    expect(new Set(result.videos.map((video) => video.id)).size).toBe(2800);
    expect(calls).toEqual(Array.from({ length: 27 }, (_, index) => `page-${index + 2}`));
    expect(page.scrollCount).toBe(1);
    expect(messages.find((message) => message.type === COLLECT_DONE)).toMatchObject({
      runId: "large-list",
      truncated: false,
      unavailable: 0,
    });
  });

  it("retries the same token through two throttle signals and still completes", async () => {
    const attempts = [];
    let call = 0;
    const fetch = async (_url, init) => {
      attempts.push(JSON.parse(init.body).continuation);
      call++;
      if (call === 1) return response(browseBody([]));
      if (call === 2) return response({ error: "throttled" }, 429);
      return response(browseBody([{ id: "continued", position: 2 }]));
    };
    const page = driverPage({
      total: 2,
      initialVideos: [{ id: "initial", position: 1 }],
      token: "retry-this-token",
      fetch,
    });
    const messages = [];
    const driver = explicitDriver({ page, messages });

    const result = await driver.collect({ mode: "full", runId: "recovered" });

    expect(result).toMatchObject({ ok: true, unavailable: 0 });
    expect(result.videos.map((video) => video.id)).toEqual(["initial", "continued"]);
    expect(attempts).toEqual(Array(3).fill("retry-this-token"));
    expect(messages.some((message) => message.type === COLLECT_ERROR)).toBe(false);
  });

  it("returns TRUNCATED only after retries are exhausted with a token outstanding", async () => {
    const harvested = Array.from({ length: 9900 }, (_, index) => ({
      id: `visible-${index + 1}`,
      position: index + 1,
    }));
    const attempts = [];
    const page = driverPage({
      total: 10000,
      initialVideos: [],
      token: "still-more",
      fetch: async (_url, init) => {
        attempts.push(JSON.parse(init.body).continuation);
        return response(browseBody([]));
      },
    });
    const messages = [];
    const driver = createCollectorDriver({
      doc: page.doc,
      win: page.win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      parseInitialDataImpl: () => harvested,
      collectInitialImpl: () => harvested,
      installBrowseCaptureImpl: noCapture,
      createYtcfgRequestTemplateImpl: async () => requestTemplate(),
      paginationOptions: { maxAttempts: 3, backoffBaseMs: 0, successPaceMs: 0 },
    });

    const result = await driver.collect({ mode: "full", runId: "small-gap" });

    expect(isMateriallyShort(harvested.length, 10000)).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
    expect(attempts).toEqual(Array(3).fill("still-more"));
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
  });

  it("accepts a fully walked list with 20 percent unavailable", async () => {
    const initialVideos = Array.from({ length: 60 }, (_, index) => ({
      id: `visible-${index + 1}`,
      position: index + 1,
    }));
    const finalVideos = Array.from({ length: 20 }, (_, index) => ({
      id: `visible-${index + 61}`,
      position: index + 61,
    }));
    const page = driverPage({
      total: 100,
      initialVideos,
      token: "final-page",
      fetch: async () => response(browseBody(finalVideos)),
    });
    const messages = [];
    const driver = explicitDriver({ page, messages });

    const result = await driver.collect({ mode: "full", runId: "unavailable" });

    expect(result).toMatchObject({ ok: true, unavailable: 20 });
    expect(result.videos).toHaveLength(80);
    expect(messages.find((message) => message.type === COLLECT_DONE)).toMatchObject({
      unavailable: 20,
      truncated: false,
    });
  });

  it("collects lockup continuations even when the DOM exposes no data", async () => {
    const page = driverPage({
      total: 2,
      initialVideos: [{ id: "initial", position: 1 }],
      token: "lockup-page",
      fetch: async () => response(browseBody([], null, [{
        lockupViewModel: lockup("lockup-video"),
      }])),
    });
    const messages = [];
    const driver = explicitDriver({ page, messages });

    const result = await driver.collect({ mode: "full", runId: "lockup-continuation" });

    expect(result).toMatchObject({ ok: true, unavailable: 0 });
    expect(result.videos.map((video) => [video.id, video.position])).toEqual([
      ["initial", 1],
      ["lockup-video", 2],
    ]);
    expect(messages.some((message) => message.type === COLLECT_ERROR)).toBe(false);
  });

  it.each([
    { total: 2, ok: true },
    { total: 3, ok: false },
  ])("uses DOM only as an exact-total setup fallback when the total is $total", async ({ total, ok }) => {
    const page = driverPage({
      total,
      initialVideos: [{ id: "initial", position: 1 }],
      token: "still-more",
      fetch: async () => { throw new Error("explicit fetch should not start"); },
    });
    const messages = [];
    const driver = createCollectorDriver({
      doc: page.doc,
      win: page.win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      installBrowseCaptureImpl: noCapture,
      createYtcfgRequestTemplateImpl: async () => {
        throw new Error("page configuration unavailable");
      },
      createCollectorImpl: () => ({
        async collectAll() {
          return {
            videos: [{ id: "continued", position: 2 }],
            truncated: false,
          };
        },
      }),
    });

    const result = await driver.collect({ mode: "full", runId: `dom-fallback-${total}` });

    if (ok) {
      expect(result).toMatchObject({ ok: true, unavailable: 0 });
      expect(result.videos.map((video) => video.id)).toEqual(["initial", "continued"]);
    } else {
      expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
      expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
    }
  });

  it("emits progress heartbeats throughout a long retry wait", async () => {
    let time = 0;
    let attempt = 0;
    const events = [];
    const page = driverPage({
      total: 2,
      initialVideos: [{ id: "initial", position: 1 }],
      token: "slow-token",
      fetch: async () => {
        attempt++;
        return attempt === 1
          ? response(browseBody([]))
          : response(browseBody([{ id: "recovered", position: 2 }]));
      },
    });
    const driver = createCollectorDriver({
      doc: page.doc,
      win: page.win,
      sleep: async (ms) => { time += ms; },
      postMessage: (message) => events.push({ message, at: time }),
      installBrowseCaptureImpl: noCapture,
      createYtcfgRequestTemplateImpl: async () => requestTemplate(),
      paginationOptions: {
        maxAttempts: 2,
        backoffBaseMs: 24000,
        backoffCapMs: 24000,
        heartbeatIntervalMs: 9000,
        successPaceMs: 0,
        now: () => time,
      },
    });

    const result = await driver.collect({ mode: "full", runId: "heartbeat" });
    const progressTimes = events
      .filter(({ message }) => message.type === COLLECT_PROGRESS)
      .map(({ at }) => at);

    expect(result.ok).toBe(true);
    expect(progressTimes).toEqual(expect.arrayContaining([0, 9000, 18000, 24000]));
    expect(progressTimes.slice(1).every((at, index) => at - progressTimes[index] <= 10000)).toBe(true);
  });
});

describe("captured request replay", () => {
  it("ignores an uncorrelated same-origin browse response", async () => {
    const calls = [];
    const page = driverPage({
      total: 2,
      initialVideos: [{ id: "initial", position: 1 }],
      token: "playlist-token",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(init.body).continuation);
        return response(browseBody([{ id: "real-continuation", position: 2 }]));
      },
    });
    const driver = createCollectorDriver({
      doc: page.doc,
      win: page.win,
      sleep: async () => {},
      postMessage: () => {},
      installBrowseCaptureImpl({ onResponse }) {
        onResponse({
          ok: true,
          continuationItems: true,
          requestToken: null,
          continuationToken: null,
          videos: [{ id: "unrelated-browse-result", position: 2 }],
        });
        return noCapture();
      },
      createYtcfgRequestTemplateImpl: async () => requestTemplate(),
      paginationOptions: { successPaceMs: 0, backoffBaseMs: 0 },
    });

    const result = await driver.collect({ mode: "full", runId: "correlated-only" });

    expect(calls).toEqual(["playlist-token"]);
    expect(result.videos.map((video) => video.id)).toEqual(["initial", "real-continuation"]);
    expect(result.videos.some((video) => video.id === "unrelated-browse-result")).toBe(false);
  });

  it("uses the natural first page once, then reuses its headers with only the token changed", async () => {
    const calls = [];
    const capturedHeaders = {
      authorization: "SAPISIDHASH captured-auth",
      "content-type": "application/json",
      "x-youtube-client-version": "captured-version",
    };
    const capturedBody = {
      context: { client: { clientName: "WEB", clientVersion: "captured-version" } },
      continuation: "page-2",
      clickTracking: { clickTrackingParams: "preserve-this" },
    };
    const originalFetch = async (url, init) => {
      const token = JSON.parse(init.body).continuation;
      calls.push({ url: String(url), init: structuredClone(init), token });
      return token === "page-2"
        ? response(browseBody([{ id: "second", position: 2 }], "page-3"))
        : response(browseBody([{ id: "third", position: 3 }]));
    };
    const scrollCalls = [];
    let requested = false;
    let win;
    win = {
      location: {
        origin: "https://www.youtube.com",
        href: "https://www.youtube.com/playlist?list=WL",
      },
      scrollX: 0,
      scrollY: 320,
      ytcfg: { get: (key) => key === "LOGGED_IN" ? true : null },
      ytInitialData: initialData(3, [{ id: "initial", position: 1 }], "page-2"),
      fetch: originalFetch,
      scrollTo(_x, y) {
        scrollCalls.push(y);
        if (!requested && y === 10000) {
          requested = true;
          void win.fetch("/youtubei/v1/browse?key=captured-key", {
            method: "POST",
            credentials: "include",
            headers: capturedHeaders,
            body: JSON.stringify(capturedBody),
          });
        }
      },
    };
    const messages = [];
    const driver = createCollectorDriver({
      doc: { ...emptyDoc(), visibilityState: "visible" },
      win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      paginationOptions: { successPaceMs: 0, backoffBaseMs: 0 },
      createYtcfgRequestTemplateImpl: async () => {
        throw new Error("captured request should win");
      },
    });

    const result = await driver.collect({ mode: "full", runId: "captured" });

    expect(result.videos.map((video) => video.id)).toEqual(["initial", "second", "third"]);
    expect(calls.map((call) => call.token)).toEqual(["page-2", "page-3"]);
    expect(calls[1].url).toBe("https://www.youtube.com/youtubei/v1/browse?key=captured-key");
    expect(Object.fromEntries(calls[1].init.headers)).toEqual(capturedHeaders);
    expect({ ...JSON.parse(calls[1].init.body), continuation: undefined }).toEqual({
      ...capturedBody,
      continuation: undefined,
    });
    expect(win.fetch).toBe(originalFetch);
    expect(scrollCalls).toEqual([10000, 320]);
    expect(messages.some((message) => message.type === COLLECT_ERROR)).toBe(false);
  });
});

class FakeXmlHttpRequest {
  constructor() {
    this.listeners = new Map();
    this.responseType = "";
    this.responseText = "";
    this.status = 200;
    this.withCredentials = true;
    this.headers = [];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers.push([name, value]);
  }

  send() {
    this.listeners.get("loadend")?.();
  }
}

describe("browse request capture", () => {
  it("ignores a foreign origin that copies the YouTube browse path", async () => {
    const originalFetch = async () => response(browseBody([{ id: "continued", position: 2 }]));
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      fetch: originalFetch,
    };
    const capture = installBrowseCapture({ win, expectedToken: "safe-token" });
    const init = {
      method: "POST",
      headers: { authorization: "must-not-leak" },
      body: JSON.stringify({ context: { client: {} }, continuation: "safe-token" }),
    };

    await win.fetch("https://attacker.example/youtubei/v1/browse", init);
    await Promise.resolve();
    expect(capture.requestTemplate).toBeNull();

    await win.fetch("/youtubei/v1/browse", init);
    expect(await capture.waitForRequest({ timeoutMs: 100 })).toMatchObject({
      url: "https://www.youtube.com/youtubei/v1/browse",
    });
    capture.restore();
    expect(win.fetch).toBe(originalFetch);
  });

  it("returns YouTube's fetch promise untouched and captures a replay template", async () => {
    const body = browseBody([{ id: "continued", position: 2 }]);
    const originalResponse = response(body);
    const originalPromise = Promise.resolve(originalResponse);
    const originalFetch = () => originalPromise;
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      fetch: originalFetch,
    };
    const capture = installBrowseCapture({ win, expectedToken: "first-token" });

    const returned = win.fetch("/youtubei/v1/browse", {
      method: "POST",
      headers: { authorization: "captured" },
      body: JSON.stringify({ context: { client: {} }, continuation: "first-token" }),
    });
    expect(returned).toBe(originalPromise);
    expect(await capture.waitForRequest({ timeoutMs: 100 })).toMatchObject({
      url: "https://www.youtube.com/youtubei/v1/browse",
      init: { method: "POST" },
    });
    await capture.drain({ timeoutMs: 100 });
    expect(capture.firstResponse).toMatchObject({
      requestToken: "first-token",
      continuationToken: null,
      continuationItems: true,
    });
    capture.restore();
    expect(win.fetch).toBe(originalFetch);
  });

  it("captures XHR headers and body, then restores every patched method", async () => {
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      XMLHttpRequest: FakeXmlHttpRequest,
    };
    const originalOpen = FakeXmlHttpRequest.prototype.open;
    const originalSend = FakeXmlHttpRequest.prototype.send;
    const originalSetRequestHeader = FakeXmlHttpRequest.prototype.setRequestHeader;
    const capture = installBrowseCapture({ win, expectedToken: "xhr-token" });
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", "/youtubei/v1/browse?key=live");
    xhr.setRequestHeader("authorization", "SAPISIDHASH xhr-auth");
    xhr.setRequestHeader("x-trace", "one");
    xhr.setRequestHeader("x-trace", "two");
    xhr.responseText = JSON.stringify(browseBody([{ id: "xhr-video", position: 2 }]));
    xhr.send(JSON.stringify({ context: { client: {} }, continuation: "xhr-token" }));

    const template = await capture.waitForRequest({ timeoutMs: 100 });
    await capture.drain({ timeoutMs: 100 });
    expect(template.init.headers).toEqual([
      ["authorization", "SAPISIDHASH xhr-auth"],
      ["x-trace", "one"],
      ["x-trace", "two"],
    ]);
    expect(JSON.parse(template.init.body).continuation).toBe("xhr-token");
    capture.restore();

    expect(FakeXmlHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(originalSend);
    expect(FakeXmlHttpRequest.prototype.setRequestHeader).toBe(originalSetRequestHeader);
  });

  it("restores fetch and XHR after explicit pagination exhausts its retries", async () => {
    const originalFetch = async () => response(browseBody([]));
    const originalOpen = FakeXmlHttpRequest.prototype.open;
    const originalSend = FakeXmlHttpRequest.prototype.send;
    let requested = false;
    let win;
    win = {
      location: {
        origin: "https://www.youtube.com",
        href: "https://www.youtube.com/playlist?list=WL",
      },
      scrollX: 0,
      scrollY: 20,
      ytcfg: { get: (key) => key === "LOGGED_IN" ? true : null },
      ytInitialData: initialData(2, [{ id: "initial", position: 1 }], "stalled-token"),
      fetch: originalFetch,
      XMLHttpRequest: FakeXmlHttpRequest,
      scrollTo(_x, y) {
        if (!requested && y === 10000) {
          requested = true;
          void win.fetch("/youtubei/v1/browse", {
            method: "POST",
            headers: { authorization: "SAPISIDHASH captured" },
            body: JSON.stringify({ context: { client: {} }, continuation: "stalled-token" }),
          });
        }
      },
    };
    const driver = createCollectorDriver({
      doc: emptyDoc(),
      win,
      sleep: async () => {},
      postMessage: () => {},
      paginationOptions: { maxAttempts: 2, backoffBaseMs: 0, successPaceMs: 0 },
    });

    const result = await driver.collect({ mode: "full", runId: "restore-on-error" });

    expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
    expect(win.fetch).toBe(originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(originalSend);
  });
});

describe("initial collection and errors", () => {
  it.each([
    { count: 60, ok: true },
    { count: 30, ok: false },
  ])("uses the half-list backstop with no continuation evidence at $count percent", async ({ count, ok }) => {
    const initialVideos = Array.from({ length: count }, (_, index) => ({
      id: `visible-${index + 1}`,
      position: index + 1,
    }));
    const page = driverPage({
      total: 100,
      initialVideos,
      token: null,
      fetch: async () => { throw new Error("a tokenless page must not fetch"); },
    });
    const messages = [];
    const driver = createCollectorDriver({
      doc: page.doc,
      win: page.win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
    });

    const result = await driver.collect({ mode: "full", runId: `no-token-${count}` });

    if (ok) {
      expect(result).toMatchObject({ ok: true, unavailable: null });
      expect(messages.find((message) => message.type === COLLECT_DONE)).toMatchObject({
        unavailable: null,
      });
    } else {
      expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
      expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
    }
  });

  it("reads the initial batch without scrolling or fetching", async () => {
    let scrollCount = 0;
    let fetchCount = 0;
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      ytcfg: { get: () => true },
      ytInitialData: initialData(50, [{ id: "delta-video", position: 1 }]),
      fetch: async () => { fetchCount++; },
      scrollTo() { scrollCount++; },
    };
    const messages = [];
    const driver = createCollectorDriver({
      doc: emptyDoc(),
      win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
    });

    const result = await driver.collect({ mode: "delta", runId: "delta" });

    expect(result).toMatchObject({ ok: true, expectedTotal: 50 });
    expect(result.videos.map((video) => video.id)).toEqual(["delta-video"]);
    expect(scrollCount).toBe(0);
    expect(fetchCount).toBe(0);
    expect(messages.find((message) => message.type === COLLECT_DONE)?.runId).toBe("delta");
  });

  it("reports SIGNED_OUT before collection starts", async () => {
    const messages = [];
    const driver = createCollectorDriver({
      doc: {},
      win: { ytcfg: { get: () => false } },
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
    });

    const result = await driver.collect({ mode: "full", runId: "signed-out" });

    expect(result).toMatchObject({ ok: false, code: "SIGNED_OUT" });
    expect(messages).toEqual([expect.objectContaining({
      type: COLLECT_ERROR,
      runId: "signed-out",
      code: "SIGNED_OUT",
    })]);
  });

  it("refuses a full import when the playlist total is unavailable", async () => {
    const messages = [];
    const driver = createCollectorDriver({
      doc: emptyDoc(),
      win: { ytcfg: { get: () => true } },
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      readPlaylistTotalImpl: () => null,
    });

    const result = await driver.collect({ mode: "full", runId: "unknown-total" });

    expect(result).toMatchObject({ ok: false, code: "PLAYLIST_TOTAL_UNKNOWN" });
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
  });
});

describe("MAIN world listener recovery", () => {
  it("replays a cached terminal event when recovery repeats the run id", async () => {
    let listener;
    let collectionCount = 0;
    const posted = [];
    const win = {
      document: {},
      location: { origin: "https://www.youtube.com" },
      addEventListener(type, handler) {
        if (type === "message") listener = handler;
      },
      postMessage(message) {
        posted.push(message);
      },
    };
    registerMainWorldListener(win, {
      createDriverImpl({ postMessage }) {
        return {
          async collect({ runId }) {
            collectionCount++;
            postMessage({
              __wll: true,
              type: COLLECT_DONE,
              runId,
              videos: [{ id: "cached" }],
              truncated: false,
            });
          },
        };
      },
    });
    const start = {
      source: win,
      data: { __wll: true, type: COLLECT_START, mode: "full", runId: "recover-me" },
    };

    listener(start);
    await Promise.resolve();
    await Promise.resolve();
    listener(start);

    expect(collectionCount).toBe(1);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual(posted[1]);
    expect(posted[1]).toMatchObject({ type: COLLECT_DONE, runId: "recover-me" });
  });
});
