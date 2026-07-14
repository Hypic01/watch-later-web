import { createExtensionApi } from "./api.js";
import { createSyncController } from "./sync.js";
import {
  COLLECT_DONE,
  COLLECT_ERROR,
  COLLECT_PROGRESS,
  WLL_GET_STATUS,
  WLL_PING,
  WLL_SET_TOKEN,
  WLL_SYNC,
  WLL_SYNC_PORT,
} from "./messages.js";

const sitePorts = new Set();

function publish(message) {
  for (const port of sitePorts) {
    try {
      port.postMessage(message);
    } catch {
      sitePorts.delete(port);
    }
  }
}

const controller = createSyncController({
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  storage: chrome.storage,
  api: createExtensionApi({ fetch: globalThis.fetch.bind(globalThis) }),
  now: Date.now,
  publish,
  setBadge: (text) => Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({
      color: text === "✓" ? "#15803d" : text === "!" ? "#b91c1c" : "#db2777",
    }),
  ]),
});

function dispatchCommand(message, sender, external = false) {
  if (message?.type === WLL_PING) {
    return Promise.resolve({ ok: true, version: chrome.runtime.getManifest().version });
  }
  if (message?.type === WLL_SET_TOKEN) return controller.setConnection(message);
  if (message?.type === WLL_GET_STATUS) return controller.getStatus();
  if (message?.type === WLL_SYNC) return controller.start({ mode: message.mode });
  if (!external && [COLLECT_PROGRESS, COLLECT_DONE, COLLECT_ERROR].includes(message?.type)) {
    return controller.handleCollectorMessage(message, sender);
  }
  return null;
}

function respond(promise, sendResponse) {
  Promise.resolve(promise).then(
    (value) => sendResponse(value),
    (error) => sendResponse({
      error: String(error?.code || "EXTENSION_ERROR"),
      message: String(error?.message || "The extension could not finish that request."),
    }),
  );
  return true;
}

// MV3 can stop the worker between any two events. Every listener is registered
// synchronously at module evaluation so Chrome can always wake this worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const result = dispatchCommand(message, sender, false);
  return result ? respond(result, sendResponse) : false;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const result = dispatchCommand(message, sender, true);
  return result ? respond(result, sendResponse) : false;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== WLL_SYNC_PORT) return;
  sitePorts.add(port);
  port.onDisconnect.addListener(() => sitePorts.delete(port));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  controller.handleTabRemoved(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  controller.handleTabUpdated(tabId, changeInfo, tab).catch(() => {});
});

controller.recover().catch(() => {});
