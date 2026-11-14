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

/* ---------------- the daily budget ----------------
   Every Claude call, from every feature (proof reads, screenshot reads, website and competition imports, inbound proof
   emails, the assistant), first takes its share of a daily budget: calls and roughly how many input tokens it sends.
   There's one budget for all of JitsFlow and a smaller one per gym (smaller still for a gym under 7 days old). When the
   overall budget is used up, every AI feature stops for the rest of the day (UTC): a circuit breaker, so a flood of uploads
   or imports can't run up the bill. Features carry on without Claude (a proof is stored for the coach to check by hand,
   an import does the plain read). Limits are environment settings: */
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
const LIMITS = () => ({
  calls: num(process.env.JF_AI_DAY_CALLS, 3000), tokens: num(process.env.JF_AI_DAY_TOKENS, 25e6),
  gymCalls: num(process.env.JF_AI_GYM_DAY_CALLS, 150), gymTokens: num(process.env.JF_AI_GYM_DAY_TOKENS, 2e6),
  newGymCalls: num(process.env.JF_AI_NEW_GYM_DAY_CALLS, 40), newGymTokens: num(process.env.JF_AI_NEW_GYM_DAY_TOKENS, 5e5),
});
class AiBudgetError extends Error { constructor(msg) { super(msg); this.code = "AI_BUDGET"; this.status = 503; } }
const DAY_OUT = "Not read automatically: today's limit for reading with AI has been reached.";
const GYM_OUT = "Not read automatically: your gym has used today's reading with AI.";
// A rough count of the input tokens in a request: text at ~3.5 characters a token, a picture at most ~1,600, a PDF ~2,500 a page.
function pdfPages(b64) { try { const n = (Buffer.from(String(b64), "base64").toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length; return Math.max(1, n); } catch (e) { return 1; } }
function estimate(system, content) {
  let t = String(system || "").length / 3.5;
  const walk = (c) => { if (typeof c === "string") { t += c.length / 3.5; return; } if (!Array.isArray(c)) return;
    for (const b of c) { if (typeof b === "string") { t += b.length / 3.5; continue; } if (!b || typeof b !== "object") continue; if (b.type === "text") t += String(b.text || "").length / 3.5; else if (b.type === "image") t += 1600;
      else if (b.type === "document") t += 2500 * pdfPages(b.source && b.source.data); else if (b.type === "tool_result" || b.type === "tool_use") t += JSON.stringify(b).length / 3.5; } };
  walk(content);
  return Math.ceil(t);
}
// Where the counts are kept: the database once the API sets it (shared by every server; see dbStore), else this process.
const mem = new Map();
let store = { take: async (scope, tokens, maxCalls, maxTokens) => { const day = new Date().toISOString().slice(0, 10), k = day + "|" + scope, u = mem.get(k) || { calls: 0, tokens: 0 };
  if (u.calls >= maxCalls || u.tokens >= maxTokens) return false; u.calls++; u.tokens += tokens; mem.set(k, u); return true; }, young: async () => false };
function useStore(s) { store = s; }
function dbStore(q) {
  return {
    async take(scope, tokens, maxCalls, maxTokens) {
      const r = await q(`insert into ai_usage(day, scope, calls, tokens) values ((now() at time zone 'utc')::date, $1, 1, $2)
        on conflict (day, scope) do update set calls = ai_usage.calls + 1, tokens = ai_usage.tokens + excluded.tokens
        where ai_usage.calls < $3 and ai_usage.tokens < $4 returning calls`, [scope, Math.round(tokens), maxCalls, maxTokens]);
      return r.rowCount > 0;
    },
    async young(gymId) { const r = await q("select created_at > now() - interval '7 days' as y from gyms where id=$1", [gymId]); return !!(r.rows[0] && r.rows[0].y); },
    async today() { return (await q("select scope, calls, tokens from ai_usage where day=(now() at time zone 'utc')::date order by scope")).rows; },
  };
}
let tripped = null; // the day (UTC) the overall budget ran out
const utcDay = () => new Date().toISOString().slice(0, 10);
const wt = require("worker_threads");
const inWorker = () => !wt.isMainThread && !!(wt.workerData && wt.workerData.jfAiViaParent);
let seq = 0; const waiting = new Map();
// meter: { gymId, feature } (gymId null: only the overall budget, e.g. an import a platform admin started).
async function take(meter, tokens) {
  meter = meter || {};
  // In an import worker the main thread holds the budget: ask it (see importer.runImport).
  if (inWorker()) return new Promise((ok, no) => { const id = ++seq; waiting.set(id, { ok, no }); wt.parentPort.postMessage({ type: "ai-take", id, meter, tokens }); });
  const L = LIMITS(), day = utcDay();
  if (tripped === day) throw new AiBudgetError(DAY_OUT);
  if (meter.gymId) {
    const young = await store.young(meter.gymId).catch(() => false);
    if (!(await store.take("gym:" + meter.gymId, tokens, young ? L.newGymCalls : L.gymCalls, young ? L.newGymTokens : L.gymTokens))) throw new AiBudgetError(GYM_OUT);
  }
  if (!(await store.take("all", tokens, L.calls, L.tokens))) {
    if (tripped !== day) console.warn(`AI budget: today's limit (${L.calls} calls, ${L.tokens} tokens) is used up; AI features are off until tomorrow (UTC).`);
    tripped = day; throw new AiBudgetError(DAY_OUT);
  }
}
// An import worker's answer from the main thread.
function answered(m) { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.ok) w.ok(); else w.no(m.budget ? new AiBudgetError(m.error) : new Error(m.error)); }
// Is any AI budget left today (for skipping work that only matters if Claude will read it)? Doesn't take any.
const spent = () => tripped === utcDay();

// Structured read: returns the parsed JSON object that matches `schema`.
async function extract(client, { system, content, schema, maxTokens, effort = "low", timeout, meter, signal }) {
  const c = client || getClient(); if (!c) throw new Error("AI isn't switched on.");
  await take(meter, estimate(system, content));
  const msg = await c.messages.create({ ...base({ system, maxTokens }), output_config: { effort, format: { type: "json_schema", schema } }, messages: [{ role: "user", content }] }, timeout || signal ? { ...(timeout ? { timeout } : {}), ...(signal ? { signal } : {}) } : undefined);
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to read it.");
  if (msg.stop_reason === "max_tokens") throw new Error("There was more than Claude could read in one go.");
  const b = (msg.content || []).find((x) => x.type === "text"); if (!b) throw new Error("No answer from Claude.");
  return JSON.parse(b.text);
}

// A short tool-using conversation (the coach assistant). Runs the tools Claude asks for, feeds results back,
// and stops after `maxSteps` rounds. Returns the final text and every tool call made.
async function converse(client, { system, messages, tools, run, maxSteps = 6, maxTokens = 1500, meter }) {
  const c = client || getClient(); if (!c) throw new Error("AI isn't switched on.");
  const convo = messages.slice(), calls = [];
  for (let step = 0; step < maxSteps; step++) {
    await take(meter, estimate(system, convo.map((m) => m.content).flat()) + JSON.stringify(tools || []).length / 3.5);
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

module.exports = { getClient, extract, converse, MODEL, take, answered, spent, estimate, pdfPages, useStore, dbStore, LIMITS, AiBudgetError, _reset: () => { mem.clear(); tripped = null; } };
