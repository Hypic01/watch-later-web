// The LLM adapter — replaces the original app's claude.js (which shelled the
// `claude` CLI on a Max plan; a hosted product can't do that). Schema-shaped
// responses use forced tool calls on the stable Messages API. Fake mode
// (FAKE_LLM=1) is deterministic so the product runs locally with zero keys.

import Anthropic from "@anthropic-ai/sdk";

export class LlmError extends Error {}

const CLASSIFY_TOOL_NAME = "emit_classification";
const JSON_TOOL_NAME = "emit_json";

export function createLlm({ apiKey, model, maxTokens = 4000, client: injectedClient }) {
  const client = injectedClient || new Anthropic({ apiKey, maxRetries: 3 });

  // Force schema-shaped JSON by requiring a single tool call. This is the
  // stable, GA path for structured output on the Messages API. The prior
  // output_config/json_schema path is the beta "structured outputs" feature
  // (anthropic-beta: structured-outputs-*) — on the non-beta endpoint it 400s
  // every call, which is why no classification ever succeeded in prod. Tool use
  // needs no beta header and is supported by haiku, in single and batch calls.
  const toolParams = (prompt, schema, {
    toolName = CLASSIFY_TOOL_NAME,
    description = "Return the classification results.",
    requestModel = model,
    requestMaxTokens = maxTokens,
  } = {}) => ({
    model: requestModel,
    max_tokens: requestMaxTokens,
    tools: [{ name: toolName, description, input_schema: schema }],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });

  // With a forced tool_choice the model must answer with a tool_use block whose
  // `input` is the parsed object — no text, no JSON.parse.
  const readToolResult = (msg, toolName) =>
    (msg?.content || []).find((b) => b.type === "tool_use" && b.name === toolName)?.input ?? null;

  const usageOf = (msg) => ({
    input: msg?.usage?.input_tokens ?? 0,
    output: msg?.usage?.output_tokens ?? 0,
  });

  async function send(params) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      throw new LlmError(e?.message || "anthropic request failed");
    }
  }

  return {
    async classifyChunk(prompt, schema) {
      const msg = await send(toolParams(prompt, schema));
      const data = readToolResult(msg, CLASSIFY_TOOL_NAME);
      if (data === null) throw new LlmError("model did not return the classification tool call");
      return { data, usage: usageOf(msg) };
    },

    async completeJson(prompt, schema, options = {}) {
      const msg = await send(toolParams(prompt, schema, {
        toolName: JSON_TOOL_NAME,
        description: "Return the requested structured response.",
        requestModel: options.model || model,
        requestMaxTokens: options.maxTokens || maxTokens,
      }));
      const data = readToolResult(msg, JSON_TOOL_NAME);
      if (data === null) throw new LlmError("model did not return the structured response tool call");
      return { data, usage: usageOf(msg) };
    },

    async completeText(prompt, options = {}) {
      const msg = await send({
        model: options.model || model,
        max_tokens: options.maxTokens || maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      const text = (msg?.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("")
        .trim();
      if (!text) throw new LlmError("model did not return text");
      return { text, usage: usageOf(msg) };
    },

    buildBatchRequest(customId, prompt, schema) {
      return { custom_id: customId, params: toolParams(prompt, schema) };
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
          const data = readToolResult(msg, CLASSIFY_TOOL_NAME);
          yield {
            customId: entry.custom_id,
            ok: data !== null,
            data,
            usage: usageOf(msg),
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

  const fakeJson = (prompt, schema) => {
    const properties = schema?.properties || {};
    const title = prompt.match(/^VIDEO:\s*(.+)$/m)?.[1]?.trim() || "this video";
    if (properties.tldr && properties.points && properties.watchIf) {
      return {
        tldr: `${title} explains its core idea in plain language. The useful parts are the concrete principles you can apply afterward.`,
        points: [
          "Start with the central idea before worrying about details.",
          "Use the examples to connect the idea to a real situation.",
          "Apply one takeaway soon so it is easier to remember.",
        ],
        watchIf: "Watch if the examples or visuals matter to how you will use the idea.",
      };
    }
    if (properties.hook && properties.concepts) {
      return {
        hook: `${title} becomes easier once you break it into one practical idea.`,
        concepts: [],
      };
    }
    return {};
  };

  return {
    async classifyChunk(prompt) {
      return run(prompt);
    },
    async completeJson(prompt, schema) {
      const data = fakeJson(prompt, schema);
      return {
        data,
        usage: { input: Math.ceil(prompt.length / 4), output: Math.ceil(JSON.stringify(data).length / 4) },
      };
    },
    async completeText(prompt) {
      const text = "Let us take the core idea one step at a time and connect it to a concrete example.";
      return {
        text,
        usage: { input: Math.ceil(prompt.length / 4), output: Math.ceil(text.length / 4) },
      };
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
