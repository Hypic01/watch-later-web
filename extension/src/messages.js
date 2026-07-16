// Shared extension protocol. The website imports this module directly so the
// external message names cannot drift from the service worker implementation.

export const WLL_PING = "WLL_PING";
export const WLL_SET_TOKEN = "WLL_SET_TOKEN";
export const WLL_GET_STATUS = "WLL_GET_STATUS";
export const WLL_SYNC = "WLL_SYNC";
export const WLL_FETCH_TRANSCRIPT = "WLL_FETCH_TRANSCRIPT";

export const WLL_SYNC_PHASE = "WLL_SYNC_PHASE";
export const WLL_SYNC_PROGRESS = "WLL_SYNC_PROGRESS";
export const WLL_SYNC_DONE = "WLL_SYNC_DONE";
export const WLL_SYNC_ERROR = "WLL_SYNC_ERROR";

export const COLLECT_START = "COLLECT_START";
export const COLLECT_PROGRESS = "COLLECT_PROGRESS";
export const COLLECT_DONE = "COLLECT_DONE";
export const COLLECT_ERROR = "COLLECT_ERROR";

export const WLL_SYNC_PORT = "wll-sync";

export const COLLECT_MESSAGE_TYPES = new Set([
  COLLECT_PROGRESS,
  COLLECT_DONE,
  COLLECT_ERROR,
]);
