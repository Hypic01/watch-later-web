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
  it("keeps the manual import flow fully visible when the extension is absent", () => {
    const html = renderToStaticMarkup(React.createElement(ImportPanel, baseProps));

    expect(html).toContain("Copy the collector");
    expect(html).toContain("Paste the result here");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("Sync your Watch Later</button>");
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
    expect(html).toContain("<summary>No extension? Paste manually</summary>");
    expect(html).toContain("Copy the collector");
  });
});
