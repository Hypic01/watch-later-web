// Stripe billing: hosted Checkout for upgrades, Customer Portal for
// manage/cancel, webhooks as the single source of truth for plan state.
// The webhook route is mounted with a raw body parser (see app.js) so
// signature verification works. Downgrade semantics: classified videos stay
// visible forever; only future classification re-locks.

import Stripe from "stripe";

export function createBilling({ db, config, stripeClient }) {
  const stripe = stripeClient || new Stripe(config.stripeSecretKey);

  async function ensureCustomer(user) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    await db.setStripeCustomer(user.id, customer.id);
    return customer.id;
  }

  return {
    async createCheckout(req, res) {
      const user = await db.getUser(req.user.id);
      const customerId = await ensureCustomer(user);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: config.stripePriceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: `${config.appUrl}/app?upgraded=1`,
        cancel_url: `${config.appUrl}/app`,
        metadata: { userId: user.id },
      });
      res.json({ url: session.url });
    },

    async createPortal(req, res) {
      const user = await db.getUser(req.user.id);
      if (!user.stripe_customer_id) return res.status(400).json({ error: "no billing profile yet" });
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${config.appUrl}/app`,
      });
      res.json({ url: portal.url });
    },

    async handleWebhook(req, res) {
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], config.stripeWebhookSecret);
      } catch {
        return res.status(400).json({ error: "bad signature" });
      }

      // Handlers are idempotent: setPlan to the same state is a no-op, so
      // Stripe's redelivery retries are safe.
      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object;
          const userId = s.metadata?.userId;
          if (userId && (await db.getUser(userId))) {
            await db.setPlan(userId, "pro", { customerId: s.customer, subscriptionId: s.subscription });
          }
          break;
        }
        case "customer.subscription.updated": {
          const sub = event.data.object;
          const user = await db.getUserByStripeCustomer(sub.customer);
          if (user) {
            const active = ["active", "trialing", "past_due"].includes(sub.status);
            await db.setPlan(user.id, active ? "pro" : "free", {
              customerId: sub.customer,
              subscriptionId: active ? sub.id : null,
            });
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const user = await db.getUserByStripeCustomer(sub.customer);
          if (user) await db.setPlan(user.id, "free", { customerId: sub.customer, subscriptionId: null });
          break;
        }
        default:
          break;
      }
      res.json({ received: true });
    },
  };
}
