// The gym's monthly programme: the head coach (or any coach) plans each month as a theme with up to 5 weekly topics, each with
// YouTube videos in their own words and techniques from the library. Members see the published months from the month they joined
// this gym, next month as a preview once it's out, and a catch-up list of the weeks they didn't train (from attendance).
// Mounted by backend/api.js (mount), which hands over its helpers: every route works on the signed-in person's own gym only.
"use strict";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MAX_WEEKS = 5, MAX_VIDEOS = 12, MAX_IDS = 30;
const LEN = { title: 80, summary: 280, week: 80, note: 280, video: 100, vnote: 120 };
const CATCH_WEEKS = 8; // how far back the catch-up list looks

// "2027-01" → its Mondays ("2027-01-04", …): each starts a week of that month's programme.
function mondays(ym) {
  const [y, m] = ym.split("-").map(Number), out = [];
  for (let d = 1; d <= 31; d++) { const t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCMonth() !== m - 1) break; if (t.getUTCDay() === 1) out.push(t.toISOString().slice(0, 10)); }
  return out;
}
const addMonths = (ym, n) => { const [y, m] = ym.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const addDays = (day, n) => { const t = new Date(day + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (day) => { const t = new Date(day + "T00:00:00Z"); return addDays(day, -((t.getUTCDay() + 6) % 7)); };
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const isMonth = (v) => /^(20[2-9]\d)-(0[1-9]|1[0-2])$/.test(String(v || ""));

// A YouTube link (watch?v=, youtu.be/, /shorts/, /embed/, /live/, m.youtube.com, youtube-nocookie.com) → its 11-character video id.
// Anything else (another site, a playlist or channel link, a look-alike address) → null.
function ytId(s) {
  s = String(s == null ? "" : s).trim();
  if (!s || s.length > 500) return null;
  let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "https://" + s); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  let id = null;
  if (h === "youtu.be") id = u.pathname.split("/")[1];
  else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(h)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else { const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/]+)/); if (m) id = m[2]; }
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
}

