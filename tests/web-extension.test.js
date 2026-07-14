import { describe, expect, it } from "vitest";
import {
  availabilitySummary,
  isChromiumBrowser,
  parseExtensionIds,
} from "../web/src/extension.js";

describe("website extension helpers", () => {
  it("shows extension onboarding only in Chromium browsers that can use the desktop extension", () => {
    expect(isChromiumBrowser({
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
    })).toBe(true);
    expect(isChromiumBrowser({
      userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
      userAgentData: { brands: [{ brand: "Google Chrome" }] },
    })).toBe(false);
    expect(isChromiumBrowser({
      userAgent: "Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/128.0",
    })).toBe(false);
  });

  it("accepts comma separated stable extension IDs and removes invalid duplicates", () => {
    const first = "abcdefghijklmnopabcdefghijklmnop";
    const second = "ponmlkjihgfedcbaponmlkjihgfedcba";
    expect(parseExtensionIds(`${first}, ${second}, ${first}, invalid`)).toEqual([first, second]);
  });

  it("explains unavailable playlist entries only when the completed walk proves a gap", () => {
    expect(availabilitySummary({ collected: 2724, unavailable: 72 })).toBe(
      "2,724 of 2,796 videos were available. The other 72 are private or deleted.",
    );
    expect(availabilitySummary({ collected: 100, unavailable: 0 })).toBe("");
    expect(availabilitySummary({ collected: 60 })).toBe("");
  });
});
