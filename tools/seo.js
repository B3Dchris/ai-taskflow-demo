// Builds the public, indexable pages of jitsflow.com from the app's own content:
//   /techniques/ and one page per technique, /positions/ and one per position, /belts/<belt>/, /glossary/,
//   a share-card image per page (/og/...), sitemap.xml, robots.txt and 404.html.
// The app is one JavaScript page that search engines barely see; these pages are what gets found and shared.
// Usage: node tools/seo.js   (run by build.py after dist/jitsflow-claude.html is built; needs Playwright)
"use strict";
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, ".."), WEB = path.join(ROOT, "web");
const SITE = "https://www.jitsflow.com";
const BELTC = { white: "#F4F4F0", blue: "#1F4FB0", purple: "#5E2D8C", brown: "#6A4326", black: "#151515" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…"; };
const write = (rel, body) => { const f = path.join(WEB, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

async function loadData(page) {
  await page.goto("file://" + path.join(ROOT, "dist", "jitsflow-claude.html"));
  await page.waitForFunction(() => typeof TECH !== "undefined" && TECH.length > 0);
  return page.evaluate(() => ({
    tech: TECH.map((t) => ({ ...t, belt: beltOf(t), ov: (typeof OV !== "undefined" && OV[t.id]) || "", vid: vidOf(t.id), def: (defFor(t.id) || {}).id || null })),
    pos: POS, gloss: Array.from(Object.values(GLOSS)), belts: BELT, cats: CATS, pri: PRI,
  }));
}

/* ---------- shared page frame ---------- */
const CSS_VERSION = () => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "src", "site.css"))).digest("hex").slice(0, 8);
function frame({ url, title, desc, image, ld = [], crumbs = [], body, type = "article" }) {
  const canonical = SITE + url;
  const bc = crumbs.length ? { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: SITE + u })) } : null;
  const lds = [...ld, ...(bc ? [bc] : [])].map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#0E1A33">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="JitsFlow">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/icons/favicon.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=Saira+Condensed:wght@700;800&family=Source+Sans+3:wght@400;600;700&display=swap">
