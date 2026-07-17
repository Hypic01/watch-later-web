import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_KEY,
  RESULT_KEY,
  SYNC_KEEPALIVE_ALARM,
  SYNC_SESSION_KEY,
  createSyncController,
} from "../extension/src/sync.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_START,
  WLL_SYNC_DONE,
  WLL_SYNC_ERROR,
} from "../extension/src/messages.js";
import { ExtensionApiError, createExtensionApi } from "../extension/src/api.js";
import { AUTO_SYNC_KEY } from "../extension/src/auto-sync.js";

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      delete data[key];
    },
    peek(key) {
      return structuredClone(data[key]);
    },
  };
}

function harness({
  existing = null,
  firstSync = false,
  apiImpl = vi.fn(async () => ({
    added: 1,
    duplicates: 0,
    jobId: 12,
    willClassify: 1,
    locked: 0,
  })),
  sessionState = null,
} = {}) {
  const tabsById = new Map();
  if (existing) tabsById.set(existing.id, { status: "complete", active: false, ...existing });
  const created = [];
  const sent = [];
  const removed = [];
  const tabs = {
    query: vi.fn(async () => existing ? [tabsById.get(existing.id)] : []),
    create: vi.fn(async (options) => {
      const tab = { id: 99, status: "complete", ...options };
      tabsById.set(tab.id, tab);
      created.push(options);
      return tab;
    }),
    get: vi.fn(async (id) => {
      if (!tabsById.has(id)) throw new Error("missing tab");
      return tabsById.get(id);
    }),
    update: vi.fn(async (id, patch) => {
      const tab = { ...tabsById.get(id), ...patch };
      tabsById.set(id, tab);
      return tab;
    }),
    sendMessage: vi.fn(async (id, message) => {
      sent.push({ id, message });
      return { ok: true };
    }),
    remove: vi.fn(async (id) => {
      tabsById.delete(id);
      removed.push(id);
    }),
  };
  const scripting = { executeScript: vi.fn(async () => []) };
  const alarms = {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => true),
  };
  const local = fakeArea({
    [CONNECTION_KEY]: {
      token: "wll_test",
      apiUrl: "https://watch-later-web.vercel.app",
      email: "reader@example.com",
    },
    ...(!firstSync ? {
      [RESULT_KEY]: {
        lastSyncAt: "2026-07-13T00:00:00.000Z",
        lastResult: { ok: true, added: 2 },
      },
    } : {}),
  });
  const session = fakeArea(sessionState ? { [SYNC_SESSION_KEY]: sessionState } : {});
  const sync = fakeArea();
  const published = [];
  const badges = [];
  const controller = createSyncController({
    tabs,
    scripting,
    storage: { local, session, sync },
    alarms,
    api: { importVideos: apiImpl },
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    publish: (message) => published.push(message),
    setBadge: (text) => badges.push(text),
  });
  return {
    controller,
    tabs,
    scripting,
    alarms,
    local,
    session,
    sync,
    apiImpl,
    created,
    sent,
    removed,
    published,
    badges,
  };
}

async function currentRun(h) {
  return h.session.peek(SYNC_SESSION_KEY);
}

async function finish(h, message = {}) {
  const state = await currentRun(h);
  return h.controller.handleCollectorMessage({
    type: COLLECT_DONE,
    runId: state.runId,
    videos: [{ id: "video12345", title: "A video" }],
    truncated: false,
    ...message,
  }, { tab: { id: state.tabId } });
}

