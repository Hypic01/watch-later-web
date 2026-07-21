import { describe, it, expect } from "vitest";
import { timeAgo, absoluteTime } from "../web/src/lib.js";

const now = Date.parse("2026-07-21T12:00:00Z");
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ago = (ms) => new Date(now - ms).toISOString();

describe("timeAgo", () => {
  it("reads 'just now' under a minute", () => {
    expect(timeAgo(ago(0), now)).toBe("just now");
    expect(timeAgo(ago(59 * SEC), now)).toBe("just now");
  });

  it("counts whole minutes, hours, and days at each boundary", () => {
    expect(timeAgo(ago(MIN), now)).toBe("1m ago");
    expect(timeAgo(ago(59 * MIN), now)).toBe("59m ago");
    expect(timeAgo(ago(HOUR), now)).toBe("1h ago");
    expect(timeAgo(ago(23 * HOUR), now)).toBe("23h ago");
    expect(timeAgo(ago(DAY), now)).toBe("1d ago");
    expect(timeAgo(ago(6 * DAY), now)).toBe("6d ago");
  });

  it("falls back to a plain date once past a week", () => {
    const out = timeAgo(ago(8 * DAY), now);
    expect(out).not.toMatch(/ago|just now/);
    expect(out).toBe(
      new Date(now - 8 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    );
  });

  it("clamps future timestamps (clock skew) to 'just now' and returns null on junk", () => {
    expect(timeAgo(ago(-5 * MIN), now)).toBe("just now");
    expect(timeAgo("not-a-date", now)).toBeNull();
    expect(timeAgo(null, now)).toBeNull();
  });
});

describe("absoluteTime", () => {
  it("returns a stamp for a valid iso and empty string for junk", () => {
    expect(absoluteTime("2026-07-21T12:00:00Z")).toBeTruthy();
    expect(absoluteTime("nope")).toBe("");
    expect(absoluteTime(null)).toBe("");
  });
});
