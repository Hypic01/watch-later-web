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

function continuationItem(token) {
  return {
    continuationItemRenderer: {
      continuationEndpoint: {
        continuationCommand: { token },
      },
    },
  };
}

function browseBody(id, position, continuationToken = null) {
  const continuationItems = [{ playlistVideoRenderer: renderer(id, position) }];
  if (continuationToken) continuationItems.push(continuationItem(continuationToken));
  return {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems,
      },
    }],
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
            metadataRows: [{ metadataParts: [{ text: { content: "Channel" } }] }],
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

function lockupBrowseBody(ids, continuationToken = null) {
  const continuationItems = ids.map((id) => ({ lockupViewModel: lockup(id) }));
  if (continuationToken) continuationItems.push(continuationItem(continuationToken));
  return {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems,
      },
    }],
  };
}

function initialData(total, items = [], continuationToken = null) {
  const contents = items.map((item) => ({ playlistVideoRenderer: item }));
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

class FakeXmlHttpRequest {
  constructor() {
    this.listeners = new Map();
    this.responseType = "";
    this.responseText = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  send() {
    this.listeners.get("loadend")?.();
  }
}

function lockupOnlyDoc() {
  return {
    documentElement: { scrollHeight: 10000 },
    querySelectorAll(selector) {
      if (selector === "yt-lockup-view-model") {
        return [{ remove() {} }]; // Deliberately no `.data` property.
      }
      return [];
    },
  };
}

function continuationWindow({
  total,
  bodies,
  initialToken = bodies.length ? "initial-next-page" : null,
}) {
  let inFlight = null;
  const remaining = [...bodies];
  const originalFetch = async (url) => {
    const body = remaining.shift();
    return {
      url: String(url),
      clone() {
        return { json: async () => body };
      },
    };
  };
  const win = {
    location: { href: "https://www.youtube.com/playlist?list=WL" },
    ytcfg: { get: () => true },
    ytInitialData: initialData(total, [renderer("initial", 1)], initialToken),
    fetch: originalFetch,
    XMLHttpRequest: FakeXmlHttpRequest,
    scrollTo() {
      if (remaining.length) inFlight = win.fetch("/youtubei/v1/browse");
    },
  };
  return {
    win,
    originalFetch,
    originalOpen: FakeXmlHttpRequest.prototype.open,
    originalSend: FakeXmlHttpRequest.prototype.send,
    async sleep() {
      if (inFlight) {
        const request = inFlight;
        inFlight = null;
        await request;
      }
    },
  };
}

describe("full collection continuation backstop", () => {
  it("harvests a full lockup playlist when the DOM exposes no data", async () => {
    const page = continuationWindow({
      total: 3,
      bodies: [
        browseBody("continued-2", 2, "page-three"),
        browseBody("continued-3", 3),
      ],
    });
    const messages = [];
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win: page.win,
      sleep: page.sleep,
      postMessage: (message) => messages.push(message),
      collectorOptions: { scrollDelayMs: 0, stallDelayMs: 0, maxRounds: 20 },
    });

    const result = await driver.collect({ mode: "full", runId: "full-success" });

    expect(result.ok).toBe(true);
    expect(result.videos.map((video) => video.id)).toEqual([
      "initial",
      "continued-2",
      "continued-3",
    ]);
    expect(messages.some((message) => (
      message.type === COLLECT_PROGRESS && message.count === 3 && message.expectedTotal === 3
    ))).toBe(true);
    expect(messages.find((message) => message.type === COLLECT_DONE)).toMatchObject({
      __wll: true,
      runId: "full-success",
      truncated: false,
      unavailable: 0,
    });
    expect(messages.some((message) => message.type === COLLECT_ERROR)).toBe(false);
    expect(page.win.fetch).toBe(page.originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(page.originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(page.originalSend);
  });

  it("accepts a fully walked playlist with 20 percent unavailable", async () => {
    const bodies = Array.from({ length: 79 }, (_, index) => browseBody(
      `visible-${index + 2}`,
      index + 2,
      index === 78 ? null : `page-${index + 3}`,
    ));
    const page = continuationWindow({
      total: 100,
      bodies,
    });
    const messages = [];
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win: page.win,
      sleep: page.sleep,
      postMessage: (message) => messages.push(message),
      collectorOptions: { scrollDelayMs: 0, stallDelayMs: 0, maxRounds: 120 },
    });

    const result = await driver.collect({ mode: "full", runId: "fully-walked-gap" });

    expect(result).toMatchObject({ ok: true, unavailable: 20 });
    expect(result.videos).toHaveLength(80);
    expect(messages.find((message) => message.type === COLLECT_DONE)).toMatchObject({
      runId: "fully-walked-gap",
      unavailable: 20,
    });
    expect(messages.some((message) => message.type === COLLECT_ERROR)).toBe(false);
    expect(page.win.fetch).toBe(page.originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(page.originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(page.originalSend);
  });

  it("fails a one percent shortfall while a continuation token is outstanding", async () => {
    const harvested = Array.from({ length: 9900 }, (_, index) => ({
      id: `visible-${index + 1}`,
      position: index + 1,
    }));
    const messages = [];
    const driver = createCollectorDriver({
      doc: {},
      win: { ytcfg: { get: () => true } },
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      parseInitialDataImpl: () => [],
      readInitialContinuationTokenImpl: () => "initial-page",
      readPlaylistTotalImpl: () => 10000,
      createCollectorImpl: () => ({
        async collectAll() {
          return { videos: harvested, rounds: 150, truncated: true };
        },
      }),
      installBrowseCaptureImpl: ({ onResponse }) => {
        onResponse({ videos: [], continuationToken: "still-more" });
        return { drain: async () => {}, restore: () => {} };
      },
    });

    const result = await driver.collect({ mode: "full", runId: "small-structural-gap" });

    expect(isMateriallyShort(9900, 10000)).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "TRUNCATED" });
    expect(result.error).toBe(
      "We could not read the whole Watch Later list. Try again and keep the YouTube tab visible.",
    );
    expect(messages.find((message) => message.type === COLLECT_ERROR)).toMatchObject({
      runId: "small-structural-gap",
      code: "TRUNCATED",
    });
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
  });

  it.each([
    { count: 60, ok: true },
    { count: 30, ok: false },
  ])("uses the half-list backstop when zero browse responses yield $count percent", async ({ count, ok }) => {
    const messages = [];
    const driver = createCollectorDriver({
      doc: {},
      win: { ytcfg: { get: () => true } },
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      parseInitialDataImpl: () => [],
      readInitialContinuationTokenImpl: () => "initial-page",
      readPlaylistTotalImpl: () => 100,
      createCollectorImpl: () => ({
        async collectAll() {
          return {
            videos: Array.from({ length: count }, (_, index) => ({ id: `video-${index}` })),
            rounds: 150,
            truncated: true,
          };
        },
      }),
      installBrowseCaptureImpl: () => ({ drain: async () => {}, restore: () => {} }),
    });

    const result = await driver.collect({ mode: "full", runId: `fallback-${count}` });

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

  it("assigns monotonic fallback positions across lockup continuation batches", async () => {
    const page = continuationWindow({
      total: 5,
      bodies: [
        lockupBrowseBody(["lockup-2", "lockup-3"], "next-lockup-page"),
        lockupBrowseBody(["lockup-4", "lockup-5"]),
      ],
    });
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win: page.win,
      sleep: page.sleep,
      postMessage: () => {},
      collectorOptions: { scrollDelayMs: 0, stallDelayMs: 0, maxRounds: 20 },
    });

    const result = await driver.collect({ mode: "full", runId: "lockup-order" });

    expect(result.ok).toBe(true);
    expect(result.videos.map((video) => [video.id, video.position])).toEqual([
      ["initial", 1],
      ["lockup-2", 2],
      ["lockup-3", 3],
      ["lockup-4", 4],
      ["lockup-5", 5],
    ]);
  });

  it("restores fetch and XHR when collection throws", async () => {
    const page = continuationWindow({ total: 1, bodies: [] });
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win: page.win,
      sleep: page.sleep,
      postMessage: () => {},
      createCollectorImpl: () => ({
        async collectAll() {
          throw new Error("scroll failed");
        },
      }),
    });

    const result = await driver.collect({ mode: "full", runId: "full-error" });

    expect(result).toMatchObject({ ok: false, code: "COLLECT_FAILED", error: "scroll failed" });
    expect(page.win.fetch).toBe(page.originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(page.originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(page.originalSend);
  });

  it("refuses a full import when the playlist total is unavailable", async () => {
    const page = continuationWindow({ total: 1, bodies: [] });
    const messages = [];
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win: page.win,
      sleep: page.sleep,
      postMessage: (message) => messages.push(message),
      readPlaylistTotalImpl: () => null,
    });

    const result = await driver.collect({ mode: "full", runId: "unknown-total" });

    expect(result).toMatchObject({ ok: false, code: "PLAYLIST_TOTAL_UNKNOWN" });
    expect(result.error).toContain("completeness could not be verified");
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
    expect(page.win.fetch).toBe(page.originalFetch);
  });
});

