import { describe, expect, it } from "vitest";
import {
  buildGetTranscriptParams,
  extractPlayerResponse,
  parseGetTranscript,
  parseJson3,
  parseTimedtext,
  pickCaptionTrack,
} from "../collector/captions.js";

describe("extractPlayerResponse", () => {
  it("parses a player response when the HTML ends at the closing brace", () => {
    const response = {
      videoDetails: { videoId: "abc123", title: "A title with } inside" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    };
    const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(response)}`;

    expect(extractPlayerResponse(html)).toEqual(response);
  });

  it("supports bracket assignment and returns null without a usable response", () => {
    expect(extractPlayerResponse(
      `<script>window["ytInitialPlayerResponse"] = {"videoDetails":{"videoId":"xyz"}};</script>`,
    )).toEqual({ videoDetails: { videoId: "xyz" } });
    expect(extractPlayerResponse("<html>attestation required</html>")).toBeNull();
    expect(extractPlayerResponse(null)).toBeNull();
  });
});

describe("pickCaptionTrack", () => {
  it("prefers manual English or Korean captions before ASR tracks", () => {
    const asrEnglish = { languageCode: "en", kind: "asr", baseUrl: "auto-en" };
    const manualKorean = { languageCode: "ko", baseUrl: "manual-ko" };

    expect(pickCaptionTrack([asrEnglish, manualKorean], ["en", "ko"]))
      .toBe(manualKorean);
  });

  it("respects language order within manual tracks and then falls back safely", () => {
    const manualEnglishRegional = { languageCode: "en-US", baseUrl: "manual-en" };
    const manualKorean = { languageCode: "ko", baseUrl: "manual-ko" };
    const automaticFrench = { languageCode: "fr", kind: "asr", baseUrl: "auto-fr" };

    expect(pickCaptionTrack([manualKorean, manualEnglishRegional], ["en", "ko"]))
      .toBe(manualEnglishRegional);
    expect(pickCaptionTrack([automaticFrench], ["en", "ko"])).toBe(automaticFrench);
    expect(pickCaptionTrack([], ["en", "ko"])).toBeNull();
  });
});

describe("parseJson3", () => {
  it("joins the archived json3 fixture into clean text", () => {
    const raw = JSON.stringify({
      events: [
        { segs: [{ utf8: "Hello " }, { utf8: "world." }] },
        { segs: [{ utf8: "\n" }] },
        { segs: [{ utf8: "Second line." }] },
      ],
    });

    expect(parseJson3(raw)).toBe("Hello world. Second line.");
  });

  it("ignores noncaption events and missing segment text", () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0 },
        { segs: [{ utf8: "  first\t" }, {}, { utf8: " line  " }] },
        { segs: [] },
      ],
    });

    expect(parseJson3(raw)).toBe("first line");
    expect(parseJson3("{}")).toBe("");
  });
});

describe("parseTimedtext", () => {
  it("reads json3, including an XSSI prefix", () => {
    const json3 = JSON.stringify({ events: [{ segs: [{ utf8: "Hello " }, { utf8: "world." }] }] });
    expect(parseTimedtext(json3)).toBe("Hello world.");
    expect(parseTimedtext(")]}'\n" + json3)).toBe("Hello world.");
  });

  it("reads legacy XML with entities and nested tags", () => {
    const xml = `<?xml version="1.0"?><transcript>
      <text start="0" dur="2">Ben &amp; Jerry&#39;s</text>
      <text start="2" dur="2">say <i>hi</i> &lt;always&gt;</text>
    </transcript>`;
    expect(parseTimedtext(xml)).toBe("Ben & Jerry's say hi <always>");
  });

  it("treats YouTube's empty 200 body as no captions, never a crash", () => {
    expect(parseTimedtext("")).toBeNull();
    expect(parseTimedtext("   ")).toBeNull();
    expect(parseTimedtext(null)).toBeNull();
    expect(parseTimedtext("not json or xml")).toBeNull();
    expect(parseTimedtext("{broken json")).toBeNull();
  });
});

describe("get_transcript panel API pieces", () => {
  it("builds the params protobuf: field 1 wraps the video id", () => {
    const params = buildGetTranscriptParams("dQw4w9WgXcQ");
    const decoded = Buffer.from(params, "base64");
    expect(decoded[0]).toBe(0x0a);
    expect(decoded[1]).toBe(11);
    expect(decoded.slice(2).toString("binary")).toBe("dQw4w9WgXcQ");
  });

  it("collects cue segments in order from a panel response", () => {
    const response = {
      actions: [{
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              content: {
                transcriptSearchPanelRenderer: {
                  body: {
                    transcriptSegmentListRenderer: {
                      initialSegments: [
                        { transcriptSegmentRenderer: { snippet: { runs: [{ text: "First" }, { text: " cue." }] } } },
                        { transcriptSectionHeaderRenderer: { snippet: { simpleText: "Chapter" } } },
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
    };
    expect(parseGetTranscript(response)).toBe("First cue. Second cue.");
    expect(parseGetTranscript({})).toBeNull();
  });
});
