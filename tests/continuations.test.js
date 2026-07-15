import { describe, expect, it } from "vitest";
import { parseBrowseResponse } from "../collector/continuations.js";

function renderer(id, position = 1) {
  return {
    videoId: id,
    title: { runs: [{ text: `Renderer ${id}` }] },
    shortBylineText: { runs: [{ text: "Renderer Channel" }] },
    lengthSeconds: "125",
    index: { simpleText: String(position) },
    videoInfo: { runs: [{ text: "2 days ago" }] },
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
            metadataRows: [
              { metadataParts: [{ text: { content: "Lockup Channel" } }] },
              { metadataParts: [{ text: { content: "3 days ago" } }] },
            ],
          },
        },
      },
    },
    rendererContext: {
      commandContext: {
        onTap: {
          innertubeCommand: {
            watchEndpoint: { videoId: id },
          },
        },
      },
    },
  };
}

function browseResponse(items, continuationToken = null) {
  const continuationItems = [...items];
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
      appendContinuationItemsAction: {
        continuationItems,
      },
    }],
  };
}

describe("parseBrowseResponse", () => {
  it("parses playlistVideoRenderer continuation items", () => {
    const result = parseBrowseResponse(browseResponse([
      { playlistVideoRenderer: renderer("renderer-one", 101) },
    ], "next-page-token"));

    expect(result.videos).toEqual([{
      id: "renderer-one",
      title: "Renderer renderer-one",
      channel: "Renderer Channel",
      durationSeconds: 125,
      position: 101,
      publishedText: "2 days ago",
    }]);
    expect(result.continuationToken).toBe("next-page-token");
  });

  it("parses lockupViewModel continuation items through the shared extractor", () => {
    const result = parseBrowseResponse(browseResponse([
      { lockupViewModel: lockup("lockup-one") },
    ]));

    expect(result.videos).toEqual([expect.objectContaining({
      id: "lockup-one",
      title: "Lockup lockup-one",
      channel: "Lockup Channel",
      position: null,
    })]);
    expect(result.continuationToken).toBeNull();
  });

  it("dedupes videos by id and tolerates serialized or malformed bodies", () => {
    const body = browseResponse([
      { playlistVideoRenderer: renderer("same-video", 101) },
      { playlistVideoRenderer: renderer("same-video", 102) },
    ]);

    expect(parseBrowseResponse(JSON.stringify(body))).toEqual({
      videos: [expect.objectContaining({ id: "same-video" })],
      continuationToken: null,
    });
    expect(parseBrowseResponse("not json")).toEqual({ videos: [], continuationToken: null });
    expect(parseBrowseResponse(null)).toEqual({ videos: [], continuationToken: null });
  });

  it("finds a continuation token defensively inside a continuation renderer", () => {
    const result = parseBrowseResponse({
      unexpectedWrapper: {
        continuationItemRenderer: {
          continuationEndpoint: {
            commandExecutorCommand: {
              commands: [{ continuationCommand: { token: "nested-next-page" } }],
            },
          },
        },
      },
    });

    expect(result).toEqual({ videos: [], continuationToken: "nested-next-page" });
  });

  it("keeps pagination moving across a page containing only unavailable entries", () => {
    const result = parseBrowseResponse(browseResponse([
      { unavailableRenderer: { reason: "Private video" } },
    ], "after-unavailable-page"));

    expect(result).toEqual({
      videos: [],
      continuationToken: "after-unavailable-page",
    });
  });
});
