// Central env config. Every knob the plan defined lives here.

export function loadConfig(env = process.env) {
  const bool = (v) => v === "1" || v === "true";
  return {
    port: Number(env.PORT) || 4400,
    databaseUrl: env.DATABASE_URL || "",
    appUrl: (env.APP_URL || "http://localhost:4400").replace(/\/$/, ""),

    supabaseUrl: env.SUPABASE_URL || "",
    supabaseAnonKey: env.SUPABASE_ANON_KEY || "",
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || "",
    devFakeAuth: bool(env.DEV_FAKE_AUTH),

    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    fakeLlm: bool(env.FAKE_LLM),
    classifyModel: env.CLASSIFY_MODEL || "claude-haiku-4-5",
    chunkSize: Number(env.CHUNK_SIZE) || 25,
    batchThreshold: Number(env.BATCH_THRESHOLD) || 500,

    // Tiers (M8): free stores the newest freeVideoCap videos and classifies
    // all of them; freeSummaryQuota is TL;DRs per calendar month. Pro's cap
    // is fair use, marketed unlimited. Caps derive from plan at request time.
    // Beta: every account gets Pro treatment at no charge. One env var,
    // zero data changes — ending the beta is removing it and redeploying.
    betaProForAll: bool(env.BETA_PRO_FOR_ALL),
    freeVideoCap: Number(env.FREE_VIDEO_CAP) || 1000,
    proVideoCap: Number(env.PRO_VIDEO_CAP) || 25000,
    freeSummaryQuota: Number(env.FREE_SUMMARY_QUOTA) || 100,
    budgetUsd: Number(env.BUDGET_USD) || 100,
    importsPerHour: Number(env.IMPORTS_PER_HOUR) || 5,

    extensionOrigins: (env.EXTENSION_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
      .map((id) => `chrome-extension://${id}`),
    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),
    betaAllowlist: (env.BETA_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

    // Serverless mode (Vercel): no interval worker exists, so user status
    // polls advance due work in bounded bites, and a cron can backstop.
    serverless: bool(env.VERCEL) || bool(env.SERVERLESS),
    pollAdvanceBudgetMs: Number(env.POLL_ADVANCE_BUDGET_MS) || 8000,
    cronSecret: env.CRON_SECRET || "",

    // Polar (merchant of record). All four required to enable billing; absent
    // means the upgrade flow is off (the pre-launch state). POLAR_SERVER must
    // be explicitly set to "production" at go-live — the default is sandbox.
    polarAccessToken: env.POLAR_ACCESS_TOKEN || "",
    polarWebhookSecret: env.POLAR_WEBHOOK_SECRET || "",
    polarProductMonthlyId: env.POLAR_PRODUCT_MONTHLY_ID || "",
    polarProductAnnualId: env.POLAR_PRODUCT_ANNUAL_ID || "",
    polarServer: env.POLAR_SERVER === "production" ? "production" : "sandbox",
  };
}

// Haiku 4.5 pricing (USD per token). Batch mode is half price.
export const PRICING = {
  inputPerToken: 1 / 1e6,
  outputPerToken: 5 / 1e6,
};

export function estimateCostUsd({ inputTokens, outputTokens, batch }) {
  const raw = inputTokens * PRICING.inputPerToken + outputTokens * PRICING.outputPerToken;
  return batch ? raw / 2 : raw;
}
