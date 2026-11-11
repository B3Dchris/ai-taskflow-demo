// A gym's brand colour, read from its website: the theme-color tag, the home page's own styles and the stylesheets it links.
// Colours are counted (weighted by where they're used), and greys, near-white and near-black are left out. Also: the text colour
// that's readable on a colour, and a colour darkened just enough to carry white button text.
"use strict";

const JF_ACCENT = "#1d4fb5"; // JitsFlow's own blue: used when a site has no colour of its own

/* ---------------- colour maths ---------------- */
const hex2rgb = (h) => { h = String(h).replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const [r, g, b] = c.map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(typeof a === "string" ? hex2rgb(a) : a), y = lum(typeof b === "string" ? hex2rgb(b) : b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t)); // whole numbers, so contrast is checked on the colour as written
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => (v + m) * 255);
}
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ""));
// Greys, near-white and near-black aren't a brand colour.
const neutral = (c) => { const [, s, l] = hsl(c); return s < 0.28 || l > 0.9 || l < 0.1 || (l > 0.82 && s < 0.6); };

// The text colour to put on a colour: white or near-black, whichever reads better (at least 4.5:1 when either can).
function textOn(accent) {
  const c = hex2rgb(accent), w = contrast(c, [255, 255, 255]), k = contrast(c, [17, 23, 34]);
  return w >= 4.5 || w >= k ? "#ffffff" : "#111722";
}
// A button in the gym's colour: white text when the colour is dark enough (darkened a little if needed), else dark text on it.
function button(accent) {
  let c = hex2rgb(isHex(accent) ? accent : JF_ACCENT);
  if (contrast(c, [17, 23, 34]) >= 7 && contrast(c, [255, 255, 255]) < 3) return { bg: rgb2hex(c), fg: "#111722" }; // a light colour (yellow, lime): dark text
  let i = 0; while (contrast(c, [255, 255, 255]) < 4.5 && i++ < 30) c = mix(c, [0, 0, 0], 0.07);
  return { bg: rgb2hex(c), fg: "#ffffff" };
}
// The colour as text or a thin line on white (headings, links): darkened until it reads at 4.5:1.
function ink(accent) { let c = hex2rgb(isHex(accent) ? accent : JF_ACCENT), i = 0; while (contrast(c, [255, 255, 255]) < 4.5 && i++ < 30) c = mix(c, [0, 0, 0], 0.07); return rgb2hex(c); }
// A pale wash of the colour, for backgrounds.
const tint = (accent, t = 0.1) => rgb2hex(mix([255, 255, 255], hex2rgb(isHex(accent) ? accent : JF_ACCENT), t));

/* ---------------- reading colours from CSS ---------------- */
// Website builders and CSS frameworks ship these on every site whether it uses them or not.
const STOCK = new Set(["#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#00d084", "#8ed1fc", "#0693e3", "#9b51e0", "#f78da7", "#abb8c3", "#6ec1e4", "#61ce70", "#54595f",
  "#007bff", "#0d6efd", "#28a745", "#198754", "#dc3545", "#ffc107", "#17a2b8", "#0dcaf0", "#6f42c1", "#6610f2", "#e83e8c", "#d63384", "#fd7e14", "#20c997",
  "#116dff", "#3899ec", "#0000ee", "#551a8b", "#0000ff", "#ff0000", "#00ff00", "#1877f2", "#3b5998", "#1da1f2", "#25d366", "#e1306c", "#c13584", "#ff0050", "#bd081c", "#0077b5", "#4285f4", "#34a853", "#fbbc05", "#ea4335"]);
