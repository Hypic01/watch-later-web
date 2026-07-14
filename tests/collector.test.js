import { describe, it, expect } from "vitest";
import {
  isWatchLaterPage,
  extractVideoData,
  extractLockupData,
  EXTRACTORS,
  parseInitialData,
  readInitialContinuationToken,
  readPlaylistTotal,
  collectInitial,
  createCollector,
  buildPayload,
  PAYLOAD_VERSION,
} from "../collector/collector.js";

// Structure mirrors real playlistVideoRenderer `.data` observed in the
// 2026-07-10 spike (content synthesized — no personal data).
function rendererData(overrides = {}) {
  return {
    videoId: "dQw4w9WgXcQ",
    title: { runs: [{ text: "How to Sharpen a Chef Knife" }] },
    shortBylineText: { runs: [{ text: "Kitchen Basics " }] },
    lengthSeconds: "897",
    index: { simpleText: "1" },
    videoInfo: { runs: [{ text: "165K views" }, { text: " • " }, { text: "4 years ago" }] },
    ...overrides,
  };
}

function lockupData(overrides = {}) {
  return {
    contentId: "lockup12345",
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    contentImage: {
      thumbnailViewModel: {
        overlays: [{
          thumbnailBottomOverlayViewModel: {
            badges: [{ thumbnailBadgeViewModel: { text: "1:02:03" } }],
          },
        }],
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: "A New YouTube Layout" },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: { content: "Layout Lab" } }] },
              { metadataParts: [{ text: { content: "12K views" } }, { text: { content: "2 days ago" } }] },
            ],
            delimiter: " • ",
          },
        },
      },
    },
    rendererContext: {
      commandContext: { onTap: { innertubeCommand: { watchEndpoint: { videoId: "lockup12345" } } } },
    },
    ...overrides,
  };
}

describe("isWatchLaterPage", () => {
  it("accepts the WL playlist URL", () => {
    expect(isWatchLaterPage("https://www.youtube.com/playlist?list=WL")).toBe(true);
    expect(isWatchLaterPage("https://youtube.com/playlist?list=WL&foo=1")).toBe(true);
  });
  it("rejects other pages", () => {
    expect(isWatchLaterPage("https://www.youtube.com/playlist?list=PL123")).toBe(false);
    expect(isWatchLaterPage("https://www.youtube.com/")).toBe(false);
    expect(isWatchLaterPage("https://evil.com/playlist?list=WL")).toBe(false);
    expect(isWatchLaterPage("not a url")).toBe(false);
  });
});

describe("extractVideoData", () => {
  it("maps the renderer fields", () => {
    expect(extractVideoData(rendererData())).toEqual({
      id: "dQw4w9WgXcQ",
      title: "How to Sharpen a Chef Knife",
      channel: "Kitchen Basics",
      durationSeconds: 897,
      position: 1,
      publishedText: "165K views • 4 years ago",
    });
  });

  it("tolerates missing optional fields", () => {
    const v = extractVideoData(rendererData({ lengthSeconds: undefined, index: undefined, videoInfo: undefined }));
    expect(v.durationSeconds).toBeNull();
    expect(v.position).toBeNull();
    expect(v.publishedText).toBeNull();
  });

  it("joins multi-run titles", () => {
    const v = extractVideoData(rendererData({ title: { runs: [{ text: "Part " }, { text: "One" }] } }));
    expect(v.title).toBe("Part One");
  });

  it("caps field lengths", () => {
    const v = extractVideoData(rendererData({ title: { runs: [{ text: "x".repeat(999) }] } }));
    expect(v.title.length).toBe(300);
  });

  it("returns null without a videoId", () => {
    expect(extractVideoData(undefined)).toBeNull();
    expect(extractVideoData({})).toBeNull();
    expect(extractVideoData({ videoId: "" })).toBeNull();
  });
});

