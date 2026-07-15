const SETUP_ERROR_CODE = "INNERTUBE_SETUP_FAILED";

export class InnerTubeSetupError extends Error {
  constructor(message, { reason = "UNKNOWN", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InnerTubeSetupError";
    this.code = SETUP_ERROR_CODE;
    this.reason = reason;
  }
}

function configured(win, key) {
  try {
    const value = win?.ytcfg?.get?.(key);
    if (value !== undefined && value !== null) return value;
  } catch {
    // Some YouTube builds expose only ytcfg.data_. Try it below.
  }
  return win?.ytcfg?.data_?.[key] ?? null;
}

function present(value) {
  return value !== undefined && value !== null && String(value) !== "";
}

function firstPresent(...values) {
  return values.find(present) ?? null;
}

function cookieValue(cookieText, name) {
  for (const part of String(cookieText || "").split(";")) {
    const entry = part.trim();
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator) !== name) continue;
    const value = entry.slice(separator + 1);
    if (value) return value;
  }
  return null;
}

function authCookies(doc) {
  let cookies = "";
  try {
    cookies = doc?.cookie || "";
  } catch {
    return { sapisid: null, onePapisid: null, threePapisid: null };
  }
  const threePapisid = cookieValue(cookies, "__Secure-3PAPISID");
  return {
    // YouTube and yt-dlp both use the 3P value as the primary SAPISID
    // fallback when the plain cookie is absent.
    sapisid: cookieValue(cookies, "SAPISID") || threePapisid,
    onePapisid: cookieValue(cookies, "__Secure-1PAPISID"),
    threePapisid,
  };
}

function parseDataSyncId(value) {
  if (typeof value !== "string" || !value) {
    return { delegatedSessionId: null, userSessionId: null };
  }
  const separator = value.indexOf("||");
  if (separator < 0) {
    return { delegatedSessionId: null, userSessionId: value };
  }
  const first = value.slice(0, separator) || null;
  const second = value.slice(separator + 2) || null;
  return second
    ? { delegatedSessionId: first, userSessionId: second }
    : { delegatedSessionId: null, userSessionId: first };
}

function sessionIds(win) {
  const fromDataSync = parseDataSyncId(configured(win, "DATASYNC_ID"));
  return {
    delegatedSessionId: firstPresent(
      configured(win, "DELEGATED_SESSION_ID"),
      fromDataSync.delegatedSessionId,
    ),
    userSessionId: firstPresent(
      configured(win, "USER_SESSION_ID"),
      fromDataSync.userSessionId,
    ),
  };
}

function originOf(win) {
  if (typeof win?.location?.origin === "string" && win.location.origin) {
    return win.location.origin;
  }
  try {
    return new URL(String(win?.location?.href)).origin;
  } catch {
    return null;
  }
}

function cloneContext(context) {
  try {
    return JSON.parse(JSON.stringify(context));
  } catch (cause) {
    throw new InnerTubeSetupError(
      "YouTube exposed an unreadable request context.",
      { reason: "INVALID_CONTEXT", cause },
    );
  }
}

