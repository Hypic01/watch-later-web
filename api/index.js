// Vercel serverless entrypoint. All /api/* requests (and /collector.js as a
// fallback) rewrite here; static files are served by Vercel from web/dist.
// The Express app is built once per warm instance. Body parsing is disabled
// so express.json / express.raw see the raw stream — the Stripe webhook's
// signature check needs the exact bytes.
import { buildApp } from "../server/boot.js";

export const config = { api: { bodyParser: false } };

const ready = buildApp();

export default async function handler(req, res) {
  const { app } = await ready;
  return app(req, res);
}
