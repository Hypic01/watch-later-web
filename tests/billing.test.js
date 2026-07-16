import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { Webhook } from "standardwebhooks";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { createBilling } from "../server/billing.js";
import { loadConfig } from "../server/config.js";

const WEBHOOK_SECRET = "polar_whs_test_secret";
let db, app, meId;

// Real Standard-Webhooks signature crypto (no network), fake Polar API
// surface for checkout/portal sessions. billing.js base64-encodes the raw
// secret before verifying (mirroring Polar's SDK), so the signer must too.
const signer = new Webhook(Buffer.from(WEBHOOK_SECRET, "utf8").toString("base64"));
let msgSeq = 0;
function signedPost(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const id = `msg_${++msgSeq}`;
  const now = new Date();
  const signature = signer.sign(id, now, payload);
  return request(app)
    .post("/api/billing/webhook")
    .set("webhook-id", id)
    .set("webhook-timestamp", String(Math.floor(now.getTime() / 1000)))
    .set("webhook-signature", signature)
    .set("content-type", "application/json")
    .send(payload);
}

let lastCheckoutOpts = null;
const fakePolarClient = {
  checkouts: { create: async (opts) => { lastCheckoutOpts = opts; return { url: "https://checkout.polar.test/session" }; } },
  customerSessions: { create: async (opts) => ({ customerPortalUrl: "https://portal.polar.test/session", ...opts }) },
};

const subscriptionEvent = (type, overrides = {}) => ({
  type,
  data: {
    id: "plr_sub_1",
    status: "active",
    recurring_interval: "month",
    cancel_at_period_end: false,
    current_period_end: null,
    ends_at: null,
    customer_id: "plr_cus_1",
    customer: { id: "plr_cus_1", external_id: meId, email: "payer@test.dev" },
    metadata: {},
    ...overrides,
  },
});

const asUser = (r, email = "payer@test.dev") => r.set("Authorization", `Bearer dev:${email}`);

beforeEach(async () => {
  ({ db } = await testDb());
  const config = loadConfig({
    POLAR_ACCESS_TOKEN: "polar_oat_test",
    POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
    POLAR_PRODUCT_MONTHLY_ID: "prod_monthly",
    POLAR_PRODUCT_ANNUAL_ID: "prod_annual",
    FREE_VIDEO_CAP: "100",
  });
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: [] });
  const importer = createImporter({ db, config });
  const billing = createBilling({ db, config, polarClient: fakePolarClient });
  app = createApp({ db, auth, importer, billing, config });
  const me = await asUser(request(app).get("/api/me"));
  meId = me.body.id;
});

describe("checkout & portal", () => {
  it("checkout passes both products, our user id, and the upgraded success url", async () => {
    const res = await asUser(request(app).post("/api/billing/checkout")).expect(200);
    expect(res.body.url).toContain("checkout.polar.test");
    // The fake captured createCheckout's request to Polar.
    expect(lastCheckoutOpts.products).toEqual(["prod_monthly", "prod_annual"]);
    expect(lastCheckoutOpts.externalCustomerId).toBe(meId);
    expect(lastCheckoutOpts.successUrl).toContain("/app?upgraded=1");
    expect(lastCheckoutOpts.metadata).toEqual({ userId: meId });
  });

  it("portal 400s without a billing profile and works after a subscription lands", async () => {
    await asUser(request(app).get("/api/billing/portal")).expect(400);
    await signedPost(subscriptionEvent("subscription.active")).expect(200);
    const res = await asUser(request(app).get("/api/billing/portal")).expect(200);
    expect(res.body.url).toContain("portal.polar.test");
  });
});

