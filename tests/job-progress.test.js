import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import JobProgress from "../web/src/components/JobProgress.jsx";

describe("JobProgress", () => {
  it("renders the sorting bar for a just-started job (the optimistic adopt shape)", () => {
    // App adopts this exact shape the instant Sync / "Sort the rest" starts a
    // job, before any fetch — the bar must render from it so fast sorts still
    // give feedback instead of appearing to do nothing.
    const html = renderToStaticMarkup(React.createElement(JobProgress, {
      job: { id: "42", state: "queued", mode: null, tier: null, total: 8, processed: 0, failed: 0, error: null },
      collection: null,
      onCancelled: () => {},
    }));
    expect(html).toContain("Sorting");
    expect(html).toContain("0 / 8");
    expect(html).toContain("progress-track");
  });

  it("shows the background note only while awaiting a batch", () => {
    const awaiting = renderToStaticMarkup(React.createElement(JobProgress, {
      job: { id: "9", state: "awaiting_batch", total: 2753, processed: 0 },
      collection: null,
      onCancelled: () => {},
    }));
    expect(awaiting).toContain("runs in the background");
    const running = renderToStaticMarkup(React.createElement(JobProgress, {
      job: { id: "9", state: "running", total: 2753, processed: 500 },
      collection: null,
      onCancelled: () => {},
    }));
    expect(running).not.toContain("runs in the background");
    expect(running).toContain("500 / 2,753");
  });
});
