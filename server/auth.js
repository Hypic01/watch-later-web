// Auth middleware. Supabase issues the JWTs (Google sign-in on the client);
// we verify them here — remote JWKS for new projects, HS256 shared secret for
// legacy ones — and JIT-provision the user row. The verifier is injected so
// tests (and DEV_FAKE_AUTH mode) can mint users without Supabase.

import { createRemoteJWKSet, jwtVerify } from "jose";
import crypto from "node:crypto";

export function supabaseVerifier({ supabaseUrl, jwtSecret }) {
  const issuer = supabaseUrl.replace(/\/$/, "") + "/auth/v1";
  if (jwtSecret) {
    const key = new TextEncoder().encode(jwtSecret);
    return async (token) => {
      const { payload } = await jwtVerify(token, key, { issuer, audience: "authenticated" });
      return { sub: payload.sub, email: payload.email };
    };
  }
  const jwks = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: "authenticated" });
    return { sub: payload.sub, email: payload.email };
  };
}

// DEV ONLY: "dev:someone@example.com" becomes a deterministic user. Enabled
// exclusively via DEV_FAKE_AUTH=1 so the full product runs locally without
// Supabase credentials. Never enable in production.
export function fakeVerifier() {
  return async (token) => {
    if (!token.startsWith("dev:")) throw new Error("bad dev token");
    const email = token.slice(4).toLowerCase();
    if (!email.includes("@")) throw new Error("bad dev email");
    const h = crypto.createHash("sha256").update("wll-dev:" + email).digest("hex");
    const sub = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    return { sub, email };
  };
}

export function createAuth({ verify, db, adminEmails = [] }) {
  const admins = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));

  async function required(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing bearer token" });
    let claims;
    try {
      claims = await verify(token);
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!claims?.sub || !claims?.email) return res.status(401).json({ error: "invalid token claims" });
    const user = await db.upsertUser({ id: claims.sub, email: claims.email });
    req.user = { id: user.id, email: user.email, isAdmin: admins.has(user.email.toLowerCase()) };
    next();
  }

  function admin(req, res, next) {
    required(req, res, () => {
      if (!req.user.isAdmin) return res.status(403).json({ error: "admin only" });
      next();
    });
  }

  return { required, admin };
}
