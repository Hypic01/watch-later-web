export class ExtensionApiError extends Error {
  constructor(code, message, status = 0, body = {}) {
    super(message);
    this.name = "ExtensionApiError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

function errorCode(status) {
  if (status === 400) return "BAD_IMPORT";
  if (status === 401) return "TOKEN_REJECTED";
  if (status === 403) return "ACCESS_DENIED";
  if (status >= 500) return "SERVER_ERROR";
  return "IMPORT_FAILED";
}

function importsUrl(apiUrl) {
  const base = new URL(String(apiUrl || ""));
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new ExtensionApiError("INVALID_API_URL", "The saved server address is invalid.");
  }
  return new URL("/api/imports", base.origin).href;
}

function userMessage(value, fallback) {
  return String(value || fallback)
    .replace(/[—–]/g, ",")
    .replace(/\s+-\s+/g, ", ");
}

export function createExtensionApi({ fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");

  return {
    async importVideos({ apiUrl, token, payload }) {
      let response;
      try {
        response = await fetchImpl(importsUrl(apiUrl), {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-Import-Token": token,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (error instanceof ExtensionApiError) throw error;
        throw new ExtensionApiError("NETWORK_ERROR", "Laterlist could not be reached.");
      }

      const body = await response.json().catch(() => ({}));
      if (response.status === 409 || response.status === 429) {
        return {
          ok: true,
          skipped: true,
          status: response.status,
          reason: response.status === 409 ? "SORT_RUNNING" : "RATE_LIMITED",
          added: 0,
          duplicates: 0,
          jobId: null,
          willClassify: 0,
          locked: 0,
        };
      }
      if (!response.ok) {
        throw new ExtensionApiError(
          errorCode(response.status),
          userMessage(body.error, `Import failed with status ${response.status}.`),
          response.status,
          body,
        );
      }
      return { ok: true, ...body };
    },
  };
}