describe("collector v2 data shapes", () => {
  it("normalizes lockupViewModel data", () => {
    expect(extractLockupData(lockupData())).toEqual({
      id: "lockup12345",
      title: "A New YouTube Layout",
      channel: "Layout Lab",
      durationSeconds: 3723,
      position: null,
      publishedText: "12K views • 2 days ago",
    });
    expect(extractLockupData({ lockupViewModel: lockupData() }).id).toBe("lockup12345");
    expect(extractLockupData(lockupData({ contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" }))).toBeNull();
  });

  it("parses playlistVideoRenderer entries from ytInitialData", () => {
    const win = {
      ytInitialData: {
        contents: [{ playlistVideoRenderer: vid("initial-old", 7) }],
      },
    };
    expect(parseInitialData(win)).toEqual([
      expect.objectContaining({ id: "initial-old", position: 7 }),
    ]);
  });

  it("parses lockupViewModel entries from ytInitialData", () => {
    const win = {
      ytInitialData: {
        contents: [{ lockupViewModel: lockupData() }],
      },
    };
    expect(parseInitialData(win)).toEqual([
      {
        id: "lockup12345",
        title: "A New YouTube Layout",
        channel: "Layout Lab",
        durationSeconds: 3723,
        position: 1,
        publishedText: "12K views • 2 days ago",
      },
    ]);
  });

  it("uses the first extractor selector that returns nodes", () => {
    expect(EXTRACTORS.map((entry) => entry.selector)).toEqual([
      "ytd-playlist-video-renderer",
      "yt-lockup-view-model",
    ]);
    const queried = [];
    const doc = {
      querySelectorAll(selector) {
        queried.push(selector);
        return selector === "yt-lockup-view-model" ? [{ data: lockupData() }] : [];
      },
    };
    expect(collectInitial({ doc, win: {} }).map((video) => video.id)).toEqual(["lockup12345"]);
    expect(queried).toEqual(["ytd-playlist-video-renderer", "yt-lockup-view-model"]);
  });

  it("collects initial JSON and DOM data without scrolling or pruning", () => {
    let scrollCount = 0;
    let removeCount = 0;
    const win = {
      ytInitialData: { contents: [{ playlistVideoRenderer: vid("initial", 1) }] },
      scrollTo() { scrollCount++; },
    };
    const doc = {
      querySelectorAll(selector) {
        if (selector !== "ytd-playlist-video-renderer") return [];
        return [{ data: vid("dom", 2), remove() { removeCount++; } }];
      },
    };
    expect(collectInitial({ doc, win }).map((video) => video.id)).toEqual(["initial", "dom"]);
    expect(scrollCount).toBe(0);
    expect(removeCount).toBe(0);
  });

  it("reads the formatted playlist total", () => {
    const win = {
      ytInitialData: {
        header: {
          playlistHeaderRenderer: {
            numVideosText: { runs: [{ text: "2,796" }, { text: " videos" }] },
          },
        },
      },
    };
    expect(readPlaylistTotal(win)).toBe(2796);
    expect(readPlaylistTotal({})).toBeNull();
  });

  it("reads the initial continuation token and returns null for a single page", () => {
    const paginated = {
      ytInitialData: {
        contents: [{
          continuationItemRenderer: {
            continuationEndpoint: {
              continuationCommand: { token: "initial-next-page" },
            },
          },
        }],
      },
    };
    const singlePage = {
      ytInitialData: {
        unrelatedContinuation: {
          continuationCommand: { token: "not-playlist-pagination" },
        },
        contents: [{ playlistVideoRenderer: vid("only-video", 1) }],
      },
    };

    expect(readInitialContinuationToken(paginated)).toBe("initial-next-page");
    expect(readInitialContinuationToken(singlePage)).toBeNull();
    expect(readInitialContinuationToken({})).toBeNull();
  });
});

// Fake page: batches of videos "load" on each scroll, like YouTube's
// infinite playlist. Nodes support .data and .remove() like real elements.
function fakePage(batches) {
  let loaded = [...batches.shift()];
  const win = {
    scrollTo() {
      if (batches.length) loaded = loaded.concat(batches.shift());
    },
  };
  const doc = {
    documentElement: { scrollHeight: 10000 },
    querySelectorAll(sel) {
      expect(sel).toBe("ytd-playlist-video-renderer");
      return loaded.map((d) => ({
        data: d,
        remove() {
          loaded = loaded.filter((x) => x !== d);
        },
      }));
    },
  };
  return { doc, win, domCount: () => loaded.length };
}

const vid = (id, pos) => rendererData({ videoId: id, index: { simpleText: String(pos) } });

describe("createCollector", () => {
  it("collects across scroll batches, dedupes, and terminates on stall", async () => {
    const page = fakePage([
      [vid("a1", 1), vid("a2", 2)],
      [vid("a2", 2), vid("a3", 3)], // duplicate a2 across batches
      [vid("a4", 4)],
    ]);
    const collector = createCollector({ ...page, sleep: async () => {}, scrollDelayMs: 0, stallDelayMs: 0 });
    const { videos, truncated } = await collector.collectAll();
    expect(videos.map((v) => v.id).sort()).toEqual(["a1", "a2", "a3", "a4"]);
    expect(truncated).toBe(false);
  });

  it("prunes rendered nodes to keep the DOM small", async () => {
    const many = Array.from({ length: 40 }, (_, i) => vid("v" + i, i + 1));
    const page = fakePage([many, [vid("w1", 41)]]);
    const collector = createCollector({ ...page, sleep: async () => {}, keepNodes: 5 });
    await collector.collectAll();
    expect(page.domCount()).toBeLessThanOrEqual(5 + 1);
  });

  it("keeps all harvested videos even after their nodes are pruned", async () => {
    const many = Array.from({ length: 30 }, (_, i) => vid("k" + i, i + 1));
    const page = fakePage([many]);
    const collector = createCollector({ ...page, sleep: async () => {}, keepNodes: 3 });
    const { videos } = await collector.collectAll();
    expect(videos.length).toBe(30);
  });

  it("reports truncation at maxRounds", async () => {
    let n = 0;
    const win = { scrollTo() {} };
    const doc = {
      documentElement: { scrollHeight: 1 },
      // a new video appears every round, forever
      querySelectorAll: () => [{ data: vid("inf" + n++, n), remove() {} }],
    };
    const collector = createCollector({ doc, win, sleep: async () => {}, maxRounds: 5 });
    const { truncated } = await collector.collectAll();
    expect(truncated).toBe(true);
  });

  it("emits progress", async () => {
    const page = fakePage([[vid("p1", 1)], [vid("p2", 2)]]);
    const collector = createCollector({ ...page, sleep: async () => {} });
    const seen = [];
    await collector.collectAll({ onProgress: (p) => seen.push(p.count) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(2);
  });

  it("uses supplemental growth to keep a lockup collection alive", async () => {
    const supplemental = [];
    let next = 1;
    const doc = {
      documentElement: { scrollHeight: 10000 },
      querySelectorAll() { return []; },
    };
    const win = {
      scrollTo() {
        if (next <= 6) supplemental.push(extractVideoData(vid(`supplemental-${next}`, next++)));
      },
    };
    const collector = createCollector({
      doc,
      win,
      sleep: async () => {},
      scrollDelayMs: 0,
      stallDelayMs: 0,
      getSupplementalVideos: () => supplemental,
    });

    const { videos } = await collector.collectAll();
    expect(videos.map((video) => video.id)).toEqual([
      "supplemental-1",
      "supplemental-2",
      "supplemental-3",
      "supplemental-4",
      "supplemental-5",
      "supplemental-6",
    ]);
  });
});

describe("buildPayload", () => {
  it("wraps videos in a versioned envelope", () => {
    const p = buildPayload([{ id: "x" }], "console");
    expect(p.v).toBe(PAYLOAD_VERSION);
    expect(p.source).toBe("console");
    expect(p.videos).toHaveLength(1);
    expect(new Date(p.collectedAt).getTime()).not.toBeNaN();
  });
});
