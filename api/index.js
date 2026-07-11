// Vercel serverless entrypoint. All /api/* requests (and /collector.js as a
// fallback) rewrite here; static files are served by Vercel from web/dist.
// The Express app is built lazily on first invocation and reused across warm
// invocations; a failed boot (e.g. missing env) answers 503 instead of
// crashing the function init. Body parsing is disabled so express.json /
// express.raw see the raw stream — the Stripe webhook needs exact bytes.
import { buildApp } from "../server/boot.js";

export const config = { api: { bodyParser: false } };

let ready = null;

export default async function handler(req, res) {
  try {
    if (!ready) ready = buildApp();
    const { app } = await ready;
    return app(req, res);
  } catch (e) {
    ready = null; // allow the next invocation to retry a fresh boot
    console.error("boot failed:", e?.message);
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "server is not fully configured yet", detail: e?.message }));
  }
}
