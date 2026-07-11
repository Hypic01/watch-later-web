import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { createBilling } from "../server/billing.js";
import { loadConfig } from "../server/config.js";

const WEBHOOK_SECRET = "whsec_test_secret";
let db, app, meId;

// Real Stripe signature crypto (no network), fake API surface for sessions.
const stripeForSigning = new Stripe("sk_test_dummy");
function signedPost(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const header = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request(app)
    .post("/api/billing/webhook")
    .set("stripe-signature", header)
    .set("content-type", "application/json")
    .send(payload);
}

const fakeStripeClient = {
  webhooks: stripeForSigning.webhooks,
  customers: { create: async ({ email }) => ({ id: "cus_fake_" + email.split("@")[0] }) },
  checkout: { sessions: { create: async (opts) => ({ url: "https://checkout.stripe.test/session", ...opts }) } },
  billingPortal: { sessions: { create: async () => ({ url: "https://portal.stripe.test/session" }) } },
};

const asUser = (r, email = "payer@test.dev") => r.set("Authorization", `Bearer dev:${email}`);

beforeEach(async () => {
  ({ db } = await testDb());
  const config = loadConfig({
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_ID: "price_test",
    FREE_VIDEO_QUOTA: "100",
  });
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: [] });
  const importer = createImporter({ db, config });
  const billing = createBilling({ db, config, stripeClient: fakeStripeClient });
  app = createApp({ db, auth, importer, billing, config });
  const me = await asUser(request(app).get("/api/me"));
  meId = me.body.id;
});

describe("checkout & portal", () => {
  it("checkout creates a customer once and returns a session url", async () => {
    const res = await asUser(request(app).post("/api/billing/checkout")).expect(200);
    expect(res.body.url).toContain("checkout.stripe.test");
    const user = await db.getUser(meId);
    expect(user.stripe_customer_id).toBe("cus_fake_payer");
    await asUser(request(app).post("/api/billing/checkout")).expect(200);
    expect((await db.getUser(meId)).stripe_customer_id).toBe("cus_fake_payer");
  });

  it("portal 400s without a billing profile", async () => {
    await asUser(request(app).get("/api/billing/portal")).expect(400);
    await db.setStripeCustomer(meId, "cus_x");
    const res = await asUser(request(app).get("/api/billing/portal")).expect(200);
    expect(res.body.url).toContain("portal.stripe.test");
  });
});

describe("webhooks", () => {
  it("rejects bad signatures", async () => {
    await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "t=1,v1=garbage")
      .set("content-type", "application/json")
      .send(JSON.stringify({ type: "checkout.session.completed" }))
      .expect(400);
    expect((await db.getUser(meId)).plan).toBe("free");
  });

  it("checkout.session.completed flips plan to pro (idempotent on replay)", async () => {
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_9", subscription: "sub_9", metadata: { userId: meId } } },
    };
    await signedPost(event).expect(200);
    let user = await db.getUser(meId);
    expect(user.plan).toBe("pro");
    expect(user.stripe_subscription_id).toBe("sub_9");
    await signedPost(event).expect(200); // Stripe redelivery
    expect((await db.getUser(meId)).plan).toBe("pro");
  });

  it("subscription.deleted re-locks future classification but keeps the board", async () => {
    await signedPost({
      type: "checkout.session.completed",
      data: { object: { customer: "cus_9", subscription: "sub_9", metadata: { userId: meId } } },
    }).expect(200);

    await db.upsertFromImport(meId, vids(3), 10000);
    for (const v of vids(2)) await db.saveScanResult(meId, v.id, { category: "learn", reasoning: "", confidence: 0.7, topics: [] });

    await signedPost({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_9", id: "sub_9", status: "canceled" } },
    }).expect(200);

    const user = await db.getUser(meId);
    expect(user.plan).toBe("free");
    expect(user.stripe_subscription_id).toBeNull();
    // board intact
    const board = await asUser(request(app).get("/api/board")).expect(200);
    expect(board.body.learn).toHaveLength(2);
    // future classification gated again (quota exhausted for this test)
    await db.incrementFreeUsed(meId, 100);
    await asUser(request(app).post("/api/jobs/classify-remaining")).expect(402);
  });

  it("subscription.updated tracks active/inactive states", async () => {
    await db.setStripeCustomer(meId, "cus_9");
    await signedPost({
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_9", id: "sub_9", status: "active" } },
    }).expect(200);
    expect((await db.getUser(meId)).plan).toBe("pro");
    await signedPost({
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_9", id: "sub_9", status: "unpaid" } },
    }).expect(200);
    expect((await db.getUser(meId)).plan).toBe("free");
  });

  it("pro users can classify-remaining after the webhook lands", async () => {
    await db.upsertFromImport(meId, vids(120), 10000);
    await signedPost({
      type: "checkout.session.completed",
      data: { object: { customer: "cus_9", subscription: "sub_9", metadata: { userId: meId } } },
    }).expect(200);
    const res = await asUser(request(app).post("/api/jobs/classify-remaining")).expect(200);
    expect(res.body.willClassify).toBe(120);
  });
});
