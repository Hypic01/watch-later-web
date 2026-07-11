# Launch checklist

The code is done and tested (82 tests, full flow QA'd in dev mode). What remains
is account wiring and rollout. Work top to bottom.

## 1. Accounts and keys

- [ ] **Supabase** (free tier): project + Google auth provider. The Google step
      needs a Google Cloud OAuth client (Web application) with redirect URI
      `https://<project>.supabase.co/auth/v1/callback`. Needed values: project
      URL, anon/publishable key, pooled connection string.
- [ ] **Anthropic** (console.anthropic.com): an API key with a little credit.
      A 50-user beta costs about $2 in classification.
- [ ] **Stripe**: Product "Pro" with a recurring Price (default $5/mo, change in
      the dashboard anytime) → webhook endpoint `https://<domain>/api/billing/webhook`
      for `checkout.session.completed`, `customer.subscription.updated`,
      `customer.subscription.deleted`. Keep TEST mode until pricing is final.
- [ ] **Hosting**: Vercel (see `vercel.json`) or any Node host (see `railway.json`).
      Set every env var from `.env.example`, including the two `VITE_` values
      that bake into the frontend at build time.

## 2. Dogfood, then friendlies

- [ ] Import a real Watch Later through the actual snippet flow on production.
- [ ] Run the E2E gate from the design spec end to end, twice.
- [ ] Record the import → sorted-board demo GIF for the landing page.
- [ ] Invite 3 to 5 friendly testers via `BETA_ALLOWLIST`, fix what they trip on.

## 3. Open the beta

- [ ] Remove the allowlist (or grow it in waves).
- [ ] Post where the pain lives: r/SideProject, r/productivity, r/youtube,
      r/DataHoarder (read each sub's self-promo rules first).
- [ ] Add Sentry (free tier) + an uptime ping when strangers arrive.

## 4. After launch

- [ ] Chrome MV3 extension (Phase 6 in the spec): one-click import, then
      bulk-remove from the real Watch Later as the killer Pro feature.
- [ ] Watch `/api/admin/stats` for spend and signups (admin account required).
- [ ] Set the real Pro price based on what the beta tells you.

## Local dev reminder

    DEV_FAKE_AUTH=1 FAKE_LLM=1 npm start    # full product, zero keys