describe("createSyncController", () => {
  it("reuses an open Watch Later tab and creates a background tab when none exists", async () => {
    const reused = harness({
      existing: { id: 7, url: "https://www.youtube.com/playlist?list=WL", active: false },
    });
    await expect(reused.controller.start({ mode: "delta" })).resolves.toMatchObject({ started: true, mode: "delta" });
    expect(reused.tabs.create).not.toHaveBeenCalled();
    expect(reused.scripting.executeScript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      target: { tabId: 7 },
      world: "ISOLATED",
    }));
    expect(reused.scripting.executeScript).toHaveBeenNthCalledWith(2, expect.objectContaining({
      target: { tabId: 7 },
      world: "MAIN",
    }));

    const created = harness();
    await created.controller.start({ mode: "delta" });
    expect(created.created).toEqual([{ url: "https://www.youtube.com/playlist?list=WL", active: false }]);
  });

  it("forwards delta and full modes while leaving full sync in the background", async () => {
    const delta = harness();
    await delta.controller.start({ mode: "delta" });
    expect(delta.sent[0].message).toMatchObject({ type: COLLECT_START, mode: "delta" });

    const full = harness({
      existing: { id: 8, url: "https://www.youtube.com/playlist?list=WL", active: false },
    });
    await full.controller.start({ mode: "full" });
    expect(full.tabs.update).not.toHaveBeenCalled();
    expect(full.sent[0].message).toMatchObject({ type: COLLECT_START, mode: "full" });
  });

  it("promotes the first requested delta sync to a background full sync", async () => {
    const h = harness({ firstSync: true });
    await expect(h.controller.start({ mode: "delta" })).resolves.toMatchObject({
      started: true,
      mode: "full",
    });
    expect(h.created[0].active).toBe(false);
    expect(h.sent[0].message.mode).toBe("full");
  });

  it("keeps an automatic first sync in delta mode", async () => {
    const h = harness({ firstSync: true });
    await expect(h.controller.start({
      mode: "delta",
      promoteFirstSync: false,
    })).resolves.toMatchObject({
      started: true,
      mode: "delta",
    });
    expect(h.sent[0].message.mode).toBe("delta");
  });

  it("reports whether automatic sync is enabled", async () => {
    const h = harness();
    await h.sync.set({ [AUTO_SYNC_KEY]: 1440 });
    await expect(h.controller.getStatus()).resolves.toMatchObject({ autoSync: true });

    await h.sync.set({ [AUTO_SYNC_KEY]: 0 });
    await expect(h.controller.getStatus()).resolves.toMatchObject({ autoSync: false });
  });

  it("rejects a saved API address outside HTTP and HTTPS", async () => {
    const h = harness();
    await expect(h.controller.setConnection({
      token: "wll_test",
      apiUrl: "file:///tmp/imports",
      email: "reader@example.com",
    })).resolves.toEqual({ ok: false, error: "INVALID_CONNECTION" });
  });

  it("propagates SIGNED_OUT cleanly without importing", async () => {
    const h = harness();
    await h.controller.start({ mode: "delta" });
    const state = await currentRun(h);
    await h.controller.handleCollectorMessage({
      type: COLLECT_ERROR,
      runId: state.runId,
      code: "SIGNED_OUT",
      error: "Sign in to YouTube, then try again.",
    }, { tab: { id: state.tabId } });

    expect(h.apiImpl).not.toHaveBeenCalled();
    expect(h.published.at(-1)).toEqual(expect.objectContaining({
      type: WLL_SYNC_ERROR,
      code: "SIGNED_OUT",
    }));
    expect((await h.controller.getStatus()).lastResult).toEqual(expect.objectContaining({
      ok: false,
      code: "SIGNED_OUT",
    }));
    expect(h.removed).toEqual([99]);
  });

  it("keeps a second trigger as a no op while one sync is active", async () => {
    const h = harness();
    await expect(h.controller.start({ mode: "delta" })).resolves.toMatchObject({ started: true });
    await expect(h.controller.start({ mode: "full" })).resolves.toEqual({ started: false });
    expect(h.tabs.query).toHaveBeenCalledTimes(1);
    expect(h.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the worker alive only while a sync is active", async () => {
    const h = harness();

    await h.controller.start({ mode: "full" });
    expect(h.alarms.create).toHaveBeenCalledWith(SYNC_KEEPALIVE_ALARM, {
      periodInMinutes: 0.5,
    });

    h.alarms.clear.mockClear();
    await finish(h);
    expect(h.alarms.clear).toHaveBeenCalledTimes(1);
    expect(h.alarms.clear).toHaveBeenCalledWith(SYNC_KEEPALIVE_ALARM);
    expect(h.session.peek(SYNC_SESSION_KEY)).toBeUndefined();
  });

  it("clears the keepalive alarm when collection fails", async () => {
    const h = harness();
    await h.controller.start({ mode: "full" });
    const state = await currentRun(h);
    h.alarms.clear.mockClear();

    await h.controller.handleCollectorMessage({
      type: COLLECT_ERROR,
      runId: state.runId,
      code: "TRUNCATED",
      error: "We could not read the whole list.",
    }, { tab: { id: state.tabId } });

    expect(h.alarms.clear).toHaveBeenCalledTimes(1);
    expect(h.alarms.clear).toHaveBeenCalledWith(SYNC_KEEPALIVE_ALARM);
    expect(h.session.peek(SYNC_SESSION_KEY)).toBeUndefined();
  });

  it("recovers a collecting run after a service worker restart and replays COLLECT_START", async () => {
    const saved = {
      syncing: true,
      runId: "persisted-run",
      mode: "full",
      phase: "collecting",
      tabId: 44,
      createdTab: false,
      count: 120,
      expectedTotal: 500,
      startedAt: "2026-07-14T11:00:00.000Z",
    };
    const h = harness({
      existing: { id: 44, url: "https://www.youtube.com/playlist?list=WL", active: true },
      sessionState: saved,
    });
    await expect(h.controller.recover()).resolves.toEqual({ recovered: true });
    expect(h.alarms.create).toHaveBeenCalledWith(SYNC_KEEPALIVE_ALARM, {
      periodInMinutes: 0.5,
    });
    expect(h.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([{ id: 44, message: {
      type: COLLECT_START,
      mode: "full",
      runId: "persisted-run",
    } }]);
  });

  it("retries an interrupted import from storage.session", async () => {
    const saved = {
      syncing: true,
      runId: "pending-import",
      mode: "full",
      phase: "importing",
      tabId: 44,
      createdTab: false,
      pendingVideos: [{ id: "pending12345", title: "Pending" }],
      pendingCollection: { collected: 1, unavailable: 9 },
    };
    const h = harness({ sessionState: saved });
    await h.controller.recover();
    expect(h.apiImpl).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ source: "extension", videos: saved.pendingVideos }),
    }));
    expect(h.published.at(-1)).toMatchObject({
      type: WLL_SYNC_DONE,
      collected: 1,
      unavailable: 9,
    });
    expect(h.session.peek(SYNC_SESSION_KEY)).toBeUndefined();
  });

  it("never closes a reused user tab when a saved temporary tab disappeared", async () => {
    const saved = {
      syncing: true,
      runId: "missing-created-tab",
      mode: "full",
      phase: "opening",
      tabId: 55,
      createdTab: true,
      count: 0,
      expectedTotal: null,
    };
    const h = harness({
      existing: { id: 7, url: "https://www.youtube.com/playlist?list=WL", active: true },
      sessionState: saved,
    });
    await h.controller.recover();
    expect(h.session.peek(SYNC_SESSION_KEY)).toMatchObject({ tabId: 7, createdTab: false });
    await finish(h);
    expect(h.tabs.remove).not.toHaveBeenCalled();
  });

  it.each([409, 429])("treats import %i as a benign skip", async (status) => {
    const error = Object.assign(new Error("skip"), { status });
    const h = harness({ apiImpl: vi.fn(async () => { throw error; }) });
    await h.controller.start({ mode: "delta" });
    await finish(h);

    expect(h.published.some((message) => message.type === WLL_SYNC_ERROR)).toBe(false);
    expect(h.published.at(-1)).toEqual(expect.objectContaining({
      type: WLL_SYNC_DONE,
      skipped: true,
    }));
    expect((await h.controller.getStatus()).lastSyncAt).toBe("2026-07-14T12:00:00.000Z");
  });

  it("updates the last sync time for an already mapped skipped import", async () => {
    const h = harness({
      apiImpl: vi.fn(async () => ({
        ok: true,
        skipped: true,
        reason: "NO_NEW_VIDEOS",
        added: 0,
        duplicates: 1,
      })),
    });
    await h.controller.start({ mode: "delta" });
    await finish(h);

    expect(h.published.some((message) => message.type === WLL_SYNC_ERROR)).toBe(false);
    await expect(h.controller.getStatus()).resolves.toMatchObject({
      lastSyncAt: "2026-07-14T12:00:00.000Z",
      lastResult: {
        ok: true,
        skipped: true,
        reason: "NO_NEW_VIDEOS",
      },
    });
  });

  it("disconnects a rejected token so the website can reconnect", async () => {
    const rejected = Object.assign(new Error("token expired"), {
      code: "TOKEN_REJECTED",
      status: 401,
    });
    const h = harness({ apiImpl: vi.fn(async () => { throw rejected; }) });
    await h.controller.start({ mode: "delta" });
    await finish(h);

    await expect(h.controller.getStatus()).resolves.toMatchObject({
      connected: false,
      email: "reader@example.com",
      lastResult: { ok: false, code: "TOKEN_REJECTED" },
    });
    expect(h.local.peek(CONNECTION_KEY)).toEqual({
      apiUrl: "https://watch-later-web.vercel.app",
      email: "reader@example.com",
    });

    await h.controller.setConnection({
      token: "wll_replacement",
      apiUrl: "https://watch-later-web.vercel.app",
      email: "reader@example.com",
    });
    await expect(h.controller.getStatus()).resolves.toMatchObject({
      connected: true,
      lastResult: null,
    });
  });

  it("refuses to import a truncated collection", async () => {
    const h = harness();
    await h.controller.start({ mode: "full" });
    await finish(h, { truncated: true });
    expect(h.apiImpl).not.toHaveBeenCalled();
    expect(h.published.at(-1)).toEqual(expect.objectContaining({
      type: WLL_SYNC_ERROR,
      code: "INCOMPLETE_COLLECTION",
    }));
  });

  it("imports a finished collection, closes only a tab it created, and stores status", async () => {
    const h = harness();
    await h.controller.start({ mode: "delta" });
    await finish(h);
    expect(h.apiImpl).toHaveBeenCalledWith(expect.objectContaining({
      token: "wll_test",
      payload: expect.objectContaining({ source: "extension" }),
    }));
    expect(h.removed).toEqual([99]);
    expect((await h.controller.getStatus()).lastSyncAt).toBe("2026-07-14T12:00:00.000Z");

    const reused = harness({
      existing: { id: 7, url: "https://www.youtube.com/playlist?list=WL", active: false },
    });
    await reused.controller.start({ mode: "delta" });
    await finish(reused);
    expect(reused.tabs.remove).not.toHaveBeenCalled();
  });

  it("carries the fully walked unavailable count into website and persisted status", async () => {
    const h = harness();
    const videos = Array.from({ length: 2724 }, (_, index) => ({
      id: `video${String(index).padStart(7, "0")}`,
      title: `Video ${index}`,
    }));
    await h.controller.start({ mode: "full" });
    await finish(h, { videos, unavailable: 72 });

    expect(h.published.at(-1)).toMatchObject({
      type: WLL_SYNC_DONE,
      collected: 2724,
      unavailable: 72,
    });
    await expect(h.controller.getStatus()).resolves.toMatchObject({
      lastResult: {
        ok: true,
        collected: 2724,
        unavailable: 72,
      },
    });
  });
});

