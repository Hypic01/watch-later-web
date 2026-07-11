import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { testDb } from "./helpers.js";

let db, app;

beforeEach(async () => {
  ({ db } = await testDb());
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: ["boss@test.dev"] });
  app = express();
  app.get("/whoami", auth.required, (req, res) => res.json(req.user));
  app.get("/admin", auth.admin, (req, res) => res.json({ ok: true }));
});

describe("auth middleware", () => {
  it("401s without a token", async () => {
    await request(app).get("/whoami").expect(401);
  });

  it("401s on garbage tokens", async () => {
    await request(app).get("/whoami").set("Authorization", "Bearer nonsense").expect(401);
    await request(app).get("/whoami").set("Authorization", "Bearer dev:not-an-email").expect(401);
  });

  it("JIT-provisions the user on first valid request", async () => {
    const res = await request(app).get("/whoami").set("Authorization", "Bearer dev:joon@test.dev").expect(200);
    expect(res.body.email).toBe("joon@test.dev");
    const user = await db.getUser(res.body.id);
    expect(user.email).toBe("joon@test.dev");
  });

  it("same dev email always maps to the same user id", async () => {
    const a = await request(app).get("/whoami").set("Authorization", "Bearer dev:same@test.dev");
    const b = await request(app).get("/whoami").set("Authorization", "Bearer dev:same@test.dev");
    expect(a.body.id).toBe(b.body.id);
  });

  it("admin gate: 403 for normal users, 200 for ADMIN_EMAILS", async () => {
    await request(app).get("/admin").set("Authorization", "Bearer dev:pleb@test.dev").expect(403);
    const res = await request(app).get("/admin").set("Authorization", "Bearer dev:boss@test.dev").expect(200);
    expect(res.body.ok).toBe(true);
  });

  it("flags isAdmin on req.user", async () => {
    const res = await request(app).get("/whoami").set("Authorization", "Bearer dev:boss@test.dev");
    expect(res.body.isAdmin).toBe(true);
  });
});