function bytesToHex(value) {
  if (typeof value === "string") return value;
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (!bytes) return "";
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function browserSha1(value, win) {
  const subtle = win?.crypto?.subtle || globalThis.crypto?.subtle;
  const Encoder = win?.TextEncoder || globalThis.TextEncoder;
  if (!subtle || !Encoder) {
    throw new InnerTubeSetupError(
      "YouTube authentication is unavailable in this browser.",
      { reason: "HASH_UNAVAILABLE" },
    );
  }
  return bytesToHex(await subtle.digest("SHA-1", new Encoder().encode(value)));
}

function setOptional(headers, name, value) {
  if (present(value)) headers[name] = String(value);
}

// Builds the authenticated fallback used when no real YouTube continuation
// request can be observed. All values come from the live page so weekly client
// version changes do not become hard coded scraper configuration.
export async function createYtcfgRequestTemplate({
  win = globalThis.window,
  doc = win?.document,
  now = Date.now,
  sha1,
} = {}) {
  const apiKey = configured(win, "INNERTUBE_API_KEY");
  if (!present(apiKey)) {
    throw new InnerTubeSetupError(
      "YouTube did not expose its request key.",
      { reason: "MISSING_API_KEY" },
    );
  }

  const configuredContext = configured(win, "INNERTUBE_CONTEXT");
  if (!configuredContext || typeof configuredContext !== "object" || Array.isArray(configuredContext)) {
    throw new InnerTubeSetupError(
      "YouTube did not expose its request context.",
      { reason: "MISSING_CONTEXT" },
    );
  }
  const context = cloneContext(configuredContext);

  const origin = originOf(win);
  if (!origin) {
    throw new InnerTubeSetupError(
      "YouTube did not expose a valid page address.",
      { reason: "MISSING_ORIGIN" },
    );
  }

  const sidCookies = authCookies(doc);
  if (!sidCookies.sapisid && !sidCookies.onePapisid && !sidCookies.threePapisid) {
    throw new InnerTubeSetupError(
      "YouTube did not expose the signed in browser session.",
      { reason: "MISSING_AUTH_COOKIE" },
    );
  }

  const current = typeof now === "function" ? now() : now;
  const timestamp = Math.floor(new Date(current).getTime() / 1000);
  if (!Number.isFinite(timestamp)) {
    throw new InnerTubeSetupError(
      "YouTube authentication could not read the current time.",
      { reason: "INVALID_TIME" },
    );
  }

  const { delegatedSessionId, userSessionId } = sessionIds(win);
  const authorizations = [];
  for (const [scheme, sid] of [
    ["SAPISIDHASH", sidCookies.sapisid],
    ["SAPISID1PHASH", sidCookies.onePapisid],
    ["SAPISID3PHASH", sidCookies.threePapisid],
  ]) {
    if (!sid) continue;
    const hashInput = userSessionId
      ? `${userSessionId} ${timestamp} ${sid} ${origin}`
      : `${timestamp} ${sid} ${origin}`;
    let digest;
    try {
      const hash = typeof sha1 === "function"
        ? await sha1(hashInput)
        : await browserSha1(hashInput, win);
      digest = bytesToHex(hash);
    } catch (cause) {
      if (cause instanceof InnerTubeSetupError) throw cause;
      throw new InnerTubeSetupError(
        "YouTube authentication could not be prepared.",
        { reason: "HASH_FAILED", cause },
      );
    }
    if (!/^[a-f\d]{40}$/i.test(digest)) {
      throw new InnerTubeSetupError(
        "YouTube authentication could not be prepared.",
        { reason: "HASH_FAILED" },
      );
    }
    const suffix = userSessionId ? `${timestamp}_${digest}_u` : `${timestamp}_${digest}`;
    authorizations.push(`${scheme} ${suffix}`);
  }

  const client = context.client && typeof context.client === "object" ? context.client : {};
  const headers = {
    "content-type": "application/json",
    authorization: authorizations.join(" "),
    "x-origin": origin,
  };
  setOptional(headers, "x-youtube-client-name", firstPresent(
    configured(win, "INNERTUBE_CONTEXT_CLIENT_NAME"),
    client.clientName,
  ));
  setOptional(headers, "x-youtube-client-version", firstPresent(
    configured(win, "INNERTUBE_CONTEXT_CLIENT_VERSION"),
    client.clientVersion,
  ));
  setOptional(headers, "x-goog-visitor-id", firstPresent(
    configured(win, "VISITOR_DATA"),
    client.visitorData,
  ));
  const sessionIndex = configured(win, "SESSION_INDEX");
  if (present(delegatedSessionId) || present(sessionIndex)) {
    headers["x-goog-authuser"] = String(present(sessionIndex) ? sessionIndex : 0);
  }
  setOptional(headers, "x-goog-pageid", delegatedSessionId);
  setOptional(headers, "x-youtube-page-cl", configured(win, "PAGE_CL"));
  setOptional(headers, "x-youtube-page-label", configured(win, "PAGE_BUILD_LABEL"));
  if (configured(win, "LOGGED_IN") === true) {
    headers["x-youtube-bootstrap-logged-in"] = "true";
  }

  const url = new URL("/youtubei/v1/browse", origin);
  url.searchParams.set("key", String(apiKey));
  url.searchParams.set("prettyPrint", "false");

  return {
    url: url.href,
    init: {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context }),
    },
  };
}
