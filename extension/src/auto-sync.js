export const AUTO_SYNC_KEY = "autoSyncMinutes";
export const AUTO_SYNC_ALARM = "wll-auto-sync";
export const AUTO_SYNC_DEFAULT_MINUTES = 1440;
export const AUTO_SYNC_ALLOWED_MINUTES = Object.freeze([360, 1440, 0]);

const RESULT_KEY = "wll.result";

function storedValue(result, key) {
  return result?.[key] ?? null;
}

function normalizedMinutes(value, fallback = AUTO_SYNC_DEFAULT_MINUTES) {
  if (value === null || value === undefined || value === "") return fallback;
  const minutes = Number(value);
  return AUTO_SYNC_ALLOWED_MINUTES.includes(minutes) ? minutes : fallback;
}

async function read(area, key) {
  return storedValue(await area.get(key), key);
}

export async function setAutoSyncMinutes({ storage, alarms, minutes } = {}) {
  if (!storage?.sync || !alarms) {
    throw new Error("storage.sync and alarms are required");
  }
  const next = normalizedMinutes(minutes, null);
  if (next === null) throw new Error("Auto sync must be every 6 hours, daily, or off");

  await storage.sync.set({ [AUTO_SYNC_KEY]: next });
  await alarms.clear(AUTO_SYNC_ALARM);
  if (next > 0) {
    await alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: next });
  }
  return next;
}

export function createAutoSyncController({
  storage,
  alarms,
  syncController,
  now = Date.now,
} = {}) {
  if (!storage?.sync || !storage?.local || !alarms || !syncController) {
    throw new Error("storage, alarms, and syncController are required");
  }

  async function getMinutes() {
    return normalizedMinutes(await read(storage.sync, AUTO_SYNC_KEY));
  }

  async function setMinutes(minutes) {
    return setAutoSyncMinutes({ storage, alarms, minutes });
  }

  async function triggerDelta() {
    const status = await syncController.getStatus();
    if (!status?.connected) return { started: false, skipped: "NOT_CONNECTED" };
    if (status.syncing) return { started: false, skipped: "SYNC_RUNNING" };

    const result = await syncController.start({
      mode: "delta",
      promoteFirstSync: false,
    });
    if (result?.error === "NOT_CONNECTED") {
      return { started: false, skipped: "NOT_CONNECTED" };
    }
    return result;
  }

  async function handleInstalled() {
    const saved = await read(storage.sync, AUTO_SYNC_KEY);
    const minutes = normalizedMinutes(saved);
    await setMinutes(minutes);
    return { minutes };
  }

  async function handleAlarm(alarm) {
    if (alarm?.name !== AUTO_SYNC_ALARM) return { handled: false };
    if ((await getMinutes()) === 0) return { handled: true, started: false, skipped: "OFF" };
    return { handled: true, ...(await triggerDelta()) };
  }

  async function handleStartup() {
    const minutes = await getMinutes();
    if (minutes === 0) return { checked: true, started: false, skipped: "OFF" };

    const result = (await read(storage.local, RESULT_KEY)) || {};
    const lastSyncMs = Date.parse(result.lastSyncAt || "");
    const nowMs = Number(typeof now === "function" ? now() : now);
    const intervalMs = minutes * 60 * 1000;
    const overdue = !Number.isFinite(lastSyncMs) || nowMs - lastSyncMs >= intervalMs;
    if (!overdue) return { checked: true, started: false, skipped: "FRESH" };
    return { checked: true, ...(await triggerDelta()) };
  }

  return {
    getMinutes,
    setMinutes,
    handleInstalled,
    handleAlarm,
    handleStartup,
  };
}
