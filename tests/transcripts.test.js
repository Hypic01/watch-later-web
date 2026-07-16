import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { testDb, vids } from "./helpers.js";
import { createApp } from "../server/app.js";
import { createAuth, fakeVerifier } from "../server/auth.js";
import { createImporter } from "../server/importer.js";
import { loadConfig } from "../server/config.js";

const asUser = (req, email = "captions@test.dev") =>
  req.set("Authorization", `Bearer dev:${email}`);

let db;
let app;
let userId;
let transcripts;

async function addVideo(video = vids(1)[0]) {
  await db.upsertFromImport(userId, [video], 10000);
  return video.id;
}

beforeEach(async () => {
  ({ db } = await testDb());
  const config = loadConfig({ FREE_SUMMARY_QUOTA: "7" });
  const auth = createAuth({ verify: fakeVerifier(), db, adminEmails: [] });
  const importer = createImporter({ db, config });
  transcripts = { fetchTranscript: async () => { throw new Error("blocked"); } };
  app = createApp({ db, auth, importer, transcripts, config });
  const claims = await fakeVerifier()("dev:captions@test.dev");
  await db.upsertUser({ id: claims.sub, email: claims.email });
  userId = claims.sub;
});

describe("transcript storage", () => {
  it("enforces ownership", async () => {
    const id = await addVideo();
    await asUser(request(app).post(`/api/videos/${id}/transcript`), "other@test.dev")
      .send({ transcript: "not yours" })
      .expect(404);
    expect((await db.getVideoTranscript(userId, id)).transcript_available).toBe(false);

    await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({ transcript: "the real captions" })
      .expect(200);
    expect((await db.getVideoTranscript(userId, id)).transcript).toBe("the real captions");
  });

  it("measures the 1 MB cap in bytes and stores at most 250,000 characters", async () => {
    const id = await addVideo();
    await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({ transcript: "é".repeat(600000) })
      .expect(413);

    const result = await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({ transcript: "x".repeat(300000) })
      .expect(200);
    expect(result.body.truncated).toBe(true);
    expect((await db.getVideoTranscript(userId, id)).transcript).toHaveLength(250000);
  });

  it("fills metadata once with COALESCE semantics and preserves existing values", async () => {
    const id = await addVideo({
      id: "meta1234567",
      title: "Metadata video",
      channel: "",
      durationSeconds: null,
      position: 1,
      publishedText: null,
    });
    await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({
        transcript: "first transcript",
        description: "first description",
        uploadDate: "2024-03-02",
        durationSeconds: 321,
        channel: "First channel",
      })
      .expect(200);
    await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({
        transcript: "new transcript",
        metadata: {
          description: "replacement description",
          upload_date: "2025-01-01",
          duration_seconds: 999,
          channel: "Replacement channel",
        },
      })
      .expect(200);

    const row = await db.getVideoTranscript(userId, id);
    expect(row.transcript).toBe("new transcript");
    expect(row.description).toBe("first description");
    expect(row.upload_date).toBe("2024-03-02");
    expect(row.duration_seconds).toBe(321);
    expect(row.channel).toBe("First channel");
  });

  it("never returns the raw transcript from the detail endpoint", async () => {
    const id = await addVideo();
    await asUser(request(app).post(`/api/videos/${id}/transcript`))
      .send({ transcript: "SECRET TRANSCRIPT", description: "Useful description" })
      .expect(200);
    const detail = await asUser(request(app).get(`/api/videos/${id}`)).expect(200);
    expect(detail.body.transcript_available).toBe(true);
    expect(detail.body.description).toBe("Useful description");
    expect(detail.body.vault_note_path).toBeNull();
    expect(detail.body).not.toHaveProperty("transcript");
    expect(JSON.stringify(detail.body)).not.toContain("SECRET TRANSCRIPT");
  });
});

describe("server transcript fallback", () => {
  it("returns the honest browser guidance when YouTube rejects the server", async () => {
    const id = await addVideo();
    const result = await asUser(request(app).post(`/api/videos/${id}/transcript/fetch`)).expect(502);
    expect(result.body.error).toBe(
      "YouTube would not hand captions to our server. With the Chrome extension we fetch them straight from your browser instead."
    );
  });

  it("stores a successful best effort server result through the same capped path", async () => {
    const id = await addVideo();
    transcripts.fetchTranscript = async () => ({
      transcript: "server captions",
      description: "From the player response",
      channel: "A channel",
      durationSeconds: 45,
    });
    await asUser(request(app).post(`/api/videos/${id}/transcript/fetch`)).expect(200);
    const row = await db.getVideoTranscript(userId, id);
    expect(row.transcript).toBe("server captions");
    expect(row.description).toBe("From the player response");
  });
});
