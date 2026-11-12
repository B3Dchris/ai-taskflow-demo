// Makes the pictures and clips for the home page (/) and /coaches/. Run it again after the app's look changes.
//   node tools/landing-media.js                       figures, app screens, technique thumbnails
//   node tools/landing-media.js --reels <folder>      also the screen recordings and the coach stills taken from them
//   node tools/landing-media.js --only figs,screens   just some of: figs, screens, thumbs, reels, chains
// Needs Playwright and ffmpeg. Reads web/app/index.html, so run python3 build.py first.
// Writes (all committed, served as they are):
//   web/img/fig/<position>.svg       the app's own position figure, coloured for the navy cards (you blue, partner grey)
//   web/img/screens/<name>.webp      app screens (iPhone 13 size, 480 px wide): map-walk, technique, belt
//   web/img/thumbs/<move>.webp       400x225 (16:9) card pictures of the technique photos in web/img/techniques/
//   web/video/<name>.mp4 + .webp     the phone screen cut out of a social reel: 600 px wide, H.264, no sound, poster frame
//   web/img/coach/<name>.webp        still coach screens from the same reels (and sm/<name>.webp, 320 px, for the home page)
//   web/data/chains-demo.json        the app's attack chains, with the moves and positions they name (a reference copy;
//                                    the home page no longer typesets them)
"use strict";
const { chromium, devices } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const ROOT = path.resolve(__dirname, ".."), WEB = path.join(ROOT, "web");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = (arg("--only") || "figs,screens,thumbs,reels,chains").split(",");
const REELS = arg("--reels");
const mk = (...p) => { const d = path.join(WEB, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
const kb = (f) => Math.round(fs.statSync(f).size / 1024) + " KB";

// Where the phone's screen sits in the 1080x1920 reels, and where each reel's end card starts (cut before it; the
// social kit's compose step prints it). crf: an H.264 quality override for a clip that would pass 1.5 MB.
const SCREEN = "crop=604:1362:238:418";
const CLIPS = [
  { reel: "r05-moves-and-map", out: "moves-and-map", end: 25.6, crf: 29 }, // the navy map screens need a little more squeeze to stay under 1.5 MB
  { reel: "r01-website-to-ready-gym", out: "website-to-gym", end: 21.9, poster: 13 },
  { reel: "r03-record-a-payment", out: "record-a-payment", end: 16.65 },
  { reel: "r04-book-a-class", out: "book-a-class", end: 18.3 },
];
const STILLS = [ // coach screens from the reels: [reel, second, name]
  ["r01-website-to-ready-gym", 9.6, "website-read"], ["r01-website-to-ready-gym", 21.3, "schedule"],
  ["r03-record-a-payment", 0.5, "money"], ["r03-record-a-payment", 3.5, "reminders"],
];

// Colours on the navy cards (#0E1A33): you in the brand's bright blue, the partner in light slate.
const FIG = { you: "#6E9BFF", them: "#C3CCDD", mat: "#3A4A6B" };

async function figures(p) {
  const out = mk("img", "fig");
  const svgs = await p.evaluate((C) => {
    const L = (pts) => `<polyline points="${pts.map((q) => q.join(",")).join(" ")}"/>`;
    const fig = (f, c) => `<g stroke="${c}" fill="${c}"><g opacity=".5" fill="none">${L([f.n, ...f.a2])}${L([f.p, ...f.l2])}</g>` +
      `<polyline fill="none" stroke-width="11" points="${f.n.join(",")} ${f.p.join(",")}"/><circle stroke="none" cx="${f.h[0]}" cy="${f.h[1]}" r="8"/>` +
      `<g fill="none">${L([f.p, ...f.l1])}${L([f.n, ...f.a1])}</g></g>`;
    const r = {};
    for (const k of Object.keys(POSFIG)) {
      const [scene, me] = POSFIG[k], sc = SCENES[scene], order = sc.order || ["a", "b"];
      const pts = []; ["a", "b"].forEach((x) => { const f = sc[x]; pts.push(f.h, f.n, f.p, ...f.a1, ...f.a2, ...f.l1, ...f.l2); });
      // Same framing as the app's posPic, a little roomier, 4:3 so every card lines up.
      const pad = 16; let x0 = Math.min(...pts.map((q) => q[0])) - pad, x1 = Math.max(...pts.map((q) => q[0])) + pad;
      let y1 = Math.max(114, Math.max(...pts.map((q) => q[1]))) + 10, y0 = Math.min(...pts.map((q) => q[1])) - pad;
      let w = x1 - x0, h = y1 - y0; const want = w * 0.75;
      if (h < want) { y0 -= want - h; h = want; } else { const nw = h / 0.75; x0 -= (nw - w) / 2; w = nw; }
      r[k] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" width="400" height="300">` +
        `<line x1="${x0.toFixed(1)}" y1="114" x2="${(x0 + w).toFixed(1)}" y2="114" stroke="${C.mat}" stroke-width="3" stroke-linecap="round"/>` +
        `<g stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${order.map((x) => fig(sc[x], x === me ? C.you : C.them)).join("")}</g></svg>\n`;
    }
    return r;
  }, FIG);
  for (const [k, s] of Object.entries(svgs)) fs.writeFileSync(path.join(out, k + ".svg"), s);
  console.log(`figures: ${Object.keys(svgs).length} in web/img/fig/`);
}

// The home page's "how it works" screens, in the app's current look with its demo data: a chain walked from standing
// (the path trail on top, their reactions below), a technique with its video, and the belt screen. The video's title strip
// (the creator's title and channel) is hidden, as in the social kit; the thumbnail itself stays.
const WALK = ["snapdown", "fhl_go_behind"]; // standing, snap-down to the front headlock, go behind to their turtle
async function screens(p) {
  const out = mk("img", "screens"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jf-shots-"));
  await p.evaluate(() => {
    const st = P().settings; st.onboarded = true; st.goal = "blue"; st.perWeek = 2; st.days = [1, 3];
    TECH.forEach((t, i) => { if (beltOf(t) === "blue" && i % 7 !== 3) { P().mastery[t.id] = [1, 2, 2, 3, 1, 4, 2][i % 7]; ensureCard(t.id); } });
    // two classes a week for the last eight weeks, so the belt screen has a streak (shown only, not saved)
    S.sessions = Array.from({ length: 16 }, (_, i) => ({ id: "demo" + i, date: addDays(today(), -(Math.floor(i / 2) * 7 + (i % 2) * 2)), mins: 90 }));
    lsSet(tipStore(), Object.fromEntries(Object.keys(TIPS).map((k) => [k, -1]))); // no first-visit tips in the pictures
    hideSheet(); render();
  });
  await p.addStyleTag({ content: ".ytmeta,.ytcap,.ytout{visibility:hidden!important}" });
  const shots = {
    "map-walk": async () => {
      await p.evaluate(() => { S.ui.trail = null; S.ui.flowSel = "standing"; go("learn-map"); });
      for (const id of WALK) { await p.waitForTimeout(300); await p.evaluate((id) => document.querySelector(`.bgo[data-v="${id}"]`).click(), id); }
      await p.waitForTimeout(400);
      await p.evaluate(() => { const r = document.getElementById("chainstage").getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - 12); });
    },
    technique: async () => { await p.evaluate(() => { window.scrollTo(0, 0); techSheet("triangle"); }); },
    belt: async () => { await p.evaluate(() => { hideSheet(); S.ui.belt = "blue"; go("learn-belt"); window.scrollTo(0, 0); }); },
  };
  for (const [k, fn] of Object.entries(shots)) {
    await fn(); await p.waitForTimeout(800);
    await p.evaluate(() => { const t = document.getElementById("toast"); if (t) t.hidden = true; document.querySelectorAll(".fab").forEach((f) => f.remove()); });
    const png = path.join(tmp, k + ".png"); await p.screenshot({ path: png });
    const dst = path.join(out, k + ".webp"); ff("-i", png, "-vf", "scale=480:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "72", "-compression_level", "6", dst);
    console.log(`screen ${k}: ${kb(dst)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The attack chains exactly as the app has them (CHAINS), plus each move's name, category, belt and the positions it
// goes from and to (TECH), and the positions' names (POS). Read-only: nothing in the app changes.
async function chains(p) {
  const data = await p.evaluate(() => {
    const TM = Object.fromEntries(TECH.map((t) => [t.id, t])), ids = new Set();
    const walk = (n) => { ids.add(n.t); (n.k || []).forEach(walk); return [n.t, n.w, ...(n.k || []).map(walk)]; };
    const ch = Object.fromEntries(Object.keys(CHAINS).map((k) => [k, CHAINS[k].map(walk)]));
    const tech = {}; [...ids].sort().forEach((id) => { const t = TM[id]; if (t) tech[id] = { n: t.n, c: t.c, f: t.f, t: t.t, belt: beltOf(t) }; });
    const pos = Object.fromEntries(Object.keys(POS).map((k) => [k, { l: POS[k].l, L: POS[k].L }]));
    return { note: "From the app's CHAINS, TECH and POS (src/app.html). Chain node: [move id, when they..., ...what to switch to]. Made by tools/landing-media.js.", chains: ch, tech, pos };
  });
  const out = path.join(mk("data"), "chains-demo.json");
  // One line per position, move and position name: small, and a diff shows what changed.
  const block = (o) => "{\n" + Object.entries(o).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}";
  fs.writeFileSync(out, `{"note": ${JSON.stringify(data.note)},\n"chains": ${block(data.chains)},\n"tech": ${block(data.tech)},\n"pos": ${block(data.pos)}}\n`);
  console.log(`chains: ${Object.keys(data.chains).length} positions, ${Object.keys(data.tech).length} moves, ${kb(out)}`);
}

// The founder's photos as small 16:9 card pictures (the same shape as a YouTube thumbnail), cropped to the action.
const CROP_Y = { back_control: 0.04, duck_under: 0, hw_guillotine: 0.02, stance_motion: 0.06 }; // top of the crop, as a share of the height; others centred
function thumbs() {
  const src = path.join(WEB, "img", "techniques"), out = mk("img", "thumbs");
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".jpg"))) {
    const id = f.replace(/\.jpg$/, ""), dst = path.join(out, id + ".webp"), y = CROP_Y[id];
    const crop = y == null ? "crop=iw:iw*9/16" : `crop=iw:iw*9/16:0:ih*${y}`;
    ff("-i", path.join(src, f), "-vf", `${crop},scale=400:225:flags=lanczos`, "-c:v", "libwebp", "-quality", "74", "-compression_level", "6", dst);
    console.log(`thumb ${f}: ${kb(dst)}`);
  }
}

function reels() {
  if (!REELS) { console.log("reels: skipped (pass --reels <folder with the r0x-*.mp4 social reels>)"); return; }
  const vd = mk("video"), cd = mk("img", "coach");
  for (const c of CLIPS) {
    const src = path.join(REELS, c.reel + ".mp4"), mp4 = path.join(vd, c.out + ".mp4"), poster = path.join(vd, c.out + ".webp");
    ff("-i", src, "-t", String(c.end), "-an", "-vf", `${SCREEN},scale=600:-2:flags=lanczos,fps=24`, "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-crf", String(c.crf || 26), "-preset", "veryslow", "-tune", "animation", "-movflags", "+faststart", mp4);
    // The poster is the clip's first frame, so nothing jumps when it starts playing, unless that frame is a blank form.
    ff("-ss", String(c.poster || 0), "-i", mp4, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-compression_level", "6", poster);
    console.log(`clip ${c.out}: ${kb(mp4)}, poster ${kb(poster)}`);
  }
  for (const [reel, t, name] of STILLS) {
    const dst = path.join(cd, name + ".webp");
    ff("-ss", String(t), "-i", path.join(REELS, reel + ".mp4"), "-frames:v", "1", "-vf", `${SCREEN},scale=480:-2:flags=lanczos`, "-c:v", "libwebp", "-quality", "78", "-compression_level", "6", dst);
    // and a small one for the home page's gyms band, where they show 160 px wide
    const sm = path.join(mk("img", "coach", "sm"), name + ".webp");
    ff("-i", dst, "-vf", "scale=320:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "74", "-compression_level", "6", sm);
    console.log(`coach still ${name}: ${kb(dst)}, small ${kb(sm)}`);
  }
}

(async () => {
  if (ONLY.includes("thumbs")) thumbs();
  if (ONLY.includes("reels")) reels();
  if (!["figs", "screens", "chains"].some((k) => ONLY.includes(k))) return;
  // Serve web/ the way the site does, without a database, and open the app.
  const port = 18000 + Math.floor(Math.random() * 1000), env = { ...process.env, PORT: String(port) }; delete env.DATABASE_URL;
  const srv = spawn("node", [path.join(ROOT, "server.js")], { env, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${port}/healthz`); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
    const b = await chromium.launch();
    const ctx = await b.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light", serviceWorkers: "block" });
    const p = await ctx.newPage();
    if (ONLY.includes("screens")) {
      // Videos as the app shows them on data saver: the poster with a play button, not YouTube's player (which the pictures can't use).
      await p.addInitScript(() => { try { Object.defineProperty(navigator, "connection", { get: () => ({ saveData: true, effectiveType: "4g", addEventListener() {} }) }); } catch (e) {} });
      // Thumbnails and fonts fetched by Node (it follows HTTPS_PROXY with NODE_USE_ENV_PROXY=1); the browser goes straight there otherwise.
      await p.route(/i\.ytimg\.com|fonts\.(googleapis|gstatic)\.com/, async (r) => {
        try { const x = await fetch(r.request().url(), { headers: { "user-agent": r.request().headers()["user-agent"] } }); if (!x.ok) throw new Error(x.status);
          await r.fulfill({ status: 200, contentType: x.headers.get("content-type") || "", body: Buffer.from(await x.arrayBuffer()), headers: { "access-control-allow-origin": "*" } }); } catch (e) { await r.continue(); }
      });
      await p.route(/youtube(-nocookie)?\.com/, (r) => r.abort());
    }
    await p.goto(`http://localhost:${port}/app/`); await p.waitForFunction(() => typeof SCENES !== "undefined" && typeof render === "function"); await p.waitForTimeout(500);
    if (ONLY.includes("figs")) await figures(p);
    if (ONLY.includes("chains")) await chains(p);
    if (ONLY.includes("screens")) await screens(p);
    await b.close();
  } finally { srv.kill(); }
})();
