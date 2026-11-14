// Security hardening: each test is an attack from the audit, shown to fail now. Against a real PostgreSQL, with Resend,
// PayFast and Claude stood in for by local servers (nothing external is contacted).
// Usage: DATABASE_URL=postgres://.../<something>test node tests/hardening.js   (wipes that database)
"use strict";
const { spawn } = require("child_process"); const path = require("path"); const http = require("http"); const crypto = require("crypto"); const { Pool } = require("pg");
const { startMailSink, startGymSite } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const enc = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+");
const itn = (fields, pass) => { const s = Object.entries(fields).map(([k, v]) => `${k}=${enc(v)}`).join("&"); return s + "&signature=" + md5(s + (pass ? `&passphrase=${enc(pass)}` : "")); };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n) => Buffer.concat([PNG, crypto.randomBytes(n)]).toString("base64");
const pdf = (n, pages = 1) => Buffer.concat([Buffer.from("%PDF-1.4\n" + Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join("")), crypto.randomBytes(n)]).toString("base64");

function client(base, extra = {}) {
  let cookie = "";
  const c = async (method, url, body, headers = {}) => {
    const h = { ...extra, ...headers }; if (cookie && !h.cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { s: r.status, j, t, h: r.headers };
  };
  c.cookie = () => cookie.replace(/^jf_s=/, "");
  return c;
}
function listen(handler) { const s = http.createServer(handler); return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s))); }
// A site built to hurt the importer (the audit's attacker.js), served on this machine.
async function attackerSite() {
  const pages = {
    "/comment": "<html><title>Comment Gym</title>" + "<!--".repeat(60000),
    "/css": `<html><head><title>Css Gym</title><link rel="stylesheet" href="/s.css"></head><body>hi</body></html>`,
    "/aopen": "<html><title>Link Gym</title>" + "<a x>".repeat(60000),
    "/table": "<html><title>Table Gym</title>" + "<table>".repeat(60000),
    "/script": "<html><title>Script Gym</title>" + "<script>".repeat(60000),
    "/tr": "<html><title>Row Gym</title><table><tr>" + "<td>".repeat(60000) + "</table>",
    "/hang": "<html><title>Hang Gym</title></html>",
  };
  return listen((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/s.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end("a".repeat(120000) + "{"); }
    // a byte every 300 ms, for ever: an idle timeout never fires
    if (u.pathname === "/slow") { res.writeHead(200, { "content-type": "text/html" }); const t = setInterval(() => { if (res.destroyed) return clearInterval(t); res.write(" "); }, 300); req.on("close", () => clearInterval(t)); return; }
    if (pages[u.pathname]) { res.writeHead(200, { "content-type": "text/html" }); return res.end(pages[u.pathname]); }
    res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not found</h1>");
  });
}
// Claude, stood in for: every structured read gets a proof-of-payment answer. Records what it was sent.
async function claudeMock() {
  const reqs = [];
  const s = await listen((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} reqs.push(j);
    const text = JSON.stringify({ is_payment: true, amount: "650.00", currency: "ZAR", date: "2026-11-01", reference: "JFAAAAA", payer: "X", bank: "FNB", amount_quote: "R650" });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model: "stand-in", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  return { url: `http://127.0.0.1:${s.address().port}`, reqs, close: () => s.close() };
}
const healthMs = async (root) => { const t = Date.now(); await new Promise((ok) => http.get(root + "/healthz", { agent: false }, (r) => { r.resume(); r.on("end", ok); }).on("error", ok)); return Date.now() - t; };

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public");
  const sink = await startMailSink(), atk = await attackerSite(), site = await startGymSite(), claude = await claudeMock();
  const ATK = `http://127.0.0.1:${atk.address().port}`;
  const pf = await listen((req, res) => { req.resume(); req.on("end", () => res.end("VALID")); });
  const servers = [];
  const start = async (extra = {}) => {
    const port = 9100 + Math.floor(Math.random() * 800), logs = [];
    const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), TRUST_PROXY: "0", APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0", JF_IMPORT_ALLOW_LOOPBACK: "1",
      RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, JF_ADMIN_EMAILS: "boss@jitsflow.test", PAYFAST_VALIDATE_URL: `http://127.0.0.1:${pf.address().port}/eng/query/validate`,
      PAYFAST_API_URL: `http://127.0.0.1:${pf.address().port}`, ...extra };
    for (const k of ["PAYFAST_AUTOPAY_TEST"]) if (!(k in extra)) delete env[k];
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "PAYFAST_MERCHANT_ID", "JF_SECRET", "JF_SECRET_OLD", "NODE_ENV", "GA_ID"]) if (!(k in extra)) delete env[k];
    for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
    const p = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => logs.push(String(d))); p.stderr.on("data", (d) => logs.push(String(d)));
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
    const S = { port, root: `http://127.0.0.1:${port}`, base: `http://127.0.0.1:${port}/api`, logs, stop: () => new Promise((r) => { p.on("exit", r); p.kill(); }) };
    servers.push(S); await wait(300); return S;
  };
  // Admins and coaches who email on a gym's behalf confirm their address first (see tests/security.js); here it's done directly.
  const verifyEmail = (email) => pool.query("update users set email_verified_at=now(), email_verified_for=email where lower(email)=lower($1)", [email]);
  const gymOn = async (S, k) => { const c = client(S.base), r = await c("POST", "/auth/start-gym", { gym: `${k} BJJ`, name: `Coach ${k}`, email: `coach-${k.toLowerCase()}@hard.test`, password: "coachpass1", timezone: "Africa/Johannesburg" });
    if (r.s !== 201) throw new Error("start-gym " + r.s + " " + r.t); c.gym = r.j.me.gym; await verifyEmail(`coach-${k.toLowerCase()}@hard.test`); return c; };
  const studentOf = async (S, coach, k) => { const c = client(S.base), r = await c("POST", "/auth/register", { code: coach.gym.studentCode, name: `${k} Student`, email: `${k.toLowerCase()}@hard.test`, password: "studentpass1" });
    if (r.s !== 201) throw new Error("register " + r.s + " " + r.t); c.id = r.j.me.id; return c; };
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => (m.to || [])[0] === addr);

  try {
    /* ---------------- 1. ReDoS: payloads that froze the server parse in a blink ---------------- */
    const im = require("../backend/importer"), brand = require("../backend/brand"), outreach = require("../backend/outreach");
    const N = 60000, slow = [];
    const payloads = { comment: "<!--".repeat(N), aopen: "<a x>".repeat(N), aNoGt: "<a x".repeat(N), table: "<table>".repeat(N), script: "<script>".repeat(N), style: "<style>".repeat(N),
      tr: "<table><tr>" + "<td>".repeat(N) + "</table>", title: "<title>".repeat(N), header: "<header>".repeat(N), lt: "<".repeat(4 * N), img: "<img".repeat(N), iframe: "<iframe ".repeat(N),
      ld: '<script type="application/ld+json">'.repeat(N / 4), quotes: "<script>var x={" + "a:'".repeat(N) + "</script>", word: "a".repeat(4 * N) };
    for (const [k, html] of Object.entries(payloads)) {
      const t = Date.now(); const pg = im.parsePage(html, "https://example.com/"); im.plainRead([pg]); await brand.fromSite(html, "https://example.com/"); const ms = Date.now() - t;
      if (ms > 200) slow.push(`${k} ${ms} ms`);
    }
    ok(!slow.length, "every ReDoS page (60,000 unclosed comments, links, tables, scripts…) is read in under 200 ms: " + slow.join(", "));
    let t0 = Date.now(); brand.tallyCss("a".repeat(120000) + "{", new Map()); brand.tallyCss("/*".repeat(N), new Map()); brand.tallyCss("a{b".repeat(N), new Map());
    ok(Date.now() - t0 < 200, "a stylesheet of 'aaaa…{' (and unclosed comments) is read in under 200 ms: " + (Date.now() - t0));
    t0 = Date.now(); outreach.parseLines("a.".repeat(10000) + "x\n" + "a".repeat(20000)); ok(Date.now() - t0 < 200, "the outreach line parser on 20,000-character lines: " + (Date.now() - t0) + " ms");
    const big = im.parsePage("<html><title>Big</title><body>" + "<p>class</p>".repeat(100000), "https://example.com/");
    ok(big.title === "Big" && big.text.length < 400 * 1024, "pages are read up to 300 KB");
    // The parse still reads ordinary pages as before (tests/importer.js has the full set).
    const pg = im.parsePage(`<html><head><title>X &amp; Y</title><meta property="og:site_name" content="XY"><link rel="icon" href="/i.png" sizes="32x32"></head><body><header><img src="/logo.png" alt="logo"></header>
      <!-- <a href="/hidden">no</a> --><a href="/timetable" title="t">Time<b>table</b></a><script>var a = "<a href='/x'>x</a>";</script><table><tr><th>Day</th><th>Time</th><th>Class</th></tr><tr><td>Mon</td><td>18:00</td><td>BJJ</td></tr></table></body></html>`, "https://example.com/");
    ok(pg.title === "X & Y" && pg.meta["og:site_name"] === "XY" && pg.links.length === 1 && pg.links[0].text === "Time table" && pg.headerImgs.length === 1 && pg.icons[0].size === 32 && /Day: Mon · Time: 18:00 · Class: BJJ/.test(pg.text), "ordinary pages read the same: " + JSON.stringify({ t: pg.title, l: pg.links, text: pg.text }));

    // A worker that gets stuck is stopped, and the server's own thread never notices.
    process.env.JF_IMPORT_ALLOW_LOOPBACK = "1"; process.env.JF_TEST_IMPORT_HANG = "/hang";
    let gap = 0, last = Date.now(); const tick = setInterval(() => { gap = Math.max(gap, Date.now() - last); last = Date.now(); }, 20);
    t0 = Date.now(); const hung = await im.runImport("site", ATK + "/hang", { stallMs: 1500 }).then(() => "finished", (e) => e.message);
    clearInterval(tick); delete process.env.JF_TEST_IMPORT_HANG;
    ok(hung === im.TOO_LONG && Date.now() - t0 < 5000, "an import whose thread is stuck is stopped (" + (Date.now() - t0) + " ms): " + hung);
    ok(gap < 150, "and the main thread kept running all along (longest pause " + gap + " ms)");
    // A site that sends a byte every 300 ms: the idle timeout never fires, the request's own deadline does.
    t0 = Date.now(); const drip = await im.safeGet(ATK + "/slow", { timeoutMs: 1000 }).then(() => "finished", (e) => e.code);
    ok(drip === "ETIMEDOUT" && Date.now() - t0 < 3500, "a slow-drip page is cut off at its deadline (" + (Date.now() - t0) + " ms)");
    const ac = new AbortController(); setTimeout(() => ac.abort(), 400); t0 = Date.now();
    const stopped = await im.importSite(ATK + "/slow", { client: null, signal: ac.signal }).then(() => "finished", (e) => e.message);
    ok(Date.now() - t0 < 1500 && /Couldn't open/.test(stopped), "an import's signal stops its fetches (" + (Date.now() - t0) + " ms)");
    // fec0::/10 and NAT64's local 64:ff9b:1::/48 aren't public
    ok(im.privateIp("fec0::1") && im.privateIp("64:ff9b:1::7f00:1") && im.privateIp("100::1") && !im.privateIp("2606:4700::1111"), "fec0::/10, 64:ff9b:1::/48 and 100::/64 are refused");

    /* ---------------- server A: imports, storage, headers ---------------- */
    let A = await start({ JF_IMPORT_DEADLINE_MS: "4000", JF_PROOF_GYM_DAY: "14", JF_PROOF_GYM_MB: "3", JF_UPLOAD_DAY_MB: "4.5", JF_LOG_MAX: "20" });
    const g1 = await gymOn(A, "Import");
    // 2. The audit's end-to-end ReDoS: import the attacker's pages while timing /healthz.
    const worst = [];
    for (const p of ["/comment", "/css", "/aopen", "/table", "/script", "/tr"]) {
      let r = await g1("POST", "/coach/import/start", { url: ATK + p });
      const times = []; for (let i = 0; i < 8; i++) { times.push(await healthMs(A.root)); await wait(60); }
      let job = null; for (let i = 0; i < 60; i++) { job = (await g1("GET", "/coach/import/job")).j.job; if (job && job.status !== "running") break; await wait(100); }
      worst.push(`${p}: /healthz ${Math.max(...times)} ms, import ${job && job.status}`);
      ok(r.s === 202 && Math.max(...times) < 200 && job && job.status === "done", `importing ${p}: /healthz stays fast and the import finishes: ` + worst[worst.length - 1]);
    }
    // 3. An import that runs past the deadline ends as failed and frees the gym's slot.
    let r = await g1("POST", "/coach/import/start", { url: ATK + "/slow" }); const startedAt = r.j.job.startedAt;
    let job = null; t0 = Date.now(); for (let i = 0; i < 80; i++) { job = (await g1("GET", "/coach/import/job")).j.job; if (job && job.status !== "running") break; await wait(100); }
    ok(job && job.status === "error" && Date.now() - t0 < 6000, "a slow-drip site: the import ends as failed by its deadline (" + (Date.now() - t0) + " ms): " + JSON.stringify(job && job.error));
    r = await g1("POST", "/coach/import/start", { url: site.url }); ok(r.s === 202 && r.j.job.startedAt !== startedAt && r.j.job.status === "running", "and the gym can start a new import straight away");
    for (let i = 0; i < 80; i++) { job = (await g1("GET", "/coach/import/job")).j.job; if (job.status !== "running") break; await wait(150); }
    ok(job.status === "done" && job.result.profile.name === "Fourways Grappling Club" && job.result.profile.timetable.length >= 5, "an ordinary site still imports (in its worker): " + job.status + " " + (job.result && job.result.profile.name));
    r = await g1("POST", "/coach/import", { url: ATK + "/comment" }); ok(r.s === 200 && r.j.profile.name === "Comment Gym", "the import a coach waits for runs in a worker too");

    // 4. Storage: proof uploads
    const g2 = await gymOn(A, "Store"), s1 = await studentOf(A, g2, "Sipho"), s2 = await studentOf(A, g2, "Thandi");
    const up = (c, data, name = "p.png") => c("POST", "/me/pay/proof", { data, name, amountCents: 65000 });
    let okN = 0; for (let i = 0; i < 10; i++) if ((await up(s1, png(3000))).s === 201) okN++;
    r = await up(s1, png(3000)); ok(okN === 10 && r.s === 429, "a member's 11th proof in a day is refused: " + okN + " then " + r.s);
    okN = 0; for (let i = 0; i < 4; i++) if ((await up(s2, png(3000))).s === 201) okN++;
    r = await up(s2, png(3000)); ok(okN === 4 && r.s === 429 && /lot of proofs of payment today/.test(r.j.error), "the gym's 15th proof in a day (all members together) is refused, nicely: " + JSON.stringify(r.j));
    const s3 = await studentOf(A, g2, "Fresh"); r = await up(s3, png(3000)); ok(r.s === 429, "a brand-new account doesn't get a fresh allowance");
    const g3 = await gymOn(A, "Quota"), s4 = await studentOf(A, g3, "Pic");
    r = await up(s4, png(3.2 * 1024 * 1024)); ok(r.s === 413 && /3 MB/.test(r.j.error), "a picture over 3 MB is refused: " + r.s);
    r = await g3("POST", "/coach/payments/proof", { data: pdf(1.4 * 1024 * 1024), name: "a.pdf" }); const first = r.j.payment;
    r = await g3("POST", "/coach/payments/proof", { data: pdf(1.4 * 1024 * 1024), name: "b.pdf" }); ok(r.s === 201, "PDFs up to the gym's space are stored");
    r = await g3("POST", "/coach/payments/proof", { data: pdf(1.4 * 1024 * 1024), name: "c.pdf" }); ok(r.s === 507 && /space for proofs of payment is full/.test(r.j.error), "over the gym's space (3 MB here): refused, nicely: " + r.s + " " + (r.j && r.j.error));
    await pool.query("update payments set status='confirmed', created_at=now() - interval '100 days' where id=$1", [first.id]);
    r = await g3("POST", "/coach/payments/proof", { data: pdf(1.4 * 1024 * 1024), name: "c.pdf" });
    ok(r.s === 201 && !(await pool.query("select 1 from pop_files where payment_id=$1", [first.id])).rows[0] && (await pool.query("select 1 from payments where id=$1", [first.id])).rows[0], "a proof confirmed months ago gives up its file to make room (the payment stays)");
    const g4 = await gymOn(A, "Budget");
    r = await g4("POST", "/coach/payments/proof", { data: pdf(2 * 1024 * 1024), name: "d.pdf" });
    ok(r.s === 503 && /a lot of uploads right now/.test(r.j.error) && A.logs.join("").includes("today's upload budget"), "over the day's upload budget for all gyms (4.5 MB here): refused with a clear message: " + r.s);
    // 5. Training logs: a cap on how many and how much
    const s5 = await studentOf(A, g4, "Logger"), note = "x".repeat(19000);
    let logsOk = 0; for (let i = 0; i < 21; i++) if ((await s5("PUT", `/logs/l${i}`, { data: { date: "2026-11-01", notes: i < 20 ? "ok" : note } })).s === 200) logsOk++;
    r = await s5("PUT", "/logs/l3", { data: { date: "2026-11-02", notes: "edited" } });
    ok(logsOk === 20 && r.s === 200, "the 21st session is refused (20 here, 3,000 by default); editing one already there still works: " + logsOk);
    r = await s5("PUT", "/logs/l99", { data: {} }); ok(r.s === 413 && /training log is full/.test(r.j.error), "with a friendly message");
    // 6. Bulk adds: 10 an hour per gym
    let bulkOk = 0; for (let i = 0; i < 11; i++) if ((await g4("POST", "/coach/students/bulk", { people: [{ name: `Bulk ${i}` }] }, { "x-jf-key": "k" + i })).s === 201) bulkOk++;
    r = await g4("POST", "/coach/students/bulk", { people: [{ name: "One more" }] }, { "x-jf-key": "kk" });
    ok(bulkOk === 10 && r.s === 429, "the 11th bulk add in an hour is refused: " + bulkOk + " then " + r.s);

    // 7. Headers and the security policy
    r = await fetch(A.root + "/"); let html = await r.text(), csp = r.headers.get("content-security-policy") || "";
    const scriptSrc = csp.split(";").find((d) => /script-src/.test(d)) || "";
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/src=|ld\+json/.test(m[1])).map((m) => `'sha256-${crypto.createHash("sha256").update(m[2]).digest("base64")}'`);
    ok(!/unsafe-inline/.test(scriptSrc) && inline.length >= 1 && inline.every((h) => scriptSrc.includes(h)), "script-src has no 'unsafe-inline': the page's own inline scripts are allowed by hash: " + scriptSrc.slice(0, 160));
    ok(/style-src 'self' 'unsafe-inline'/.test(csp) && /object-src 'none'/.test(csp), "inline styles stay allowed; plugins aren't");
    ok(r.headers.get("cross-origin-opener-policy") === "same-origin" && r.headers.get("x-frame-options") === "SAMEORIGIN" && !r.headers.get("strict-transport-security"), "COOP and X-Frame-Options on pages; no HSTS outside production");
    r = await fetch(A.base + "/status"); const st = await r.json();
    ok(r.headers.get("cross-origin-resource-policy") === "same-origin" && Object.keys(st).sort().join() === "ai,build,db,mail", "/api answers can't be embedded by other sites, and /api/status says only what the app needs: " + Object.keys(st));
    // 8. A cookie that isn't valid %-encoding: not a 500 on every call
    r = await fetch(A.base + "/me", { headers: { cookie: "jf_s=%E0%A4%A; theme=%" } }); ok(r.status === 200 && (await r.json()).me === null, "a malformed cookie is ignored (was a 500): " + r.status);
    // 9. Line breaks in an email subject can't add headers
    const s6 = await studentOf(A, g4, "Mailee"); let m0 = sink.mails.length;
    r = await g4("POST", "/coach/message", { subject: "Hello\r\nBcc: victim@evil.test\r\nX: y", text: "Hi", userIds: [s6.id] });
    const sent = sink.mails.slice(m0).find((m) => (m.to || [])[0] === "mailee@hard.test" && /Hello/.test(m.subject));
    ok(r.s === 200 && sent && !/[\r\n]/.test(sent.subject) && sent.subject.startsWith("Hello"), "CR/LF in a subject become spaces: " + JSON.stringify(sent && sent.subject));
    process.env.RESEND_API_KEY = "test-key"; process.env.RESEND_API_URL = sink.url; const mailM = require("../backend/mail"); m0 = sink.mails.length;
    await mailM.sendRaw({ fromName: "Thabo\r\nBcc: x@evil.test", to: "owner@gym.test\r\nBcc: y@evil.test", replyTo: "me@jitsflow.test\nCc: z@evil.test", subject: "Hi\r\nBcc: q@evil.test", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": "<https://x>\r\nBcc: w@evil.test" } });
    const raw = sink.mails[m0];
    ok(raw && !/[\r\n]/.test(raw.from + raw.to[0] + raw.reply_to + raw.subject + raw.headers["List-Unsubscribe"]) && !raw.to[0].includes(","), "sendRaw: no line breaks in from, to, reply-to, subject or extra headers: " + JSON.stringify(raw && [raw.from, raw.to, raw.subject]));
    // 10. Byte ranges: bytes=-N with N bigger than the file is the whole file
    r = await fetch(A.root + "/video/book-a-class.mp4", { headers: { range: "bytes=-999999999" } }); const vbody = Buffer.from(await r.arrayBuffer());
    ok(r.status === 206 && new RegExp(`^bytes 0-${vbody.length - 1}/${vbody.length}$`).test(r.headers.get("content-range") || ""), "Range: bytes=-N past the start serves the whole video (was 416): " + r.status + " " + r.headers.get("content-range"));
    // 11. No security-policy violations on the site's pages and the app's screens (inline scripts all run by hash or nonce).
    {
      const { chromium, devices } = require("playwright"); const b = await chromium.launch();
      const tok = outreach.newToken(); await pool.query("insert into prospects(token,website,domain,name,profile,import_state) values($1,'https://preview.test','preview.test','Preview BJJ',$2,'done')",
        [tok, { name: "Preview BJJ", timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "No-Gi" }], coaches: [], rates: [] }]);
      const seen = [], visit = async (ctx, url, act) => { const p = await ctx.newPage(), v = [], errs = [];
        p.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) v.push(m.text().slice(0, 160)); }); p.on("pageerror", (e) => errs.push(e.message));
        await p.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); });
        await p.goto(A.root + url); await p.waitForTimeout(700); if (act) await act(p);
        const got = await p.evaluate(() => window.__csp || []).catch(() => []); seen.push(url); await p.close(); return [...got, ...v, ...errs.map((e) => "error: " + e)]; };
      const ctx = await b.newContext({ ...devices["iPhone 13"] }); const bad = [];
      for (const u of ["/", "/coaches/", "/techniques/", "/techniques/americana/", "/positions/back-control/", "/belts/blue/", "/glossary/", "/privacy/", "/no-such-page", "/app/", `/try/${tok}`]) { const v = await visit(ctx, u); if (v.length) bad.push(u + ": " + v.join(", ")); }
      // the app signed in, as a head coach and as a member: every tab
      const tabs = async (p) => { const n = await p.evaluate(() => document.querySelectorAll("nav.tabs [data-v]").length); for (let i = 0; i < n; i++) { await p.evaluate((k) => document.querySelectorAll("nav.tabs [data-v]")[k].click(), i); await p.waitForTimeout(500); } return n; };
      let nTabs = 0;
      for (const who of [g2, s1]) { const c2 = await b.newContext({ ...devices["iPhone 13"] }); await c2.addCookies([{ name: "jf_s", value: who.cookie(), url: A.root }]);
        const v = await visit(c2, "/app/", async (p) => { nTabs += await tabs(p); }); if (v.length) bad.push("app: " + v.join(", ")); await c2.close(); }
      ok(!bad.length && nTabs >= 6, `no security-policy violations or script errors on ${seen.length} pages and ${nTabs} app tabs: ` + bad.join(" | "));
      await b.close();
    }
    await A.stop();

    /* ---------------- server B: the AI budget ---------------- */
    const B = await start({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: claude.url, JF_AI_DAY_CALLS: "4", JF_AI_NEW_GYM_DAY_CALLS: "3" });
    const g6 = await gymOn(B, "Ai"), s7 = await studentOf(B, g6, "Ayo");
    let n0 = claude.reqs.length;
    for (let i = 0; i < 4; i++) { await s7("POST", "/me/pay/proof", { data: png(3000), name: "p.png", amountCents: 65000 }); await wait(400); }
    await wait(800);
    let pays = (await g6("GET", "/coach/payments")).j.payments;
    ok(claude.reqs.length - n0 === 3, "a gym under a week old gets 3 AI reads a day here (40 by default): " + (claude.reqs.length - n0));
    ok(pays.length === 4 && pays.filter((p) => p.read && /your gym has used today's reading/.test(p.read.error || "")).length === 1, "the 4th proof is still stored, for the coach to check by hand: " + JSON.stringify(pays.map((p) => p.read && p.read.error)));
    n0 = claude.reqs.length; r = await g6("POST", "/coach/import", { url: site.url });
    ok(r.s === 200 && r.j.method === "basic" && /your gym has used today's reading/.test(r.j.aiError || "") && claude.reqs.length === n0, "a website import over the gym's budget: the worker asks this thread, is told no, and does the plain read: " + JSON.stringify([r.j.method, r.j.aiError]));
    r = await g6("POST", "/coach/students/read-people", { images: [png(3000)] }); ok(r.s === 503 && /paused for today/.test(r.j.error), "reading screenshots over budget: a clear 503");
    const g7 = await gymOn(B, "Pdf");
    n0 = claude.reqs.length; r = await g7("POST", "/coach/payments/proof", { data: pdf(5000, 5), name: "statement.pdf" });
    ok(r.s === 201 && claude.reqs.length === n0 && /Too long to read automatically/.test(r.j.payment.read.error || ""), "a PDF of more than 3 pages isn't sent to Claude (kept for the coach): " + JSON.stringify(r.j.payment.read));
    r = await g7("POST", "/coach/payments/proof", { data: pdf(2.2 * 1024 * 1024, 1), name: "huge.pdf" }); ok(r.s === 201 && claude.reqs.length === n0, "nor one over 2 MB");
    r = await g7("POST", "/coach/payments/proof", { data: png(3000), name: "a.png" }); ok(r.s === 201 && claude.reqs.length === n0 + 1 && r.j.payment.read.amountCents === 65000, "the 4th read of the day overall is the last one (4 here)");
    r = await g7("POST", "/coach/payments/proof", { data: png(3000), name: "b.png" });
    ok(r.s === 201 && claude.reqs.length === n0 + 1 && /today's limit for reading with AI/.test(r.j.payment.read.error || ""), "then every AI feature stops for the day (circuit breaker); the proof is kept: " + JSON.stringify(r.j.payment.read));
    ok(B.logs.join("").includes("AI budget: today's limit"), "and the server log says so once");
    const usage = (await pool.query("select scope, calls from ai_usage order by scope")).rows;
    ok(usage.find((u) => u.scope === "all").calls === 4, "use is counted in the database (shared by every server): " + JSON.stringify(usage));
    const admin = client(B.base); await admin("POST", "/auth/register", { name: "Boss", email: "boss@jitsflow.test", password: "bosspass12" }); await verifyEmail("boss@jitsflow.test");
    r = await admin("GET", "/admin/overview"); ok(r.s === 200 && r.j.system && r.j.system.ai.paused === true && r.j.system.ai.calls === 4 && r.j.system.secretOk === false, "the team's dashboard shows AI paused, today's use, and that JF_SECRET isn't set: " + JSON.stringify(r.j.system));
    await B.stop();

    /* ---------------- PayFast secrets: JF_SECRET, rotation, the legacy key, failures surfaced ---------------- */
    const pfm = require("../backend/payfast"), keep = { ...process.env };
    process.env.DATABASE_URL = DB; delete process.env.JF_SECRET; delete process.env.JF_SECRET_OLD;
    const legacy = (txt) => { const k = crypto.createHash("sha256").update("jf-payfast:" + DB).digest(), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv);
      const o = Buffer.concat([c.update(txt, "utf8"), c.final()]); return [iv, c.getAuthTag(), o].map((b) => b.toString("base64")).join("."); };
    const lv = legacy("legacy-pass");
    process.env.JF_SECRET = "first secret"; let u1 = pfm.unseal(lv);
    ok(u1.ok && u1.text === "legacy-pass" && u1.stale, "a value sealed before JF_SECRET (the DATABASE_URL key) is still read, and marked to seal again");
    const v1 = pfm.reseal(lv); ok(/^v2\.[0-9a-f]{8}\./.test(v1) && pfm.unseal(v1).text === "legacy-pass" && !pfm.unseal(v1).stale, "sealed again with JF_SECRET, with a key id: " + v1.slice(0, 14));
    process.env.JF_SECRET = "second secret"; ok(!pfm.unseal(v1).ok && pfm.unseal(v1).text === "", "a new JF_SECRET alone can't read it (no silent garbage)");
    process.env.JF_SECRET_OLD = "first secret"; const u2 = pfm.unseal(v1); const v2 = pfm.reseal(v1);
    ok(u2.ok && u2.stale && u2.text === "legacy-pass" && v2 && v2.split(".")[1] !== v1.split(".")[1] && pfm.unseal(v2).text === "legacy-pass", "with the old one in JF_SECRET_OLD it's read and sealed again with the new key (rotation)");
    Object.assign(process.env, keep); for (const k of ["JF_SECRET", "JF_SECRET_OLD"]) if (!(k in keep)) delete process.env[k];

    const C1 = await start({ JF_SECRET: "secret one" });
    const g8 = await gymOn(C1, "Keys"), s8 = await studentOf(C1, g8, "Kim");
    r = await g8("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "gym pass phrase" });
    let row = (await pool.query("select payfast from gyms where id=$1", [g8.gym.id])).rows[0].payfast;
    ok(r.s === 200 && /^v2\.[0-9a-f]{8}\./.test(row.key) && /^v2\./.test(row.pass), "gyms' PayFast keys are sealed with JF_SECRET and a key id");
    // A legacy-sealed gym and saved card (from before JF_SECRET): sealed again when the server starts
    const gl = (await pool.query("insert into gyms(name, student_code, coach_code, payfast) values('Legacy BJJ','LEGACYS1','LEGACYC1',$1) returning id", [{ merchantId: "10000105", key: legacy("abcdefghijk12"), pass: legacy("old pass") }])).rows[0].id;
    await pool.query("insert into autopay(user_id,gym_id,payer_id,token,token_hash,merchant_id,from_month) values($1,$2,$1,$3,'h','10000105','2026-11')", [s8.id, g8.gym.id, legacy("tok-legacy")]);
    await C1.stop();
    // JF_SECRET changed without JF_SECRET_OLD: the keys can't be read. Surfaced, not silently dropped.
    m0 = sink.mails.length;
    const C2 = await start({ JF_SECRET: "secret two" });
    const boss = client(C2.base); await boss("POST", "/auth/login", { email: "boss@jitsflow.test", password: "bosspass12" });
    const g8b = client(C2.base); await g8b("POST", "/auth/login", { email: "coach-keys@hard.test", password: "coachpass1" });
    r = await g8b("GET", "/coach/payfast"); ok(r.j.payfast.connected === false && r.j.payfast.needsReconnect === true, "the head coach sees 'PayFast needs reconnecting': " + JSON.stringify(r.j.payfast));
    const s8b = client(C2.base); await s8b("POST", "/auth/login", { email: "kim@hard.test", password: "studentpass1" });
    r = await s8b("POST", "/me/pay/payfast", { amountCents: 50000 }); ok(r.s === 400, "students can't start a card payment that couldn't be checked");
    await fetch(C2.base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.2.3.4" }, body: itn({ m_payment_id: `pay-${s8.id}-1`, pf_payment_id: "777", payment_status: "COMPLETE", item_name: "fees", amount_gross: "500.00",
      custom_str1: "pay", custom_int1: String(s8.id), custom_int2: String(g8.gym.id), custom_int3: "", merchant_id: "10000105" }, "gym pass phrase") });
    await wait(1200);
    ok(to("coach-keys@hard.test", m0).filter((m) => m.subject === "Connect PayFast again").length === 1 && to("boss@jitsflow.test", m0).some((m) => /PayFast keys can't be read for Keys BJJ/.test(m.subject) && /PayFast 777/.test(m.text)),
      "a payment notification that can't be checked: the head coach and the admins are emailed (not dropped silently)");
    ok(C2.logs.join("").includes("can't be decrypted"), "and the server log says so");
    r = await boss("GET", "/admin/overview"); ok(r.j.system.payfastBroken.some((g) => g.name === "Keys BJJ"), "the team's dashboard lists the gym: " + JSON.stringify(r.j.system.payfastBroken));
    await C2.stop();
    // The old secret in JF_SECRET_OLD: everything reads again and is sealed with the new key at startup.
    const C3 = await start({ JF_SECRET: "secret three", JF_SECRET_OLD: "secret two, secret one" }); await wait(800);
    process.env.DATABASE_URL = DB; process.env.JF_SECRET = "secret three"; delete process.env.JF_SECRET_OLD;
    row = (await pool.query("select payfast from gyms where id=$1", [g8.gym.id])).rows[0].payfast;
    const lg = (await pool.query("select payfast from gyms where id=$1", [gl])).rows[0].payfast, tokRow = (await pool.query("select token from autopay where user_id=$1", [s8.id])).rows[0];
    ok(pfm.unseal(row.key).text === "abcdefghijk12" && !pfm.unseal(row.key).stale && !row.brokenAt, "with JF_SECRET_OLD set, the gym's keys are sealed again with the new JF_SECRET at startup, and no longer marked broken");
    ok(pfm.unseal(lg.pass).text === "old pass" && !pfm.unseal(lg.pass).stale && pfm.unseal(tokRow.token).text === "tok-legacy" && /^v2\./.test(tokRow.token), "legacy values (DATABASE_URL key) and saved-card tokens are sealed with JF_SECRET too");
    Object.assign(process.env, keep); for (const k of ["JF_SECRET", "JF_SECRET_OLD"]) if (!(k in keep)) delete process.env[k];
    const g8c = client(C3.base); await g8c("POST", "/auth/login", { email: "coach-keys@hard.test", password: "coachpass1" });
    r = await g8c("GET", "/coach/payfast"); ok(r.j.payfast.connected === true && !r.j.payfast.needsReconnect, "the gym takes card payments again");
    // The notification's source address is the real one, not a header anyone can set.
    await fetch(C3.base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "1.2.3.4" }, body: itn({ m_payment_id: `pay-${s8.id}-2`, pf_payment_id: "778", payment_status: "COMPLETE", item_name: "fees", amount_gross: "500.00",
      custom_str1: "pay", custom_int1: String(s8.id), custom_int2: String(g8.gym.id), custom_int3: "", merchant_id: "10000105" }, "gym pass phrase") });
    await wait(1200);
    const itnLog = C3.logs.join("").split("\n").filter((l) => /payfast itn/.test(l)).join(" | ");
    ok(!/1\.2\.3\.4/.test(itnLog) && (await pool.query("select 1 from payments where reference='PayFast 778'")).rows[0], "a spoofed cf-connecting-ip isn't taken as PayFast's address; the genuine notification is recorded: " + itnLog);
    await C3.stop();

    /* ---------------- production: HSTS, and loud warnings for missing settings ---------------- */
    const P = await start({ NODE_ENV: "production" });
    r = await fetch(P.root + "/coaches/");
    ok(r.headers.get("strict-transport-security") === "max-age=31536000; includeSubDomains", "HSTS in production");
    ok(/WARNING: JF_SECRET isn't set/.test(P.logs.join("")) && /WARNING: PAYFAST_MERCHANT_ID isn't set/.test(P.logs.join("")), "production without JF_SECRET or PAYFAST_MERCHANT_ID: it still runs, and says so loudly");
    const pb = client(P.base); await pb("POST", "/auth/login", { email: "boss@jitsflow.test", password: "bosspass12" });
    r = await pb("GET", "/admin/overview"); ok(r.s === 200 && r.j.system.cardsTestMode === true && r.j.system.production === true && r.j.system.secretOk === false, "the dashboard tells the team: card payments in test mode, JF_SECRET not set");
    await P.stop();
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { for (const s of servers) await Promise.race([s.stop(), wait(2000)]); await pool.end(); sink.close(); atk.close(); site.close(); claude.close(); pf.close(); }
  console.log(`hardening: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
