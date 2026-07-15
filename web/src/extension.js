import {
  WLL_GET_STATUS,
  WLL_PING,
  WLL_SET_TOKEN,
  WLL_SYNC,
  WLL_SYNC_DONE,
  WLL_SYNC_ERROR,
  WLL_SYNC_PHASE,
  WLL_SYNC_PORT,
  WLL_SYNC_PROGRESS,
} from "../../extension/src/messages.js";

export { WLL_SYNC_DONE, WLL_SYNC_ERROR, WLL_SYNC_PHASE, WLL_SYNC_PROGRESS };

const EXTENSION_ID_RE = /^[a-p]{32}$/;

export function parseExtensionIds(value = "") {
  return String(value)
    .split(",")
    .map((id) => id.trim())
    .filter((id, index, ids) => EXTENSION_ID_RE.test(id) && ids.indexOf(id) === index);
}

export function isChromiumBrowser(navigatorLike = globalThis.navigator) {
  const userAgent = navigatorLike?.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return false;
  const brands = navigatorLike?.userAgentData?.brands || [];
  if (brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand))) {
    return true;
  }
  return !/Firefox|FxiOS/i.test(userAgent) && /Chrome|Chromium|Edg|OPR|Brave/i.test(userAgent);
}

export function availabilitySummary(result = {}) {
  const collected = Number(result.collected);
  const unavailable = Number(result.unavailable);
  if (
    !Number.isFinite(collected)
    || collected < 0
    || !Number.isFinite(unavailable)
    || unavailable <= 0
  ) {
    return "";
  }
  const availableCount = Math.trunc(collected);
  const unavailableCount = Math.trunc(unavailable);
  const playlistTotal = availableCount + unavailableCount;
  const unavailableText = unavailableCount === 1
    ? "The other video is private or deleted."
    : `The other ${unavailableCount.toLocaleString()} are private or deleted.`;
  return `${availableCount.toLocaleString()} of ${playlistTotal.toLocaleString()} videos were available. ${unavailableText}`;
}

function sendMessage(runtime, extensionId, type, payload = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    try {
      const maybePromise = runtime.sendMessage(extensionId, { type, ...payload }, (response) => {
        const runtimeError = runtime.lastError;
        if (runtimeError) {
          finish(reject, new Error(runtimeError.message || "Extension message failed."));
          return;
        }
        finish(resolve, response);
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then((response) => finish(resolve, response), (error) => finish(reject, error));
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function createExtensionClient({
  runtime = globalThis.chrome?.runtime,
  extensionIds = parseExtensionIds(import.meta.env.VITE_EXTENSION_ID),
} = {}) {
  let selectedId = null;

  const send = async (type, payload) => {
    if (!runtime || !selectedId) throw new Error("Chrome extension is not available.");
    const response = await sendMessage(runtime, selectedId, type, payload);
    if (!response) throw new Error("Chrome extension did not respond.");
    return response;
  };

  return {
    get configured() {
      return Boolean(runtime && extensionIds.length);
    },

    get extensionId() {
      return selectedId;
    },

    async detect() {
      selectedId = null;
      if (!runtime) return { present: false };
      for (const id of extensionIds) {
        try {
          const response = await sendMessage(runtime, id, WLL_PING);
          if (response?.ok) {
            selectedId = id;
            return { present: true, id, version: response.version || null };
          }
        } catch {
          // Try the next configured development or store ID.
        }
      }
      return { present: false };
    },

    getStatus() {
      return send(WLL_GET_STATUS);
    },

    setToken({ token, apiUrl, email }) {
      return send(WLL_SET_TOKEN, { token, apiUrl, email });
    },

    sync(mode = "delta") {
      return send(WLL_SYNC, { mode });
    },

    connectPort() {
      if (!runtime || !selectedId) throw new Error("Chrome extension is not available.");
      return runtime.connect(selectedId, { name: WLL_SYNC_PORT });
    },
  };
}
