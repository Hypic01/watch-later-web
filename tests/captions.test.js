import { describe, expect, it } from "vitest";
import {
  extractPlayerResponse,
  parseJson3,
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
