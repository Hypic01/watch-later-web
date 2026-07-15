// The LLM adapter — replaces the original app's claude.js (which shelled the
// `claude` CLI on a Max plan; a hosted product can't do that). Real mode uses
// the Anthropic API with structured outputs; fake mode (FAKE_LLM=1) is a
// deterministic heuristic so the whole product runs locally with zero keys.

import Anthropic from "@anthropic-ai/sdk";

export class LlmError extends Error {}

const TOOL_NAME = "emit_classification";

export function createLlm({ apiKey, model, maxTokens = 4000 }) {
  const client = new Anthropic({ apiKey, maxRetries: 3 });

  // Force schema-shaped JSON by requiring a single tool call. This is the
  // stable, GA path for structured output on the Messages API. The prior
  // output_config/json_schema path is the beta "structured outputs" feature
  // (anthropic-beta: structured-outputs-*) — on the non-beta endpoint it 400s
  // every call, which is why no classification ever succeeded in prod. Tool use
  // needs no beta header and is supported by haiku, in single and batch calls.
  const messageParams = (prompt, schema) => ({
    model,
    max_tokens: maxTokens,
    tools: [{ name: TOOL_NAME, description: "Return the classification results.", input_schema: schema }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: prompt }],
  });

  // With a forced tool_choice the model must answer with a tool_use block whose
  // `input` is the parsed object — no text, no JSON.parse.
  const readToolResult = (msg) => (msg?.content || []).find((b) => b.type === "tool_use" && b.name === TOOL_NAME)?.input ?? null;

  return {
    async classifyChunk(prompt, schema) {
      let msg;
      try {
        msg = await client.messages.create(messageParams(prompt, schema));
      } catch (e) {
        throw new LlmError(e?.message || "anthropic request failed");
      }
      const data = readToolResult(msg);
      if (data === null) throw new LlmError("model did not return the classification tool call");
      return {
        data,
        usage: { input: msg.usage?.input_tokens ?? 0, output: msg.usage?.output_tokens ?? 0 },
      };
    },

    buildBatchRequest(customId, prompt, schema) {
      return { custom_id: customId, params: messageParams(prompt, schema) };
    },

    async submitBatch(requests) {
      const batch = await client.messages.batches.create({ requests });
      return batch.id;
    },

    async getBatch(id) {
      return client.messages.batches.retrieve(id);
    },

    async *batchResults(id) {
      for await (const entry of await client.messages.batches.results(id)) {
        if (entry.result?.type === "succeeded") {
          const msg = entry.result.message;
          const data = readToolResult(msg);
          yield {
            customId: entry.custom_id,
            ok: data !== null,
            data,
            usage: { input: msg.usage?.input_tokens ?? 0, output: msg.usage?.output_tokens ?? 0 },
          };
        } else {
          yield { customId: entry.custom_id, ok: false, error: entry.result?.type || "errored" };
        }
      }
    },
  };
}

// Deterministic local stand-in. Never used when a real API key is configured.
export function createFakeLlm() {
  const classify = (v) => {
    const t = `${v.title} ${v.channel}`.toLowerCase();
    const dur = v.duration_seconds ?? v.durationSeconds ?? 0;
    const guide = /guide|tier list|meta|patch|season|set \d/i.test(t);
    if (/mix\b|dj set|full album|playlist|lofi|lo-fi|\bost\b|1 hour|radio|live set|음악|노래/.test(t) && !/tutorial|how to/.test(t))
      return ["music", "the point is listening"];
    if (guide && /old|2019|2020|2021|previous|legacy/.test(t)) return ["outdated", "superseded guide content"];
    if (/gaming|stream|funny|meme|반응|웃긴|esports|highlights|variety/.test(t) && !guide)
      return ["entertainment", "fun is the point"];
    if (/vlog|travel|tour|room|살이|여행|inspiration|portfolio review|breakdown/.test(t))
      return ["watch", "visuals carry the value"];
    if (dur && dur < 75) return ["entertainment", "short-form fun"];
    return ["learn", "informational content"];
  };
  const topicFor = (v) => {
    const t = `${v.title} ${v.channel}`.toLowerCase();
    if (/game|gaming|tft|league|minecraft|esports/.test(t)) return "gaming";
    if (/music|mix|album|song|lofi|beats|\bdj\b/.test(t)) return "music";
    if (/tech|\bai\b|claude|gpt|llm|code|dev|app|figma/.test(t)) return "tech";
    if (/tutorial|how to|learn|guide|course|explain/.test(t)) return "learning & how-to";
    if (/travel|tour|trip|vlog/.test(t)) return "travel";
    if (/food|recipe|cook|kitchen/.test(t)) return "food & cooking";
    return "other";
  };
  const run = (prompt) => {
    // Recover the ids + metadata from the prompt blocks — deterministic.
    const blocks = [...prompt.matchAll(/--- VIDEO id: "([^"]+)" ---\nTitle: ([^\n]*)\nChannel: ([^\n]*)\nDuration: ([^\n ]*)/g)];
    const results = blocks.map(([, id, title, channel, dur]) => {
      const v = { title, channel, duration_seconds: Number(dur) || 0 };
      const [category, reasoning] = classify(v);
      return { id, category, reasoning, confidence: 0.62, topics: [topicFor(v)] };
    });
    return {
      data: { results },
      usage: { input: Math.ceil(prompt.length / 4), output: results.length * 45 },
    };
  };

  const pendingBatches = new Map();
  let batchSeq = 0;

  return {
    async classifyChunk(prompt) {
      return run(prompt);
    },
    buildBatchRequest(customId, prompt) {
      return { custom_id: customId, params: { __fakePrompt: prompt } };
    },
    async submitBatch(requests) {
      const id = `fakebatch_${++batchSeq}`;
      pendingBatches.set(id, requests);
      return id;
    },
    async getBatch(id) {
      return { id, processing_status: pendingBatches.has(id) ? "ended" : "ended" };
    },
    async *batchResults(id) {
      const requests = pendingBatches.get(id) || [];
      for (const r of requests) {
        const { data, usage } = run(r.params.__fakePrompt);
        yield { customId: r.custom_id, ok: true, data, usage };
      }
      pendingBatches.delete(id);
    },
  };
}
