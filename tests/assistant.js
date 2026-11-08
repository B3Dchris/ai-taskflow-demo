// Coach assistant, background website import, adding students in bulk, gym look.
// A stand-in for the Anthropic API replays scripted answers, so every tool runs for real against the database.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/assistant.js
const { spawn } = require("child_process"); const http = require("http"); const path = require("path"); const { Pool } = require("pg");
const { startGymSite } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Fake Claude: "TOOL {json}" -> calls that tool; after a tool result -> "RESULT <json>" (or "ERROR <msg>"); anything else -> a question.
const seen = [];
function fakeClaude() { return new Promise((res) => { const s = http.createServer((req, rsp) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const body = JSON.parse(b || "{}"); seen.push(body); const last = body.messages[body.messages.length - 1]; let content, stop = "end_turn";
  if (Array.isArray(last.content) && last.content[0] && last.content[0].type === "tool_result") { const r = last.content[0]; content = [{ type: "text", text: (r.is_error ? "ERROR " : "RESULT ") + r.content }]; }
  else { const t = typeof last.content === "string" ? last.content : ""; const m = t.match(/^TOOL (.+)$/s);
    if (m) { const j = JSON.parse(m[1]); content = [{ type: "tool_use", id: "tu_" + seen.length, name: j.name, input: j.input || {} }]; stop = "tool_use"; }
    else if (body.output_config && body.output_config.format) content = [{ type: "text", text: "not json" }]; // importer reads: fall back to the plain read
    else content = [{ type: "text", text: "What's the account number?" }]; }
  rsp.writeHead(200, { "content-type": "application/json" }); rsp.end(JSON.stringify({ id: "msg_" + seen.length, type: "message", role: "assistant", model: body.model, content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  s.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() })); }); }
function client(base) { let cookie = ""; return async (method, url, body) => { const h = { "content-type": "application/json", "x-jf": "1" }; if (cookie) h.cookie = cookie;
  const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; }; }
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists pop_files, notices, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const ai = await fakeClaude(), site = await startGymSite();
  const port = 9600 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: ai.url, JF_IMPORT_ALLOW_LOOPBACK: "1", JF_ASSISTANT: "1", RESEND_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  try {
    const co = client(base), other = client(base), stu = client(base);
    let r = await co("POST", "/auth/start-gym", { gym: "Ask Gym", name: "Coach Ana", email: "ana@ask.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const code = r.j.me.gym.studentCode;
    await other("POST", "/auth/start-gym", { gym: "Other Gym", name: "Coach Ben", email: "ben@other.test", password: "coachpass1" });
    const otherStu = (await other("POST", "/coach/students", { name: "Not Yours", phone: "0839990000" })).j.id;
    await stu("POST", "/auth/register", { code, name: "Sipho Ndlovu", email: "sipho@ask.test", password: "password1" });
    const say = (text, history = []) => co("POST", "/coach/assistant", { messages: [...history, { role: "user", text }] });
    const tool = (name, input) => say("TOOL " + JSON.stringify({ name, input }));
    // --- plumbing
    r = await say("update my bank details"); ok(r.s === 200 && /account number/i.test(r.j.reply), "a request with details missing gets a follow-up question");
    const req0 = seen[seen.length - 1]; ok(req0.model === "claude-haiku-5-5" && req0.thinking && req0.thinking.type === "disabled" && req0.tools.length === 9 && /Ask Gym/.test(req0.system), "uses the cheap model, no thinking, with the gym's tools");
    r = await stu("POST", "/coach/assistant", { messages: [{ role: "user", text: "hi" }] }); ok(r.s === 403, "students can't use the coach assistant");
    // --- each tool
    r = await tool("update_bank_details", { bank: "FNB", account_number: "62 123 456 789", branch_code: "250655", account_holder: "Ask Gym", due_day: 3 });
    ok(r.s === 200 && r.j.actions.some((a) => a.summary === "Bank details updated") && r.j.refresh.includes("pay"), "bank details: changed, and the app is told to refresh");
    r = await co("GET", "/coach/gym/pay"); ok(r.j.pay.bank === "FNB" && r.j.pay.account === "62 123 456 789" && r.j.pay.dueDay === 3, "bank details are really saved");
    r = await tool("add_plan", { name: "2x a week", price: 650, classes_per_week: 2 }); ok(/Plan added: 2x a week/.test(r.j.actions[0].summary), "adds a plan");
    r = await tool("add_student", { name: "Nomsa Dube", phone: "082 444 1111", belt: "blue", plan: "2x a week", note: "Came from Fight Club" });
    ok(/Added Nomsa Dube/.test(r.j.actions[0].summary), "adds a student who isn't on the app");
    r = await tool("add_student", { name: "No Contact" }); ok(/^ERROR .*WhatsApp number or an email/.test(r.j.reply) && !r.j.actions.length, "a student with no number or email isn't added; the reason goes back to Claude");
    r = await tool("find_students", { name: "nomsa" }); const found = JSON.parse(r.j.reply.replace(/^RESULT /, "")).students;
    ok(found.length === 1 && found[0].plan === "2x a week" && found[0].belt === "blue", "finds students by name");
    r = await tool("find_students", { name: "sihpo" }); ok(JSON.parse(r.j.reply.replace(/^RESULT /, "")).students.some((s) => s.name === "Sipho Ndlovu"), "finds a student even with a typo");
    const nomsa = found[0].id;
    r = await tool("update_student", { student_id: nomsa, belt: "purple", note: "Great guard retention" }); ok(/Nomsa: belt purple, note added/.test(r.j.actions[0].summary), "changes a belt and adds a note");
    r = await co("GET", `/coach/students/${nomsa}`); ok(r.j.student.belt === "purple" && /Came from Fight Club/.test(r.j.student.notes) && /Great guard retention/.test(r.j.student.notes), "the note is added, not replaced");
    r = await tool("update_student", { student_id: otherStu, belt: "black" }); ok(/^ERROR/.test(r.j.reply), "can't touch another gym's student");
    r = await tool("record_payment", { student_id: nomsa, amount: 650, method: "cash" }); ok(/Recorded R\s?650/.test(r.j.actions[0].summary), "records a payment");
    r = await co("GET", "/coach/payments"); ok(r.j.payments.some((p) => p.userId === nomsa && p.amountCents === 65000 && p.method === "cash" && p.status === "confirmed"), "the payment counts as paid");
    r = await tool("add_classes", { title: "No-Gi Fundamentals", weekday: "mon", start_time: "18:00", duration_min: 60, repeat_weeks: 3 }); ok(/Added 3 classes/.test(r.j.actions[0].summary), "adds a class every Monday for 3 weeks");
    r = await co("GET", "/classes"); const mons = r.j.classes.filter((c) => c.title === "No-Gi Fundamentals");
    ok(mons.length === 3 && mons.every((c) => new Date(c.startsAt).getUTCDay() === 1 && new Date(c.startsAt).getUTCHours() === 16), "on Mondays at 18:00 Johannesburg time");
    r = await tool("add_classes", { title: "No-Gi Fundamentals", weekday: "mon", start_time: "18:00", repeat_weeks: 1 }); ok(JSON.parse(r.j.reply.replace(/^RESULT /, "")).skipped === 1, "doesn't double up a class that's already there");
    r = await tool("update_gym", { whatsapp_number: "082 555 0000", monthly_fee: 800 }); r = await co("GET", "/me"); ok(r.j.me.gym.waPhone === "082 555 0000" && r.j.me.gym.monthlyFeeCents === 80000, "changes the gym's WhatsApp number and fee");
    r = await co("GET", "/me"); ok(r.j.me.gym.setup.assistantUsed === true, "using the assistant ticks it off Getting started");
    // --- background website import
    r = await co("POST", "/coach/import/start", { url: "jpbuys" }); ok(r.s === 400 && /web address/.test(r.j.error), "an address that can't be a website gets a plain message");
    r = await co("POST", "/coach/import/start", { url: site.url.replace("http://", "").replace("127.0.0.1", "localhost") }); ok(r.s === 202 && r.j.job.status === "running", "import starts in the background (address typed without http://)");
    let job; for (let i = 0; i < 60; i++) { job = (await co("GET", "/coach/import/job")).j.job; if (job.status !== "running") break; await wait(300); }
    ok(job.status === "done" && job.result.profile.timetable.length > 0, "the import finishes in the background with the timetable");
    r = await co("DELETE", "/coach/import/job"); r = await co("GET", "/coach/import/job"); ok(r.j.job === null, "the coach can clear it");
    // --- bulk add from contacts / a list
    r = await co("POST", "/coach/students/bulk", { people: [{ name: "Lerato Dlamini", phone: "+27 82 777 1234" }, { name: "Same Phone", phone: "0827771234" }, { name: "Kyle Naidoo", email: "kyle@x.test" }, { name: "Nomsa Dube", phone: "0821230000" }, { name: "No Way" }] });
    ok(r.s === 201 && r.j.added === 2 && r.j.skipped === 3, "bulk add skips duplicates (same number, same name) and people with no contact");
    // --- look
    r = await co("PATCH", "/coach/gym", { brandAccent: "#C62828" }); ok(r.j.me.gym.brand.accent === "#c62828", "the gym's colour is saved");
    r = await stu("GET", "/me"); ok(r.j.me.gym.brand.accent === "#c62828" && !r.j.me.gym.setup, "students get the gym's colour (not the coach's setup)");
    r = await co("PATCH", "/coach/gym", { brandAccent: "red; background:url(x)" }); ok(!r.j.me.gym.brand.accent, "anything that isn't a colour is ignored");
    r = await co("PATCH", "/coach/gym", { setup: { welcomed: true, dismissed: true, junk: 1 } }); ok(r.j.me.gym.setup.welcomed && r.j.me.gym.setup.dismissed && !("junk" in r.j.me.gym.setup), "getting-started flags are saved");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); ai.close(); site.close(); await pool.end();
  console.log(`assistant: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
