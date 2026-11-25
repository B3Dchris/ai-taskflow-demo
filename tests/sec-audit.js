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

  //@@SERVER@@
  console.log(`sec-audit: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