function mount(api, h) {
  const { q, wrap, once, fail, clean, needUser, needCoach, isCoach, isHead, tzOf, todayIn, VISIT, dayIn } = h;
  const monthIn = (v) => { if (!isMonth(v)) fail(400, "Pick a month."); return v; };
  const access = async (gymId) => ((await q("select programme_access from gyms where id=$1", [gymId])).rows[0] || {}).programme_access || "all";

  // A month as the app sees it: its weeks with their Mondays. member: weeks with nothing in them are left out.
  function out(row, member) {
    const ym = String(row.month).slice(0, 7), starts = mondays(ym);
    let weeks = (Array.isArray(row.weeks) ? row.weeks : []).slice(0, starts.length).map((w, i) => ({ n: i + 1, start: starts[i], title: w.title || "", note: w.note || "",
      videos: (w.videos || []).map((v) => ({ v: v.v, title: v.title || "", note: v.note || "" })), ids: w.ids || [] }));
    if (member) weeks = weeks.filter((w) => w.title || w.videos.length || w.ids.length);
    return { month: ym, title: row.title, summary: row.summary, published: !!row.published_at, publishedAt: row.published_at || null, updatedAt: row.updated_at, weeks };
  }
  const load = async (gymId, ym) => (await q("select * from programmes where gym_id=$1 and month=$2::date", [gymId, ym + "-01"])).rows[0] || null;

  // What a coach sends for a month: checked, cut to length, links turned into video ids. Weeks: one per Monday at most.
  function readMonth(b, ym) {
    const n = mondays(ym).length, raw = b.weeks === undefined ? [] : b.weeks;
    if (!Array.isArray(raw)) fail(400, "Weeks must be a list.");
    if (raw.length > Math.min(n, MAX_WEEKS)) fail(400, `${monthName(ym)} has ${n} weeks.`);
    const weeks = raw.map((w, i) => {
      if (!w || typeof w !== "object") fail(400, "Bad week.");
      const vids = w.videos === undefined ? [] : w.videos;
      if (!Array.isArray(vids)) fail(400, "Videos must be a list.");
      if (vids.length > MAX_VIDEOS) fail(400, `Up to ${MAX_VIDEOS} videos a week. Week ${i + 1} has ${vids.length}.`);
      const videos = vids.map((v) => {
        if (!v || typeof v !== "object") fail(400, "Bad video.");
        const id = v.url !== undefined && v.url !== "" ? ytId(v.url) : /^[A-Za-z0-9_-]{11}$/.test(String(v.v || "")) ? v.v : null;
        if (!id) fail(400, `Week ${i + 1}: that isn't a YouTube video link. Copy it from YouTube's Share button.`);
        const title = clean(v.title, LEN.video);
        if (!title) fail(400, `Week ${i + 1}: give each video a short title.`);
        return { v: id, title, note: clean(v.note, LEN.vnote) };
      });
      const ids = Array.isArray(w.ids) ? [...new Set(w.ids.map((x) => String(x || "")).filter((x) => /^[a-z0-9_]{1,64}$/.test(x)))].slice(0, MAX_IDS) : [];
      return { title: clean(w.title, LEN.week), note: clean(w.note, LEN.note), videos, ids };
    });
    return { title: clean(b.title, LEN.title), summary: clean(b.summary, LEN.summary), weeks: [...weeks, ...blank(ym).slice(weeks.length)] };
  }
  // Empty weeks up to the month's Mondays, so the planner always shows every week.
  const blank = (ym) => mondays(ym).slice(0, MAX_WEEKS).map(() => ({ title: "", note: "", videos: [], ids: [] }));

  // ---------- reading a month ----------
  // Coaches: the month with drafts, the three months around now (for the switcher), and whether last month has one to copy.
  // Members: a published month from the month they joined (or next month, as a preview), what they trained, and their catch-up list.
  api.get("/programme", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ programme: null });
    const today = await todayIn(u), cur = today.slice(0, 7), ym = req.query.month ? monthIn(req.query.month) : cur, acc = await access(u.gym_id);
    if (isCoach(u)) {
      const row = await load(u.gym_id, ym);
      const near = (await q("select to_char(month,'YYYY-MM') as m, title, published_at from programmes where gym_id=$1 and month between $2::date and $3::date order by month",
        [u.gym_id, addMonths(cur, -1) + "-01", addMonths(cur, 1) + "-01"])).rows;
      const prev = await load(u.gym_id, addMonths(ym, -1));
      return res.json({ month: ym, today, coach: true, canDelete: isHead(u), access: acc, programme: row ? out(row) : null,
        months: near.map((r) => ({ month: r.m, title: r.title, published: !!r.published_at })), prev: prev ? { month: addMonths(ym, -1), title: prev.title, weeks: (prev.weeks || []).length } : null });
    }
    const joined = dayIn(u.gym_joined_at || u.created_at || new Date(), tzOf(u)), from = joined.slice(0, 7), next = addMonths(cur, 1);
    const sees = acc === "all";
    const row = sees && ym >= from && ym <= next ? await load(u.gym_id, ym) : null;
    const prog = row && row.published_at ? out(row, true) : null;
    const nx = sees && ym === cur ? await load(u.gym_id, next) : null;
    // Weeks they trained: a check-in, or a booking for a class without a register (the app's usual rule), in classes that have started.
    const mon = mondayOf(today), back = addDays(mon, -7 * CATCH_WEEKS), first = prog && prog.weeks[0] ? prog.weeks[0].start : mon;
    const since = [back, first, mondayOf(joined)].sort()[0];
    const trained = (await q(`select distinct to_char(date_trunc('week', c.starts_at at time zone $3),'YYYY-MM-DD') as wk from attendance a join classes c on c.id=a.class_id
      where a.user_id=$1 and c.gym_id=$2 and ${VISIT("a", "c")} and c.starts_at >= ($4::date - 1) and c.starts_at < now()`, [u.id, u.gym_id, tzOf(u), since])).rows.map((r) => r.wk);
    const caught = (await q("select to_char(week,'YYYY-MM-DD') as w from programme_caught where user_id=$1 and gym_id=$2 and week >= $3::date - 7", [u.id, u.gym_id, since])).rows.map((r) => r.w);
    // Catch up: published weeks with something to watch, from the week they joined to last week (the last 8 weeks), that they didn't train or mark caught up.
    const catchUp = [];
    if (sees) {
      const lo = [back, mondayOf(joined)].sort()[1], rows = (await q(`select * from programmes where gym_id=$1 and published_at is not null and month between $2::date and $3::date order by month`,
        [u.gym_id, lo.slice(0, 7) + "-01", cur + "-01"])).rows;
      for (const r of rows) for (const w of out(r, true).weeks) {
        if (w.start < lo || w.start >= mon || trained.includes(w.start) || caught.includes(w.start) || !(w.videos.length || w.ids.length)) continue;
        catchUp.push({ month: out(r).month, monthTitle: r.title, n: w.n, start: w.start, title: w.title, note: w.note, videos: w.videos, ids: w.ids });
      }
    }
    res.json({ month: ym, today, joined: from, access: sees ? "all" : "none", programme: prog,
      next: nx && nx.published_at ? { month: next, title: nx.title, summary: nx.summary } : null, trained, caught, catchUp });
  }));

  // ---------- planning (any coach; deleting a month is the head coach's) ----------
  // Saves the whole month (title, summary, weeks). was: the updatedAt the coach loaded, so two coaches don't undo each other.
  api.put("/coach/programme/:month", wrap(async (req, res) => {
    const u = needCoach(req), ym = monthIn(req.params.month), b = req.body || {}, m = readMonth(b, ym), cur = await load(u.gym_id, ym);
    if (cur && b.was && new Date(b.was).getTime() !== new Date(cur.updated_at).getTime()) return res.status(409).json({ error: "Another coach changed this month while you had it open. It's updated now: check it and try again.", programme: out(cur) });
    const r = await q(`insert into programmes(gym_id,month,title,summary,weeks,updated_by) values($1,$2::date,$3,$4,$5::jsonb,$6)
      on conflict(gym_id,month) do update set title=excluded.title, summary=excluded.summary, weeks=excluded.weeks, updated_by=excluded.updated_by, updated_at=clock_timestamp() returning *`,
    [u.gym_id, ym + "-01", m.title, m.summary, JSON.stringify(m.weeks), u.id]);
    res.json({ programme: out(r.rows[0]) });
  }));
  // Publish (members see it, and get one notice the first time) or take it back to a draft (published: false).
  api.post("/coach/programme/:month/publish", once(async (req, res) => {
    const u = needCoach(req), ym = monthIn(req.params.month), cur = await load(u.gym_id, ym), on = req.body?.published !== false;
    if (!cur) fail(404, `Nothing planned for ${monthName(ym)} yet.`);
    if (on && !cur.title) fail(400, "Give the month a title first.");
    let row = (await q(`update programmes set published_at=case when $2 then coalesce(published_at, now()) end, updated_at=clock_timestamp() where id=$1 returning *`, [cur.id, on])).rows[0];
    let told = false;
    if (on && !row.notice_id) {
      const n = (await q("insert into notices(gym_id,user_id,kind,title,body) values($1,null,'programme',$2,$3) returning id",
        [u.gym_id, `${monthName(ym)}'s programme is up: ${row.title}`, row.summary || "See the weeks and videos in Learn."])).rows[0].id;
      row = (await q("update programmes set notice_id=$2 where id=$1 returning *", [row.id, n])).rows[0]; told = true;
    }
    res.json({ programme: out(row), told });
  }));
  // Start a month from last month's: the same weeks, with their titles and notes (no videos or techniques), as a draft.
  api.post("/coach/programme/:month/copy", once(async (req, res) => {
    const u = needCoach(req), ym = monthIn(req.params.month), pm = addMonths(ym, -1), prev = await load(u.gym_id, pm), cur = await load(u.gym_id, ym);
    if (!prev) fail(404, `There's nothing in ${monthName(pm)} to copy.`);
    if (cur && (cur.title || (cur.weeks || []).some((w) => w.title || (w.videos || []).length || (w.ids || []).length))) fail(409, `${monthName(ym)} already has a plan.`);
    const weeks = blank(ym).map((w, i) => { const p = (prev.weeks || [])[i]; return p ? { ...w, title: p.title || "", note: p.note || "" } : w; });
    const r = await q(`insert into programmes(gym_id,month,title,summary,weeks,updated_by) values($1,$2::date,'','',$3::jsonb,$4)
      on conflict(gym_id,month) do update set weeks=excluded.weeks, updated_by=excluded.updated_by, updated_at=clock_timestamp() returning *`, [u.gym_id, ym + "-01", JSON.stringify(weeks), u.id]);
    res.json({ programme: out(r.rows[0]), from: pm });
  }));
  api.delete("/coach/programme/:month", wrap(async (req, res) => {
    const u = needCoach(req); if (!isHead(u)) fail(403, "Only the head coach can delete a month.");
    const ym = monthIn(req.params.month), r = (await q("delete from programmes where gym_id=$1 and month=$2::date returning notice_id", [u.gym_id, ym + "-01"])).rows[0];
    if (!r) fail(404, `Nothing planned for ${monthName(ym)}.`);
    if (r.notice_id) await q("delete from notices where id=$1 and gym_id=$2 and kind='programme'", [r.notice_id, u.gym_id]);
    res.json({ ok: true });
  }));

  // ---------- members: "Caught up" takes a missed week off their catch-up list (on: false puts it back) ----------
  api.post("/me/programme/caught-up", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const w = String(req.body?.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w) || isNaN(new Date(w + "T00:00:00Z")) || mondayOf(w) !== w) fail(400, "Pick a week.");
    if (req.body?.on === false) await q("delete from programme_caught where user_id=$1 and gym_id=$2 and week=$3::date", [u.id, u.gym_id, w]);
    else await q("insert into programme_caught(user_id,gym_id,week) values($1,$2,$3::date) on conflict do nothing", [u.id, u.gym_id, w]);
    res.json({ ok: true });
  }));
}

module.exports = { mount, ytId, mondays };