describe("extension import API", () => {
  it("posts the token and payload without asking for an API host permission", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ added: 3, duplicates: 1 }),
    }));
    const api = createExtensionApi({ fetch });
    await expect(api.importVideos({
      apiUrl: "https://watch-later-web.vercel.app/app",
      token: "wll_secret",
      payload: { v: 1, source: "extension", videos: [] },
    })).resolves.toMatchObject({ ok: true, added: 3 });
    expect(fetch).toHaveBeenCalledWith(
      "https://watch-later-web.vercel.app/api/imports",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        headers: expect.objectContaining({ "X-Import-Token": "wll_secret" }),
      }),
    );
  });

  it.each([409, 429])("maps HTTP %i to a benign skip", async (status) => {
    const api = createExtensionApi({
      fetch: vi.fn(async () => ({ ok: false, status, json: async () => ({ error: "skip" }) })),
    });
    await expect(api.importVideos({
      apiUrl: "https://watch-later-web.vercel.app",
      token: "wll_secret",
      payload: {},
    })).resolves.toMatchObject({ ok: true, skipped: true, status });
  });

  it("maps rejected tokens to a stable error code", async () => {
    const api = createExtensionApi({
      fetch: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "bad token" }) })),
    });
    await expect(api.importVideos({
      apiUrl: "https://watch-later-web.vercel.app",
      token: "wll_bad",
      payload: {},
    })).rejects.toMatchObject({
      name: "ExtensionApiError",
      code: "TOKEN_REJECTED",
      status: 401,
    });
    expect(ExtensionApiError).toBeTypeOf("function");
  });
});
