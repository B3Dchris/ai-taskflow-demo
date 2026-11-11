// Families against a real PostgreSQL: one parent login with several kids, and family money (one reminder, one payment split between kids).
// Usage: DATABASE_URL=postgres://.../<something>test node tests/families.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
let ipN = 10;
function client(base) {
  let cookie = ""; const ip = `198.51.100.${ipN++}`;
  const c = async (method, url, body, headers = {}) => {
    const h = { "x-forwarded-for": ip, ...headers }; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  return c;
}
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mAdd = (m, n) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  let pfValid = "VALID"; const pfSrv = require("http").createServer((q, r) => { q.on("data", () => {}); q.on("end", () => r.end(pfValid)); }).listen(0);
  const port = 9300 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test",
    PAYFAST_VALIDATE_URL: `http://127.0.0.1:${pfSrv.address().port}/eng/query/validate`, PAYFAST_SANDBOX: "" }; delete env.ANTHROPIC_API_KEY;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  // The scheduled reminder job, run here the way server.js runs it (two "servers" at once, to show a family is emailed once).
  Object.assign(process.env, { RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0" });
  const { makeApi } = require("../backend/api"), pool2 = new Pool({ connectionString: DB });
  const jobsA = makeApi(pool, {}).jobs, jobsB = makeApi(pool2, {}).jobs;
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => m.to[0] === addr);
  try {
    const hc = client(base);
    let r = await hc("POST", "/auth/start-gym", { gym: "Family BJJ", name: "Head Coach", email: "head@fam.test", password: "headpass11", timezone: "Africa/Johannesburg" });
    const g = r.j.me.gym, code = g.studentCode;
    const plan = (await hc("POST", "/coach/plans", { name: "Kids", priceCents: 50000, period: "month" })).j.plan.id;
    const today = (await hc("GET", "/coach/roster")).j.today, M0 = today.slice(0, 7), N1 = mAdd(M0, 1);
    const addKid = async (name, phone, parentName = "Thandi") => { const id = (await hc("POST", "/coach/students", { name, parentName, phone })).j.id; await hc("PATCH", `/coach/students/${id}`, { planId: plan }); return id; };
    const roster = async () => Object.fromEntries((await hc("GET", "/coach/roster")).j.people.map((p) => [p.id, p]));
    const money = async (m) => Object.fromEntries((await hc("GET", "/coach/money" + (m ? `?month=${m}` : ""))).j.students.map((s) => [s.id, s]));

    // ---- 1. One parent login, several kids: the number matches two kids, so the parent is asked once which of them train here.
    const lerato = await addKid("Lerato Dlamini", "082 555 1234"), sipho = await addKid("Sipho Dlamini", "082 555 1234");
    const mom = client(base), body = { code, name: "Thandi Dlamini", email: "thandi@fam.test", password: "thandipass1", phone: "082 555 1234" };
    r = await mom("POST", "/auth/register", body);
    ok(r.s === 200 && r.j.ask && !r.j.ask.id && r.j.ask.kids.map((k) => k.id).join() === [lerato, sipho].join(), "a number that matches two kids asks once: 'Which of your kids train here?' " + JSON.stringify(r.j));
    r = await mom("POST", "/auth/register", { ...body, kids: [lerato, sipho] });
    ok(r.s === 201 && r.j.me.id === lerato && r.j.me.family && r.j.me.family.map((f) => f.id).join() === [lerato, sipho].join(), "ticking both puts them on one login: " + JSON.stringify(r.j.me && r.j.me.family));
    ok(r.j.me.account && r.j.me.account.name === "Thandi Dlamini" && r.j.me.account.email === "thandi@fam.test", "the account is the parent's (their name and email)");
    let ro = await roster();
    ok(ro[lerato].name === "Lerato Dlamini" && ro[sipho].name === "Sipho Dlamini" && !ro[lerato].offline && !ro[sipho].offline, "coaches still see two kids, both on the app now, with their own names");
    ok(ro[lerato].parentName === "Thandi Dlamini" && ro[sipho].parentName === "Thandi Dlamini" && ro[sipho].parentAccount === "Lerato Dlamini" && ro[sipho].email === "thandi@fam.test", "with the parent shown, and the parent's email for the kid on her login");
    ok(!Object.values(ro).some((p) => p.name === "Thandi Dlamini"), "and no third, empty account for the parent");
    r = await mom("POST", "/auth/register", { ...body, email: "thandi2@fam.test", kids: [lerato] }); ok(r.s === 409, "a kid already on a login can't be picked again");

    // ---- 2. Booking for: everything is per kid.
    const cls = (await hc("POST", "/classes", { title: "Kids BJJ", startsAt: new Date(Date.now() + 2 * DAY).toISOString(), durationMin: 60 })).j.class.id;
    r = await mom("POST", "/me/as", { id: sipho }); ok(r.s === 200 && r.j.me.id === sipho && r.j.me.name === "Sipho Dlamini" && r.j.me.kid && r.j.me.family.length === 2, "'Booking for: Sipho' switches who the app is for");
    r = await mom("GET", "/me"); ok(r.j.me.id === sipho && r.j.me.email === "thandi@fam.test", "and it stays that way on this phone");
    await mom("PUT", `/classes/${cls}/rsvp`, { going: true });
    await mom("PUT", "/logs/sipho1", { data: { date: today, mins: 60, notes: "Sipho's class" } });
    const pipho = (await mom("GET", "/me/pay")).j.pay;
    r = await hc("GET", `/coach/classes/${cls}`); ok(r.j.attendees.length === 1 && r.j.attendees[0].id === sipho, "a booking is the kid's own");
    r = await mom("POST", "/me/as", { id: lerato }); ok(r.j.me.id === lerato, "back to Lerato");
    r = await mom("GET", "/classes"); ok(!r.j.classes.find((c) => c.id === cls).myGoing, "Lerato isn't booked for Sipho's class");
    r = await mom("GET", "/logs"); ok(!r.j.logs.some((l) => l.id === "sipho1"), "and Sipho's journal isn't hers");
    const plera = (await mom("GET", "/me/pay")).j.pay;
    ok(plera.reference && pipho.reference && plera.reference !== pipho.reference, "each kid keeps their own payment reference");
    r = await mom("POST", "/me/as", { id: String(Number(sipho) + 1000) }); ok(r.s === 404, "can't book for someone who isn't on the login");
    const other = client(base); await other("POST", "/auth/register", { code, name: "Other Parent", email: "other@fam.test", password: "otherpass1" });
    r = await other("POST", "/me/as", { id: sipho }); ok(r.s === 404, "nor for another parent's kid");
    const mom2 = client(base); r = await mom2("POST", "/auth/login", { email: "thandi@fam.test", password: "thandipass1" });
    ok(r.j.me.id === lerato && r.j.me.family.length === 2, "another phone starts on the login itself, with the same kids");

    // ---- 3. A kid's invite link opened while signed in adds that kid with one tap (and books for them).
    const kabelo = await addKid("Kabelo Dlamini", "082 999 0000");
    const tok = new URL((await hc("POST", `/coach/students/${kabelo}/claim-link`)).j.url).searchParams.get("claim");
    r = await mom("POST", "/me/kids", { claim: tok });
    ok(r.s === 201 && r.j.me.id === kabelo && r.j.me.family.length === 3 && r.j.kid.name === "Kabelo Dlamini", "the link adds Kabelo to the parent's login and books for him: " + JSON.stringify(r.j));
    r = await mom("POST", "/me/kids", { claim: tok }); ok(r.s === 404, "the link works once");
    const adult = (await hc("POST", "/coach/students", { name: "Adult Member", phone: "082 111 2222" })).j.id;
    const atok = new URL((await hc("POST", `/coach/students/${adult}/claim-link`)).j.url).searchParams.get("claim");
    r = await mom("POST", "/me/kids", { claim: atok }); ok(r.s === 400 && /own account/.test(r.j.error), "an adult's own link isn't added as a kid");
    ro = await roster(); ok(!ro[kabelo].offline && ro[kabelo].parentName === "Thandi Dlamini", "the coach sees Kabelo on the app, with his parent");
    // A parent adds a kid the coach hasn't: by name, in the gym they're booking at. A name the coach already has is linked, not copied.
    r = await mom("POST", "/me/kids", { name: "Naledi Dlamini" }); const naledi = r.j.kid.id;
    ok(r.s === 201 && r.j.me.id === naledi && r.j.me.family.length === 4, "a parent adds a kid by name");
    ro = await roster(); ok(ro[naledi] && ro[naledi].parentName === "Thandi Dlamini" && !ro[naledi].offline && ro[naledi].phone === "082 555 1234", "the coach sees the new kid with the parent's name and number");
    const zola = await addKid("Zola Dlamini", "082 555 1234", "Mama Zola");
    r = await mom("POST", "/me/kids", { name: "zola  dlamini" }); ro = await roster();
    ok(r.s === 201 && r.j.kid.id === zola && ro[zola].parentAccount === "Lerato Dlamini", "a kid the coach added with the parent's number is linked, not added twice");
    ok(ro[zola].parentName === "Mama Zola", "and the parent's name the coach has for them stays: " + ro[zola].parentName);
    r = await mom("POST", "/me/kids", { name: "Adult Member" }); ro = await roster();
    ok(r.s === 201 && r.j.kid.id !== adult && ro[adult].offline && !ro[adult].parentName && !ro[adult].parentAccount, "an adult's record isn't taken over by typing their name");
    await pool.query("delete from users where id=$1", [r.j.kid.id]); await mom("POST", "/me/as", { id: lerato });
    r = await hc("POST", "/me/kids", { name: "Coach Kid" }); ok(r.s === 400, "coaches add their kids in Members instead");

    // ---- 4. A kid's invite link, signed out, with a brother the coach added with the same number: asked once.
    const ayanda = await addKid("Ayanda Dube", "072 333 4444", "Bongi"), lebo = await addKid("Lebo Dube", "072 333 4444", "Bongi");
    const atok2 = new URL((await hc("POST", `/coach/students/${ayanda}/claim-link`)).j.url).searchParams.get("claim");
    const bongi = client(base), bb = { code, claim: atok2, name: "Bongi Dube", email: "bongi@fam.test", password: "bongipass1" };
    r = await bongi("POST", "/auth/register", bb);
    ok(r.s === 200 && r.j.ask && r.j.ask.claim === ayanda && r.j.ask.kids.map((k) => k.id).join() === [ayanda, lebo].join(), "a kid's link asks about the brother with the same number: " + JSON.stringify(r.j));
    r = await bongi("POST", "/auth/register", { ...bb, kids: [ayanda, lebo] });
    ok(r.s === 201 && r.j.me.id === ayanda && r.j.me.family.map((f) => f.id).join() === [ayanda, lebo].join() && r.j.me.name === "Ayanda Dube", "both go on one login, and the kid keeps their name");
    // A parent who trains too: "Are you Bongani?" and their kid on the same login.
    const bongani = (await hc("POST", "/coach/students", { name: "Bongani Mokoena", phone: "071 222 3333" })).j.id, thabo = await addKid("Thabo Mokoena", "071 222 3333", "Bongani");
    const bm = client(base), bmb = { code, name: "Bongani Mokoena", email: "bongani@fam.test", password: "bonganipass1", phone: "071 222 3333" };
    r = await bm("POST", "/auth/register", bmb);
    ok(r.j.ask && r.j.ask.id === bongani && !r.j.ask.kid && r.j.ask.kids.map((k) => k.id).join() === thabo, "a parent who's a member is asked about themselves and their kid at once");
    r = await bm("POST", "/auth/register", { ...bmb, link: bongani, kids: [thabo] });
    ok(r.s === 201 && r.j.me.id === bongani && !r.j.me.kid && r.j.me.family.map((f) => f.id).join() === [bongani, thabo].join() && r.j.me.account.name === "Bongani Mokoena", "the parent's own record is the login, with the kid on it");

    // ---- 5. Emails and notices for a kid reach the parent.
    const priv = (await hc("POST", "/classes", { title: "Private", kind: "private", startsAt: new Date(Date.now() + 3 * DAY).toISOString(), durationMin: 60, capacity: 1, priceCents: 0 })).j.class.id;
    let m0 = sink.mails.length; await mom("POST", "/me/as", { id: sipho });
    r = await mom("PUT", `/classes/${priv}/rsvp`, { going: true }); await wait(400);
    ok(r.s === 200 && to("thandi@fam.test", m0).some((m) => /private lesson is booked/i.test(m.subject)), "a kid's private-lesson booking emails the parent");
    m0 = sink.mails.length; await hc("DELETE", `/classes/${priv}`, {}); await wait(400);
    ok(to("thandi@fam.test", m0).some((m) => /Cancelled/.test(m.subject)), "and so does a cancelled class they were booked on");
    await mom("POST", "/me/as", { id: lerato });
    r = await mom("GET", "/me/notices"); ok(r.j.notices.some((n) => /^Sipho: Cancelled/.test(n.title)), "Lerato's screen shows Sipho's notice, with his name: " + JSON.stringify(r.j.notices.map((n) => n.title)));

    // ---- 6. Family money: one reminder with one total and a line per kid; a payment for one pays the others.
    for (const id of [kabelo, naledi, zola]) await hc("PATCH", `/coach/students/${id}`, { planId: null }); // just two kids on fees for now
    let mo = await money();
    ok(mo[lerato].family && mo[lerato].family === mo[sipho].family && mo[ayanda].family === mo[lebo].family && mo[lerato].family !== mo[ayanda].family, "brothers and sisters share a family on Money");
    ok(mo[lerato].reference !== mo[sipho].reference, "each keeps their own reference");
    await hc("PATCH", "/coach/gym/pay", { holder: "Family BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
    m0 = sink.mails.length; r = await hc("POST", "/coach/money/remind", { userIds: [lerato, sipho], auto: false }); await wait(400);
    const fm = to("thandi@fam.test", m0);
    ok(r.j.sent === 1 && fm.length === 1, "one email for the two of them: " + JSON.stringify(r.j));
    ok(fm[0] && /R\s?1[\s ]000/.test(fm[0].text) && /Lerato: R\s?500/.test(fm[0].text) && /Sipho: R\s?500/.test(fm[0].text) && fm[0].text.includes(mo[lerato].reference) && fm[0].text.includes(mo[sipho].reference) && /^Hi Thandi,/m.test(fm[0].text), "with one total, a line and a reference per kid, to the parent: " + (fm[0] && fm[0].text.slice(0, 400)));
    r = await hc("POST", "/coach/money/remind", { userIds: [lerato, sipho] }); ok(r.j.sent === 0 && r.j.recent.length === 1, "and not twice in a week");
    // The parent's Pay sheet: the family total and each kid's line.
    let fam = (await mom("GET", "/me/pay")).j.pay.family;
    ok(fam && fam.totalCents === 100000 && fam.kids.length === 5 && fam.kids.filter((k) => k.owedCents).map((k) => k.id).join() === [lerato, sipho].join() && fam.kids.find((k) => k.me).id === lerato && fam.kids.every((k) => /^JF/.test(k.reference)), "the parent's Pay sheet shows the family total and each kid: " + JSON.stringify(fam));
    // R1 000 recorded for Lerato: R500 is hers, R500 pays Sipho.
    r = await hc("POST", "/coach/payments", { userId: lerato, amountCents: 100000, paidOn: today, method: "eft" });
    const fp = r.j.payment;
    ok(r.s === 201 && fp.amountCents === 50000 && r.j.split.length === 1 && r.j.split[0].id === sipho && r.j.split[0].cents === 50000, "a family payment for one kid is split with the other: " + JSON.stringify(r.j.split));
    ok(/Family payment of R\s?1[\s ]000/.test(fp.note), "with a note saying so: " + fp.note);
    mo = await money(); ok(mo[lerato].owedCents === 0 && mo[sipho].owedCents === 0, "and both are paid");
    r = await hc("POST", `/coach/payments/${fp.id}/unsplit`, {}); mo = await money();
    ok(r.j.payment.amountCents === 100000 && !/Family payment/.test(r.j.payment.note) && mo[sipho].owedCents === 50000 && mo[lerato].owedCents === 0, "Undo puts it all back on Lerato");
    await hc("DELETE", `/coach/payments/${fp.id}`);
    r = await hc("POST", "/coach/payments", { userId: lerato, amountCents: 100000, paidOn: today, method: "eft" }); await hc("DELETE", `/coach/payments/${r.j.payment.id}`);
    ok(Number((await pool.query("select count(*) from payments where gym_id=$1", [g.id])).rows[0].count) === 0, "deleting a split payment takes its shares with it");
    r = await hc("POST", "/coach/payments", { userId: lerato, amountCents: 50000, paidOn: today, method: "cash" }); ok(r.j.split.length === 0, "what they owe exactly isn't split");
    await hc("DELETE", `/coach/payments/${r.j.payment.id}`);
    r = await hc("POST", "/coach/payments", { userId: lerato, amountCents: 100000, paidOn: today, method: "eft", forMonth: M0 }); ok(r.j.split.length === 0, "nor one the coach said which month it's for");
    await hc("DELETE", `/coach/payments/${r.j.payment.id}`);
    // A proof the parent sends from one kid's Pay sheet, confirmed by the coach.
    await mom("POST", "/me/pay/proof", { name: "pop.png", data: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex").toString("base64"), amountCents: 100000 });
    const pend = (await hc("GET", "/coach/payments")).j.payments.find((p) => p.status === "pending" && p.userId === lerato);
    r = await hc("PATCH", `/coach/payments/${pend.id}`, { status: "confirmed", amountCents: 100000 });
    mo = await money(); ok(r.j.split.length === 1 && r.j.payment.amountCents === 50000 && mo[lerato].owedCents === 0 && mo[sipho].owedCents === 0, "confirming a family proof splits it too");
    fam = (await mom("GET", "/me/pay")).j.pay.family; ok(fam.totalCents === 0, "and the family's Pay sheet is clear");
    // Paid up for this month: a family payment pays what's due next, for both.
    r = await hc("POST", "/coach/payments", { userId: lerato, amountCents: 100000, paidOn: today, method: "eft" });
    const ahead = r.j; const nx = await money(N1);
    ok(ahead.split.length === 1 && ahead.split[0].cents === 50000 && nx[lerato].paidCents === 50000 && nx[sipho].paidCents === 50000, "paid ahead, it pays next month for both: " + JSON.stringify([ahead.split, nx[lerato].paidCents, nx[sipho].paidCents]));
    await hc("DELETE", `/coach/payments/${ahead.payment.id}`);
    // Kids the coach added who aren't on the app yet, with the same number, are a family too.
    mo = await money(); ok(mo[ayanda].family === mo[lebo].family, "linked or not, kids with the same parent's number are one family");
    // A year plan isn't split: a big payment is what the year costs.
    const year = (await hc("POST", "/coach/plans", { name: "Kids year", priceCents: 500000, period: "year" })).j.plan.id;
    await hc("PATCH", `/coach/students/${ayanda}`, { planId: year }); await hc("PATCH", `/coach/students/${lebo}`, { planId: plan });
    r = await hc("POST", "/coach/payments", { userId: ayanda, amountCents: 500000, paidOn: today, method: "eft" }); ok(r.j.split.length === 0, "a year plan's payment stays with its kid");
    await hc("DELETE", `/coach/payments/${r.j.payment.id}`); await hc("PATCH", `/coach/students/${ayanda}`, { planId: plan });

    // ---- 7. Card payments (PayFast) from one kid's Pay sheet are split the same way.
    await hc("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "gym secret" });
    const itn = (fields, pass) => { const str = Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim()).replace(/%20/g, "+")}`).join("&") + `&passphrase=${encodeURIComponent(pass).replace(/%20/g, "+")}`;
      return str.replace(/&passphrase=.*$/, "") + "&signature=" + crypto.createHash("md5").update(str).digest("hex"); };
    const post = (b) => fetch(base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: b });
    const pf = { m_payment_id: "pay-a", pf_payment_id: "5550001", payment_status: "COMPLETE", item_name: "Fees", item_description: "", amount_gross: "1000.00", amount_fee: "-23.00", amount_net: "977.00", custom_str1: "pay", custom_str2: "", custom_int1: ayanda, custom_int2: g.id, name_first: "", email_address: "", merchant_id: "10000105" };
    await post(itn(pf, "gym secret")); await wait(500); await post(itn(pf, "gym secret")); await wait(500);
    mo = await money(); const pfs = (await pool.query("select user_id, amount_cents, source from payments where gym_id=$1 and (source='payfast' or split_of in (select id from payments where source='payfast')) order by id", [g.id])).rows;
    ok(pfs.length === 2 && pfs[0].amount_cents === 50000 && String(pfs[1].user_id) === lebo && pfs[1].amount_cents === 50000 && mo[ayanda].owedCents === 0 && mo[lebo].owedCents === 0, "a family card payment is split between the kids, once: " + JSON.stringify(pfs));
    await pool.query("delete from payments where gym_id=$1", [g.id]);

    // ---- 8. The automatic reminders send one email per family, once, even with two servers running them.
    await pool.query("update users set reminded_at=null where gym_id=$1", [g.id]);
    const dd = +today.slice(8, 10), weekAgo = +new Date(Date.parse(today + "T12:00:00Z") - 7 * DAY).toISOString().slice(8, 10);
    await hc("PATCH", "/coach/gym/pay", { holder: "Family BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: dd <= 28 ? dd : weekAgo });
    await hc("PUT", "/coach/money/auto", { on: true });
    m0 = sink.mails.length;
    await Promise.all([jobsA.autoRemind({ hour: 9 }), jobsB.autoRemind({ hour: 9 })]); await wait(300);
    const auto = to("thandi@fam.test", m0), bauto = to("bongi@fam.test", m0);
    ok(auto.length === 1 && /Lerato/.test(auto[0].text) && /Sipho/.test(auto[0].text) && bauto.length === 1 && /Ayanda/.test(bauto[0].text) && /Lebo/.test(bauto[0].text), "each family gets one automatic reminder: " + JSON.stringify([auto.length, bauto.length]));

    // ---- 9. Leaving: a coach removing a kid keeps the parent's login; a parent deleting their account sends the kids back to the coach's list.
    r = await hc("DELETE", `/coach/students/${naledi}`, {}); r = await mom("GET", "/me");
    ok(!r.j.me.family.some((f) => f.id === naledi) && (await pool.query("select gym_id from users where id=$1", [naledi])).rows[0].gym_id === null, "a kid the coach removes leaves the gym and the parent's list");
    await mom("POST", "/me/as", { id: sipho });
    ok((await mom("GET", "/me")).j.me.stays.join() === ["Lerato Dlamini", "Sipho Dlamini", "Kabelo Dlamini", "Zola Dlamini"].join(), "the app knows which kids stay at the gym if the account is deleted (for the delete text)");
    r = await mom("DELETE", "/me", { password: "thandipass1" }); ro = await roster();
    ok(r.s === 200 && ro[lerato] && ro[lerato].offline && ro[lerato].name === "Lerato Dlamini" && ro[sipho] && ro[sipho].offline && ro[kabelo].offline, "deleting the parent's account (while booking for Sipho) deletes the login only: Lerato, whose record held it, stays a member like her brothers, not on the app");
    r = await mom2("POST", "/auth/login", { email: "thandi@fam.test", password: "thandipass1" }); ok(r.s === 401, "and the login is gone");
    await bm("POST", "/me/as", { id: thabo }); r = await bm("POST", "/me/join", { code }); const r2 = await bm("GET", "/me");
    ok(r.j.me.id === bongani && r2.j.me.id === bongani && (await roster())[thabo], "joining or moving gyms is for the login itself (and it books for itself again)");

    // ---- 10. A third round of testing, in a gym of its own.
    const h3 = client(base);
    r = await h3("POST", "/auth/start-gym", { gym: "Round Three BJJ", name: "Coach Three", email: "head3@fam.test", password: "headpass33", timezone: "Africa/Johannesburg" });
    const code3 = r.j.me.gym.studentCode, gym3 = r.j.me.gym.id;
    const plan3 = (await h3("POST", "/coach/plans", { name: "Kids", priceCents: 50000, period: "month" })).j.plan.id;
    await h3("PATCH", "/coach/gym/pay", { holder: "Round Three", bank: "FNB", account: "62000000001", branch: "250655", dueDay: dd <= 28 ? dd : weekAgo });
    const add3 = async (name, phone, parentName = "Thandi") => { const id = (await h3("POST", "/coach/students", { name, parentName, phone })).j.id; await h3("PATCH", `/coach/students/${id}`, { planId: plan3 }); return id; };
    const ro3 = async () => Object.fromEntries((await h3("GET", "/coach/roster")).j.people.map((p) => [p.id, p]));
    const mo3 = async (m) => (await h3("GET", "/coach/money" + (m ? `?month=${m}` : ""))).j;
    const st3 = async (m) => Object.fromEntries((await mo3(m)).students.map((s) => [s.id, s]));
    const link3 = async (id) => new URL((await h3("POST", `/coach/students/${id}/claim-link`)).j.url).searchParams.get("claim");
    const wipe3 = () => pool.query("delete from payments where gym_id=$1", [gym3]);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex").toString("base64");
    const le3 = await add3("Lerato Three", "084 100 2000"), si3 = await add3("Sipho Three", "084 100 2000");
    const m3 = client(base), m3b = { code: code3, name: "Thandi Three", email: "thandi3@fam.test", password: "thandipass3", phone: "084 100 2000" };
    r = await m3("POST", "/auth/register", { ...m3b, kids: [le3, si3] }); ok(r.s === 201 && r.j.me.id === le3, "round 3: Thandi's login holds Lerato and Sipho");

    // Record a payment: the 'For' line says what a family payment does before it's saved.
    r = await h3("GET", `/coach/payments/months?userId=${le3}&amountCents=100000&paidOn=${today}`);
    ok(r.j.forMonths.join() === M0 && r.j.keepCents === 50000 && r.j.split.length === 1 && r.j.split[0].id === si3 && r.j.split[0].cents === 50000 && r.j.split[0].forMonths.join() === M0,
      "the months preview shows the family split: R500 for Lerato's month, R500 to Sipho: " + JSON.stringify(r.j));
    r = await h3("GET", `/coach/payments/months?userId=${le3}&amountCents=100000&paidOn=${today}&forMonth=${M0}`);
    ok(r.j.split.length === 0 && r.j.forMonths.join() === [M0, N1].join(), "picking a month keeps it all on Lerato: " + JSON.stringify(r.j));

    // A split shows on both lines, can be undone from either, and deleting a share gives it back.
    r = await h3("POST", "/coach/payments", { userId: le3, amountCents: 100000, paidOn: today, method: "eft" });
    const o3 = r.j.payment, sh3 = () => h3("GET", "/coach/payments").then((x) => x.j.payments);
    let ps = await sh3(), share = ps.find((p) => p.userId === si3);
    ok(o3.family && o3.family.of === o3.id && o3.family.totalCents === 100000 && share && share.family && share.family.of === o3.id && share.family.totalCents === 100000, "both lines say they're part of a family payment of R1 000: " + JSON.stringify([o3.family, share && share.family]));
    r = await h3("POST", `/coach/payments/${share.id}/unsplit`, {});
    ok(r.j.payment.id === o3.id && r.j.payment.amountCents === 100000 && !r.j.payment.family && (await sh3()).length === 1, "Undo split works from the brother's line too");
    await wipe3(); r = await h3("POST", "/coach/payments", { userId: le3, amountCents: 100000, paidOn: today, method: "eft" });
    ps = await sh3(); share = ps.find((p) => p.userId === si3); const before = (await mo3()).collectedCents;
    r = await h3("DELETE", `/coach/payments/${share.id}`); ps = await sh3(); let s3 = await st3();
    const back3 = ps.find((p) => p.userId === le3);
    ok(r.j.backTo === back3.id && ps.length === 1 && back3.amountCents === 100000 && !/Family payment/.test(back3.note || "") && !back3.family, "deleting Sipho's share gives it back to the payment it came from: " + JSON.stringify(ps.map((p) => [p.amountCents, p.note])));
    ok((await mo3()).collectedCents === before && s3[si3].owedCents === 50000 && s3[le3].owedCents === 0, "so the R1 000 the gym got is still counted, all on Lerato, and Sipho owes again");

    // Lerato paid November; a family payment sent from her sheet pays Sipho's November, not her December.
    await wipe3(); await h3("POST", "/coach/payments", { userId: le3, amountCents: 50000, paidOn: today, method: "cash" });
    let fam3 = (await m3("GET", "/me/pay")).j.pay.family; ok(fam3 && fam3.totalCents === 50000, "her Pay sheet shows the family total: Sipho's R500");
    await m3("POST", "/me/pay/proof", { name: "pop.png", data: png, amountCents: 50000 });
    const pend3 = (await sh3()).find((p) => p.status === "pending");
    r = await h3("PATCH", `/coach/payments/${pend3.id}`, { status: "confirmed", amountCents: 50000 }); s3 = await st3(); const nx3 = await st3(N1);
    ok(r.j.split.length === 1 && r.j.split[0].id === si3 && r.j.split[0].cents === 50000 && s3[si3].owedCents === 0 && nx3[le3].paidCents === 0, "the family payment from a kid who's paid up pays her brother's month: " + JSON.stringify([r.j.split, s3[si3].owedCents, nx3[le3].paidCents]));
    ok(/Family payment of R\s?500,00: Sipho R\s?500/.test(r.j.payment.note || ""), "with a note saying where it went: " + r.j.payment.note);

    // One proof for the family, being checked: nobody in the family is reminded, and the Pay sheet counts it for them all.
    const ama = await add3("Ama Three", "084 300 4000", "Zanele"), bo = await add3("Bo Three", "084 300 4000", "Zanele");
    const z3 = client(base);
    r = await z3("POST", "/auth/register", { code: code3, name: "Zanele Three", email: "zanele@fam.test", password: "zanelepass3", phone: "084 300 4000", kids: [ama, bo] }); ok(r.s === 201, "Zanele signs up for Ama and Bo");
    await z3("POST", "/me/pay/proof", { name: "pop.png", data: png, amountCents: 100000 });
    fam3 = (await z3("GET", "/me/pay")).j.pay.family;
    ok(fam3 && fam3.totalCents === 0 && fam3.kids.every((k) => k.owedCents === 0), "after one R1 000 proof from Ama's sheet, the family total is R0, not Bo's R500: " + JSON.stringify(fam3));
    m0 = sink.mails.length; r = await h3("POST", "/coach/money/remind", { userIds: [ama, bo], auto: false }); await wait(300);
    ok(r.j.sent === 0 && r.j.checking.length === 1 && !to("zanele@fam.test", m0).length, "'Email reminders' leaves out a family with a proof being checked: " + JSON.stringify(r.j));
    await h3("PUT", "/coach/money/auto", { on: true }); m0 = sink.mails.length;
    await jobsA.autoRemind({ hour: 9 }); await wait(300);
    ok(!to("zanele@fam.test", m0).length, "and so does the automatic job (no 'Hi Bo' to the parent who just paid for him)");

    // A kid on a parent's login alone: the reminder greets the parent, about the kid. A second kid's link, signed out, says to sign in.
    const sizwe = await add3("Sizwe Three", "084 500 6000", "Lindi"), kab3 = await add3("Kabelo Three", "084 700 8000", "Lindi");
    const l3 = client(base), l3b = { code: code3, claim: await link3(sizwe), name: "Lindi Three", email: "lindi@fam.test", password: "lindipass3" };
    r = await l3("POST", "/auth/register", l3b); ok(r.s === 201 && r.j.me.id === sizwe && r.j.me.account && r.j.me.account.name === "Lindi Three", "Lindi signs up for Sizwe; the account is hers: " + JSON.stringify(r.j.me && r.j.me.account));
    await pool.query("update users set reminded_at=null where gym_id=$1", [gym3]); m0 = sink.mails.length;
    r = await h3("POST", "/coach/money/remind", { userIds: [sizwe] }); await wait(300); const lm = to("lindi@fam.test", m0)[0];
    ok(r.j.sent === 1 && lm && /^Hi Lindi,/m.test(lm.text) && /due for Sizwe for/.test(lm.text), "a single kid's reminder greets the parent, about the kid: " + (lm && lm.text.slice(0, 160)));
    const l3x = client(base), ktok = await link3(kab3);
    r = await l3x("POST", "/auth/register", { ...l3b, claim: ktok }); ok(r.s === 409 && /Sign in to add Kabelo/.test(r.j.error), "Kabelo's link with an email that has an account: 'Sign in to add Kabelo': " + JSON.stringify(r.j));
    r = await l3x("POST", "/auth/login", { email: "lindi@fam.test", password: "lindipass3" }); ok(r.j.me.account.name === "Lindi Three", "signing in, the welcome uses the account's name");
    r = await l3x("POST", "/me/kids", { claim: ktok }); ok(r.s === 201 && r.j.me.id === kab3 && r.j.me.family.length === 2, "and the link then adds Kabelo with one tap");

    // Typing a kid's name doesn't take over their record: only the parent's own number proves it. The coach can unlink a kid.
    const naledi6 = (await h3("POST", "/coach/students", { name: "Naledi Six", parentName: "Thandi Six", phone: "085 600 7000" })).j.id;
    const rnd = client(base); await rnd("POST", "/auth/register", { code: code3, name: "Random Adult", email: "random@fam.test", password: "randompass1", phone: "079 111 2222" });
    m0 = (await pool.query("select count(*) from notices where kind='kidask'")).rows[0].count;
    r = await rnd("POST", "/me/kids", { name: "naledi six" }); let ro6 = await ro3();
    ok(r.s === 409 && /invite link/.test(r.j.error) && ro6[naledi6].offline && ro6[naledi6].parentName === "Thandi Six" && !ro6[naledi6].parentAccount, "a stranger typing the kid's name gets 409 and nothing changes: " + JSON.stringify(r.j));
    ok(Number((await pool.query("select count(*) from notices where kind='kidask'")).rows[0].count) === Number(m0) + 1 && (await h3("POST", `/coach/students/${naledi6}/claim-link`)).s === 200, "the head coach hears about it, and can still send the real parent the invite link");
    const t6 = client(base);
    r = await t6("POST", "/auth/register", { code: code3, name: "Thandi S", email: "thandi6@fam.test", password: "thandipass6", phone: "085 600 7000" });
    r = await t6("POST", "/auth/register", { code: code3, name: "Thandi S", email: "thandi6@fam.test", password: "thandipass6", phone: "085 600 7000", link: "no" });
    ok(r.s === 201 && (await ro3())[r.j.me.id], "the real parent signs up (no to 'Signing up for Naledi?'), and is on Members for now");
    const t6id = r.j.me.id;
    r = await t6("POST", "/me/kids", { name: "Naledi Six" }); ro6 = await ro3(); const mo6 = await st3();
    ok(r.s === 201 && r.j.kid.id === naledi6 && ro6[naledi6].parentAccount === "Thandi S" && ro6[naledi6].parentName === "Thandi Six", "with her own number, the name links Naledi, and the parent's name the coach has stays");
    ok(r.j.parentOnly && !ro6[t6id] && !mo6[t6id] && mo6[naledi6], "a parent who never booked or had a plan comes off Members and Money when she adds her first kid");
    r = await t6("GET", "/me"); ok(r.j.me.id === naledi6 && r.j.me.gym && r.j.me.family.find((f) => f.id === t6id && !f.inGym), "and the app books for Naledi");
    r = await t6("POST", "/me/train", {}); ok(r.s === 200 && (await ro3())[t6id] && r.j.me.id === naledi6, "'I train too' puts her back on Members in one tap");
    await t6("POST", "/me/kids", { name: "Second Kid" }); ok((await ro3())[t6id], "a second kid doesn't take her off again");
    r = await h3("POST", `/coach/students/${naledi6}/unlink`, {}); ro6 = await ro3();
    ok(r.s === 200 && ro6[naledi6].offline && !ro6[naledi6].parentAccount && !(await t6("GET", "/me")).j.me.family.some((f) => f.id === naledi6), "the coach unlinks Naledi from the login: she's not on the app again, and off that login");
    ok((await h3("POST", `/coach/students/${naledi6}/unlink`, {})).s === 400 && (await h3("POST", `/coach/students/${naledi6}/claim-link`)).s === 200, "and can send the invite link again");

    // The kid whose record holds the login leaves: the app carries on for her brother, and the parent keeps her name.
    const le4 = await add3("Lerato Four", "086 400 4000"), si4 = await add3("Sipho Four", "086 400 4000");
    const f4 = client(base), f4b = { code: code3, name: "Thandi Four", email: "thandi4@fam.test", password: "thandipass4", phone: "086 400 4000" };
    r = await f4("POST", "/auth/register", { ...f4b, kids: [le4, si4] }); ok(r.j.me.id === le4, "Thandi Four's login is Lerato's record");
    r = await f4("POST", "/me/leave", {});
    ok(r.s === 200 && r.j.me.id === si4 && r.j.me.gym && r.j.me.gym.id === gym3 && r.j.me.account.name === "Thandi Four", "'Leave gym' while booking for Lerato: the app carries on for Sipho: " + JSON.stringify(r.j.me && [r.j.me.id, r.j.me.gym, r.j.me.account]));
    r = await f4("POST", "/me/as", { id: le4 }); ok(r.j.me.id === le4 && !r.j.me.gym, "Lerato can still be picked (not in a gym)");
    r = await f4("POST", "/me/join", { code: code3 }); ok(r.j.me.id === le4 && r.j.me.gym, "and join again");
    r = await h3("DELETE", `/coach/students/${le4}`, {}); const f4x = client(base);
    r = await f4x("POST", "/auth/login", { email: "thandi4@fam.test", password: "thandipass4" });
    ok(r.j.me.id === si4 && r.j.me.gym && r.j.me.gym.id === gym3 && r.j.me.account.name === "Thandi Four", "the coach removes Lerato: signing in lands on Sipho's gym, with the parent's name: " + JSON.stringify(r.j.me && [r.j.me.id, r.j.me.account]));
    ok((await f4("GET", "/me")).j.me.id === si4, "and the phone that was booking for Lerato is on Sipho now");

    // Deleting the parent's account when the login is a kid's record: only the login goes.
    await f4("POST", "/me/join", { code: code3 }); await h3("PATCH", `/coach/students/${le4}`, { planId: plan3 });
    const cls3 = (await h3("POST", "/classes", { title: "Kids BJJ 3", startsAt: new Date(Date.now() + 2 * DAY).toISOString(), durationMin: 60 })).j.class.id;
    await f4("POST", "/me/as", { id: le4 }); await f4("PUT", `/classes/${cls3}/rsvp`, { going: true });
    await h3("POST", "/coach/payments", { userId: le4, amountCents: 50000, paidOn: today, method: "cash", forMonth: M0 });
    r = await f4("GET", "/me"); ok(r.j.me.stays && r.j.me.stays.join() === "Lerato Four,Sipho Four", "the delete text can name who stays: " + JSON.stringify(r.j.me.stays));
    r = await f4("DELETE", "/me", { password: "thandipass4" }); ro6 = await ro3(); s3 = await st3();
    ok(r.s === 200 && ro6[le4] && ro6[le4].offline && ro6[si4] && ro6[si4].offline && s3[le4] && s3[le4].paidCents === 50000, "deleting the account keeps Lerato in the gym (not on the app), with her payment");
    r = await h3("GET", `/coach/classes/${cls3}`); ok(r.j.attendees.some((a) => a.id === le4), "and her booking");
    ok(Number((await pool.query("select count(*) from notices where kind='unlinked' and gym_id=$1", [gym3])).rows[0].count) === 1, "and the head coach is told");
    ok((await h3("POST", `/coach/students/${le4}/claim-link`)).s === 200, "the coach can send her invite link again");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); pfSrv.close(); await pool.end().catch(() => {}); await pool2.end().catch(() => {});
  console.log(`families: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