<link rel="stylesheet" href="/site.css?v=${CSS_VERSION()}">
${lds}
</head>
<body>
<header class="night"><div class="wrap top"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span>JitsFlow</a>
<nav class="toplinks"><a href="/techniques/">Techniques</a><a href="/positions/">Positions</a><a class="hide-s" href="/glossary/">Glossary</a><a class="btn primary sm" href="/app/" data-ev="open_app">Open the app</a></nav></div></header>
${crumbs.length > 1 ? `<nav class="wrap crumbs" aria-label="Breadcrumb">${crumbs.map(([n, u], i) => i < crumbs.length - 1 ? `<a href="${u}">${esc(n)}</a><span aria-hidden="true">›</span>` : `<span aria-current="page">${esc(n)}</span>`).join("")}</nav>` : ""}
<main class="wrap">
${body}
</main>
<footer><div class="wrap">
<nav class="foot"><a href="/techniques/">All techniques</a><a href="/positions/">Positions</a><a href="/belts/">Belt curriculum</a><a href="/glossary/">Glossary</a><a href="/app/">Open the app</a><a href="/app/?signin=1">Coach sign in</a><a href="#" data-consent-open hidden>Cookie settings</a></nav>
<p>JitsFlow · No-gi technique library and flow map. Train safely, tap early, and check techniques with your coach. Videos are hosted by YouTube and belong to their creators.</p>
<p class="credit">Built and developed by <a href="https://b-3data.com" target="_blank" rel="noopener">b-3data.com</a></p>
</div></footer>
<script>
document.addEventListener("click",function(e){var b=e.target.closest(".vidbtn");if(b){var id=b.getAttribute("data-v");var f=document.createElement("iframe");f.src="https://www.youtube-nocookie.com/embed/"+encodeURIComponent(id)+"?autoplay=1&rel=0&playsinline=1";f.title=b.getAttribute("aria-label");f.allow="autoplay; encrypted-media; picture-in-picture; fullscreen";f.allowFullscreen=true;b.replaceWith(f);window.jfTrack&&jfTrack("video_start",{video_id:id});return}
var s=e.target.closest("[data-share]");if(s){var u=location.href.split("#")[0],t=document.title;if(navigator.share){e.preventDefault();navigator.share({title:t,url:u}).then(function(){window.jfTrack&&jfTrack("share",{method:"native",content_type:s.getAttribute("data-share"),item_id:location.pathname})}).catch(function(){})}else{window.jfTrack&&jfTrack("share",{method:"whatsapp",content_type:s.getAttribute("data-share"),item_id:location.pathname})}return}
var w=e.target.closest("[data-ev]");if(w&&window.jfTrack)jfTrack(w.getAttribute("data-ev"),{from:location.pathname})});
var q=document.getElementById("tq");if(q)q.addEventListener("input",function(){var v=q.value.trim().toLowerCase();document.querySelectorAll("[data-find]").forEach(function(li){li.hidden=!!v&&li.getAttribute("data-find").indexOf(v)<0});document.querySelectorAll("[data-group]").forEach(function(g){g.hidden=!g.querySelector("[data-find]:not([hidden])")})});
</script>
</body>
</html>
`;
}
const shareRow = (kind, text) => `<div class="share"><a class="btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener" data-share="${kind}">Send to a training partner</a></div>`;
const appCta = (href, line) => `<section class="panel cta"><h2>Track it in JitsFlow</h2><p>${line}</p><a class="btn primary" href="${href}" data-ev="open_app">Open in JitsFlow</a><p class="small muted">Free. Works offline at the gym. Add it to your home screen.</p></section>`;

/* ---------- linking glossary terms inside text ---------- */
function termLinker(gloss) {
  const terms = gloss.map((g) => ({ k: g.k, s: slug(g.k), re: new RegExp(`\\b(?:${g.re})\\b`, "i") }));
  return () => {
    const used = new Set();
    return (text) => {
      let out = esc(text); const holes = [];
      for (const t of terms) {
        if (used.has(t.s)) continue;
        const m = out.match(t.re); if (!m) continue;
        used.add(t.s);
        out = out.slice(0, m.index) + `\u0000${holes.length}\u0000` + out.slice(m.index + m[0].length);
        holes.push(`<a class="term" href="/glossary/#${t.s}" title="${esc(clip(gloss.find((g) => g.k === t.k).d, 140))}">${m[0]}</a>`);
      }
      return out.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)]);
    };
  };
}

/* ---------- share-card images ---------- */
function cardHtml({ eyebrow, title, sub, belt }) {
  const bc = BELTC[belt] || "#1D4FB5";
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=Saira+Condensed:wght@700;800&family=Source+Sans+3:wght@600&display=swap">
<style>*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;overflow:hidden;color:#EEF2FA;font-family:"Source Sans 3",sans-serif;
background:#0D1730;
padding:64px 72px;display:flex;flex-direction:column;justify-content:space-between;position:relative}
.top{display:flex;align-items:center;gap:16px;font-family:"Saira Condensed";font-weight:800;font-size:44px;text-transform:uppercase;letter-spacing:.01em}
.mark{width:58px;height:20px;background:#151515;border:2px solid #3A4458;position:relative}.mark:after{content:"";position:absolute;right:8px;top:0;bottom:0;width:16px;background:#B3261E}
.eb{font-family:"IBM Plex Mono";font-size:26px;letter-spacing:.08em;text-transform:uppercase;color:#9FB0D0;margin-bottom:14px}
h1{font-family:"Saira Condensed";font-weight:800;text-transform:uppercase;line-height:.95;font-size:${title.length > 30 ? 92 : title.length > 18 ? 112 : 132}px;max-width:1050px}
.sub{font-size:34px;color:#C9D3E6;margin-top:18px;max-width:1000px}
.foot{display:flex;justify-content:space-between;align-items:center;font-family:"IBM Plex Mono";font-size:24px;color:#9FB0D0}
.belt{position:absolute;left:0;right:0;bottom:0;height:22px;background:${bc}}.belt:after{content:"";position:absolute;right:120px;top:0;bottom:0;width:90px;background:${belt === "black" ? "#B3261E" : "#151515"}}
</style></head><body><div class="top"><span class="mark"></span>JitsFlow</div>
<div><p class="eb">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}</div>
<div class="foot"><span>No-gi technique library</span><span>jitsflow.com</span></div><div class="belt"></div></body></html>`;
}
async function renderCards(page, cards) {
  const manPath = path.join(ROOT, "tools", "og-manifest.json");
  let man = {}; try { man = JSON.parse(fs.readFileSync(manPath, "utf8")); } catch (e) {}
  const next = {}; let made = 0;
  await page.setViewportSize({ width: 1200, height: 630 });
  for (const c of cards) {
    const html = cardHtml(c), h = crypto.createHash("sha256").update(html).digest("hex").slice(0, 16), out = path.join(WEB, c.file);
    next[c.file] = h;
    if (man[c.file] === h && fs.existsSync(out)) continue;
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: "jpeg", quality: 82 });
    made++;
  }
  for (const f of Object.keys(man)) if (!next[f]) { try { fs.unlinkSync(path.join(WEB, f)); } catch (e) {} }
  fs.writeFileSync(manPath, JSON.stringify(next, null, 0) + "\n");
  return made;
}

