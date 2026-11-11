// Makes the pictures and clips for the home page (/) and /coaches/. Run it again after the app's look changes.
//   node tools/landing-media.js                       figures, app screens, technique thumbnails
//   node tools/landing-media.js --reels <folder>      also the screen recordings and the coach stills taken from them
//   node tools/landing-media.js --only figs,screens   just some of: figs, screens, thumbs, reels
// Needs Playwright and ffmpeg. Reads web/app/index.html, so run python3 build.py first.
// Writes (all committed, served as they are):
//   web/img/fig/<position>.svg       the app's own position figure, coloured for the navy cards (you blue, partner grey)
//   web/img/screens/<name>.webp      app screens at 2x (iPhone 13 size): chains, defense, belt, map
//   web/img/thumbs/<move>.webp       560 px thumbnails of the technique photos in web/img/techniques/
//   web/video/<name>.mp4 + .webp     the phone screen cut out of a social reel: 600 px wide, H.264, no sound, poster frame
//   web/img/coach/<name>.webp        still coach screens from the same reels
"use strict";
const { chromium, devices } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const ROOT = path.resolve(__dirname, ".."), WEB = path.join(ROOT, "web");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = (arg("--only") || "figs,screens,thumbs,reels").split(",");
const REELS = arg("--reels");
const mk = (...p) => { const d = path.join(WEB, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: "inherit" });
const kb = (f) => Math.round(fs.statSync(f).size / 1024) + " KB";

// Where the phone's screen sits in the 1080x1920 reels, and where each reel's end card starts (cut before it).
const SCREEN = "crop=604:1362:238:418";
const CLIPS = [
  { reel: "r05-moves-and-map", out: "moves-and-map", end: 21.8 },
  { reel: "r01-website-to-ready-gym", out: "website-to-gym", end: 21.9, poster: 13 },
  { reel: "r03-record-a-payment", out: "record-a-payment", end: 16.6 },
  { reel: "r04-book-a-class", out: "book-a-class", end: 18.3 },
];
const STILLS = [ // coach screens from the reels: [reel, second, name]
  ["r01-website-to-ready-gym", 9.5, "website-read"], ["r01-website-to-ready-gym", 21.3, "schedule"],
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

async function screens(p) {
  const out = mk("img", "screens"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jf-shots-"));
  await p.evaluate(() => {
    const st = P().settings; st.onboarded = true; st.goal = "blue"; st.perWeek = 2; st.days = [1, 3];
    TECH.forEach((t, i) => { if (beltOf(t) === "blue" && i % 7 !== 3) { P().mastery[t.id] = [1, 2, 2, 3, 1, 4, 2][i % 7]; ensureCard(t.id); } });
    lsSet(tipStore(), Object.fromEntries(Object.keys(TIPS).map((k) => [k, -1]))); // no first-visit tips in the pictures
    hideSheet(); render();
  });
  const toHeading = (re) => p.evaluate((src) => { const h = [...document.querySelectorAll("h2.label")].find((x) => new RegExp(src).test(x.textContent)); if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 14); }, re);
  const shots = {
    chains: async () => { await p.evaluate(() => { S.ui.flowSel = "cg_bot"; go("learn-map"); }); await toHeading("Your attack chains"); },
    defense: async () => { await p.evaluate(() => { S.ui.flowSel = "mount_bot"; go("learn-map"); }); await toHeading("Their attacks"); },
    belt: async () => { await p.evaluate(() => { S.ui.belt = "blue"; go("learn-belt"); }); },
    map: async () => { await p.evaluate(() => { S.ui.flowSel = "cg_bot"; go("learn-map"); }); },
  };
  for (const [k, fn] of Object.entries(shots)) {
    await fn(); await p.waitForTimeout(500);
    await p.evaluate(() => { const t = document.getElementById("toast"); if (t) t.hidden = true; document.querySelectorAll(".fab").forEach((f) => f.remove()); });
    const png = path.join(tmp, k + ".png"); await p.screenshot({ path: png });
    const dst = path.join(out, k + ".webp"); ff("-i", png, "-vf", "scale=660:-2:flags=lanczos", "-c:v", "libwebp", "-quality", "78", "-compression_level", "6", dst);
    console.log(`screen ${k}: ${kb(dst)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function thumbs() {
  const src = path.join(WEB, "img", "techniques"), out = mk("img", "thumbs");
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".jpg"))) {
    const dst = path.join(out, f.replace(/\.jpg$/, ".webp"));
    ff("-i", path.join(src, f), "-vf", "scale=560:560:flags=lanczos", "-c:v", "libwebp", "-quality", "74", "-compression_level", "6", dst);
    console.log(`thumb ${f}: ${kb(dst)}`);
  }
}

function reels() {
  if (!REELS) { console.log("reels: skipped (pass --reels <folder with the r0x-*.mp4 social reels>)"); return; }
  const vd = mk("video"), cd = mk("img", "coach");
  for (const c of CLIPS) {
    const src = path.join(REELS, c.reel + ".mp4"), mp4 = path.join(vd, c.out + ".mp4"), poster = path.join(vd, c.out + ".webp");
    ff("-i", src, "-t", String(c.end), "-an", "-vf", `${SCREEN},scale=600:-2:flags=lanczos,fps=24`, "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-crf", "26", "-preset", "veryslow", "-tune", "animation", "-movflags", "+faststart", mp4);
    // The poster is the clip's first frame, so nothing jumps when it starts playing, unless that frame is a blank form.
    ff("-ss", String(c.poster || 0), "-i", mp4, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", "-compression_level", "6", poster);
    console.log(`clip ${c.out}: ${kb(mp4)}, poster ${kb(poster)}`);
  }
  for (const [reel, t, name] of STILLS) {
    const dst = path.join(cd, name + ".webp");
    ff("-ss", String(t), "-i", path.join(REELS, reel + ".mp4"), "-frames:v", "1", "-vf", `${SCREEN},scale=480:-2:flags=lanczos`, "-c:v", "libwebp", "-quality", "78", "-compression_level", "6", dst);
    console.log(`coach still ${name}: ${kb(dst)}`);
  }
}

(async () => {
  if (ONLY.includes("thumbs")) thumbs();
  if (ONLY.includes("reels")) reels();
  if (!ONLY.includes("figs") && !ONLY.includes("screens")) return;
  // Serve web/ the way the site does, without a database, and open the app.
  const port = 18000 + Math.floor(Math.random() * 1000), env = { ...process.env, PORT: String(port) }; delete env.DATABASE_URL;
  const srv = spawn("node", [path.join(ROOT, "server.js")], { env, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${port}/healthz`); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
    const b = await chromium.launch();
    const ctx = await b.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light", serviceWorkers: "block" });
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/app/`); await p.waitForFunction(() => typeof SCENES !== "undefined" && typeof render === "function"); await p.waitForTimeout(500);
    if (ONLY.includes("figs")) await figures(p);
    if (ONLY.includes("screens")) await screens(p);
    await b.close();
  } finally { srv.kill(); }
})();
