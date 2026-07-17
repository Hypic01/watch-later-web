import { WLL_GET_STATUS, WLL_SYNC } from "./messages.js";
import {
  AUTO_SYNC_ALLOWED_MINUTES,
  AUTO_SYNC_DEFAULT_MINUTES,
  AUTO_SYNC_KEY,
  setAutoSyncMinutes,
} from "./auto-sync.js";

const statusNode = document.querySelector("[data-status]");
const emailNode = document.querySelector("[data-email]");
const lastSyncNode = document.querySelector("[data-last-sync]");
const autoSyncSelect = document.querySelector("[data-auto-sync]");
const autoSyncNote = document.querySelector("[data-auto-sync-note]");
const deltaButton = document.querySelector("[data-sync-delta]");
const fullButton = document.querySelector("[data-sync-full]");
const appLink = document.querySelector("[data-open-app]");
let currentAutoSyncMinutes = AUTO_SYNC_DEFAULT_MINUTES;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function setBusy(busy) {
  deltaButton.disabled = busy;
  fullButton.disabled = busy;
}

function resultText(result) {
  if (!result) return "Ready when you are.";
  if (!result.ok) return result.error || "The last sync did not finish.";
  if (result.skipped) return "The last sync was safely skipped.";
  const added = Number(result.added) || 0;
  return added === 1 ? "1 new video added." : `${added} new videos added.`;
}

function lastSyncText(value) {
  if (!value) return "Last sync: not yet.";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Last sync time unavailable.";
  try {
    return `Last sync: ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date)}.`;
  } catch {
    return `Last sync: ${date.toLocaleString()}.`;
  }
}

function autoSyncText(minutes) {
  if (minutes === 0) return "Automatic sync is off.";
  if (minutes === 360) return "New videos sync about every 6 hours.";
  return "New videos sync about once a day.";
}

async function renderAutoSync() {
  try {
    const stored = await chrome.storage.sync.get(AUTO_SYNC_KEY);
    const minutes = Number(stored?.[AUTO_SYNC_KEY]);
    const selected = AUTO_SYNC_ALLOWED_MINUTES.includes(minutes)
      ? minutes
      : AUTO_SYNC_DEFAULT_MINUTES;
    currentAutoSyncMinutes = selected;
    autoSyncSelect.value = String(selected);
    autoSyncSelect.disabled = false;
    autoSyncNote.textContent = autoSyncText(selected);
  } catch {
    autoSyncSelect.value = String(AUTO_SYNC_DEFAULT_MINUTES);
    autoSyncSelect.disabled = true;
    autoSyncNote.textContent = "Auto sync settings could not be read.";
  }
}

async function renderStatus() {
  try {
    const status = await send({ type: WLL_GET_STATUS });
    lastSyncNode.textContent = lastSyncText(status.lastSyncAt);
    if (!status.connected) {
      statusNode.textContent = "Connect this extension from Watch Later Librarian.";
      emailNode.textContent = "";
      setBusy(true);
      return;
    }
    emailNode.textContent = status.email || "Connected";
    statusNode.textContent = status.syncing
      ? "Sync is running in the background. You can close this popup."
      : resultText(status.lastResult);
    setBusy(!!status.syncing);
  } catch {
    statusNode.textContent = "The extension could not read its status.";
    lastSyncNode.textContent = "Last sync time unavailable.";
    setBusy(true);
  }
}

async function updateAutoSync() {
  const previous = currentAutoSyncMinutes;
  const minutes = Number(autoSyncSelect.value);
  autoSyncSelect.disabled = true;
  autoSyncNote.textContent = "Saving auto sync setting.";
  try {
    await setAutoSyncMinutes({
      storage: chrome.storage,
      alarms: chrome.alarms,
      minutes,
    });
    currentAutoSyncMinutes = minutes;
    autoSyncNote.textContent = autoSyncText(minutes);
  } catch {
    autoSyncSelect.value = String(previous);
    autoSyncNote.textContent = "Auto sync setting could not be saved.";
  } finally {
    autoSyncSelect.disabled = false;
  }
}

async function start(mode) {
  setBusy(true);
  statusNode.textContent = mode === "full" ? "Opening YouTube for a full sync." : "Finding new videos.";
  try {
    const reply = await send({ type: WLL_SYNC, mode });
    if (reply?.started) {
      statusNode.textContent = mode === "full"
        ? "Full sync started in the background. You can close this popup."
        : "Sync started. You can close this popup.";
    } else if (reply?.error === "NOT_CONNECTED") {
      statusNode.textContent = "Connect this extension from Watch Later Librarian.";
    } else {
      statusNode.textContent = "A sync is already running.";
    }
  } catch {
    statusNode.textContent = "Sync could not start.";
  }
  await renderStatus();
}

deltaButton.addEventListener("click", () => start("delta"));
fullButton.addEventListener("click", () => start("full"));
autoSyncSelect.addEventListener("change", updateAutoSync);
appLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: appLink.href });
});

Promise.all([renderStatus(), renderAutoSync()]);
