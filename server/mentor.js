const TRANSCRIPT_CAP = 20000;

export class MentorError extends Error {}

export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    tldr: { type: "string" },
    points: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 6,
    },
    watchIf: { type: "string" },
  },
  required: ["tldr", "points", "watchIf"],
  additionalProperties: false,
};

function persona(tasteProfile = {}) {
  const interests = Array.isArray(tasteProfile.interests)
    ? tasteProfile.interests.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 15)
    : [];
  const note = String(tasteProfile.note || "").trim().slice(0, 280);
  return [
    "You are a patient, sharp learning mentor. The user saved a YouTube video but wants the useful ideas without sitting through the whole thing.",
    "Explain the real substance in plain language. Be warm, direct, and specific. Do not invent claims that are absent from the transcript.",
    interests.length ? `Their interests include: ${interests.join(", ")}.` : "",
    note ? `Their own note about what matters to them: ${note}` : "",
  ].filter(Boolean).join("\n");
}

function videoBlock(video) {
  const raw = String(video.transcript || "");
  const transcript = raw.length > TRANSCRIPT_CAP
    ? raw.slice(0, TRANSCRIPT_CAP) + " ... [transcript truncated]"
    : raw;
  return `VIDEO: ${video.title || "Untitled video"}
Channel: ${video.channel || "unknown"}
Uploaded: ${video.upload_date || "unknown"}
Category: ${video.category || "unknown"}

Transcript:
${transcript}`;
}

export function buildSummaryPrompt(video, tasteProfile = {}) {
  return `${persona(tasteProfile)}

${videoBlock(video)}

Give the user the gist in this exact shape:
1. tldr: no more than two sentences explaining what the video actually says.
2. points: three to six short takeaways that matter.
3. watchIf: one line explaining when the actual footage is worth their eyes, or say the words carry it all.

Keep the whole response under 180 words. No fluff.`;
}

export function validateSummary(data) {
  const tldr = typeof data?.tldr === "string" ? data.tldr.trim().slice(0, 1000) : "";
  if (!tldr) throw new MentorError("summary missing tldr");
  const points = Array.isArray(data?.points)
    ? data.points
      .filter((point) => typeof point === "string")
      .map((point) => point.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 6)
    : [];
  if (!points.length) throw new MentorError("summary missing points");
  const watchIf = typeof data?.watchIf === "string" ? data.watchIf.trim().slice(0, 500) : "";
  return { tldr, points, watchIf };
}

export function createMentor({ llm, model, maxTokens = 1200 }) {
  return {
    async summarize(video, { tasteProfile = {} } = {}) {
      const prompt = buildSummaryPrompt(video, tasteProfile);
      const { data, usage } = await llm.completeJson(prompt, SUMMARY_SCHEMA, { model, maxTokens });
      return {
        summary: validateSummary(data),
        usage,
        model,
      };
    },
  };
}