describe("delta collection", () => {
  it("reads the initial batch without scrolling or patching networking", async () => {
    let scrollCount = 0;
    const originalFetch = async () => { throw new Error("delta must not fetch"); };
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      ytcfg: { get: () => true },
      ytInitialData: initialData(50, [renderer("delta-video", 1)]),
      fetch: originalFetch,
      XMLHttpRequest: FakeXmlHttpRequest,
      scrollTo() { scrollCount++; },
    };
    const messages = [];
    const driver = createCollectorDriver({
      doc: { querySelectorAll: () => [] },
      win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
    });

    const result = await driver.collect({ mode: "delta", runId: "delta" });

    expect(result).toMatchObject({ ok: true, expectedTotal: 50 });
    expect(result.videos.map((video) => video.id)).toEqual(["delta-video"]);
    expect(scrollCount).toBe(0);
    expect(win.fetch).toBe(originalFetch);
    expect(messages.find((message) => message.type === COLLECT_DONE)?.runId).toBe("delta");
  });

  it("reports a clean signed out error before collection starts", async () => {
    const messages = [];
    const driver = createCollectorDriver({
      doc: {},
      win: { ytcfg: { get: () => false } },
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
    });

    const result = await driver.collect({ mode: "delta", runId: "signed-out" });

    expect(result).toMatchObject({ ok: false, code: "SIGNED_OUT" });
    expect(messages).toEqual([expect.objectContaining({
      type: COLLECT_ERROR,
      runId: "signed-out",
      code: "SIGNED_OUT",
    })]);
  });
});

