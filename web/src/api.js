import { getToken, signOut } from "./auth.js";

async function call(url, opts = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    await signOut();
    throw new Error("signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const post = (url, body) => call(url, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const getMe = () => call("/api/me");
export const saveTaste = (profile) => call("/api/me/taste", { method: "PUT", body: JSON.stringify(profile) });
export const deleteAccount = () => call("/api/me", { method: "DELETE" });
export const listTokens = () => call("/api/tokens");
export const createToken = ({ scope, label }) => post("/api/tokens", { scope, label });
export const revokeToken = (id) => call(`/api/tokens/${id}`, { method: "DELETE" });
export const getBoard = () => call("/api/board");
export const getStatus = () => call("/api/status");
export const getCleanup = () => call("/api/cleanup");
export const getCurrentJob = () => call("/api/jobs/current");
export const cancelJob = (id) => post(`/api/jobs/${id}/cancel`);
export const submitImport = (payload) => post("/api/imports", payload);
export const classifyRemaining = () => post("/api/jobs/classify-remaining");
export const setCategory = (id, category) => post(`/api/videos/${id}/category`, { category });
export const dismissVideo = (id) => post(`/api/videos/${id}/dismiss`);
export const markDone = (ids) => post("/api/videos/done", { ids });
export const checkoutUrl = () => post("/api/billing/checkout");
export const portalUrl = () => call("/api/billing/portal");
export const fetchSnippet = () => fetch("/collector.js").then((r) => (r.ok ? r.text() : Promise.reject(new Error("snippet unavailable"))));
