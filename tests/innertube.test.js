import { describe, expect, it, vi } from "vitest";
import {
  InnerTubeSetupError,
  createYtcfgRequestTemplate,
} from "../collector/innertube.js";

function page({ values = {}, cookie = "SAPISID=session-cookie" } = {}) {
  return {
    win: {
      location: {
        origin: "https://www.youtube.com",
        href: "https://www.youtube.com/playlist?list=WL",
      },
      ytcfg: {
        get: (key) => values[key],
      },
    },
    doc: { cookie },
  };
}

function config(overrides = {}) {
  return {
    INNERTUBE_API_KEY: "live-api-key",
    INNERTUBE_CONTEXT: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20260714.01.00",
        visitorData: "context-visitor",
        hl: "en",
      },
      user: { lockedSafetyMode: false },
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    INNERTUBE_CONTEXT_CLIENT_VERSION: "2.20260714.01.00",
    VISITOR_DATA: "live-visitor",
    SESSION_INDEX: 0,
    DELEGATED_SESSION_ID: "delegated-page",
    PAGE_CL: 777001,
    PAGE_BUILD_LABEL: "youtube.desktop.web_20260714_01_RC00",
    LOGGED_IN: true,
    ...overrides,
  };
}

describe("createYtcfgRequestTemplate", () => {
  it("builds an authenticated request from the live YouTube page configuration", async () => {
    const values = config();
    const context = values.INNERTUBE_CONTEXT;
    const { win, doc } = page({
      values,
      cookie: "__Secure-3PAPISID=secure-cookie; SAPISID=preferred-cookie; other=value",
    });
    const sha1 = vi.fn(async () => "a".repeat(40));

    const template = await createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 1_721_000_123_999,
      sha1,
    });

    const url = new URL(template.url);
    expect(url.origin).toBe("https://www.youtube.com");
    expect(url.pathname).toBe("/youtubei/v1/browse");
    expect(url.searchParams.get("key")).toBe("live-api-key");
    expect(url.searchParams.get("prettyPrint")).toBe("false");
    expect(template.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: [
          `SAPISIDHASH 1721000123_${"a".repeat(40)}`,
          `SAPISID3PHASH 1721000123_${"a".repeat(40)}`,
        ].join(" "),
        "x-origin": "https://www.youtube.com",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": "2.20260714.01.00",
        "x-goog-visitor-id": "live-visitor",
        "x-goog-authuser": "0",
        "x-goog-pageid": "delegated-page",
        "x-youtube-page-cl": "777001",
        "x-youtube-page-label": "youtube.desktop.web_20260714_01_RC00",
        "x-youtube-bootstrap-logged-in": "true",
      },
    });
    expect(JSON.parse(template.init.body)).toEqual({ context });
    expect(sha1).toHaveBeenNthCalledWith(1,
      "1721000123 preferred-cookie https://www.youtube.com",
    );
    expect(sha1).toHaveBeenNthCalledWith(2,
      "1721000123 secure-cookie https://www.youtube.com",
    );

    context.client.clientVersion = "changed-after-build";
    expect(JSON.parse(template.init.body).context.client.clientVersion).toBe("2.20260714.01.00");
  });

  it.each([
    {
      cookie: "__Secure-3PAPISID=secure-three; __Secure-1PAPISID=secure-one",
      expectedInputs: ["secure-three", "secure-one", "secure-three"],
      expectedSchemes: ["SAPISIDHASH", "SAPISID1PHASH", "SAPISID3PHASH"],
    },
    {
      cookie: "__Secure-1PAPISID=secure-one",
      expectedInputs: ["secure-one"],
      expectedSchemes: ["SAPISID1PHASH"],
    },
  ])("uses the correct auth scheme for each secure cookie", async ({
    cookie,
    expectedInputs,
    expectedSchemes,
  }) => {
    const { win, doc } = page({ values: config(), cookie });
    const sha1 = vi.fn(async () => "b".repeat(40));

    const template = await createYtcfgRequestTemplate({ win, doc, now: () => 10_000, sha1 });

    expect(sha1.mock.calls.map(([input]) => input)).toEqual(
      expectedInputs.map((cookieValue) => `10 ${cookieValue} https://www.youtube.com`),
    );
    expect(template.init.headers.authorization.split(" ").filter((part) => part.endsWith("HASH")))
      .toEqual(expectedSchemes);
  });

  it("uses live data sync session ids for secondary account authorization", async () => {
    const values = config({
      SESSION_INDEX: 2,
      DELEGATED_SESSION_ID: null,
      DATASYNC_ID: "delegated-brand||user-session",
    });
    const { win, doc } = page({
      values,
      cookie: [
        "SAPISID=plain-cookie",
        "__Secure-1PAPISID=secure-one",
        "__Secure-3PAPISID=secure-three",
      ].join("; "),
    });
    const sha1 = vi.fn(async () => "f".repeat(40));

    const template = await createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 10_000,
      sha1,
    });

    expect(sha1.mock.calls.map(([input]) => input)).toEqual([
      "user-session 10 plain-cookie https://www.youtube.com",
      "user-session 10 secure-one https://www.youtube.com",
      "user-session 10 secure-three https://www.youtube.com",
    ]);
    expect(template.init.headers.authorization).toBe([
      `SAPISIDHASH 10_${"f".repeat(40)}_u`,
      `SAPISID1PHASH 10_${"f".repeat(40)}_u`,
      `SAPISID3PHASH 10_${"f".repeat(40)}_u`,
    ].join(" "));
    expect(template.init.headers["x-goog-pageid"]).toBe("delegated-brand");
    expect(template.init.headers["x-goog-authuser"]).toBe("2");
  });

  it("parses a primary account data sync id without inventing a page id", async () => {
    const values = config({
      SESSION_INDEX: null,
      DELEGATED_SESSION_ID: null,
      DATASYNC_ID: "primary-user||",
    });
    const { win, doc } = page({ values });
    const sha1 = vi.fn(async () => "9".repeat(40));

    const template = await createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 10_000,
      sha1,
    });

    expect(sha1).toHaveBeenCalledWith(
      "primary-user 10 session-cookie https://www.youtube.com",
    );
    expect(template.init.headers.authorization).toBe(
      `SAPISIDHASH 10_${"9".repeat(40)}_u`,
    );
    expect(template.init.headers).not.toHaveProperty("x-goog-pageid");
    expect(template.init.headers).not.toHaveProperty("x-goog-authuser");
  });

  it("uses context client values and omits unavailable optional headers", async () => {
    const values = config({
      INNERTUBE_CONTEXT_CLIENT_NAME: null,
      INNERTUBE_CONTEXT_CLIENT_VERSION: null,
      VISITOR_DATA: null,
      SESSION_INDEX: null,
      DELEGATED_SESSION_ID: null,
      PAGE_CL: null,
      PAGE_BUILD_LABEL: null,
      LOGGED_IN: false,
    });
    const { win, doc } = page({ values });

    const template = await createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 10_000,
      sha1: async () => "c".repeat(40),
    });

    expect(template.init.headers).toMatchObject({
      "x-youtube-client-name": "WEB",
      "x-youtube-client-version": "2.20260714.01.00",
      "x-goog-visitor-id": "context-visitor",
    });
    expect(template.init.headers).not.toHaveProperty("x-goog-authuser");
    expect(template.init.headers).not.toHaveProperty("x-goog-pageid");
    expect(template.init.headers).not.toHaveProperty("x-youtube-page-cl");
    expect(template.init.headers).not.toHaveProperty("x-youtube-page-label");
    expect(template.init.headers).not.toHaveProperty("x-youtube-bootstrap-logged-in");
  });

  it("falls back to the live ytcfg data object when get is unavailable", async () => {
    const values = config();
    const win = {
      location: { origin: "https://www.youtube.com" },
      ytcfg: { data_: values },
    };

    const template = await createYtcfgRequestTemplate({
      win,
      doc: { cookie: "SAPISID=session-cookie" },
      now: () => 10_000,
      sha1: async () => "e".repeat(40),
    });

    expect(new URL(template.url).searchParams.get("key")).toBe("live-api-key");
    expect(JSON.parse(template.init.body).context.client.clientVersion)
      .toBe("2.20260714.01.00");
  });

  it.each([
    {
      reason: "MISSING_API_KEY",
      values: config({ INNERTUBE_API_KEY: null }),
      cookie: "SAPISID=session-cookie",
    },
    {
      reason: "MISSING_CONTEXT",
      values: config({ INNERTUBE_CONTEXT: null }),
      cookie: "SAPISID=session-cookie",
    },
    {
      reason: "MISSING_AUTH_COOKIE",
      values: config(),
      cookie: "other=value",
    },
  ])("throws a typed $reason setup error", async ({ reason, values, cookie }) => {
    const { win, doc } = page({ values, cookie });

    await expect(createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 10_000,
      sha1: async () => "d".repeat(40),
    })).rejects.toMatchObject({
      name: "InnerTubeSetupError",
      code: "INNERTUBE_SETUP_FAILED",
      reason,
    });

    try {
      await createYtcfgRequestTemplate({
        win,
        doc,
        now: () => 10_000,
        sha1: async () => "d".repeat(40),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(InnerTubeSetupError);
    }
  });

  it("wraps hashing failures in a typed setup error", async () => {
    const { win, doc } = page({ values: config() });
    const failure = new Error("digest unavailable");

    await expect(createYtcfgRequestTemplate({
      win,
      doc,
      now: () => 10_000,
      sha1: async () => { throw failure; },
    })).rejects.toMatchObject({
      name: "InnerTubeSetupError",
      code: "INNERTUBE_SETUP_FAILED",
      reason: "HASH_FAILED",
      cause: failure,
    });
  });
});
