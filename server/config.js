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

    freeVideoQuota: Number(env.FREE_VIDEO_QUOTA) || 100,
    budgetUsd: Number(env.BUDGET_USD) || 100,
    importsPerHour: Number(env.IMPORTS_PER_HOUR) || 5,

    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean),
    betaAllowlist: (env.BETA_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),

    stripeSecretKey: env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    stripePriceId: env.STRIPE_PRICE_ID || "",
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