/* ---------- pages ---------- */
function build(D) {
  const TM = Object.fromEntries(D.tech.map((t) => [t.id, t]));
  // Readable, keyword-rich addresses from names ("Kimura from side control" -> kimura-from-side-control).
  const uniq = (pairs) => { const seen = {}, out = {}; for (const [id, sl] of pairs) { let x = sl || slug(id); if (seen[x]) x = x + "-" + slug(id); seen[x] = 1; out[id] = x; } return out; };
  const tS = uniq(D.tech.map((t) => [t.id, slug(t.n.replace(/&/g, "and"))]));
  const pl = Object.keys(D.pos).map((k) => slug(D.pos[k].l.replace(/'/g, "").replace(/&/g, "and")));
  const pS = uniq(Object.keys(D.pos).map((k, i) => [k, pl.filter((x) => x === pl[i]).length > 1 ? slug(D.pos[k].L.replace(/'/g, "").replace(/&/g, "and")) : pl[i]]));
  const posName = (k) => (D.pos[k] ? D.pos[k].l : k);
  const posLink = (k) => (D.pos[k] ? `<a href="/positions/${pS[k]}/">${esc(D.pos[k].l)}</a>` : esc(k));
  const tLink = (t) => `<a href="/techniques/${tS[t.id]}/">${esc(t.n)}</a>`;
  const beltOrder = ["blue", "purple", "brown", "black"], catOrder = Object.keys(D.cats);
  const linker = termLinker(D.gloss);
  const pages = [], cards = [];
  const add = (url, html, pri) => { pages.push({ url, pri }); write(url.replace(/\/$/, "/index.html").replace(/^\//, ""), html); };

  // --- one page per technique
  for (const t of D.tech) {
    const L = linker(), B = D.belts[t.belt] || { to: cap(t.belt) };
    const isSub = t.t === "sub" || t.c === "sub";
    const from = posName(t.f), to = isSub ? "the finish" : posName(t.t);
    const title = `${t.n}: no-gi ${D.cats[t.c].toLowerCase()} from ${from.toLowerCase()} | JitsFlow`;
    const desc = clip(t.ov || `${t.n}: step-by-step ${D.cats[t.c].toLowerCase()} from ${from}. ${(t.s || [])[0] || ""}`, 158);
    const leadsHere = D.tech.filter((x) => (x.nx || []).includes(t.id));
    const next = (t.nx || []).map((id) => TM[id]).filter(Boolean);
    const def = t.def && TM[t.def];
    const counters = D.tech.filter((x) => x.def === t.id);
    const v = t.vid;
    const img = `/og/t/${tS[t.id]}.jpg`;
    cards.push({ file: img.slice(1), eyebrow: `${B.to} belt · ${D.cats[t.c]}`, title: t.n, sub: isSub ? `Finish from ${from}` : `${from} → ${to}`, belt: t.belt });
    const ld = [{ "@context": "https://schema.org", "@type": "HowTo", name: `How to do the ${t.n} (no-gi)`, description: desc, image: SITE + img,
      step: (t.s || []).map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: s })), }];
    const body = `<article class="stack-lg">
<header class="stack"><p class="eyebrow"><span class="beltdot" style="--bc:${BELTC[t.belt]}"></span><a href="/belts/${t.belt}/">${esc(B.to)} belt</a> · ${esc(D.cats[t.c])} · ${esc(D.pri[t.p])}</p>
<h1>${esc(t.n)}</h1>${t.ov ? `<p class="lead">${L(t.ov)}</p>` : ""}
<p class="flowline">${posLink(t.f)} <span aria-hidden="true">→</span> ${isSub ? "<b>Submission</b>" : posLink(t.t)}</p></header>
${v ? `<figure class="vid"><button class="vidbtn" type="button" data-v="${esc(v.v)}" aria-label="Play video: ${esc(v.title || t.n)}"><img src="https://i.ytimg.com/vi/${esc(v.v)}/hqdefault.jpg" alt="" width="480" height="360" loading="lazy"><span class="play" aria-hidden="true"></span></button>
<figcaption class="small muted">${esc(v.title || "Video")}${v.channel ? " · " + esc(v.channel) : ""} · YouTube${v.nogi === false ? " · shown in the gi; the mechanics carry over" : ""}</figcaption></figure>` : ""}
<section class="stack"><h2>Step by step</h2><ol class="steps">${(t.s || []).map((s) => `<li><span>${L(s)}</span></li>`).join("")}</ol></section>
${(t.d || []).length ? `<section class="stack"><h2>Details that make it work</h2><ul class="ticks">${t.d.map((s) => `<li>${L(s)}</li>`).join("")}</ul></section>` : ""}
${(t.m || []).length ? `<section class="stack"><h2>Common mistakes</h2><ul class="crosses">${t.m.map((s) => `<li>${L(s)}</li>`).join("")}</ul></section>` : ""}
${t.dr ? `<section class="panel"><h2>Drill it</h2><p>${L(t.dr)}</p></section>` : ""}
${next.length ? `<section class="stack"><h2>If it fails, or what comes next</h2><ul class="links">${next.map((x) => `<li>${tLink(x)} <span class="muted small">${esc(D.cats[x.c])} · ${esc(posName(x.f))}</span></li>`).join("")}</ul></section>` : ""}
${leadsHere.length ? `<section class="stack"><h2>Set it up from</h2><ul class="links">${leadsHere.slice(0, 10).map((x) => `<li>${tLink(x)}</li>`).join("")}</ul></section>` : ""}
${def ? `<section class="stack"><h2>How to defend it</h2><p>${tLink(def)}: ${esc(clip(def.ov || (def.s || [])[0], 160))}</p></section>` : ""}
${counters.length ? `<section class="stack"><h2>This defends against</h2><ul class="links">${counters.map((x) => `<li>${tLink(x)}</li>`).join("")}</ul></section>` : ""}
${shareRow("technique", `${t.n} (no-gi), step by step: ${SITE}/techniques/${tS[t.id]}/`)}
${appCta(`/app/?t=${encodeURIComponent(t.id)}`, `Rate how well you know the ${esc(t.n)}, add it to your review queue and see where it fits on the flow map with every attack and escape.`)}
</article>`;
    add(`/techniques/${tS[t.id]}/`, frame({ url: `/techniques/${tS[t.id]}/`, title, desc, image: img, ld, body,
      crumbs: [["JitsFlow", "/"], ["Techniques", "/techniques/"], [`${B.to} belt`, `/belts/${t.belt}/`], [t.n, `/techniques/${tS[t.id]}/`]] }), 0.8);
  }

  // --- technique index
  const tIndex = beltOrder.map((b) => {
    const ts = D.tech.filter((t) => t.belt === b); if (!ts.length) return "";
    return `<section class="stack" data-group><h2><span class="beltdot" style="--bc:${BELTC[b]}"></span><a href="/belts/${b}/">${esc(D.belts[b].from)} to ${esc(D.belts[b].to)} belt</a> <span class="muted small">${ts.length} techniques</span></h2>
${catOrder.map((c) => { const g = ts.filter((t) => t.c === c); return g.length ? `<div class="stack" data-group><h3>${esc(D.cats[c])}</h3><ul class="links cols">${g.map((t) => `<li data-find="${esc((t.n + " " + posName(t.f) + " " + D.cats[t.c]).toLowerCase())}">${tLink(t)} <span class="muted small">${esc(posName(t.f))}</span></li>`).join("")}</ul></div>` : ""; }).join("")}</section>`;
  }).join("");
  cards.push({ file: "og/techniques.jpg", eyebrow: "No-gi technique library", title: `${D.tech.length} techniques`, sub: "White to black belt. Steps, details, mistakes, drills and a video for each.", belt: "blue" });
  add("/techniques/", frame({ url: "/techniques/", type: "website", title: `No-gi BJJ techniques: ${D.tech.length} moves, white to black belt | JitsFlow`,
    desc: `Every no-gi Brazilian Jiu-Jitsu technique from white to black belt: takedowns, guards, passes, sweeps, escapes and submissions, each with steps, key details, common mistakes, a drill and a video.`,
    image: "/og/techniques.jpg", crumbs: [["JitsFlow", "/"], ["Techniques", "/techniques/"]],
    ld: [{ "@context": "https://schema.org", "@type": "ItemList", name: "No-gi BJJ techniques", numberOfItems: D.tech.length, itemListElement: D.tech.map((t, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/techniques/${tS[t.id]}/`, name: t.n })) }],
    body: `<div class="stack-lg"><header class="stack"><p class="eyebrow">Technique library</p><h1>No-gi techniques, white to black belt</h1>
<p class="lead">${D.tech.length} techniques, each with step-by-step instructions, the details that make it work, common mistakes, a drill and a video. Grouped by the belt they're usually expected at.</p>
<input id="tq" type="search" placeholder="Search: kimura, half guard, escape…" aria-label="Search techniques"></header>${tIndex}</div>` }), 0.9);

  // --- positions
  const posKeys = Object.keys(D.pos);
  for (const k of posKeys) {
    const P = D.pos[k], from = D.tech.filter((t) => t.f === k), into = D.tech.filter((t) => t.t === k && t.f !== k);
    const img = `/og/p/${pS[k]}.jpg`;
    cards.push({ file: img.slice(1), eyebrow: "No-gi position", title: P.l, sub: `${from.length} moves from here · ${into.length} ways in`, belt: "blue" });
    const L = linker();
    const byCat = catOrder.map((c) => [c, from.filter((t) => t.c === c)]).filter(([, g]) => g.length);
    add(`/positions/${pS[k]}/`, frame({ url: `/positions/${pS[k]}/`, title: `${P.L}: goals, attacks and escapes in no-gi | JitsFlow`,
      desc: clip(`${P.L}. ${P.g} ${from.length} techniques start here.`, 158), image: img,
      crumbs: [["JitsFlow", "/"], ["Positions", "/positions/"], [P.l, `/positions/${pS[k]}/`]],
      body: `<article class="stack-lg"><header class="stack"><p class="eyebrow">Position</p><h1>${esc(P.L)}</h1><p class="lead">${L(P.g)}</p></header>
${byCat.length ? `<section class="stack"><h2>Moves from here</h2>${byCat.map(([c, g]) => `<div class="stack"><h3>${esc(D.cats[c])}</h3><ul class="links">${g.map((t) => `<li>${tLink(t)}${t.t && t.t !== "sub" && t.t !== k && D.pos[t.t] ? ` <span class="muted small">→ ${esc(posName(t.t))}</span>` : ""}</li>`).join("")}</ul></div>`).join("")}</section>` : ""}
${into.length ? `<section class="stack"><h2>Ways to get here</h2><ul class="links">${into.map((t) => `<li>${tLink(t)} <span class="muted small">from ${esc(posName(t.f))}</span></li>`).join("")}</ul></section>` : ""}
${shareRow("position", `${P.L}: every attack and escape in no-gi: ${SITE}/positions/${pS[k]}/`)}
${appCta("/app/#flow", "See this position on the interactive flow map, with every move in and out, and what to do when each one fails.")}</article>` }), 0.7);
  }
  add("/positions/", frame({ url: "/positions/", type: "website", title: "No-gi BJJ positions, best to worst: the flow map | JitsFlow",
    desc: `The ${posKeys.length} positions of no-gi Brazilian Jiu-Jitsu, from back control to being stuck under mount, with your goal in each and every move in and out.`,
    image: "/og/techniques.jpg", crumbs: [["JitsFlow", "/"], ["Positions", "/positions/"]],
    body: `<div class="stack-lg"><header class="stack"><p class="eyebrow">Positions</p><h1>Know where you are</h1><p class="lead">No-gi positions ranked from best to worst. Each one lists your goal, the moves that start there and the ways to get there.</p></header>
<ul class="poslist">${posKeys.map((k) => `<li><a href="/positions/${pS[k]}/"><b>${esc(D.pos[k].L)}</b><span>${esc(clip(D.pos[k].g, 120))}</span></a></li>`).join("")}</ul></div>` }), 0.8);

  // --- belts
  for (const b of beltOrder) {
    const B = D.belts[b]; if (!B) continue;
    const ts = D.tech.filter((t) => t.belt === b), L = linker();
    const img = `/og/b/${b}.jpg`;
    cards.push({ file: img.slice(1), eyebrow: "No-gi curriculum", title: `${B.from} to ${B.to} belt`, sub: B.time, belt: b });
    add(`/belts/${b}/`, frame({ url: `/belts/${b}/`, title: `How to get your ${B.to.toLowerCase()} belt in no-gi BJJ: the full curriculum | JitsFlow`,
      desc: clip(`What it takes to go from ${B.from.toLowerCase()} to ${B.to.toLowerCase()} belt in no-gi Jiu-Jitsu: ${B.time} ${B.about}`, 158), image: img,
      crumbs: [["JitsFlow", "/"], ["Belts", "/belts/"], [`${B.to} belt`, `/belts/${b}/`]],
      body: `<article class="stack-lg"><header class="stack"><p class="eyebrow"><span class="beltdot" style="--bc:${BELTC[b]}"></span>Curriculum</p><h1>${esc(B.from)} to ${esc(B.to)} belt</h1><p class="lead">${L(B.about)}</p><p class="muted">${esc(B.time)}</p></header>
<section class="stack"><h2>What coaches look for</h2><ul class="ticks">${(B.look || []).map((x) => `<li>${L(x)}</li>`).join("")}</ul></section>
${(B.how || []).length ? `<section class="panel"><h2>How to get there faster</h2><ul class="ticks">${B.how.map((x) => `<li>${L(x)}</li>`).join("")}</ul></section>` : ""}
<section class="stack"><h2>The ${ts.length} techniques</h2>${catOrder.map((c) => { const g = ts.filter((t) => t.c === c); return g.length ? `<div class="stack"><h3>${esc(D.cats[c])}</h3><ul class="links cols">${g.map((t) => `<li>${tLink(t)}</li>`).join("")}</ul></div>` : ""; }).join("")}</section>
${shareRow("belt", `The ${B.from.toLowerCase()} to ${B.to.toLowerCase()} belt no-gi curriculum: ${SITE}/belts/${b}/`)}
${appCta("/app/#learn", `Track every ${B.to.toLowerCase()}-belt technique, see your readiness score and get a weekly study plan built around your weak spots.`)}</article>` }), 0.9);
  }
  add("/belts/", frame({ url: "/belts/", type: "website", title: "No-gi BJJ belt curriculum: white to black belt | JitsFlow",
    desc: "What you need to know at each belt in no-gi Brazilian Jiu-Jitsu, how long it usually takes, and every technique in each stage.", image: "/og/techniques.jpg",
    crumbs: [["JitsFlow", "/"], ["Belts", "/belts/"]],
    body: `<div class="stack-lg"><header class="stack"><p class="eyebrow">Curriculum</p><h1>White to black belt</h1><p class="lead">Four stages, each with what coaches look for and every technique in it.</p></header>
<ul class="poslist">${beltOrder.filter((b) => D.belts[b]).map((b) => `<li><a href="/belts/${b}/"><b><span class="beltdot" style="--bc:${BELTC[b]}"></span>${esc(D.belts[b].from)} to ${esc(D.belts[b].to)}</b><span>${esc(D.belts[b].time)}</span></a></li>`).join("")}</ul></div>` }), 0.8);

  // --- glossary
  const gs = D.gloss.slice().sort((a, b) => a.k.localeCompare(b.k));
  add("/glossary/", frame({ url: "/glossary/", type: "website", title: "BJJ glossary: no-gi terms explained (crossface, underhook, kuzushi…) | JitsFlow",
    desc: `${gs.length} Brazilian Jiu-Jitsu terms in plain English: what a crossface, underhook, frame, shrimp, kesa and more actually mean on the mat.`, image: "/og/techniques.jpg",
    crumbs: [["JitsFlow", "/"], ["Glossary", "/glossary/"]],
    ld: [{ "@context": "https://schema.org", "@type": "DefinedTermSet", name: "JitsFlow BJJ glossary", hasDefinedTerm: gs.map((g) => ({ "@type": "DefinedTerm", name: g.k, description: g.d, url: `${SITE}/glossary/#${slug(g.k)}` })) }],
    body: `<div class="stack-lg"><header class="stack"><p class="eyebrow">Glossary</p><h1>BJJ terms, explained</h1><p class="lead">${gs.length} words you'll hear on the mat, in plain English.</p>
<input id="tq" type="search" placeholder="Search terms" aria-label="Search terms"></header>
<dl class="gloss">${gs.map((g) => `<div data-find="${esc(g.k.toLowerCase())}" id="${slug(g.k)}"><dt>${esc(g.k)}</dt><dd>${esc(g.d)}</dd></div>`).join("")}</dl>
${shareRow("glossary", `BJJ terms explained in plain English: ${SITE}/glossary/`)}</div>` }), 0.7);

  // --- privacy notice
  add("/privacy/", frame({ url: "/privacy/", type: "website", title: "Privacy | JitsFlow", desc: "What JitsFlow stores, why, where, and how to delete it.", image: "/og/home.jpg",
    crumbs: [["JitsFlow", "/"], ["Privacy", "/privacy/"]],
    body: `<article class="stack-lg"><header class="stack"><p class="eyebrow">Privacy</p><h1>Your data</h1><p class="lead">Short version: without an account everything stays on your phone. With an account we keep what's needed to sync your training and run your gym, nothing is sold, and you can delete it all yourself.</p></header>
<section class="stack"><h2>Without an account</h2><p>Your ratings, notes, training log, photos and videos are stored only in your browser on your device. Nothing is sent to us.</p></section>
<section class="stack"><h2>With an account</h2><ul class="ticks"><li>Your name, email and a scrambled (hashed) password, so you can sign in.</li><li>Your technique ratings, settings and training log, so they're on every device.</li><li>If you join a gym: your belt, the classes and private lessons you book and attend, your membership plan, and any payments your coach records. Your coaches can see these.</li><li>If your gym allows it, other members of your gym see your first name, last initial and belt on group classes you've booked. Private lessons are never shown to other members.</li><li>If you add a WhatsApp number, your coaches can see it so they can message you. Other students can't.</li><li>Coaches' gym details, which can be imported from the gym's public website.</li></ul></section>
<section class="stack"><h2>Who else handles it</h2><ul class="ticks"><li>Render hosts the site and database in Frankfurt, Germany.</li><li>Resend sends account emails (welcome, password reset, invites).</li><li>Cloudflare routes traffic and email for jitsflow.com.</li><li>YouTube plays a technique video only when you tap it (in privacy-enhanced mode).</li><li>Anthropic (Claude) reads a gym's public website when a coach imports it, and answers "explain this" questions in the app.</li><li>Google Analytics counts visits and which pages are used, only if you tap Allow. You can change that any time with Cookie settings at the bottom of the page.</li></ul></section>
<section class="stack"><h2>Deleting it</h2><p>Signed in, go to Settings › Your account › Delete account. That removes your account, progress, training log and attendance straight away. Payment records your coach keeps for their gym are unlinked from you. For anything else, email <a href="mailto:hello@jitsflow.com">hello@jitsflow.com</a>.</p></section>
<p class="small muted">Questions or requests under POPIA or GDPR: <a href="mailto:hello@jitsflow.com">hello@jitsflow.com</a>.</p></article>` }), 0.3);

  // --- 404, sitemap, robots
  write("404.html", frame({ url: "/404", type: "website", title: "Page not found | JitsFlow", desc: "That page isn't here.", image: "/og/techniques.jpg",
    body: `<div class="stack-lg"><header class="stack"><p class="eyebrow">404</p><h1>That page isn't here</h1><p class="lead">It may have moved. Try the technique library or open the app.</p></header><p class="row"><a class="btn primary" href="/techniques/">Browse techniques</a><a class="btn" href="/app/">Open the app</a></p></div>` }).replace('<link rel="canonical" href="https://www.jitsflow.com/404">', '<meta name="robots" content="noindex">'));
  const today = new Date().toISOString().slice(0, 10);
  const all = [{ url: "/", pri: 1 }, { url: "/app/", pri: 0.6 }, ...pages];
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${all.map((p) => `<url><loc>${SITE}${p.url}</loc><lastmod>${today}</lastmod><priority>${p.pri.toFixed(1)}</priority></url>`).join("\n")}\n</urlset>\n`);
  write("robots.txt", `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);
  cards.push({ file: "og/home.jpg", eyebrow: "No-gi BJJ study app", title: "Know what to do from every position", sub: `${D.tech.length} techniques, every position, attack chain and escape, white to black belt.`, belt: "black" });
  return { pages: all.length, cards };
}

(async () => {
  fs.copyFileSync(path.join(ROOT, "src", "site.css"), path.join(WEB, "site.css"));
  for (const d of ["techniques", "positions", "belts", "glossary"]) fs.rmSync(path.join(WEB, d), { recursive: true, force: true });
  const b = await chromium.launch(); const page = await b.newPage();
  const D = await loadData(page);
  const { pages, cards } = build(D);
  const made = await renderCards(page, cards);
  fs.writeFileSync(path.join(ROOT, "dist", "counts.json"), JSON.stringify({ techniques: D.tech.length, positions: Object.keys(D.pos).length, terms: D.gloss.length }));
  await b.close();
  console.log(`seo: ${pages} pages in the sitemap, ${cards.length} share cards (${made} redrawn)`);
})().catch((e) => { console.error(e); process.exit(1); });
