import { describe, expect, it, vi } from "vitest";
import { createTranscriptController } from "../extension/src/transcript.js";
import { WLL_FETCH_TRANSCRIPT, WLL_PING } from "../extension/src/messages.js";
import { createExtensionClient } from "../web/src/extension.js";

const VIDEO_ID = "abc123DEF_0";

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  };
}

function playerResponse({ trackKind = null } = {}) {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: {
      author: "Caption Channel",
      lengthSeconds: "125",
      shortDescription: "A useful description.",
    },
    microformat: {
      playerMicroformatRenderer: { uploadDate: "2026-07-15" },
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: "https://www.youtube.com/api/timedtext?lang=en",
          languageCode: "en",
          ...(trackKind ? { kind: trackKind } : {}),
        }],
      },
    },
  };
}

function baseChromeFakes() {
  return {
    tabs: {
      create: vi.fn(async () => ({ id: 42, status: "complete" })),
      remove: vi.fn(async () => {}),
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
  };
}

describe("extension transcript controller", () => {
  it("fetches a watch page and json3 captions directly with YouTube credentials", async () => {
    const player = playerResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(textResponse(
        `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`,
      ))
      .mockResolvedValueOnce(textResponse(JSON.stringify({
        events: [{ segs: [{ utf8: "First " }, { utf8: "caption." }] }],
      })));
    const { tabs, scripting } = baseChromeFakes();
    const controller = createTranscriptController({ fetch, tabs, scripting });

    await expect(controller.fetchTranscript(VIDEO_ID)).resolves.toEqual({
      ok: true,
      transcript: "First caption.",
      source: "extension",
      captionKind: "manual",
      language: "en",
      description: "A useful description.",
      uploadDate: "2026-07-15",
      durationSeconds: 125,
      channel: "Caption Channel",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      { credentials: "include" },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://www.youtube.com/api/timedtext?lang=en&fmt=json3",
      { credentials: "include" },
    );
    expect(tabs.create).not.toHaveBeenCalled();
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  // The tab fakes answer each MAIN-world call by shape: no args reads the
  // page's player response; { playerWaitTicks } is the in-page probe, which
  // answers with panelBody (transcript-panel API) and/or captionBody (the
  // player's own captured timedtext response).
  function smartScripting({ player = null, captionBody = null, panelBody = null, detail = [] } = {}) {
    return {
      executeScript: vi.fn(async ({ args }) => {
        if (!args) return [{ frameId: 0, result: player }];
        if (args[0]?.playerWaitTicks) {
          return [{ frameId: 0, result: { panelBody, captionBody, detail } }];
        }
        return [];
      }),
    };
  }

  it("falls back to a background tab and fetches captions with page context", async () => {
    const player = playerResponse({ trackKind: "asr" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(textResponse("<html>attestation required</html>"));
    let markTabCreated;
    const tabCreated = new Promise((resolve) => { markTabCreated = resolve; });
    const tabs = {
      create: vi.fn(async (options) => {
        markTabCreated(options);
        return { id: 42, status: "loading", ...options };
      }),
      remove: vi.fn(async () => {}),
    };
    const scripting = smartScripting({
      player,
      captionBody: JSON.stringify({ events: [{ segs: [{ utf8: "Recovered captions." }] }] }),
    });
    const controller = createTranscriptController({ fetch, tabs, scripting });

    const pending = controller.fetchTranscript(VIDEO_ID);
    await tabCreated;
    let handled = false;
    for (let attempt = 0; attempt < 10 && !handled; attempt += 1) {
      await Promise.resolve();
      handled = controller.handleTabUpdated(
        42,
        { status: "complete" },
        { id: 42, status: "complete" },
      );
    }

    await expect(pending).resolves.toMatchObject({
      ok: true,
      transcript: "Recovered captions.",
      source: "extension",
      captionKind: "asr",
      language: "en",
    });
    expect(handled).toBe(true);
    expect(tabs.create).toHaveBeenCalledWith({
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      active: false,
    });
    expect(scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42 },
      world: "MAIN",
      func: expect.any(Function),
    }));
    expect(tabs.remove).toHaveBeenCalledWith(42);
  });

  it("opens the tab when the worker caption fetch gets YouTube's empty 200", async () => {
    // The exact production failure: the watch page parses fine and a track
    // exists, but timedtext answers the extension with a zero-byte 200.
    const player = playerResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(textResponse(
        `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`,
      ))
      .mockResolvedValueOnce(textResponse("")); // worker timedtext: empty 200
    const tabs = {
      create: vi.fn(async () => ({ id: 7, status: "complete" })),
      remove: vi.fn(async () => {}),
    };
    const scripting = smartScripting({
      player,
      captionBody: JSON.stringify({ events: [{ segs: [{ utf8: "Page context wins." }] }] }),
    });
    const controller = createTranscriptController({ fetch, tabs, scripting });

    await expect(controller.fetchTranscript(VIDEO_ID)).resolves.toMatchObject({
      ok: true,
      transcript: "Page context wins.",
      captionKind: "manual",
    });
    expect(tabs.remove).toHaveBeenCalledWith(7);
  });

  it("falls through to the transcript panel API when caption URLs stay empty", async () => {
    const player = playerResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(textResponse(
        `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`,
      ))
      .mockResolvedValueOnce(textResponse(""));
    const tabs = {
      create: vi.fn(async () => ({ id: 7, status: "complete" })),
      remove: vi.fn(async () => {}),
    };
    const scripting = smartScripting({
      player,
      captionBody: null,
      panelBody: JSON.stringify({
        actions: [{
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                content: {
                  transcriptSearchPanelRenderer: {
                    body: {
                      transcriptSegmentListRenderer: {
                        initialSegments: [
                          { transcriptSegmentRenderer: { snippet: { runs: [{ text: "Panel " }, { text: "saves the day." }] } } },
                          { transcriptSegmentRenderer: { snippet: { simpleText: "Second cue." } } },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        }],
      }),
    });
    const controller = createTranscriptController({ fetch, tabs, scripting });

    await expect(controller.fetchTranscript(VIDEO_ID)).resolves.toMatchObject({
      ok: true,
      transcript: "Panel saves the day. Second cue.",
      captionKind: "manual",
    });
    expect(tabs.remove).toHaveBeenCalledWith(7);
  });

  it("reports empty captions honestly with the probe's layer detail", async () => {
    const player = playerResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(textResponse(
        `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`,
      ))
      .mockResolvedValueOnce(textResponse(""));
    const tabs = {
      create: vi.fn(async () => ({ id: 7, status: "complete" })),
      remove: vi.fn(async () => {}),
    };
    const scripting = smartScripting({
      player,
      detail: ["panel 400 274b authed", "player capture empty"],
    });
    const controller = createTranscriptController({ fetch, tabs, scripting });

    const failure = await controller.fetchTranscript(VIDEO_ID).catch((error) => error);
    expect(failure).toMatchObject({ code: "EMPTY_TRANSCRIPT" });
    // The layer detail rides in the message so a real-world failure tells us
    // exactly which layer to blame without a debug build.
    expect(failure.message).toContain("panel 400 274b authed");
    expect(failure.message).toContain("player capture empty");
    expect(tabs.remove).toHaveBeenCalledWith(7);
  });

  it("always closes a fallback tab when MAIN world injection fails", async () => {
    const fetch = vi.fn(async () => textResponse("<html>attestation required</html>"));
    const tabs = {
      create: vi.fn(async () => ({ id: 42, status: "complete" })),
      remove: vi.fn(async () => {}),
    };
    const scripting = {
      executeScript: vi.fn(async () => { throw new Error("injection failed"); }),
    };
    const controller = createTranscriptController({ fetch, tabs, scripting });

    await expect(controller.fetchTranscript(VIDEO_ID)).rejects.toMatchObject({
      code: "PLAYER_RESPONSE_UNAVAILABLE",
      message: "YouTube did not expose captions for this video.",
    });
    expect(tabs.remove).toHaveBeenCalledWith(42);
  });
});

describe("website transcript extension client", () => {
  it("uses the detected extension ID for WLL_FETCH_TRANSCRIPT", async () => {
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const runtime = {
      lastError: null,
      sendMessage: vi.fn(async (_id, message) => {
        if (message.type === WLL_PING) return { ok: true, version: "0.1.0" };
        if (message.type === WLL_FETCH_TRANSCRIPT) {
          return { ok: true, transcript: "From Chrome." };
        }
        return null;
      }),
    };
    const client = createExtensionClient({ runtime, extensionIds: [extensionId] });

    await expect(client.detect()).resolves.toMatchObject({ present: true, id: extensionId });
    await expect(client.fetchTranscript(VIDEO_ID)).resolves.toEqual({
      ok: true,
      transcript: "From Chrome.",
    });
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      extensionId,
      { type: WLL_FETCH_TRANSCRIPT, videoId: VIDEO_ID },
      expect.any(Function),
    );
  });

  it("surfaces the extension transcript error code and honest message", async () => {
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const runtime = {
      lastError: null,
      sendMessage: vi.fn(async (_id, message) => message.type === WLL_PING
        ? { ok: true, version: "0.1.0" }
        : { error: "NO_CAPTIONS", message: "This video has no captions available." }),
    };
    const client = createExtensionClient({ runtime, extensionIds: [extensionId] });
    await client.detect();

    await expect(client.fetchTranscript(VIDEO_ID)).rejects.toMatchObject({
      code: "NO_CAPTIONS",
      message: "This video has no captions available.",
    });
  });
});
