import { describe, it, expect } from "vitest";
import {
  buildClassificationPrompt,
  validateResults,
  RESULT_SCHEMA,
  TOPICS,
  ClassificationError,
} from "../server/classify.js";
import { CATEGORIES } from "../server/db.js";

const video = (id = "abc12345678") => ({
  id,
  title: "Learn Something Fast",
  channel: "Some Channel",
  duration_seconds: 600,
  playlist_position: 3,
  published_text: "12K views • 2 years ago",
});

describe("buildClassificationPrompt", () => {
  it("is metadata-only and persona-generic by default", () => {
    const p = buildClassificationPrompt([video()], {});
    expect(p).toContain("METADATA ONLY");
    expect(p).not.toContain("Transcript");
    expect(p).not.toContain("Joon");
    expect(p).not.toContain("interests include");
    expect(p).toContain('--- VIDEO id: "abc12345678" ---');
    expect(p).toContain("Saved-list position: 3");
    expect(p).toContain("Age/views: 12K views • 2 years ago");
  });

  it("injects the taste profile", () => {
    const p = buildClassificationPrompt([video()], {
      tasteProfile: { interests: ["design", "ai-tools"], note: "I am learning UX" },
    });
    expect(p).toContain("Their interests include: design, ai-tools.");
    expect(p).toContain('In their own words: "I am learning UX"');
  });

  it("includes override examples as taste calibration", () => {
    const p = buildClassificationPrompt([video()], {
      examples: [
        { title: "Some Mix", channel: "DJ X", override_from: "entertainment", category: "music" },
        { title: "A Vlog", channel: null, override_from: null, category: "watch" },
      ],
    });
    expect(p).toContain("TASTE CALIBRATION");
    expect(p).toContain("AI said entertainment → they filed it as music");
    expect(p).toContain('"A Vlog" (unknown)');
  });

  it("uses learn (not ingest) and the five-category precedence", () => {
    const p = buildClassificationPrompt([video()], {});
    expect(p).toContain('"learn"');
    expect(p).not.toContain('"ingest"');
    expect(p).toContain("music > outdated > watch > learn");
  });
});

describe("RESULT_SCHEMA", () => {
  it("locks category and topics to the closed sets", () => {
    const item = RESULT_SCHEMA.properties.results.items;
    expect(item.properties.category.enum).toEqual([...CATEGORIES]);
    expect(item.properties.topics.items.enum).toEqual([...TOPICS]);
    expect(item.additionalProperties).toBe(false);
  });
});

describe("validateResults", () => {
  const ok = (id) => ({ id, category: "learn", reasoning: "r", confidence: 0.7, topics: ["design"] });

  it("passes a clean result set", () => {
    const out = validateResults({ results: [ok("a"), ok("b")] }, ["a", "b"]);
    expect(out).toHaveLength(2);
  });

  it("clamps confidence into [0,1]", () => {
    const out = validateResults({ results: [{ ...ok("a"), confidence: 3.7 }] }, ["a"]);
    expect(out[0].confidence).toBe(1);
    const low = validateResults({ results: [{ ...ok("a"), confidence: -2 }] }, ["a"]);
    expect(low[0].confidence).toBe(0);
  });

  it("filters topics to the whitelist and defaults to other", () => {
    const out = validateResults(
      { results: [{ ...ok("a"), topics: ["bogus", "design", "tech", "career"] }] },
      ["a"]
    );
    expect(out[0].topics).toEqual(["design", "tech"]);
    const none = validateResults({ results: [{ ...ok("a"), topics: ["bogus"] }] }, ["a"]);
    expect(none[0].topics).toEqual(["other"]);
  });

  it("rejects unknown categories, missing ids, id mismatches", () => {
    expect(() => validateResults({ results: [{ ...ok("a"), category: "ingest" }] }, ["a"])).toThrow(ClassificationError);
    expect(() => validateResults({ results: [{ ...ok("a"), id: 5 }] }, ["a"])).toThrow(ClassificationError);
    expect(() => validateResults({ results: [ok("a")] }, ["a", "b"])).toThrow(ClassificationError);
    expect(() => validateResults({}, ["a"])).toThrow(ClassificationError);
  });
});