describe("webhooks", () => {
  it("rejects bad signatures", async () => {
    await request(app)
      .post("/api/billing/webhook")
      .set("webhook-id", "msg_bad")
      .set("webhook-timestamp", String(Math.floor(Date.now() / 1000)))
      .set("webhook-signature", "v1,Z2FyYmFnZQ==")
      .set("content-type", "application/json")
      .send(JSON.stringify(subscriptionEvent("subscription.active")))
      .expect(400);
    expect((await db.getUser(meId)).plan).toBe("free");
  });

  it("subscription.active flips plan to pro (idempotent on replay)", async () => {
    const event = subscriptionEvent("subscription.active");
    await signedPost(event).expect(200);
    const user = await db.getUser(meId);
    expect(user.plan).toBe("pro");
    expect(user.billing_customer_id).toBe("plr_cus_1");
    expect(user.billing_subscription_id).toBe("plr_sub_1");
    expect(user.billing_ends_at).toBeNull();
    expect(user.billing_interval).toBe("month");
    await signedPost(event).expect(200); // Polar redelivery
    expect((await db.getUser(meId)).plan).toBe("pro");
  });

  it("subscription.canceled keeps pro and surfaces the end date; uncanceled clears it", async () => {
    await signedPost(subscriptionEvent("subscription.active")).expect(200);
    await signedPost(subscriptionEvent("subscription.canceled", {
      cancel_at_period_end: true,
      current_period_end: "2026-08-16T00:00:00.000Z",
    })).expect(200);
    const user = await db.getUser(meId);
    expect(user.plan).toBe("pro");
    expect(user.billing_ends_at).not.toBeNull();
    const me = await asUser(request(app).get("/api/me")).expect(200);
    expect(me.body.proEndsAt).not.toBeNull();

    await signedPost(subscriptionEvent("subscription.uncanceled")).expect(200);
    expect((await db.getUser(meId)).billing_ends_at).toBeNull();
    expect((await db.getUser(meId)).plan).toBe("pro");
  });

  it("subscription.revoked re-locks the free cap but keeps the board", async () => {
    await signedPost(subscriptionEvent("subscription.active")).expect(200);

    await db.upsertFromImport(meId, vids(3), 10000);
    for (const v of vids(2)) await db.saveScanResult(meId, v.id, { category: "learn", reasoning: "", confidence: 0.7, topics: [] });

    await signedPost(subscriptionEvent("subscription.revoked", { status: "canceled" })).expect(200);

    const user = await db.getUser(meId);
    expect(user.plan).toBe("free");
    expect(user.billing_subscription_id).toBeNull();
    expect(user.billing_interval).toBeNull();
    // board intact
    const board = await asUser(request(app).get("/api/board")).expect(200);
    expect(board.body.learn).toHaveLength(2);
    // imports beyond the free cap (100 in this config) now cap instead of storing
    const over = Array.from({ length: 120 }, (_, i) => ({
      id: `overcap${String(i).padStart(4, "0")}`,
      title: `Over ${i}`,
      channel: "c",
      position: i + 1,
    }));
    const res = await asUser(request(app).post("/api/imports"))
      .send({ source: "console", videos: over })
      .expect(200);
    expect(res.body.capped).toBeGreaterThan(0);
    expect(res.body.locked).toBe(0);
  });

  it("classify-remaining works for free users now", async () => {
    await db.upsertFromImport(meId, vids(5), 10000);
    const res = await asUser(request(app).post("/api/jobs/classify-remaining")).expect(200);
    expect(res.body.willClassify).toBe(5);
  });

  it("subscription.updated tracks active/unpaid transitions and plan switches", async () => {
    await signedPost(subscriptionEvent("subscription.updated")).expect(200);
    expect((await db.getUser(meId)).plan).toBe("pro");
    // monthly → annual switch in the portal arrives as an updated event
    await signedPost(subscriptionEvent("subscription.updated", { recurring_interval: "year" })).expect(200);
    const switched = await db.getUser(meId);
    expect(switched.billing_interval).toBe("year");
    const me = await asUser(request(app).get("/api/me")).expect(200);
    expect(me.body.proInterval).toBe("year");
    await signedPost(subscriptionEvent("subscription.updated", { status: "unpaid" })).expect(200);
    expect((await db.getUser(meId)).plan).toBe("free");
  });

  it("acks verified events it does not handle", async () => {
    await signedPost({ type: "order.created", data: { id: "ord_1" } }).expect(200);
    expect((await db.getUser(meId)).plan).toBe("free");
  });

  it("resolves the user by billing customer id when the external id is missing", async () => {
    await signedPost(subscriptionEvent("subscription.active")).expect(200);
    await signedPost(subscriptionEvent("subscription.updated", {
      status: "unpaid",
      customer: { id: "plr_cus_1", external_id: null, email: "payer@test.dev" },
    })).expect(200);
    expect((await db.getUser(meId)).plan).toBe("free");
  });
});