function parseColour(s) {
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) { const h = m[1]; if (h.length === 4 || h.length === 8) { const a = parseInt(h.length === 4 ? h[3] + h[3] : h.slice(6, 8), 16) / 255; if (a < 0.6) return null; }
    if (![3, 4, 6, 8].includes(h.length)) return null; return hex2rgb(h.length <= 4 ? h.slice(0, 3) : h.slice(0, 6)); }
  m = s.match(/^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i);
  if (m) { if (m[4] !== undefined && Number(m[4]) / (m[5] ? 100 : 1) < 0.6) return null; const c = [m[1], m[2], m[3]].map(Number); return c.every((v) => v <= 255) ? c : null; }
  m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i);
  if (m) { if (m[4] !== undefined && Number(m[4]) / (m[5] ? 100 : 1) < 0.6) return null; return fromHsl(Number(m[1]) % 360, Math.min(1, Number(m[2]) / 100), Math.min(1, Number(m[3]) / 100)); }
  return null;
}
const COLOUR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]{5,60}\)|hsla?\([^)]{5,60}\)/gi;
// How much a colour in this declaration says about the brand.
function weightOf(prop, selector) {
  prop = prop.toLowerCase();
  if (/^--wp--preset|^--bs-|^--e-global-color-(secondary|text)|shadow|^--tw-/.test(prop)) return 0;
  let w = /^--[\w-]*(accent|primary|brand|theme|button|btn|cta|highlight|main)/.test(prop) ? 6 : /^background(-color)?$|^background-image$/.test(prop) ? 3 : prop === "color" ? 1.5 : /^border|^outline|^fill$|^stroke$|^--/.test(prop) ? 1 : 0.5;
  if (/btn|button|cta|accent|primary|brand|nav a|menu|header|\bh1\b|\bh2\b/i.test(selector || "")) w *= 2;
  return w;
}
// Adds every colour in a block of CSS (or a style="" attribute) to the tally.
function tallyCss(css, tally, scale = 1) {
  css = String(css).replace(/\/\*[\s\S]*?\*\//g, " ");
  const add = (prop, value, selector) => {
    const w = weightOf(prop, selector) * scale; if (!w) return;
    for (const tok of value.match(COLOUR_RE) || []) { const c = parseColour(tok.trim()); if (!c || neutral(c)) continue; const hex = rgb2hex(c); if (STOCK.has(hex) && scale < 5) continue; tally.set(hex, (tally.get(hex) || 0) + w); }
  };
  if (!/[{}]/.test(css)) { for (const d of css.split(";")) { const i = d.indexOf(":"); if (i > 0) add(d.slice(0, i).trim(), d.slice(i + 1), ""); } return; }
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) for (const d of m[2].split(";")) { const i = d.indexOf(":"); if (i > 0) add(d.slice(0, i).trim(), d.slice(i + 1), m[1]); }
}
// The colour most used across the tally, after putting near-identical colours together.
function pick(tally) {
  const groups = new Map();
  for (const [hex, w] of tally) { const [h, s, l] = hsl(hex2rgb(hex)); const k = `${Math.round(h / 12)}|${Math.round(l * 6)}|${s > 0.6 ? 1 : 0}`; const g = groups.get(k) || { w: 0, best: hex, bw: 0 }; g.w += w; if (w > g.bw) { g.best = hex; g.bw = w; } groups.set(k, g); }
  const top = [...groups.values()].sort((a, b) => b.w - a.w)[0];
  return top && top.w >= 3 ? top.best : null;
}

/* ---------------- a whole site ---------------- */
// html: the home page; base: its address; get: safeGet from the importer (bounded fetches). Never throws; resolves within budgetMs.
async function fromSite(html, base, { get, budgetMs = 6000, maxSheets = 4 } = {}) {
  const tally = new Map(); html = String(html || "");
  try {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const t = m[0]; if (!/name\s*=\s*["']?(theme-color|msapplication-TileColor)/i.test(t)) continue;
      const c = parseColour(((t.match(/content\s*=\s*["']([^"']+)["']/i) || [])[1] || "").trim());
      if (c && !neutral(c)) { const hex = rgb2hex(c); tally.set(hex, (tally.get(hex) || 0) + 40); }
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) tallyCss(m[1], tally, 1.5);
    for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]{3,600})"/gi)) tallyCss(m[1].replace(/&quot;/g, '"'), tally, 1.5);
    if (get) {
      const hrefs = [];
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const t = m[0]; if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(t)) continue; const h = (t.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (!h || /fonts\.googleapis|font-awesome|fontawesome|bootstrap(\.min)?\.css|jquery|swiper|slick|animate(\.min)?\.css|dashicons|wp-block-library|elementor-icons|\/icons?\//i.test(h)) continue;
        try { hrefs.push(new URL(h.replace(/&amp;/g, "&"), base).href); } catch (e) {} }
      const t0 = Date.now(), left = () => budgetMs - (Date.now() - t0);
      const sheets = await Promise.race([
        Promise.all([...new Set(hrefs)].slice(0, maxSheets).map((u) => get(u, { timeoutMs: Math.max(1000, Math.min(5000, left())), maxBytes: 600000, accept: "text/css,*/*;q=0.5" })
          .then((r) => (r && r.status === 200 ? r.body.toString("utf8") : "")).catch(() => ""))),
        new Promise((r) => setTimeout(() => r([]), Math.max(500, budgetMs))),
      ]);
      for (const css of sheets) if (css) tallyCss(css, tally, 1);
    }
  } catch (e) { /* a colour is a nice-to-have: never fail the import over it */ }
  const accent = pick(tally);
  return accent ? { accent, source: "site" } : { accent: JF_ACCENT, source: "default" };
}

module.exports = { JF_ACCENT, fromSite, tallyCss, pick, parseColour, neutral, contrast, textOn, button, ink, tint, hex2rgb, rgb2hex, isHex };
