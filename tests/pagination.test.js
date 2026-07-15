import { describe, expect, it } from "vitest";
import {
  buildContinuationRequest,
  createContinuationPaginator,
  hasContinuationItems,
} from "../collector/pagination.js";

function renderer(id, position) {
  return {
    videoId: id,
    title: { runs: [{ text: `Video ${id}` }] },
    shortBylineText: { runs: [{ text: "Channel" }] },
    lengthSeconds: "60",
    index: { simpleText: String(position) },
  };
}

function browseResponse(videos, continuationToken = null) {
  const continuationItems = videos.map((video, index) => ({
    playlistVideoRenderer: renderer(video.id, video.position ?? index + 1),
  }));
  if (continuationToken) {
    continuationItems.push({
      continuationItemRenderer: {
        continuationEndpoint: {
          continuationCommand: { token: continuationToken },
        },
      },
    });
  }
  return {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: { continuationItems },
    }],
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function requestTemplate() {
  return {
    url: "https://www.youtube.com/youtubei/v1/browse?key=live-key&prettyPrint=false",
    init: {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        authorization: "SAPISIDHASH live-page-auth",
        "content-type": "application/json",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": "live-version",
      },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB", clientVersion: "live-version" },
        },
        continuation: "captured-token",
        clickTracking: { clickTrackingParams: "tracking-value" },
      }),
    },
  };
}

function fakeClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    async sleep(ms) {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("createContinuationPaginator", () => {
  it("paginates 2,800 videos to a tokenless structural end", async () => {
    const calls = [];
    const clock = fakeClock();
    const fetch = async (_url, init) => {
      const token = JSON.parse(init.body).continuation;
      calls.push(token);
      const page = Number(token.slice("page-".length));
      const start = (page - 1) * 100;
      const videos = Array.from({ length: 100 }, (_, index) => ({
        id: `video-${start + index + 1}`,
        position: start + index + 1,
      }));
      const next = page < 28 ? `page-${page + 1}` : null;
      return response(browseResponse(videos, next));
    };
    const paginator = createContinuationPaginator({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });

    const result = await paginator.paginate({
      continuationToken: "page-1",
      requestTemplate: requestTemplate(),
    });

    expect(result.complete).toBe(true);
    expect(result.continuationToken).toBeNull();
    expect(result.pages).toBe(28);
    expect(result.videos).toHaveLength(2800);
    expect(new Set(result.videos.map((video) => video.id)).size).toBe(2800);
    expect(calls).toEqual(Array.from({ length: 28 }, (_, index) => `page-${index + 1}`));
  });

  it("retries the same token through an empty page and a throttle, then completes", async () => {
    const attemptedTokens = [];
    const clock = fakeClock();
    let attempt = 0;
    const fetch = async (_url, init) => {
      attemptedTokens.push(JSON.parse(init.body).continuation);
      attempt++;
      if (attempt === 1) return response(browseResponse([]));
      if (attempt === 2) return response({ error: "throttled" }, 429);
      return response(browseResponse([{ id: "recovered", position: 1 }]));
    };
    const paginator = createContinuationPaginator({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });

    const result = await paginator.paginate({
      continuationToken: "retry-this-token",
      requestTemplate: requestTemplate(),
    });

    expect(result).toMatchObject({ complete: true, pages: 1, retries: 2 });
    expect(result.videos.map((video) => video.id)).toEqual(["recovered"]);
    expect(attemptedTokens).toEqual([
      "retry-this-token",
      "retry-this-token",
      "retry-this-token",
    ]);
    expect(clock.sleeps).toEqual([1500, 3000]);
  });

  it("does not mistake unrelated continuation items for a completed playlist page", async () => {
    const attemptedTokens = [];
    let attempt = 0;
    const paginator = createContinuationPaginator({
      fetch: async (_url, init) => {
        attemptedTokens.push(JSON.parse(init.body).continuation);
        attempt++;
        if (attempt === 1) {
          return response({
            onResponseReceivedActions: [{
              appendContinuationItemsAction: { continuationItems: [] },
            }],
            unrelatedWidget: {
              continuationItems: [{ notificationRenderer: { title: "Not a playlist item" } }],
            },
          });
        }
        return response(browseResponse([{ id: "real-video", position: 1 }]));
      },
      sleep: async () => {},
      backoffBaseMs: 0,
    });

    const result = await paginator.paginate({
      continuationToken: "playlist-token",
      requestTemplate: requestTemplate(),
    });

    expect(result).toMatchObject({ complete: true, retries: 1 });
    expect(result.videos.map((video) => video.id)).toEqual(["real-video"]);
    expect(attemptedTokens).toEqual(["playlist-token", "playlist-token"]);
  });

  it("accepts a tokenless final page containing only an unavailable item", async () => {
    const paginator = createContinuationPaginator({
      fetch: async () => response({
        onResponseReceivedActions: [{
          appendContinuationItemsAction: {
            continuationItems: [{
              playlistVideoRenderer: {
                title: { simpleText: "Deleted video" },
              },
            }],
          },
        }],
      }),
      sleep: async () => {},
    });

    const result = await paginator.paginate({
      initialVideos: [{ id: "visible-video" }],
      continuationToken: "final-token",
      requestTemplate: requestTemplate(),
    });

    expect(result).toMatchObject({ complete: true, pages: 1, retries: 0 });
    expect(result.videos.map((video) => video.id)).toEqual(["visible-video"]);
  });

  it("advances through a private-only page when it carries a new token", async () => {
    const attemptedTokens = [];
    const paginator = createContinuationPaginator({
      fetch: async (_url, init) => {
        const token = JSON.parse(init.body).continuation;
        attemptedTokens.push(token);
        if (token === "private-page") {
          return response({
            onResponseReceivedActions: [{
              appendContinuationItemsAction: {
                continuationItems: [
                  { unavailableRenderer: { reason: "Private video" } },
                  {
                    continuationItemRenderer: {
                      continuationEndpoint: {
                        continuationCommand: { token: "visible-page" },
                      },
                    },
                  },
                ],
              },
            }],
          });
        }
        return response(browseResponse([{ id: "visible-video", position: 2 }]));
      },
      sleep: async () => {},
      successPaceMs: 0,
    });

    const result = await paginator.paginate({
      initialVideos: [{ id: "initial-video", position: 1 }],
      continuationToken: "private-page",
      requestTemplate: requestTemplate(),
    });

    expect(result.videos.map((video) => video.id)).toEqual(["initial-video", "visible-video"]);
    expect(attemptedTokens).toEqual(["private-page", "visible-page"]);
    expect(result.retries).toBe(0);
  });

  it("returns TRUNCATED only after all retries for the outstanding token are exhausted", async () => {
    const attemptedTokens = [];
    const clock = fakeClock();
    const paginator = createContinuationPaginator({
      fetch: async (_url, init) => {
        attemptedTokens.push(JSON.parse(init.body).continuation);
        return response(browseResponse([]));
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    await expect(paginator.paginate({
      initialVideos: [{ id: "initial-video" }],
      continuationToken: "still-outstanding",
      requestTemplate: requestTemplate(),
    })).rejects.toMatchObject({
      code: "TRUNCATED",
      continuationToken: "still-outstanding",
      attempts: 8,
    });

    expect(attemptedTokens).toEqual(Array(8).fill("still-outstanding"));
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(94500);
  });

  it("times out a hung request and retries the same token", async () => {
    const attemptedTokens = [];
    const timeoutDelays = [];
    const timers = new Map();
    let nextTimer = 0;
    let aborts = 0;
    const paginator = createContinuationPaginator({
      fetch: async (_url, init) => {
        attemptedTokens.push(JSON.parse(init.body).continuation);
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborts++;
            reject(new Error("aborted"));
          }, { once: true });
        });
      },
      sleep: async () => {},
      maxAttempts: 3,
      backoffBaseMs: 0,
      requestTimeoutMs: 1234,
      setInterval: null,
      clearInterval: null,
      setTimeout(fn, ms) {
        const timer = ++nextTimer;
        timeoutDelays.push(ms);
        timers.set(timer, fn);
        queueMicrotask(() => timers.get(timer)?.());
        return timer;
      },
      clearTimeout(timer) {
        timers.delete(timer);
      },
    });

    await expect(paginator.paginate({
      continuationToken: "hung-token",
      requestTemplate: requestTemplate(),
    })).rejects.toMatchObject({
      code: "TRUNCATED",
      continuationToken: "hung-token",
      attempts: 3,
    });

    expect(attemptedTokens).toEqual(Array(3).fill("hung-token"));
    expect(timeoutDelays).toEqual(Array(3).fill(1234));
    expect(aborts).toBe(3);
  });

  it("emits progress heartbeats at most ten seconds apart during a long backoff", async () => {
    const clock = fakeClock();
    const events = [];
    const paginator = createContinuationPaginator({
      fetch: async () => response(browseResponse([])),
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 2,
      backoffBaseMs: 24000,
      backoffCapMs: 24000,
      heartbeatIntervalMs: 9000,
    });

    await expect(paginator.paginate({
      continuationToken: "slow-token",
      requestTemplate: requestTemplate(),
      onProgress(event) {
        if (event.heartbeat) events.push(event);
      },
    })).rejects.toMatchObject({ code: "TRUNCATED" });

    expect(events.map((event) => event.at)).toEqual([0, 9000, 18000, 24000]);
    expect(events.every((event) => event.continuationToken === "slow-token")).toBe(true);
    expect(events.slice(1).every((event, index) => event.at - events[index].at <= 10000)).toBe(true);
  });

  it("replays the captured URL and headers while changing only the continuation token", async () => {
    const template = requestTemplate();
    const originalTemplate = structuredClone(template);
    const calls = [];
    const clock = fakeClock();
    const paginator = createContinuationPaginator({
      fetch: async (url, init) => {
        calls.push({ url, init: structuredClone(init) });
        const token = JSON.parse(init.body).continuation;
        return token === "first-token"
          ? response(browseResponse([{ id: "one", position: 1 }], "second-token"))
          : response(browseResponse([{ id: "two", position: 2 }]));
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    const result = await paginator.paginate({
      continuationToken: "first-token",
      requestTemplate: template,
    });

    expect(result.videos.map((video) => video.id)).toEqual(["one", "two"]);
    expect(calls.map((call) => call.url)).toEqual([template.url, template.url]);
    expect(calls.map((call) => call.init.headers)).toEqual([
      template.init.headers,
      template.init.headers,
    ]);
    expect(calls.map((call) => ({
      ...JSON.parse(call.init.body),
      continuation: undefined,
    }))).toEqual([
      { ...JSON.parse(template.init.body), continuation: undefined },
      { ...JSON.parse(template.init.body), continuation: undefined },
    ]);
    expect(calls.map((call) => JSON.parse(call.init.body).continuation)).toEqual([
      "first-token",
      "second-token",
    ]);
    expect(template).toEqual(originalTemplate);
  });
});

describe("buildContinuationRequest", () => {
  it("does not mutate the captured request template", () => {
    const template = requestTemplate();
    const before = structuredClone(template);

    const request = buildContinuationRequest(template, "replacement-token");

    expect(request.url).toBe(template.url);
    expect(JSON.parse(request.init.body)).toEqual({
      ...JSON.parse(template.init.body),
      continuation: "replacement-token",
    });
    expect(template).toEqual(before);
  });
});

describe("hasContinuationItems", () => {
  it("distinguishes nonvideo items from missing or empty continuation arrays", () => {
    expect(hasContinuationItems({
      nested: {
        appendContinuationItemsAction: {
          continuationItems: [{ unavailableRenderer: { reason: "Private video" } }],
        },
      },
    })).toBe(true);
    expect(hasContinuationItems({
      nested: { continuationItems: [{ unrelatedRenderer: {} }] },
    })).toBe(false);
    expect(hasContinuationItems({ nested: { continuationItems: [] } })).toBe(false);
    expect(hasContinuationItems({ nested: { items: [{}] } })).toBe(false);
    expect(hasContinuationItems("not json")).toBe(false);
  });
});
