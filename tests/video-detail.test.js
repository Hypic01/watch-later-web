import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VideoDetail from "../web/src/components/VideoDetail.jsx";
import { LearnIcon } from "../web/src/components/icons.jsx";

const video = {
  id: "abc12345678",
  title: "A useful video",
  channel: "A channel",
  duration_seconds: 603,
  category: "learn",
  reasoning: "The ideas carry the value.",
  topics: ["tech"],
  transcript_available: false,
};

const baseProps = {
  video,
  rowMeta: { label: "Worth learning from", tint: "#f472b6", icon: LearnIcon },
  extensionPresent: false,
  onBack: vi.fn(),
  onMove: vi.fn(),
  onDismiss: vi.fn(),
  onToast: vi.fn(),
};

describe("VideoDetail M4 actions", () => {
  it("always shows Learn, TLDR, and the free summary meter", () => {
    const html = renderToStaticMarkup(React.createElement(VideoDetail, {
      ...baseProps,
      me: { plan: "free", isAdmin: false, summariesUsed: 2, summaryQuota: 7 },
    }));

    expect(html).toContain("Learn</button>");
    expect(html).toContain("TL;DR</button>");
    expect(html).toContain("2 of 7 free summaries used");
    expect(html).toContain("YouTube</a>");
  });

  it("does not show a free meter for Pro", () => {
    const html = renderToStaticMarkup(React.createElement(VideoDetail, {
      ...baseProps,
      me: { plan: "pro", isAdmin: false, summariesUsed: 12, summaryQuota: 7 },
    }));

    expect(html).toContain("Learn</button>");
    expect(html).toContain("TL;DR</button>");
    expect(html).not.toContain("free summaries used");
  });
});
