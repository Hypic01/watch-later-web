import { buildPayload, isWatchLaterPage } from "../../collector/collector.js";
import { AUTO_SYNC_KEY } from "./auto-sync.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_PROGRESS,
  COLLECT_START,
  WLL_SYNC_DONE,
  WLL_SYNC_ERROR,
  WLL_SYNC_PHASE,
  WLL_SYNC_PROGRESS,
} from "./messages.js";

export const WATCH_LATER_URL = "https://www.youtube.com/playlist?list=WL";
export const SYNC_SESSION_KEY = "wll.sync";
export const CONNECTION_KEY = "wll.connection";
export const RESULT_KEY = "wll.result";
export const SYNC_KEEPALIVE_ALARM = "wll.sync.keepalive";

const KEEPALIVE_PERIOD_MINUTES = 0.5;

function isoTime(now) {
  const value = typeof now === "function" ? now() : Date.now();
  return new Date(value).toISOString();
}

function publicError(error, fallback = "SYNC_FAILED") {
  return {
    code: String(error?.code || fallback),
    error: String(error?.error || error?.message || "Sync could not finish."),
  };
}

function optionalCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null;
}

function importResult(result = {}) {
  const collected = optionalCount(result.collected);
  const unavailable = optionalCount(result.unavailable);
  return {
    added: Number(result.added) || 0,
    duplicates: Number(result.duplicates) || 0,
    jobId: result.jobId ?? null,
    willClassify: Number(result.willClassify) || 0,
    locked: Number(result.locked) || 0,
    ...(collected !== null ? { collected } : {}),
    ...(unavailable !== null ? { unavailable } : {}),
    ...(result.skipped ? { skipped: true, reason: result.reason || null } : {}),
  };
}

function benignImport(error) {
  const status = Number(error?.status);
  if (status !== 409 && status !== 429) return null;
  return importResult({
    skipped: true,
    reason: status === 409 ? "SORT_RUNNING" : "RATE_LIMITED",
  });
}

