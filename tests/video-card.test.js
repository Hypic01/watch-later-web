import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import VideoCard from "../web/src/components/VideoCard.jsx";

const video = {
  id: "vid00000001",
  title: "A very good video",
  channel: "A channel",
  duration_seconds: 300,
  category: "learn",
  reasoning: "teaches something",
};

const baseProps = {
  video,
  onMove: () => {},
  onDismiss: () => {},
  onDone: () => {},
  onOpenDetail: () => {},
  onTldr: () => {},
  onLearn: () => {},
};

describe("VideoCard face", () => {
  it("surfaces TL;DR and Learn on the card and keeps Done off the face", () => {
    const html = renderToStaticMarkup(React.createElement(VideoCard, { ...baseProps, freePlan: false }));
    expect(html).toContain("TL;DR");
    expect(html).toContain("Learn");
    // Done now lives in the kebab menu as "Remove · watched it".
    expect(html).not.toContain(">done<");
    expect(html).not.toContain("Mark ");
  });

  it("locks Learn for free users", () => {
    const free = renderToStaticMarkup(React.createElement(VideoCard, { ...baseProps, freePlan: true }));
    const pro = renderToStaticMarkup(React.createElement(VideoCard, { ...baseProps, freePlan: false }));
    // The lock icon renders only on the free card's Learn button.
    expect(free).not.toBe(pro);
    expect(free).toContain("Learn");
  });
});
