import {
  COLLECT_ERROR,
  COLLECT_DONE,
  COLLECT_PROGRESS,
  COLLECT_START,
} from "./messages.js";

const RELAY_MARK = "__wllRelayInstalled";
const FROM_DRIVER = new Set([COLLECT_PROGRESS, COLLECT_DONE, COLLECT_ERROR]);

if (!globalThis[RELAY_MARK]) {
  globalThis[RELAY_MARK] = true;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!message?.__wll || !FROM_DRIVER.has(message.type)) return;
    chrome.runtime.sendMessage(message).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== COLLECT_START) return false;
    window.postMessage({ ...message, __wll: true }, window.location.origin);
    sendResponse({ ok: true });
    return false;
  });
}
