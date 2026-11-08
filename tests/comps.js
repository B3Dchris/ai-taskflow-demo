// Competitions: reading an event page, the coach's team list, and students asking to enter. Needs a test database.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/comps.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startGymSite, startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base) { let cookie = ""; return async (method, url, body) => { const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
  const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = "jf_s=" + m[1]; }
  let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; }; }
(async () => {
  process.env.JF_IMPORT_ALLOW_LOOPBACK = "1";
  const site = await startGymSite(), sink = await startMailSink(), im = require("../backend/importer");
  // ---- reading event pages (no database needed)
  try {
    let r = await im.importEvent(site.url + "/events/gauteng-open", { client: null });
    const e = r.event;
    ok(e.name === "Gauteng Open No-Gi 2026" && e.startsOn === "2026-12-12" && e.endsOn === "2026-12-13" && e.venue === "Wanderers Stadium Hall" && e.city === "Johannesburg", "event page with event data: name, dates, venue, city");
    ok(e.organiser === "Grapple SA" && /650/.test(e.fee) && e.registerBy === "2026-12-05" && e.style === "nogi" && r.dateChecked, "organiser, fee, registration deadline, no-gi");
    ok(r.pages.length === 2, "also reads the linked divisions page");
    r = await im.importEvent(site.url + "/events/text-only", { client: null });
    ok(r.event.startsOn === "2027-01-23" && r.event.registerBy === "2027-01-16" && r.event.style === "nogi", "text-only page: date, deadline and style from the words on the page");
    let sent = null; const fake = (out) => ({ messages: { create: async (p) => { sent = p; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }] }; } } });
    const base = { name: "Fourways Submission Only", start_date: "2027-01-23", end_date: "", venue: "Fourways Grappling Club", city: "Johannesburg", organiser: "Fourways GC", register_by: "2027-01-16", fee: "R400", style: "nogi", divisions: ["Adult -77kg"], details: "Submission only.", date_quote: "Saturday 23rd January 2027" };
    r = await im.importEvent(site.url + "/events/text-only", { client: fake(base) });
    ok(r.method === "claude" && r.event.divisions[0] === "Adult -77kg" && r.event.fee === "R400" && r.dateChecked, "Claude read fills divisions and details");
    ok(sent.model === "claude-haiku-5-5" && sent.output_config.format.type === "json_schema" && /untrusted/.test(sent.system), "event read uses structured output, fallbacks and an untrusted-text warning");
    r = await im.importEvent(site.url + "/events/text-only", { client: fake({ ...base, start_date: "2027-02-14", register_by: "2027-02-01" }) });
    ok(r.event.startsOn === "2027-01-23" && r.event.registerBy === "2027-01-16" && !r.dateChecked, "a date Claude gives that isn't on the page is replaced with the one that is");
    ok(await im.importEvent("http://10.0.0.1/x").then(() => false, (e) => /public website/.test(e.message)), "private addresses are refused");
  } catch (e) { fail++; fails.push("CRASH import " + (e.stack || e)); }

  // ---- API
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9300 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, JF_IMPORT_ALLOW_LOOPBACK: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url }; delete env.ANTHROPIC_API_KEY;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  try {
    const coach = client(base), ana = client(base), ben = client(base), other = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "Comp Gym", name: "Coach Kim", email: "kim@comp.test", password: "coachpass1" }); const code = r.j.me.gym.studentCode;
    r = await ana("POST", "/auth/register", { code, name: "Ana Lima", email: "ana@comp.test", password: "anapass11" }); const anaId = r.j.me.id;
    r = await ben("POST", "/auth/register", { code, name: "Ben Cole", email: "ben@comp.test", password: "benpass11" }); const benId = r.j.me.id;
    await other("POST", "/auth/start-gym", { gym: "Other", name: "Other", email: "o@comp.test", password: "otherpass1" });
    r = await ana("POST", "/coach/competitions/import", { url: site.url + "/events/gauteng-open" }); ok(r.s === 403, "students can't import competitions");
    r = await coach("POST", "/coach/competitions/import", { url: site.url + "/events/gauteng-open" });
    ok(r.s === 200 && r.j.event.startsOn === "2026-12-12" && r.j.method === "basic", "coach reads an event page through the API");
    const ev = { ...r.j.event, divisions: ["Adult blue belt -76kg", "Masters 1 blue belt"] };
    r = await coach("POST", "/coach/competitions", ev); const cid = r.j.competition.id;
    ok(r.s === 201 && r.j.competition.name === "Gauteng Open No-Gi 2026" && r.j.competition.divisions.length === 2, "coach saves the competition");
    r = await coach("POST", "/coach/competitions", { name: "x" }); ok(r.s === 400 && /date/.test(r.j.error), "a competition needs a date");
    r = await ana("GET", "/competitions"); let c = r.j.competitions.find((x) => x.id === cid);
    ok(c && c.mine === null && c.entered === 0 && c.team.length === 0, "students see the competition");
    r = await other("GET", "/competitions"); ok(!r.j.competitions.length, "other gyms don't");
    const m0 = sink.mails.length;
    r = await ana("POST", `/competitions/${cid}/request`, { division: "Adult blue belt -76kg", weight: "74", note: "First comp" });
    await wait(300);
    ok(r.s === 200 && sink.mails.slice(m0).some((m) => m.to[0] === "kim@comp.test" && /Ana Lima wants to compete/.test(m.subject) && m.reply_to === "ana@comp.test"), "a student asks to enter; the coach gets an email (reply goes to the student)");
    r = await ana("POST", `/competitions/${cid}/request`, { division: "Adult blue belt -76kg", weight: "73.5", note: "First comp" }); await wait(200);
    ok(sink.mails.length - m0 === 1, "asking again updates the request without another email");
    r = await coach("GET", "/competitions"); c = r.j.competitions.find((x) => x.id === cid);
    ok(c.requested === 1 && c.team[0].name === "Ana Lima" && c.team[0].note === "First comp" && c.team[0].weight === "73.5", "coach sees the request with division, weight and note");
    r = await ben("GET", "/competitions"); ok(!r.j.competitions.find((x) => x.id === cid).team.length, "other students don't see requests, only the team");
    const m1 = sink.mails.length;
    r = await coach("PUT", `/coach/competitions/${cid}/competitors/${anaId}`, { status: "entered", coachNote: "Weigh-in 7am" }); await wait(300);
    ok(r.j.status === "entered" && sink.mails.slice(m1).some((m) => m.to[0] === "ana@comp.test" && /on the team/.test(m.subject) && /Weigh-in 7am/.test(m.text)), "coach enters her; she's emailed with the coach's note");
    r = await ben("GET", "/competitions"); c = r.j.competitions.find((x) => x.id === cid);
    ok(c.entered === 1 && c.team[0].name === "Ana L." && c.team[0].belt && c.team[0].note === undefined, "teammates see who's entered (first name, initial, belt) but not private notes");
    r = await ana("POST", `/competitions/${cid}/request`, {}); ok(r.s === 409, "can't re-request once entered");
    r = await coach("PUT", `/coach/competitions/${cid}/competitors/${benId}`, { status: "entered", division: "Masters 1 blue belt", paid: true });
    r = await coach("GET", "/competitions"); c = r.j.competitions.find((x) => x.id === cid);
    ok(c.entered === 2 && c.team.find((x) => x.name === "Ben Cole").paid === true, "coach adds a student directly and marks the fee paid");
    r = await ben("DELETE", `/competitions/${cid}/request`); ok(r.j.status === "withdrawn", "a student can withdraw");
    r = await coach("GET", "/competitions"); ok(r.j.competitions.find((x) => x.id === cid).entered === 1, "the team count drops");
    r = await coach("PUT", `/coach/competitions/${cid}/competitors/${anaId}`, { result: "gold" }); r = await ana("GET", "/competitions");
    ok(r.j.competitions.find((x) => x.id === cid).mine.result === "gold", "coach records a result the student can see");
    r = await coach("PUT", `/coach/competitions/${cid}/competitors/${anaId}`, { result: "platinum" }); ok(r.s === 400, "results are from a fixed list");
    r = await other("PUT", `/coach/competitions/${cid}/competitors/${anaId}`, { status: "entered" }); ok(r.s === 404, "other gyms' coaches can't touch the team");
    r = await coach("PUT", `/coach/competitions/${cid}`, { ...ev, name: "Gauteng Open 2026" }); ok(r.j.competition.name === "Gauteng Open 2026", "coach edits the competition");
    r = await coach("POST", "/coach/competitions", { name: "Last month's", startsOn: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10) }); const old = r.j.competition.id;
    r = await ana("POST", `/competitions/${old}/request`, {}); ok(r.s === 400 && /over/.test(r.j.error), "can't ask to enter a competition that's over");
    r = await coach("DELETE", `/coach/competitions/${cid}`); r = await ana("GET", "/competitions"); ok(!r.j.competitions.find((x) => x.id === cid), "coach deletes a competition (team list goes with it)");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); site.close(); sink.close(); await pool.end();
  console.log(`comps: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
