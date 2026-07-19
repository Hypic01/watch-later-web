import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ImportPanel from "../web/src/components/ImportPanel.jsx";

const baseProps = {
  onImported: vi.fn(),
  extension: {
    checking: false,
    present: false,
    connected: false,
    mismatch: false,
    isChromium: true,
  },
  onConnectExtension: vi.fn(),
  extensionBusy: false,
  onSyncExtension: vi.fn(),
};

describe("ImportPanel extension priority", () => {
  it("offers the store install and collapses the manual flow on Chromium without the extension", () => {
    const html = renderToStaticMarkup(React.createElement(ImportPanel, baseProps));

    expect(html).toContain("Add to Chrome");
    expect(html).toContain("chromewebstore.google.com");
    expect(html).toContain("<summary>Prefer not to install? Paste manually</summary>");
    expect(html).toContain("Copy the collector");
    expect(html).not.toContain("Sync your Watch Later</button>");
  });

  // Non-Chromium users cannot install the extension at all, so pasting is their
  // only path and must never be hidden behind a disclosure.
  it("keeps the manual import flow fully visible off Chromium", () => {
    const html = renderToStaticMarkup(
      React.createElement(ImportPanel, {
        ...baseProps,
        extension: { ...baseProps.extension, isChromium: false },
      }),
    );

    expect(html).toContain("Copy the collector");
    expect(html).toContain("Paste the result here");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("Add to Chrome");
  });

  it("makes Sync primary and collapses the manual flow when the extension is connected", () => {
    const html = renderToStaticMarkup(
      React.createElement(ImportPanel, {
        ...baseProps,
        extension: { ...baseProps.extension, present: true, connected: true },
        extensionConnected: true,
      }),
    );

    expect(html).toContain("Sync your Watch Later</button>");
    expect(html).toContain("<details class=\"importer__manual\">");
    expect(html).toContain("<summary>Import manually instead</summary>");
    expect(html).toContain("Copy the collector");
  });
});
