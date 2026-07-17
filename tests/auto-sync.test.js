import { describe, expect, it, vi } from "vitest";
import {
  AUTO_SYNC_ALARM,
  AUTO_SYNC_DEFAULT_MINUTES,
  AUTO_SYNC_KEY,
  createAutoSyncController,
} from "../extension/src/auto-sync.js";
import { CONNECTION_KEY, RESULT_KEY } from "../extension/src/sync.js";

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    get: vi.fn(async (key) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values) => Object.assign(data, structuredClone(values))),
    remove: vi.fn(async (key) => { delete data[key]; }),
    peek(key) {
      return structuredClone(data[key]);
    },
  };
}

function harness({ minutes, lastSyncAt, connected = true, syncing = false, now } = {}) {
  const sync = fakeArea(minutes === undefined ? {} : { [AUTO_SYNC_KEY]: minutes });
  const local = fakeArea({
    ...(connected ? {
      [CONNECTION_KEY]: {
        token: "wll_test",
        apiUrl: "https://watch-later-web.vercel.app",
      },
    } : {}),
    ...(lastSyncAt === undefined ? {} : {
      [RESULT_KEY]: { lastSyncAt, lastResult: { ok: true } },
    }),
  });
  const session = fakeArea();
  const alarms = {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => true),
  };
  const syncController = {
    getStatus: vi.fn(async () => ({ connected, syncing })),
    start: vi.fn(async () => ({ started: true, mode: "delta" })),
  };
  const controller = createAutoSyncController({
    storage: { sync, local, session },
    alarms,
    syncController,
    now: now || (() => Date.parse("2026-07-16T12:00:00.000Z")),
  });
  return { controller, storage: { sync, local, session }, alarms, syncController };
}

describe("createAutoSyncController", () => {
  it("sets daily auto sync on install", async () => {
    const h = harness();
    await expect(h.controller.handleInstalled()).resolves.toEqual({
      minutes: AUTO_SYNC_DEFAULT_MINUTES,
    });
    expect(h.storage.sync.peek(AUTO_SYNC_KEY)).toBe(1440);
    expect(h.alarms.clear).toHaveBeenCalledWith(AUTO_SYNC_ALARM);
    expect(h.alarms.create).toHaveBeenCalledWith(AUTO_SYNC_ALARM, {
      periodInMinutes: 1440,
    });
  });

  it("reschedules when the setting changes and clears the alarm when turned off", async () => {
    const h = harness({ minutes: 1440 });
    await h.controller.setMinutes(360);
    expect(h.storage.sync.peek(AUTO_SYNC_KEY)).toBe(360);
    expect(h.alarms.clear).toHaveBeenLastCalledWith(AUTO_SYNC_ALARM);
    expect(h.alarms.create).toHaveBeenLastCalledWith(AUTO_SYNC_ALARM, {
      periodInMinutes: 360,
    });

    h.alarms.create.mockClear();
    await h.controller.setMinutes(0);
    expect(h.storage.sync.peek(AUTO_SYNC_KEY)).toBe(0);
    expect(h.alarms.clear).toHaveBeenLastCalledWith(AUTO_SYNC_ALARM);
    expect(h.alarms.create).not.toHaveBeenCalled();
  });

  it("starts only a delta sync for the auto sync alarm", async () => {
    const h = harness({ minutes: 1440 });
    await expect(h.controller.handleAlarm({ name: AUTO_SYNC_ALARM })).resolves.toMatchObject({
      handled: true,
      started: true,
    });
    expect(h.syncController.start).toHaveBeenCalledWith({
      mode: "delta",
      promoteFirstSync: false,
    });
  });

  it("does nothing when a sync is already running or the token is missing", async () => {
    const running = harness({ minutes: 1440, syncing: true });
    await expect(running.controller.handleAlarm({ name: AUTO_SYNC_ALARM })).resolves.toMatchObject({
      started: false,
      skipped: "SYNC_RUNNING",
    });
    expect(running.syncController.start).not.toHaveBeenCalled();

    const disconnected = harness({ minutes: 1440, connected: false });
    await expect(disconnected.controller.handleAlarm({ name: AUTO_SYNC_ALARM })).resolves.toMatchObject({
      started: false,
      skipped: "NOT_CONNECTED",
    });
    expect(disconnected.syncController.start).not.toHaveBeenCalled();
  });

  it("catches up when the configured interval is due, including the exact boundary", async () => {
    const overdue = harness({
      minutes: 360,
      lastSyncAt: "2026-07-16T05:59:59.999Z",
    });
    await expect(overdue.controller.handleStartup()).resolves.toMatchObject({ started: true });
    expect(overdue.syncController.start).toHaveBeenCalledTimes(1);

    const boundary = harness({
      minutes: 360,
      lastSyncAt: "2026-07-16T06:00:00.000Z",
    });
    await expect(boundary.controller.handleStartup()).resolves.toMatchObject({ started: true });
    expect(boundary.syncController.start).toHaveBeenCalledTimes(1);

    const fresh = harness({
      minutes: 360,
      lastSyncAt: "2026-07-16T06:00:00.001Z",
    });
    await expect(fresh.controller.handleStartup()).resolves.toMatchObject({
      started: false,
      skipped: "FRESH",
    });
    expect(fresh.syncController.start).not.toHaveBeenCalled();
  });

  it("does not catch up when auto sync is off", async () => {
    const h = harness({ minutes: 0, lastSyncAt: null });
    await expect(h.controller.handleStartup()).resolves.toMatchObject({
      started: false,
      skipped: "OFF",
    });
    expect(h.syncController.getStatus).not.toHaveBeenCalled();
    expect(h.syncController.start).not.toHaveBeenCalled();
  });
});
