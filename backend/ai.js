// One place for every Claude call. All of them use the small, cheap model (Claude Haiku 5.5): reading a gym website,
// a competition page or a proof of payment, and the coach assistant. Thinking is off and effort is low: these are
// extraction and form-filling jobs, not deep reasoning, so the extra tokens would only cost money.
"use strict";
const MODEL = () => process.env.JF_AI_MODEL || "claude-haiku-5-5";
let shared = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!shared) { const A = require("@anthropic-ai/sdk"); const C = A.default || A; shared = new C({ timeout: 55000, maxRetries: 1 }); }
  return shared;
}
const base = (o) => ({ model: MODEL(), max_tokens: o.maxTokens || 4000, thinking: { type: "disabled" }, ...(o.system ? { system: o.system } : {}) });

// Structured read: returns the parsed JSON object that matches `schema`.
async function extract(client, { system, content, schema, maxTokens, effort = "low", timeout }) {
  const c = client || getClient(); if (!c) throw new Error("AI isn't switched on.");
  const msg = await c.messages.create({ ...base({ system, maxTokens }), output_config: { effort, format: { type: "json_schema", schema } }, messages: [{ role: "user", content }] }, timeout ? { timeout } : undefined);
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to read it.");
  if (msg.stop_reason === "max_tokens") throw new Error("There was more than Claude could read in one go.");
  const b = (msg.content || []).find((x) => x.type === "text"); if (!b) throw new Error("No answer from Claude.");
  return JSON.parse(b.text);
}

// A short tool-using conversation (the coach assistant). Runs the tools Claude asks for, feeds results back,
// and stops after `maxSteps` rounds. Returns the final text and every tool call made.
async function converse(client, { system, messages, tools, run, maxSteps = 6, maxTokens = 1500 }) {
  const c = client || getClient(); if (!c) throw new Error("AI isn't switched on.");
  const convo = messages.slice(), calls = [];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await c.messages.create({ ...base({ system, maxTokens }), output_config: { effort: "low" }, tools, messages: convo });
    if (msg.stop_reason === "refusal") return { text: "I can't help with that one.", calls };
    convo.push({ role: "assistant", content: msg.content });
    const uses = (msg.content || []).filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) return { text: (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(), calls };
    const results = [];
    for (const u of uses) {
      let out, isError = false;
      try { out = await run(u.name, u.input || {}); } catch (e) { out = { error: String((e && e.message) || e).slice(0, 300) }; isError = true; }
      calls.push({ name: u.name, input: u.input, ok: !isError, result: out });
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 8000), ...(isError ? { is_error: true } : {}) });
    }
    convo.push({ role: "user", content: results });
  }
  return { text: "Done. Anything else?", calls };
}

module.exports = { getClient, extract, converse, MODEL };