export function createSyncController({
  tabs,
  scripting,
  storage,
  api,
  alarms = null,
  now = Date.now,
  publish = () => {},
  setBadge = () => {},
} = {}) {
  if (!tabs || !scripting || !storage?.session || !storage?.local || !api) {
    throw new Error("tabs, scripting, storage, and api are required");
  }

  const session = storage.session;
  const local = storage.local;
  const synced = storage.sync || null;
  let activeState = null;
  let recoveryPromise = null;
  let starting = false;
  let runSequence = 0;

  async function read(area, key) {
    const result = await area.get(key);
    return result?.[key] ?? null;
  }

  async function write(area, key, value) {
    await area.set({ [key]: value });
    return value;
  }

  async function notify(message) {
    try {
      await publish(message);
    } catch {
      // A website port can disappear while a sync is running.
    }
  }

  async function badge(text) {
    try {
      await setBadge(String(text));
    } catch {
      // Badge updates are helpful state, never a reason to fail a sync.
    }
  }

  async function persist(next) {
    activeState = next;
    await write(session, SYNC_SESSION_KEY, next);
    return next;
  }

  async function ensureKeepalive() {
    if (typeof alarms?.create !== "function") return;
    try {
      await alarms.create(SYNC_KEEPALIVE_ALARM, {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
    } catch {
      // Driver heartbeats remain the fallback on browsers without alarms.
    }
  }

  async function stopKeepalive() {
    if (typeof alarms?.clear !== "function") return;
    try {
      await alarms.clear(SYNC_KEEPALIVE_ALARM);
    } catch {
      // A stale alarm is harmless and recovery will try to clear it again.
    }
  }

  async function update(patch) {
    if (!activeState) return null;
    return persist({ ...activeState, ...patch });
  }

  async function clearActive() {
    activeState = null;
    await session.remove(SYNC_SESSION_KEY);
    await stopKeepalive();
  }

  async function closeCreatedTab(snapshot) {
    if (!snapshot?.createdTab || !snapshot.tabId || typeof tabs.remove !== "function") return;
    try {
      await tabs.remove(snapshot.tabId);
    } catch {
      // The user may have closed our temporary tab already.
    }
  }

  async function finishSuccess(result) {
    const snapshot = activeState;
    if (!snapshot) return;
    const lastSyncAt = isoTime(now);
    const lastResult = { ok: true, ...importResult(result) };
    await write(local, RESULT_KEY, { lastSyncAt, lastResult });
    await notify({ type: WLL_SYNC_DONE, ...importResult(result) });
    await badge("✓");
    await clearActive();
    await closeCreatedTab(snapshot);
  }

  async function finishError(error) {
    const snapshot = activeState;
    if (!snapshot) return;
    const detail = publicError(error);
    const previous = (await read(local, RESULT_KEY)) || {};
    if (detail.code === "TOKEN_REJECTED") {
      const connection = await read(local, CONNECTION_KEY);
      if (connection) {
        const { token: _rejectedToken, ...disconnectedConnection } = connection;
        await write(local, CONNECTION_KEY, disconnectedConnection);
      }
    }
    await write(local, RESULT_KEY, {
      ...previous,
      lastResult: { ok: false, ...detail },
    });
    await notify({ type: WLL_SYNC_ERROR, ...detail });
    await badge("!");
    await clearActive();
    await closeCreatedTab(snapshot);
  }

  async function phase(name) {
    await update({ phase: name });
    await notify({ type: WLL_SYNC_PHASE, phase: name });
  }

  async function findWatchLaterTab() {
    const candidates = await tabs.query({ url: "https://www.youtube.com/playlist*" });
    return (candidates || []).find((tab) => isWatchLaterPage(tab.url || tab.pendingUrl || "")) || null;
  }

  async function injectAndStart(snapshot, tab, { announce = true } = {}) {
    await scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      files: ["relay.js"],
    });
    await scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      files: ["collector-driver.main.js"],
    });

    if (announce) {
      await phase("collecting");
    }
    await badge(activeState?.count || "0");
    await tabs.sendMessage(tab.id, {
      type: COLLECT_START,
      mode: snapshot.mode,
      runId: snapshot.runId,
    });
    return true;
  }

  async function prepareCollection(snapshot) {
    let tab = null;
    let createdTab = !!snapshot.createdTab;

    if (snapshot.tabId && typeof tabs.get === "function") {
      try {
        tab = await tabs.get(snapshot.tabId);
      } catch {
        tab = null;
        createdTab = false;
      }
    }
    if (!tab) tab = await findWatchLaterTab();
    if (!tab) {
      tab = await tabs.create({
        url: WATCH_LATER_URL,
        active: false,
      });
      createdTab = true;
    }

    await update({ tabId: tab.id, createdTab });
    if (tab.status !== "complete" && typeof tabs.get === "function") {
      tab = await tabs.get(tab.id);
    }
    if (tab.status !== "complete") return false;
    return injectAndStart(snapshot, tab);
  }

  async function importVideos(videos, truncated = false, collection = {}) {
    if (!activeState) return;
    if (truncated) {
      await finishError({
        code: "INCOMPLETE_COLLECTION",
        error: "YouTube stopped loading before the full playlist was collected.",
      });
      return;
    }
    if (!Array.isArray(videos) || videos.length === 0) {
      await finishError({ code: "NO_VIDEOS", error: "No Watch Later videos were found." });
      return;
    }

    const connection = await read(local, CONNECTION_KEY);
    if (!connection?.token || !connection?.apiUrl) {
      await finishError({ code: "NOT_CONNECTED", error: "Connect the extension from Watch Later Librarian." });
      return;
    }

    const payload = buildPayload(videos, "extension");
    payload.collectedAt = isoTime(now);
    const unavailable = optionalCount(collection.unavailable);
    const collectionResult = {
      collected: videos.length,
      ...(unavailable !== null ? { unavailable } : {}),
    };
    await update({
      phase: "importing",
      pendingVideos: videos,
      pendingCollection: collectionResult,
    });
    await notify({ type: WLL_SYNC_PHASE, phase: "importing" });

    try {
      const result = await api.importVideos({
        apiUrl: connection.apiUrl,
        token: connection.token,
        payload,
      });
      await finishSuccess({ ...result, ...collectionResult });
    } catch (error) {
      const skipped = benignImport(error);
      if (skipped) await finishSuccess({ ...skipped, ...collectionResult });
      else await finishError(error);
    }
  }

  async function doRecover() {
    const saved = await read(session, SYNC_SESSION_KEY);
    if (!saved?.syncing) {
      await stopKeepalive();
      return { recovered: false };
    }
    activeState = saved;
    await ensureKeepalive();

    if (saved.phase === "importing" && Array.isArray(saved.pendingVideos)) {
      await importVideos(saved.pendingVideos, false, saved.pendingCollection);
    } else if (saved.phase === "opening") {
      try {
        await prepareCollection(saved);
      } catch (error) {
        await finishError(error);
      }
    } else if (saved.phase === "collecting" && saved.tabId && typeof tabs.get === "function") {
      try {
        const tab = await tabs.get(saved.tabId);
        if (tab?.status === "complete") await injectAndStart(saved, tab, { announce: false });
      } catch {
        await finishError({ code: "TAB_CLOSED", error: "The YouTube tab was closed before sync finished." });
      }
    }
    return { recovered: true };
  }

  function recover() {
    if (!recoveryPromise) recoveryPromise = doRecover();
    return recoveryPromise;
  }

  async function start({ mode = "delta", promoteFirstSync = true } = {}) {
    if (!['delta', 'full'].includes(mode)) return { error: "INVALID_MODE" };
    await recover();
    if (starting || activeState?.syncing) return { started: false };
    starting = true;

    try {
      const connection = await read(local, CONNECTION_KEY);
      if (!connection?.token || !connection?.apiUrl) return { error: "NOT_CONNECTED" };

      const previous = (await read(local, RESULT_KEY)) || {};
      const effectiveMode = mode === "delta" && promoteFirstSync && !previous.lastSyncAt
        ? "full"
        : mode;

      const startedAt = isoTime(now);
      const runId = `${startedAt}:${++runSequence}`;
      await persist({
        syncing: true,
        runId,
        mode: effectiveMode,
        phase: "opening",
        tabId: null,
        createdTab: false,
        count: 0,
        expectedTotal: null,
        startedAt,
      });
      await ensureKeepalive();
      await notify({ type: WLL_SYNC_PHASE, phase: "opening" });
      await badge("…");

      try {
        await prepareCollection(activeState);
        return { started: true, mode: effectiveMode };
      } catch (error) {
        const detail = publicError(error);
        await finishError(detail);
        return { error: detail.code };
      }
    } finally {
      starting = false;
    }
  }

  async function handleCollectorMessage(message, sender = {}) {
    await recover();
    if (!activeState?.syncing) return { handled: false };
    if (message?.runId !== activeState.runId) return { handled: false };
    if (sender.tab?.id && activeState.tabId && sender.tab.id !== activeState.tabId) {
      return { handled: false };
    }

    if (message.type === COLLECT_PROGRESS && activeState.phase === "collecting") {
      const count = Math.max(0, Number(message.count) || 0);
      const expectedTotal = Number.isFinite(Number(message.expectedTotal))
        ? Number(message.expectedTotal)
        : null;
      await update({ count, expectedTotal });
      await badge(count);
      await notify({ type: WLL_SYNC_PROGRESS, count, expectedTotal });
      return { handled: true };
    }
    if (message.type === COLLECT_DONE && activeState.phase === "collecting") {
      await importVideos(message.videos, !!message.truncated, {
        unavailable: message.unavailable,
      });
      return { handled: true };
    }
    if (message.type === COLLECT_ERROR && activeState.phase === "collecting") {
      await finishError({ code: message.code || "COLLECT_FAILED", error: message.error });
      return { handled: true };
    }
    return { handled: false };
  }

  async function setConnection({ token, apiUrl, email } = {}) {
    if (!token || !apiUrl) return { ok: false, error: "INVALID_CONNECTION" };
    let normalizedUrl;
    try {
      const parsed = new URL(String(apiUrl));
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("invalid protocol");
      normalizedUrl = parsed.origin;
    } catch {
      return { ok: false, error: "INVALID_CONNECTION" };
    }
    const previous = await read(local, CONNECTION_KEY);
    const normalizedEmail = String(email || "");
    await write(local, CONNECTION_KEY, {
      token: String(token),
      apiUrl: normalizedUrl,
      email: normalizedEmail,
    });
    if (!previous?.token || previous.apiUrl !== normalizedUrl || previous.email !== normalizedEmail) {
      await local.remove(RESULT_KEY);
    }
    return { ok: true };
  }

  async function getStatus() {
    await recover();
    const connection = await read(local, CONNECTION_KEY);
    const result = (await read(local, RESULT_KEY)) || {};
    return {
      connected: !!(connection?.token && connection?.apiUrl),
      email: connection?.email || null,
      lastSyncAt: result.lastSyncAt || null,
      lastResult: result.lastResult || null,
      syncing: !!activeState?.syncing,
      autoSync: synced ? Number(await read(synced, AUTO_SYNC_KEY)) > 0 : false,
    };
  }

  async function handleTabRemoved(tabId) {
    await recover();
    if (activeState?.syncing && activeState.tabId === tabId) {
      await finishError({ code: "TAB_CLOSED", error: "The YouTube tab was closed before sync finished." });
      return { handled: true };
    }
    return { handled: false };
  }

  async function handleTabUpdated(tabId, changeInfo = {}, tab = null) {
    await recover();
    if (!activeState?.syncing || activeState.tabId !== tabId) return { handled: false };
    if (changeInfo.status !== "complete" && tab?.status !== "complete") return { handled: false };
    if (activeState.phase !== "opening" && activeState.phase !== "collecting") {
      return { handled: false };
    }
    try {
      await injectAndStart(activeState, tab || { id: tabId, status: "complete" }, {
        announce: activeState.phase === "opening",
      });
      return { handled: true };
    } catch (error) {
      await finishError(error);
      return { handled: true };
    }
  }

  return {
    start,
    recover,
    setConnection,
    getStatus,
    handleCollectorMessage,
    handleTabRemoved,
    handleTabUpdated,
  };
}
