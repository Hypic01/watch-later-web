// Polar billing (merchant of record): hosted Checkout for upgrades, the
// Customer Portal for manage/cancel/plan-switching, and webhooks as the
// single source of truth for plan state. The webhook route is mounted with a
// raw body parser (see app.js) because Standard-Webhooks signatures cover the
// exact bytes. Downgrade semantics: classified videos stay visible forever;
// only future imports and TL;DR quotas re-lock at the free tier.
//
// Verification is standardwebhooks directly (the same crypto the Polar SDK's
// validateEvent wraps) + JSON.parse, deliberately NOT the SDK's zod-schema
// parser: a schema drift or unknown event type must never make us drop a
// signed, legitimate plan change. Payload fields are therefore snake_case,
// confined to resolveUser/applySubscription below.

import { Polar } from "@polar-sh/sdk";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function createBilling({ db, config, polarClient }) {
  const polar = polarClient || new Polar({
    accessToken: config.polarAccessToken,
    server: config.polarServer, // "sandbox" unless POLAR_SERVER=production
  });
  // Polar signs with the base64 of the raw secret (mirroring its SDK).
  const webhook = new Webhook(Buffer.from(config.polarWebhookSecret, "utf8").toString("base64"));

  // Customers are keyed by OUR user id via external_customer_id, so there is
  // no ensureCustomer step: checkout creates/links the Polar customer and
  // webhooks carry the external id back.
  async function resolveUser(sub) {
    const externalId = sub.customer?.external_id;
    if (externalId && UUID_RE.test(externalId)) {
      const user = await db.getUser(externalId);
      if (user) return user;
    }
    const metaId = sub.metadata?.userId;
    if (metaId && UUID_RE.test(String(metaId))) {
      const user = await db.getUser(String(metaId));
      if (user) return user;
    }
    return sub.customer_id ? db.getUserByBillingCustomer(sub.customer_id) : null;
  }

  // Every subscription.* event carries the subscription's FULL current state,
  // so one status-derived handler serves them all: active/trialing/past_due
  // means pro, anything else means free, and a scheduled cancellation
  // (status still active, cancel_at_period_end) stays pro with the end date
  // surfaced. setPlan to the current state is a no-op UPDATE, so Polar's
  // redelivery retries are harmless.
  async function applySubscription(sub) {
    const user = await resolveUser(sub);
    if (!user) return; // deleted account or foreign event — ack, don't retry
    const active = ACTIVE_STATUSES.has(sub.status);
    const scheduledEnd = active && sub.cancel_at_period_end
      ? (sub.ends_at ?? sub.current_period_end ?? null)
      : null;
    await db.setPlan(user.id, active ? "pro" : "free", {
      customerId: sub.customer_id,
      subscriptionId: active ? sub.id : null,
      endsAt: scheduledEnd,
    });
  }

  return {
    async createCheckout(req, res) {
      const user = await db.getUser(req.user.id);
      const checkout = await polar.checkouts.create({
        // Two products = the hosted checkout shows a monthly/annual picker.
        products: [config.polarProductMonthlyId, config.polarProductAnnualId],
        successUrl: `${config.appUrl}/app?upgraded=1`,
        externalCustomerId: user.id,
        customerEmail: user.email,
        metadata: { userId: user.id },
      });
      res.json({ url: checkout.url });
    },

    async createPortal(req, res) {
      const user = await db.getUser(req.user.id);
      // billing_customer_id lands with the first subscription webhook, which
      // is exactly "has a billing profile". Settings expects this 400.
      if (!user.billing_customer_id) {
        return res.status(400).json({ error: "no billing profile yet" });
      }
      const session = await polar.customerSessions.create({ externalCustomerId: user.id });
      res.json({ url: session.customerPortalUrl });
    },

    async handleWebhook(req, res) {
      let event;
      try {
        // verify() checks the signature AND returns the parsed JSON body.
        event = webhook.verify(req.body, req.headers);
      } catch (e) {
        if (e instanceof WebhookVerificationError) {
          return res.status(400).json({ error: "bad signature" });
        }
        // Verified bytes that fail to parse would be a Polar-side fault;
        // acking would drop them silently, so let it 500 into a retry.
        throw e;
      }
      if (event?.type?.startsWith("subscription.") && event.data) {
        await applySubscription(event.data);
      }
      // 2xx for everything verified — unknown event types must never
      // retry-loop, and unhandled types are intentional no-ops.
      res.json({ received: true });
    },
  };
}
