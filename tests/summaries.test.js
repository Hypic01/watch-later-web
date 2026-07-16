import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { loadConfig } from "../server/config.js";
import { createFakeLlm, createLlm } from "../server/anthropic.js";
import { createMentor, SUMMARY_SCHEMA } from "../server/mentor.js";

const asUser = (req, email = "reader@test.dev") =>
  req.set("Authorization", `Bearer dev:${email}`);

let db;
let pg;
let app;
let auth;
let importer;
let config;
let mentor;
let userId;

function build(mentorOverride = mentor) {
  app = createApp({ db, auth, importer, mentor: mentorOverride, config });
}

async function provision(email = "reader@test.dev") {
  const claims = await fakeVerifier()(`dev:${email}`);
  await db.upsertUser({ id: claims.sub, email: claims.email });
  return claims.sub;
}

async function addReadyVideos(id, count, prefix = "s") {
  const videos = vids(count, prefix);
  await db.upsertFromImport(id, videos, 10000);
  await pg.query(
    "UPDATE videos SET transcript = 'A useful transcript with examples and practical advice.', transcript_available = true, transcript_source = 'test' WHERE user_id = $1",
    [id]
  );
  return videos;
}

beforeEach(async () => {
  ({ db, pg } = await testDb());
  config = loadConfig({ FREE_SUMMARY_QUOTA: "7", BUDGET_USD: "5" });
  auth = createAuth({ verify: fakeVerifier(), db, adminEmails: ["boss@test.dev"] });
  importer = createImporter({ db, config });
  mentor = createMentor({ llm: createFakeLlm(), model: config.classifyModel });
  build();
  userId = await provision();
});

describe("summary cache and free meter", () => {
  it("returns a cache hit without spending tokens or another free summary", async () => {
    const [video] = await addReadyVideos(userId, 1);
    const first = await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(200);
    expect(first.body.cached).toBe(false);
    expect(first.body.summariesUsed).toBe(1);
    const usageAfterFirst = await db.getConfig("global_usage");

    const second = await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(200);
    expect(second.body.cached).toBe(true);
    expect(second.body.summary).toEqual(first.body.summary);
    expect(second.body.summariesUsed).toBe(1);
    expect(await db.getConfig("global_usage")).toEqual(usageAfterFirst);
    expect(await db.countSummariesThisMonth(userId)).toBe(1);
  });

  it("allows exactly the monthly quota, then returns a 402 while cache still works", async () => {
    const videos = await addReadyVideos(userId, 8, "q");
    for (const video of videos.slice(0, 7)) {
      await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(200);
    }
    expect(await db.countSummariesThisMonth(userId)).toBe(7);

    const blocked = await asUser(request(app).post(`/api/videos/${videos[7].id}/summary`)).expect(402);
    expect(blocked.body.upgrade).toBe(true);
    expect(blocked.body.error).toContain("this month");
    expect(blocked.body.summariesUsed).toBe(7);
    expect(blocked.body.summaryQuota).toBe(7);

    const cached = await asUser(request(app).post(`/api/videos/${videos[0].id}/summary`)).expect(200);
    expect(cached.body.cached).toBe(true);
  });

  it("the wall lifts when last month rolls over (calendar-month reset)", async () => {
    const videos = await addReadyVideos(userId, 8, "r");
    for (const video of videos.slice(0, 7)) {
      await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(200);
    }
    await asUser(request(app).post(`/api/videos/${videos[7].id}/summary`)).expect(402);

    // Age every generated summary into last month: the meter resets to zero.
    await pg.query(
      "UPDATE summaries SET created_at = date_trunc('month', now()) - interval '1 day' WHERE user_id = $1",
      [userId]
    );
    expect(await db.countSummariesThisMonth(userId)).toBe(0);
    const fresh = await asUser(request(app).post(`/api/videos/${videos[7].id}/summary`)).expect(200);
    expect(fresh.body.summariesUsed).toBe(1);
  });

  it("lets Pro users and admins bypass the monthly wall", async () => {
    // Fill this month's quota with real generated summaries, then go pro:
    // the 8th succeeds.
    const videos = await addReadyVideos(userId, 8, "p");
    for (const video of videos.slice(0, 7)) {
      await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(200);
    }
    await asUser(request(app).post(`/api/videos/${videos[7].id}/summary`)).expect(402);
    await db.setPlan(userId, "pro", {});
    await asUser(request(app).post(`/api/videos/${videos[7].id}/summary`)).expect(200);

    const adminId = await provision("boss@test.dev");
    const adminVideos = await addReadyVideos(adminId, 8, "a");
    for (const video of adminVideos.slice(0, 7)) {
      await asUser(request(app).post(`/api/videos/${video.id}/summary`), "boss@test.dev").expect(200);
    }
    await asUser(request(app).post(`/api/videos/${adminVideos[7].id}/summary`), "boss@test.dev").expect(200);
  });

  it("requires a transcript and returns a fetch hint", async () => {
    const [video] = vids(1, "n");
    await db.upsertFromImport(userId, [video], 10000);
    const result = await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(400);
    expect(result.body.needsTranscript).toBe(true);
  });
});

describe("summary generation and accounting", () => {
  it("produces deterministic fake summaries", async () => {
    const [video] = await addReadyVideos(userId, 1, "d");
    const row = await db.getVideoTranscript(userId, video.id);
    const a = await mentor.summarize(row, { tasteProfile: { interests: ["design"] } });
    const b = await mentor.summarize(row, { tasteProfile: { interests: ["design"] } });
    expect(a.summary).toEqual(b.summary);
    expect(a.usage).toEqual(b.usage);
  });

  it("records user and global usage when jobId is null", async () => {
    await db.addUsage({
      userId,
      jobId: null,
      inputTokens: 123,
      outputTokens: 45,
      videosClassified: 0,
      costUsd: 0.001,
    });
    const user = await db.getUser(userId);
    expect(Number(user.input_tokens)).toBe(123);
    expect(Number(user.output_tokens)).toBe(45);
    expect(await db.getLatestJob(userId)).toBeNull();
    const global = await db.getConfig("global_usage");
    expect(Number(global.input_tokens)).toBe(123);
    expect(Number(global.est_cost_usd)).toBeCloseTo(0.001, 6);
  });

  it("honors the shared budget kill switch before calling the model", async () => {
    const [video] = await addReadyVideos(userId, 1, "b");
    await db.setConfig("global_usage", { input_tokens: 0, output_tokens: 0, est_cost_usd: 5 });
    let calls = 0;
    build({ summarize: async () => { calls++; throw new Error("should not run"); } });
    await asUser(request(app).post(`/api/videos/${video.id}/summary`)).expect(503);
    expect(calls).toBe(0);
    expect((await db.getConfig("kill_switch")).on).toBe(true);
  });

  it("uses a forced tool call for completeJson and never output_config", async () => {
    let params;
    const data = { tldr: "A concise summary.", points: ["One", "Two", "Three"], watchIf: "Watch for visuals." };
    const client = {
      messages: {
        create: async (input) => {
          params = input;
          return {
            content: [{ type: "tool_use", name: "emit_json", input: data }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      },
    };
    const llm = createLlm({ apiKey: "unused", model: "claude-haiku-4-5", client });
    const result = await llm.completeJson("Summarize", SUMMARY_SCHEMA);
    expect(result.data).toEqual(data);
    expect(params.tool_choice).toEqual({ type: "tool", name: "emit_json" });
    expect(params.tools[0].input_schema).toBe(SUMMARY_SCHEMA);
    expect(params.output_config).toBeUndefined();
  });
});