describe("browse capture and completeness", () => {
  it("returns the fetch response without waiting for clone parsing", async () => {
    let resolveBody;
    const body = new Promise((resolve) => { resolveBody = resolve; });
    const response = {
      url: "https://www.youtube.com/youtubei/v1/browse",
      clone() {
        return { json: () => body };
      },
    };
    const responsePromise = Promise.resolve(response);
    const originalFetch = () => responsePromise;
    const videos = [];
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      fetch: originalFetch,
    };
    const capture = installBrowseCapture({
      win,
      onVideos: (items) => videos.push(...items),
    });

    const returnedPromise = win.fetch("/youtubei/v1/browse");
    expect(returnedPromise).toBe(responsePromise);
    const returned = await returnedPromise;
    expect(returned).toBe(response);
    expect(videos).toEqual([]);

    resolveBody(browseBody("deferred-video", 2));
    await capture.drain({ timeoutMs: 100 });
    capture.restore();
    expect(videos.map((video) => video.id)).toEqual(["deferred-video"]);
    expect(win.fetch).toBe(originalFetch);
  });

  it("times out a hung capture, fails loudly, and restores networking", async () => {
    const never = new Promise(() => {});
    const response = {
      url: "https://www.youtube.com/youtubei/v1/browse",
      clone() { return { json: () => never }; },
    };
    const originalFetch = async () => response;
    let requested = false;
    let inFlight = null;
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      ytcfg: { get: () => true },
      ytInitialData: initialData(100, [renderer("initial", 1)]),
      fetch: originalFetch,
      XMLHttpRequest: FakeXmlHttpRequest,
      scrollTo() {
        if (!requested) {
          requested = true;
          inFlight = win.fetch("/youtubei/v1/browse");
        }
      },
    };
    const originalOpen = FakeXmlHttpRequest.prototype.open;
    const originalSend = FakeXmlHttpRequest.prototype.send;
    const messages = [];
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win,
      sleep: async () => {
        if (inFlight) {
          const request = inFlight;
          inFlight = null;
          await request;
        }
      },
      postMessage: (message) => messages.push(message),
      collectorOptions: { scrollDelayMs: 0, stallDelayMs: 0, maxRounds: 20 },
      captureDrainTimeoutMs: 5,
    });

    const result = await driver.collect({ mode: "full", runId: "hung-capture" });

    expect(result).toMatchObject({ ok: false, code: "CAPTURE_TIMEOUT" });
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
    expect(win.fetch).toBe(originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(originalSend);
  });

  it("tracks an unresolved browse fetch before its response exists", async () => {
    const unresolvedResponse = new Promise(() => {});
    const originalFetch = () => unresolvedResponse;
    let requested = false;
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      ytcfg: { get: () => true },
      ytInitialData: initialData(2, [renderer("initial", 1)]),
      fetch: originalFetch,
      XMLHttpRequest: FakeXmlHttpRequest,
      scrollTo() {
        if (!requested) {
          requested = true;
          expect(win.fetch("/youtubei/v1/browse")).toBe(unresolvedResponse);
        }
      },
    };
    const originalOpen = FakeXmlHttpRequest.prototype.open;
    const originalSend = FakeXmlHttpRequest.prototype.send;
    const messages = [];
    const driver = createCollectorDriver({
      doc: lockupOnlyDoc(),
      win,
      sleep: async () => {},
      postMessage: (message) => messages.push(message),
      collectorOptions: { scrollDelayMs: 0, stallDelayMs: 0, maxRounds: 20 },
      captureDrainTimeoutMs: 5,
    });

    const result = await driver.collect({ mode: "full", runId: "pending-fetch" });

    expect(result).toMatchObject({ ok: false, code: "CAPTURE_TIMEOUT" });
    expect(messages.some((message) => message.type === COLLECT_DONE)).toBe(false);
    expect(win.fetch).toBe(originalFetch);
    expect(FakeXmlHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(originalSend);
  });

  it("captures XHR browse responses and restores the prototype", async () => {
    const videos = [];
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      XMLHttpRequest: FakeXmlHttpRequest,
    };
    const originalOpen = FakeXmlHttpRequest.prototype.open;
    const originalSend = FakeXmlHttpRequest.prototype.send;
    const capture = installBrowseCapture({
      win,
      onVideos: (items) => videos.push(...items),
    });
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", "/youtubei/v1/browse");
    xhr.responseText = JSON.stringify(browseBody("xhr-video", 2));
    xhr.send();
    await capture.drain();
    capture.restore();

    expect(videos.map((video) => video.id)).toEqual(["xhr-video"]);
    expect(FakeXmlHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXmlHttpRequest.prototype.send).toBe(originalSend);
  });

  it("delivers asynchronously parsed browse responses in request order", async () => {
    let resolveFirstBody;
    const firstBody = new Promise((resolve) => { resolveFirstBody = resolve; });
    const responses = [
      {
        clone() { return { json: () => firstBody }; },
      },
      {
        clone() { return { json: async () => browseBody("final-video", 3) }; },
      },
    ];
    const originalFetch = async () => responses.shift();
    const states = [];
    const win = {
      location: { href: "https://www.youtube.com/playlist?list=WL" },
      fetch: originalFetch,
    };
    const capture = installBrowseCapture({
      win,
      onResponse: ({ continuationToken }) => states.push(continuationToken),
    });

    await Promise.all([
      win.fetch("/youtubei/v1/browse"),
      win.fetch("/youtubei/v1/browse"),
    ]);
    await Promise.resolve();
    expect(states).toEqual([]);

    resolveFirstBody(browseBody("middle-video", 2, "final-page"));
    await capture.drain({ timeoutMs: 100 });
    capture.restore();

    expect(states).toEqual(["final-page", null]);
    expect(win.fetch).toBe(originalFetch);
  });

  it("uses only a catastrophic half-list threshold as the no-capture fallback", () => {
    expect(isMateriallyShort(2724, 2796)).toBe(false);
    expect(isMateriallyShort(9900, 10000)).toBe(false);
    expect(isMateriallyShort(60, 100)).toBe(false);
    expect(isMateriallyShort(50, 100)).toBe(false);
    expect(isMateriallyShort(49, 100)).toBe(true);
    expect(isMateriallyShort(30, 100)).toBe(true);
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
