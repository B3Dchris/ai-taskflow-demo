// The gym's monthly programme: coaches plan, edit and publish a month (weeks of YouTube videos and techniques), links are checked,
// members see published months from the month they joined plus next month's preview, never another gym's, catch up on weeks they
// didn't train (and mark them caught up), a class planned that week takes the week's focus in one tap, and publishing tells members.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/programme.js   (wipes that database)
//        PROG_SHOTS=<folder> also saves iPhone 13 screenshots there (thumbnails load through HTTPS_PROXY when it's set).
const { spawn } = require("child_process"); const path = require("path"); const fs = require("fs"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
const SHOTS = process.env.PROG_SHOTS || "";
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base) {
  let cookie = "";
  const c = async (method, url, body, key) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; } if (key) h["x-jf-key"] = key;
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  c.cookie = () => cookie.replace(/^jf_s=/, "");
  return c;
}
const addM = (ym, n) => { const [y, m] = ym.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const addD = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const monday = (d) => addD(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const VIDS = ["dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "OPf0YbXqDm0", "JGwWNGJdvx8", "RgKAFK5djSk"];
const week = (title, n = 2, ids = ["double_leg"]) => ({ title, note: title + " basics", ids, videos: Array.from({ length: n }, (x, i) => ({ v: VIDS[i % VIDS.length], title: `${title} ${i + 1}`, note: i ? "Variation " + i : "" })) });

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public;");
  const port = 10300 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api";
  const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), APP_URL: "https://www.jitsflow.test" };
  for (const k of ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "PAYFAST_MERCHANT_ID", "GA_ID", "NODE_ENV"]) delete env[k];
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + "/healthz"); break; } catch (e) { await wait(150); } }
  let b; const errs = [];
  try {
    const start = async (gym, email) => { const c = client(base), r = await c("POST", "/auth/start-gym", { gym, name: "Coach " + gym, email, password: "coachpass1", timezone: "Africa/Johannesburg" });
      c.gym = r.j.me.gym.id; c.code = r.j.me.gym.studentCode; c.coachCode = r.j.me.gym.coachCode; return c; };
    const A = await start("JPB Academy", "head@prog.test"), B = await start("Other Gym", "other@prog.test");
    const join = async (code, name, email) => { const c = client(base), r = await c("POST", "/auth/register", { code, name, email, password: "memberpass1" }); c.id = r.j.me.id; return c; };
    const A2 = await join(A.coachCode, "Coach Two", "two@prog.test");
    const M = await join(A.code, "Mia Member", "mia@prog.test"), N = await join(A.code, "Nat New", "nat@prog.test"), O = await join(B.code, "Oli Other", "oli@prog.test");
    let r = await A("GET", "/programme"); const today = r.j.today, cur = r.j.month, thisMon = monday(today);
    ok(r.s === 200 && r.j.coach && r.j.canDelete && r.j.programme === null && r.j.access === "all", "a coach reads an empty month: " + JSON.stringify(r.j));
    ok((await A2("GET", "/programme")).j.canDelete === false, "a coach who isn't the head can't delete months");
    // Mia joined two months ago (on the 10th): she sees from that month on.
    await pool.query("update users set gym_joined_at=$2, created_at=$2 where id=$1", [M.id, addM(cur, -2) + "-10T10:00:00Z"]);
    const months = {}; for (const k of [-3, -2, -1, 0, 1, 2]) months[k] = addM(cur, k);

    // ---------- coaches plan, edit and publish ----------
    const plan = (ym, title, n) => ({ title, summary: title + " for the whole gym", weeks: Array.from({ length: n }, (x, i) => week(`${title} W${i + 1}`)) });
    const weeksIn = async (ym) => (await A("GET", "/programme?month=" + ym)).j;
    r = await A2("PUT", `/coach/programme/${months[0]}`, plan(months[0], "Wrestling for BJJ", 1));
    const nWeeks0 = r.j.programme.weeks.length;
    ok(r.s === 200 && r.j.programme.title === "Wrestling for BJJ" && !r.j.programme.published && nWeeks0 >= 4 && nWeeks0 <= 5 && r.j.programme.weeks.every((w) => new Date(w.start + "T00:00:00Z").getUTCDay() === 1 && w.start.slice(0, 7) === months[0]),
      "any coach saves a month as a draft, with a week for each Monday of the month: " + JSON.stringify(r.j.programme && r.j.programme.weeks.map((w) => w.start)));
    for (const k of [-3, -1, 0, 1, 2]) { const n = (await weeksIn(months[k])).programme?.weeks.length || (await A("PUT", `/coach/programme/${months[k]}`, plan(months[k], "T", 1))).j.programme.weeks.length;
      r = await A("PUT", `/coach/programme/${months[k]}`, plan(months[k], { "-3": "Old guard", "-1": "Mount", 0: "Wrestling for BJJ", 1: "Guard passing", 2: "Leg locks" }[k], n));
      ok(r.s === 200 && r.j.programme.weeks.length === n && r.j.programme.weeks[0].videos.length === 2 && r.j.programme.weeks[0].videos[0].v === VIDS[0], "month " + k + " planned with " + n + " weeks"); }
    let p0 = (await weeksIn(months[0])).programme;
    // Two coaches: an edit from a stale copy is refused (with the month as it is now), not saved over the other coach's.
    r = await A("PUT", `/coach/programme/${months[0]}`, { ...plan(months[0], "Stale", nWeeks0), was: "2001-01-01T00:00:00.000Z" });
    ok(r.s === 409 && r.j.programme && r.j.programme.title === "Wrestling for BJJ", "a save from a stale copy gets 409 and the current month: " + r.s);
    r = await A("PUT", `/coach/programme/${months[0]}`, { ...plan(months[0], "Wrestling for BJJ", nWeeks0), was: p0.updatedAt });
    ok(r.s === 200, "a save with the current version goes through");

    // ---------- links and limits ----------
    const good = { "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s": "dQw4w9WgXcQ", "youtu.be/9bZkp7q19f0?si=abc": "9bZkp7q19f0", "https://youtube.com/shorts/kJQP7kiw5Fk": "kJQP7kiw5Fk",
      "https://m.youtube.com/watch?v=OPf0YbXqDm0&feature=share": "OPf0YbXqDm0", "http://www.youtube.com/embed/JGwWNGJdvx8": "JGwWNGJdvx8" };
    r = await A("PUT", `/coach/programme/${months[2]}`, { title: "Leg locks", weeks: [{ title: "Links", videos: Object.keys(good).map((url, i) => ({ url, title: "Video " + i })) }] });
    ok(r.s === 200 && JSON.stringify(r.j.programme.weeks[0].videos.map((v) => v.v)) === JSON.stringify(Object.values(good)), "watch?v=, youtu.be, shorts, m.youtube.com and embed links keep just the video id: " + JSON.stringify(r.j && r.j.programme && r.j.programme.weeks[0].videos));
    ok(!JSON.stringify(r.j.programme).includes("http"), "only the id is stored, never the link");
    for (const bad of ["https://vimeo.com/76979871", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/playlist?list=PL0123456789", "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=short", "not a link", "https://www.youtube.com/@jpbacademy", "https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ"]) {
      r = await A("PUT", `/coach/programme/${months[2]}`, { title: "Leg locks", weeks: [{ title: "Bad", videos: [{ url: bad, title: "x" }] }] });
      ok(r.s === 400 && /YouTube/.test(r.j.error), "refused: " + bad + " → " + r.s);
    }
    r = await A("PUT", `/coach/programme/${months[2]}`, { title: "x", weeks: [{ title: "No title", videos: [{ url: "https://youtu.be/dQw4w9WgXcQ", title: "  " }] }] });
    ok(r.s === 400 && /title/.test(r.j.error), "a video needs a title");
    r = await A("PUT", `/coach/programme/${months[2]}`, { title: "x", weeks: [{ title: "Many", videos: Array.from({ length: 13 }, (x, i) => ({ v: VIDS[0], title: "v" + i })) }] });
    ok(r.s === 400 && /12/.test(r.j.error), "13 videos in a week are refused: " + (r.j && r.j.error));
    r = await A("PUT", `/coach/programme/${months[2]}`, { title: "x", weeks: Array.from({ length: 6 }, () => ({ title: "w" })) });
    ok(r.s === 400, "six weeks in a month are refused");
    for (const m of ["2026-13", "26-01", "2026-1", "abcd-ef"]) ok((await A("PUT", `/coach/programme/${m}`, { title: "x" })).s === 400 && (await A("GET", "/programme?month=" + m)).s === 400, "a month that isn't a month is refused: " + m);
    r = await A("PUT", `/coach/programme/${months[2]}`, { title: "L".repeat(300), summary: "S".repeat(900), weeks: [{ title: "T".repeat(300), note: "N".repeat(900), ids: ["armbar", "<script>", "a".repeat(80), "armbar"], videos: [{ v: VIDS[1], title: "V".repeat(300), note: "x".repeat(500) }] }] });
    const lp = r.j.programme;
    ok(r.s === 200 && lp.title.length === 80 && lp.summary.length === 280 && lp.weeks[0].title.length === 80 && lp.weeks[0].note.length === 280 && lp.weeks[0].videos[0].title.length === 100 && lp.weeks[0].videos[0].note.length === 120
      && JSON.stringify(lp.weeks[0].ids) === '["armbar"]', "long text is cut to length, and only technique ids are kept: " + JSON.stringify(lp.weeks[0].ids));
    r = await A("PUT", `/coach/programme/${months[2]}`, plan(months[2], "Leg locks", (await weeksIn(months[2])).programme.weeks.length));

    // ---------- members: published only, from the month they joined, plus next month's preview ----------
    const mem = async (c, ym) => (await c("GET", "/programme" + (ym ? "?month=" + ym : ""))).j;
    let m = await mem(M);
    ok(m.programme === null && m.next === null && !m.coach, "drafts are hidden from members: " + JSON.stringify(m.programme));
    for (const k of [-3, -1, 0, 1, 2]) { r = await A2("POST", `/coach/programme/${months[k]}/publish`, {}, "pub" + k); ok(r.s === 200 && r.j.programme.published, "published month " + k); }
    await A("POST", `/coach/programme/${months[1]}/publish`, { published: false }, "unpub1");
    m = await mem(M);
    ok(m.programme && m.programme.title === "Wrestling for BJJ" && m.programme.published && m.next === null, "Mia sees this month once it's published; next month is still a draft, so no preview");
    ok((await mem(M, months[-1])).programme?.title === "Mount", "and last month (she was here)");
    ok((await mem(M, months[-3])).programme === null, "but not a month from before she joined");
    ok((await mem(M, months[2])).programme === null, "nor two months ahead");
    ok((await mem(M, months[1])).programme === null, "nor next month while it's a draft");
    await A("POST", `/coach/programme/${months[1]}/publish`, {}, "pub1b");
    m = await mem(M);
    ok(m.next && m.next.month === months[1] && m.next.title === "Guard passing", "next month shows as a preview once it's published: " + JSON.stringify(m.next));
    ok((await mem(M, months[1])).programme?.weeks.length >= 4, "and opens");
    ok((await mem(N, months[-1])).programme === null && (await mem(N)).programme?.title === "Wrestling for BJJ", "Nat, who joined this month, sees this month but not last month");
    // A parent sees it for their kid (the kid's own join month counts), as they see the kid's classes and fees.
    const P = await join(A.code, "Pat Parent", "pat@prog.test");
    r = await P("POST", "/me/kids", { name: "Kai Kid" }, "kid1"); const kidId = r.j && r.j.kid && r.j.kid.id;
    ok(r.s === 201 && kidId, "a parent adds a kid: " + r.s);
    await pool.query("update users set created_at=$2 where id=$1", [kidId, months[-1] + "-05T10:00:00Z"]);
    ok((await mem(P)).programme?.title === "Wrestling for BJJ" && (await mem(P, months[-1])).programme?.title === "Mount" && (await mem(P, months[-3])).programme === null,
      "booking for the kid, the parent sees the kid's programme, from the month the kid joined");

    // ---------- other gyms ----------
    r = await B("GET", "/programme?month=" + months[0]);
    ok(r.s === 200 && r.j.programme === null && !JSON.stringify(r.j).includes("Wrestling"), "another gym's coach doesn't see this gym's programme");
    ok((await mem(O)).programme === null && !JSON.stringify(await mem(O)).includes("Wrestling"), "nor do its members");
    r = await B("PUT", `/coach/programme/${months[0]}`, { title: "Bravo's own", weeks: [] });
    ok(r.s === 200 && (await weeksIn(months[0])).programme.title === "Wrestling for BJJ", "another gym saving the same month saves its own, not this gym's");
    r = await B("DELETE", `/coach/programme/${months[-1]}`);
    ok(r.s === 404 && (await weeksIn(months[-1])).programme, "nor can it delete this gym's month");
    r = await M("PUT", `/coach/programme/${months[0]}`, { title: "hacked" }); ok(r.s === 403, "members can't edit");
    r = await M("POST", `/coach/programme/${months[0]}/publish`, { published: false }); ok(r.s === 403, "or unpublish");
    r = await client(base)("GET", "/programme"); ok(r.s === 401, "signed out: nothing");

    // ---------- notices ----------
    const notes = async (c) => ((await c("GET", "/me/notices")).j.notices || []).filter((x) => x.kind === "programme");
    const MN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let nn = await notes(N);
    ok(nn.some((x) => x.title === `${MN[Number(months[0].slice(5)) - 1]}'s programme is up: Wrestling for BJJ`), "members get a notice when a month is published: " + JSON.stringify(nn.map((x) => x.title)));
    ok(nn.filter((x) => /Guard passing/.test(x.title)).length === 1, "one notice per month, even published again after a draft");
    ok(!(await notes(A)).length, "coaches don't get the members' notice");
    ok(!(await notes(O)).length, "another gym's members don't get it");

    // ---------- deleting and copying ----------
    r = await A2("DELETE", `/coach/programme/${months[2]}`); ok(r.s === 403, "only the head coach deletes a month");
    r = await A("DELETE", `/coach/programme/${months[2]}`); ok(r.s === 200 && !(await weeksIn(months[2])).programme && !(await notes(N)).some((x) => /Leg locks/.test(x.title)), "the head coach deletes a month, and its notice goes");
    r = await A2("POST", `/coach/programme/${months[2]}/copy`, {}, "copy1");
    const g1 = (await weeksIn(months[1])).programme;
    ok(r.s === 200 && r.j.programme.title === "" && !r.j.programme.published && r.j.programme.weeks[0].title === g1.weeks[0].title && r.j.programme.weeks.every((w) => !w.videos.length && !w.ids.length) && r.j.from === months[1],
      "Copy last month's weeks: same week titles and notes, no videos, a draft: " + JSON.stringify(r.j.programme && r.j.programme.weeks[0]));
    r = await A2("PUT", `/coach/programme/${months[2]}`, { title: "Leg locks", weeks: [week("Heel hooks")] });
    r = await A2("POST", `/coach/programme/${months[2]}/copy`, {}, "copy2"); ok(r.s === 409, "a month that's planned isn't copied over");
    r = await A("POST", `/coach/programme/${addM(cur, 9)}/copy`, {}, "copy3"); ok(r.s === 404, "nothing to copy: 404");
    r = await A("POST", `/coach/programme/${months[2]}/publish`, { published: true }, "pubnotitle");
    await A("PUT", `/coach/programme/${addM(cur, 5)}`, { title: "", weeks: [] });
    r = await A("POST", `/coach/programme/${addM(cur, 5)}/publish`, {}, "pub5"); ok(r.s === 400 && /title/.test(r.j.error), "a month needs a title to publish");

    // ---------- catch-up from attendance ----------
    // Classes in Mia's last 8 weeks: some she came to (checked in, or booked a class with no register), some she missed.
    const allWeeks = [...(await weeksIn(months[-1])).programme.weeks, ...(await weeksIn(months[0])).programme.weeks].filter((w) => w.start < thisMon && w.start >= addD(thisMon, -56) && w.start >= monday(months[-2] + "-10"));
    ok(allWeeks.length >= 3, "enough past weeks to test catch-up: " + allWeeks.length);
    const cls = async (day, register) => (await pool.query("insert into classes(gym_id,title,starts_at,register_at) values($1,'No-Gi',$2,$3) returning id", [A.gym, day + "T16:00:00Z", register ? day + "T17:00:00Z" : null])).rows[0].id;
    const came = allWeeks[0].start, booked = allWeeks[1].start, absent = allWeeks[2] && allWeeks[2].start;
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,true)", [await cls(addD(came, 1), true), M.id]);
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,false)", [await cls(addD(booked, 2), false), M.id]);
    if (absent) await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,false)", [await cls(addD(absent, 3), true), M.id]); // booked, but the register says she wasn't there
    m = await mem(M);
    const cu = m.catchUp.map((w) => w.start);
    ok(!cu.includes(came) && !cu.includes(booked), "weeks she trained aren't on her catch-up list: " + JSON.stringify(cu));
    ok(absent && cu.includes(absent), "a week she booked but the register says she missed is: " + absent);
    ok(JSON.stringify(cu) === JSON.stringify(allWeeks.map((w) => w.start).filter((d) => d !== came && d !== booked)), "every other published week since she joined (last 8 weeks), up to last week: " + JSON.stringify(cu));
    ok(!cu.includes(thisMon) && cu.every((d) => d < thisMon), "this week isn't a missed week yet");
    ok(m.trained.includes(came) && m.trained.includes(booked), "her trained weeks come back for the week chips");
    ok(m.catchUp.every((w) => w.videos.length && w.title && w.month), "each missed week comes with its videos");
    ok((await mem(N)).catchUp.length === 0, "Nat, who joined this week, has nothing to catch up on: " + JSON.stringify((await mem(N)).catchUp.map((w) => w.start)));
    r = await M("POST", "/me/programme/caught-up", { week: absent });
    ok(r.s === 200 && !(await mem(M)).catchUp.some((w) => w.start === absent), "Caught up takes a week off the list");
    await M("POST", "/me/programme/caught-up", { week: absent, on: false });
    ok((await mem(M)).catchUp.some((w) => w.start === absent), "Undo puts it back");
    ok((await M("POST", "/me/programme/caught-up", { week: addD(absent, 1) })).s === 400 && (await M("POST", "/me/programme/caught-up", { week: "x" })).s === 400, "only a Monday is a week");
    ok((await O("POST", "/me/programme/caught-up", { week: absent })).s === 200 && !(await pool.query("select 1 from programme_caught where user_id=$1 and gym_id=$2", [O.id, A.gym])).rows[0], "a member of another gym marks it for their own gym only");

    await A("POST", `/coach/programme/${months[2]}/publish`, { published: false }, "unpub2");
    // ---------- in the app (iPhone 13) ----------
    const launch = { ...(SHOTS && process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } } : {}) };
    b = await chromium.launch(launch);
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    errs.length = 0;
    const phone = async (c, scheme = "light") => { const ctx = await b.newContext({ ...devices["iPhone 13"], colorScheme: scheme, ignoreHTTPSErrors: true }); await ctx.addCookies([{ name: "jf_s", value: c.cookie(), url: BASE }]);
      const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); await pg.addInitScript(() => { try { localStorage.setItem("jf.tips.*", "1"); } catch (e) {} }); return pg; };
    const ev = (pg, fn, arg) => pg.evaluate(fn, arg);
    const noSide = (pg) => ev(pg, () => document.documentElement.scrollWidth <= innerWidth + 1);
    const shot = async (pg, name, full) => { if (SHOTS) { await wait(SHOTS && process.env.HTTPS_PROXY ? 1500 : 200); await pg.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: !!full && process.env.PROG_FULL === "1" }); } };
    const quiet = (pg) => ev(pg, () => { try { const k = "jf.tips." + (API.me ? API.me.id : "me"); localStorage.setItem(k, JSON.stringify({ "*": -1 })); } catch (e) {} if (!document.getElementById("sheet").hidden) hideSheet(); });

    // Coach: Schedule → Programme → a week → add a video.
    let pg = await phone(A); await pg.goto(BASE + "/app/#coach-schedule"); await wait(1800); await quiet(pg); await ev(pg, () => render()); await wait(600);
    ok(await ev(pg, () => { const e = document.querySelector(".prgentry"); return !!e && /Programme/.test(e.textContent) && /Wrestling for BJJ/.test(e.textContent); }), "Schedule has a Programme row with this month's theme");
    await pg.click(".prgentry"); await wait(600);
    ok(await ev(pg, (t) => S.ui.sheet && S.ui.sheet.k === "prg" && /Published/.test(document.getElementById("sheet").innerText) && document.querySelectorAll(".prgwk").length === t, nWeeks0), "the planner shows the month, published, a card per week");
    ok(await noSide(pg), "planner: no sideways scroll");
    await shot(pg, "1-coach-planner", true);
    await pg.click('.prgseg [data-v="' + months[1] + '"]'); await wait(700);
    await pg.click('.prgseg [data-v="' + months[2] + '"]'); await wait(700);
    ok(await ev(pg, () => /Draft/.test(document.getElementById("sheet").innerText) && !!document.querySelector('#sheetbar [data-a="prgpub"][data-v="1"]') && document.querySelectorAll(".prgwk .pill.due").length > 0), "a draft month: Publish in the bar, amber Add videos on empty weeks");
    await ev(pg, (m) => prgAct("prgmon", m), months[0]); await wait(700);
    await pg.click(".prgwk >> nth=1"); await wait(500);
    ok(await ev(pg, () => S.ui.sheet.k === "prgwk" && document.querySelectorAll(".prgedv").length === 2), "a week opens with its videos");
    await pg.fill("#prg-url", "https://youtu.be/RgKAFK5djSk?si=share"); await pg.dispatchEvent("#prg-url", "input");
    ok(await ev(pg, () => !document.getElementById("prg-prev").hidden), "a pasted link shows its thumbnail straight away");
    await pg.fill('#prgvform [name="vtitle"]', "Snap down to front headlock"); await pg.fill('#prgvform [name="vnote"]', "3 variations");
    await pg.click('#prgvform [type="submit"]'); await wait(900);
    let p = (await weeksIn(months[0])).programme;
    ok(p.weeks[1].videos.length === 3 && p.weeks[1].videos[2].v === "RgKAFK5djSk" && p.weeks[1].videos[2].title === "Snap down to front headlock", "adding a video in the app saves it: " + JSON.stringify(p.weeks[1].videos.map((v) => v.v)));
    await pg.click('[data-a="prgvmv"][data-v="2:-1"]'); await wait(700);
    p = (await weeksIn(months[0])).programme; ok(p.weeks[1].videos[1].v === "RgKAFK5djSk", "↑ moves it up, saved");
    ok(await noSide(pg), "week editor: no sideways scroll");
    await shot(pg, "2-coach-week-videos", true);
    await pg.fill('#prgwform [name="title"]', "Entries"); await pg.click('#sheetbar [data-a="prgwkdone"]'); await wait(800);
    p = (await weeksIn(months[0])).programme;
    ok(p.weeks[1].title === "Entries" && (await ev(pg, () => S.ui.sheet.k === "prg")), "Done saves the title and goes back to the month");
    // Planning a class in that week: one tap fills the plan.
    await quiet(pg); await ev(pg, (d) => { S.ui.cplan = null; classForm(null, d); }, addD(p.weeks[1].start, 1)); await wait(1200);
    ok(await ev(pg, () => { const h = document.querySelector("#prg-hint .prguse"); return !!h && /Use this week: Entries/.test(h.textContent); }), "a class that week offers Use this week: Entries");
    await pg.click("#prg-hint .prguse"); await wait(300);
    ok(await ev(pg, () => document.getElementById("c-focus").value === "Entries" && S.ui.cplan.ids.includes("double_leg") && /Double/i.test(document.getElementById("cplan-chips").textContent)), "one tap fills the focus and the week's techniques");
    await shot(pg, "3-class-use-this-week");
    await ev(pg, () => { const d = document.getElementById("c-date"); d.value = "2001-01-01"; d.dispatchEvent(new Event("change", { bubbles: true })); }); await wait(900);
    ok(await ev(pg, () => !document.querySelector("#prg-hint .prguse")), "a date with no programme week offers nothing");
    await pg.context().close();

    // Member: Train's This month (an old #learn link lands there), a week, catch-up, Home.
    pg = await phone(M); await pg.goto(BASE + "/app/#learn"); await wait(1800); await quiet(pg); await ev(pg, () => render()); await wait(700);
    const lt = await ev(pg, () => { const h = document.querySelector(".prghero"); return h ? { t: h.innerText, chips: document.querySelectorAll(".prgchip").length, now: !!document.querySelector(".prgchip.now"), done: document.querySelectorAll(".prgchip.done").length, miss: document.querySelectorAll(".prgchip.miss").length, first: document.querySelector("#app .stack-lg > *").classList.contains("prgtop") } : null; });
    ok(lt && /Wrestling for BJJ/.test(lt.t) && lt.chips === nWeeks0 && lt.first, "Train opens with This month at the top, a chip per week: " + JSON.stringify(lt));
    ok(lt && lt.now, "this week's chip says now");
    ok(await ev(pg, () => document.querySelectorAll(".prgweekcard .prgvid").length >= 1 && /This week/.test(document.querySelector(".prgweekcard").textContent)), "this week's videos are one tap away");
    ok(await ev(pg, () => { const c = document.querySelector(".prgcatch"); return !!c && /Catch up/.test(c.textContent) && !!c.querySelector('[data-a="prgcatch"]'); }), "Catch up lists the weeks she missed, with Watch what you missed");
    ok(await ev(pg, (t) => { const n = document.querySelector(".prgnext"); return !!n && n.innerText.includes(t); }, "Guard passing"), "next month's preview card");
    ok(await ev(pg, () => { const top = document.querySelector(".prgtop"), st = document.querySelectorAll(".trainstats"), sw = document.querySelector(".trainseg");
      return S.ui.tab === "train" && location.hash === "#train" && !!top && st.length === 1 && !!sw && !!(top.compareDocumentPosition(st[0]) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(st[0].compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING); }),
      "#learn opens Train: This month first, then one stats block, then Moves | Map | Log");
    ok(await noSide(pg), "Train: no sideways scroll");
    await shot(pg, "4-member-this-month", true);
    await pg.click(".prgchip.now"); await wait(600);
    ok(await ev(pg, () => S.ui.sheet && S.ui.sheet.k === "prgweek" && document.querySelectorAll("#sheet .ytbox, #sheet .ytm").length >= 2 && /This week/.test(document.getElementById("sheet").textContent)), "a week opens with its videos ready to play");
    ok(await ev(pg, () => [...document.querySelectorAll("#sheet iframe")].every((f) => f.src.startsWith("https://www.youtube-nocookie.com/embed/"))), "videos play in YouTube's privacy-enhanced player");
    ok(await noSide(pg), "week sheet: no sideways scroll");
    await shot(pg, "5-member-week-sheet");
    await pg.click('#sheetbar [data-a="back"]'); await wait(400);
    await pg.click('[data-a="prgcatch"]'); await wait(500);
    const before = await ev(pg, () => document.querySelectorAll(".prgcu").length);
    ok(before === (await mem(M)).catchUp.length && before > 0, "Watch what you missed lists each missed week: " + before);
    await shot(pg, "6-member-catch-up", true);
    await pg.click('.prgcu [data-a="prgcaught"] >> nth=0'); await wait(800);
    ok(await ev(pg, () => document.querySelectorAll(".prgcu").length) === before - 1 && (await mem(M)).catchUp.length === before - 1, "Caught up takes it off the list (and stays off)");
    await ev(pg, () => { hideSheet(); go("classes"); }); await wait(1200); // gym updates load with Classes, and show on Home too
    await ev(pg, () => go("home")); await wait(900);
    ok(await ev(pg, () => { const c = document.querySelector(".prghome"); return !!c && /This week/i.test(c.textContent); }), "Home has a small This week card");
    ok(await ev(pg, () => [...document.querySelectorAll(".notice")].some((n) => /programme is up/.test(n.innerText))), "and the gym update that the month is up");
    await shot(pg, "7-member-home");
    await pg.click(".prghome"); await wait(500);
    ok(await ev(pg, () => S.ui.tab === "train" && S.ui.trainView === "moves" && !!document.querySelector(".prghero")), "the Home card opens Train's This month");
    await pg.context().close();
    // Dark mode.
    pg = await phone(M, "dark"); await pg.goto(BASE + "/app/#learn"); await wait(1800); await quiet(pg); await ev(pg, () => render()); await wait(700);
    ok(await ev(pg, () => !!document.querySelector(".prghero") && getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)"), "dark mode: This month shows on a dark page");
    ok(await noSide(pg), "dark mode: no sideways scroll");
    await shot(pg, "8-member-dark", true);
    await pg.context().close();
    ok(!errs.length, "no script errors: " + errs.join(" | "));
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message) + (errs.length ? " | page errors: " + errs.join(" | ") : "")); }
  finally { if (b) await b.close(); srv.kill(); await pool.end(); }
  console.log(`programme: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
