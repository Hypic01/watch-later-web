import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier, hashToken } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { loadConfig } from "../server/config.js";

let app, db, pg;

const asUser = (r, email = "user@test.dev") => r.set("Authorization", `Bearer dev:${email}`);
const importPayload = () => ({ v: 1, source: "extension", videos: vids(1, "token") });

function createToken({ email = "user@test.dev", scope = "imports", label = "Chrome extension" } = {}) {
  return asUser(request(app).post("/api/tokens"), email).send({ scope, label });
}

beforeEach(async () => {
  ({ db, pg } = await testDb());
  const config = loadConfig({
    DEV_FAKE_AUTH: "1",
    FAKE_LLM: "1",
    EXTENSION_IDS: "abcdefghijklmnopabcdefghijklmnop,ponmlkjihgfedcbaponmlkjihgfedcba",
  });
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: ["boss@test.dev"] });
  const importer = createImporter({ db, config });
  app = createApp({ db, auth, importer, config });
});

describe("api tokens", () => {
  it("returns plaintext once and stores only its hash", async () => {
    const created = await createToken().expect(200);
    expect(created.body.token).toMatch(/^wll_[A-Za-z0-9_-]{43}$/);
    expect(created.body).not.toHaveProperty("token_hash");

    const { rows } = await pg.query("SELECT token_hash FROM api_tokens WHERE id = $1", [created.body.id]);
    expect(rows[0].token_hash).toBe(hashToken(created.body.token));
    expect(rows[0].token_hash).not.toBe(created.body.token);

    const listed = await asUser(request(app).get("/api/tokens")).expect(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id: created.body.id, scope: "imports", label: "Chrome extension" }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
    expect(JSON.stringify(listed.body)).not.toContain("token_hash");
  });

  it("authenticates imports by hash lookup and records use", async () => {
    const created = await createToken().expect(200);
    const imported = await request(app)
      .post("/api/imports")
      .set("X-Import-Token", created.body.token)
      .send(importPayload())
      .expect(200);
    expect(imported.body.added).toBe(1);
    const { rows } = await pg.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [created.body.id]);
    expect(rows[0].last_used_at).toBeTruthy();
  });

  it("rejects revoked tokens and removes them from the active list", async () => {
    const created = await createToken().expect(200);
    await asUser(request(app).delete(`/api/tokens/${created.body.id}`)).expect(200, { ok: true });
    await request(app)
      .post("/api/imports")
      .set("X-Import-Token", created.body.token)
      .send(importPayload())
      .expect(401);
    const listed = await asUser(request(app).get("/api/tokens")).expect(200);
    expect(listed.body).toEqual([]);
  });

  it("allows only admins to mint bridge tokens and keeps their scope isolated", async () => {
    await createToken({ scope: "bridge", label: "Vault bridge" }).expect(403);
    const created = await createToken({ email: "boss@test.dev", scope: "bridge", label: "Vault bridge" })
      .expect(200);
    expect(created.body.scope).toBe("bridge");
    await request(app)
      .post("/api/imports")
      .set("X-Import-Token", created.body.token)
      .send(importPayload())
      .expect(401);
  });

  it("never lets a token mint another token", async () => {
    const created = await createToken().expect(200);
    await request(app)
      .post("/api/tokens")
      .set("X-Import-Token", created.body.token)
      .send({ scope: "imports", label: "Second token" })
      .expect(401);
  });

  it("keeps token listing and revocation scoped to the owning user", async () => {
    const created = await createToken().expect(200);
    const otherList = await asUser(request(app).get("/api/tokens"), "other@test.dev").expect(200);
    expect(otherList.body).toEqual([]);
    await asUser(request(app).delete(`/api/tokens/${created.body.id}`), "other@test.dev").expect(404);
    await request(app)
      .post("/api/imports")
      .set("X-Import-Token", created.body.token)
      .send(importPayload())
      .expect(200);
  });

  it("rejects token ids outside the PostgreSQL bigint range", async () => {
    await asUser(request(app).delete("/api/tokens/9999999999999999999999999999999999999999"))
      .expect(404);
  });

  it("throttles last used writes to once every five minutes", async () => {
    const created = await createToken().expect(200);
    await pg.query("UPDATE api_tokens SET last_used_at = now() - interval '4 minutes' WHERE id = $1", [created.body.id]);
    const before = await pg.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [created.body.id]);
    await request(app).post("/api/imports").set("X-Import-Token", created.body.token).send({}).expect(400);
    const throttled = await pg.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [created.body.id]);
    expect(throttled.rows[0].last_used_at.getTime()).toBe(before.rows[0].last_used_at.getTime());

    await pg.query("UPDATE api_tokens SET last_used_at = now() - interval '6 minutes' WHERE id = $1", [created.body.id]);
    const stale = await pg.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [created.body.id]);
    await request(app).post("/api/imports").set("X-Import-Token", created.body.token).send({}).expect(400);
    const touched = await pg.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [created.body.id]);
    expect(touched.rows[0].last_used_at.getTime()).toBeGreaterThan(stale.rows[0].last_used_at.getTime());
  });
});

describe("extension CORS", () => {
  it("echoes an exact allowlisted extension origin and never a wildcard", async () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const res = await request(app)
      .options("/api/imports")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    expect(res.headers.vary).toContain("Origin");
    expect(res.headers["access-control-allow-headers"]).toBe("content-type, x-import-token");
    expect(res.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
  });

  it("sends no CORS headers to a nonlisted origin", async () => {
    const res = await request(app)
      .options("/api/imports")
      .set("Origin", "chrome-extension://not-allowed")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    expect(res.headers.vary).toContain("Origin");
  });
});
