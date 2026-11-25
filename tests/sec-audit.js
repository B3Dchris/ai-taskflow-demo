// Findings from the November 2026 security audit, each with the check that would have caught it.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/sec-audit.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const pop = require("../backend/pop");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
function client(base) {
  let cookie = "";
  return async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
}

(async () => {
  // ---------- 1. ReDoS: the proof-of-payment reader runs on emails sent to a public address ----------
  {
    const hostile = {
      "ref + 20,000 newlines": "ref" + "\n".repeat(20000) + "x",
      "reference + 19,000 spaces": "reference " + " ".repeat(19000) + "x",
      "ref no. + tabs, many lines": ("reference number " + " \t".repeat(80) + "\n").repeat(250),
      "R + 20,000 digits": "R" + "1".repeat(20000),
      "dates over and over": "2026-11-0".repeat(2500),
    };
    for (const [name, text] of Object.entries(hostile)) { const ms = timed(() => pop.plainRead(text)); ok(ms < 50, `the plain proof reader stays fast on hostile input (${name}): ${ms.toFixed(1)} ms`); }
    const r = pop.plainRead("Payment notification\nR650.00 paid to Ubuntu BJJ\nRef: JF7KQ3M\nDate 2026-11-03");
    ok(r.amountCents === 65000 && r.reference === "JF7KQ3M" && r.date === "2026-11-03", "it still reads a normal bank notification: " + JSON.stringify(r));
    const r2 = pop.plainRead("Beneficiary reference no. ABC 123\nAmount: R 1,250.00");
    ok(r2.amountCents === 125000 && r2.reference === "ABC 123", "and a beneficiary reference with a thousands separator: " + JSON.stringify(r2));
  }

  // ---------- with the server ----------
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public;");
  const port = 9500 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api";
  const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0" };
  delete env.ANTHROPIC_API_KEY; delete env.RESEND_API_KEY; delete env.PAYSTACK_SECRET_KEY;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + "/healthz"); break; } catch (e) { await wait(150); } }
  try {
    const coach = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "Audit BJJ", name: "Coach A", email: "coach@audit.test", password: "coachpass123", timezone: "Africa/Johannesburg" });
    const code = r.j.me.gym.studentCode;

    // ---------- 2. An invite (claim) link works once, even when two people send it at the same moment ----------
    for (let round = 0; round < 3; round++) {
      const st = (await coach("POST", "/coach/students", { name: "Invitee " + round, phone: "08255512" + (30 + round) })).j, sid = st.student ? st.student.id : st.id;
      const link = (await coach("POST", `/coach/students/${sid}/claim-link`)).j.url, claim = new URL(link).searchParams.get("claim");
      const A = client(base), B = client(base);
      const [ra, rb] = await Promise.all([A("POST", "/auth/register", { code, claim, name: "Alice", email: `alice${round}@audit.test`, password: "alicepass123" }),
        B("POST", "/auth/register", { code, claim, name: "Mallory", email: `mallory${round}@audit.test`, password: "mallorypass1" })]);
      const codes = [ra.s, rb.s].sort().join(","), row = (await pool.query("select email from users where id=$1", [sid])).rows[0];
      const winner = ra.s === 201 ? `alice${round}@audit.test` : `mallory${round}@audit.test`;
      ok(codes === "201,409" && row.email === winner, `round ${round}: one invite link, two sign-ups at once: exactly one gets the account (${codes}, record is ${row.email})`);
      const loser = ra.s === 201 ? B : A, me = await loser("GET", "/me");
      ok(me.s === 401 || !me.j.me || String(me.j.me.id) !== String(sid), `round ${round}: the one who lost isn't signed in to that account`);
    }
    //@@MORE@@
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { srv.kill(); await pool.end(); }
  console.log(`sec-audit: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
