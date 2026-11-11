// Outreach to gyms: a private preview of a gym on JitsFlow (made from its public website by the importer), the email that
// introduces it to the gym's owner, and the public preview page at /try/<token> where the owner claims it in one step.
// Platform admins (JF_ADMIN_EMAILS) make and send these from the app; the admin routes are in api.js.
"use strict";
const crypto = require("crypto");
const express = require("express");
const brand = require("./brand");
const payfast = require("./payfast");
const importer = require("./importer");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], DAYL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TZ = "Africa/Johannesburg";
const FOLLOWUP_DAYS = 5;

/* ---------------- who's a platform admin ---------------- */
// JF_ADMIN_EMAILS: comma-separated addresses, any case. Nobody is an admin when it isn't set.
const adminEmails = () => [...new Set(String(process.env.JF_ADMIN_EMAILS || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
const isAdmin = (email) => !!email && adminEmails().includes(String(email).trim().toLowerCase());

/* ---------------- small helpers ---------------- */
const newToken = () => crypto.randomBytes(24).toString("base64url"); // 192 bits, 32 characters
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
function domainOf(u) { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; } }
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const rand = (cents) => "R" + (cents % 100 ? (cents / 100).toFixed(2) : String(Math.round(cents / 100)));
const PERIOD = { month: "a month", week: "a week", class: "a class", year: "a year", term: "a term", once: "once-off", other: "" };
function priceOf(r) {
  const n = Number(r.price) || 0, cur = (r.currency || "ZAR").toUpperCase();
  let amt; if (cur === "ZAR") amt = "R" + (n % 1 ? n.toFixed(2) : n.toLocaleString("en-ZA").replace(/,/g, " ")); else { try { amt = new Intl.NumberFormat("en-ZA", { style: "currency", currency: cur, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch (e) { amt = `${cur} ${n}`; } }
  return `${amt}${PERIOD[r.period] ? " " + PERIOD[r.period] : ""}`;
}
// "Free for 3 months, then R99 a month." and the card fee, from the plan settings in payfast.js.
function priceLine() {
  const m = payfast.TRIAL_MONTHS();
  return { main: `Free for ${m} month${m === 1 ? "" : "s"}, then ${rand(payfast.PRICE_CENTS())} a month.`, fee: payfast.platform().sandbox ? "" : `Members who pay by card in the app pay a ${payfast.FEE_PCT()}% fee on that payment. EFT and cash cost nothing extra.`, months: m };
}
// Lines pasted by the admin: "jpbuys.com/academy", or with the owner: "jpbuys.com, JP Buys, jp@example.com" (any order, commas or tabs).
function parseLines(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const email = (line.match(/[^\s,;<>()"']+@[^\s,;<>()"']+\.[a-z]{2,24}/i) || [""])[0];
    const rest = line.replace(email, " ");
    const url = (rest.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d+)?(?:\/[^\s,;]*)?|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s,;]*)?/i) || [""])[0];
    const name = rest.replace(url, " ").replace(/[<>()"'|\t,;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    out.push({ line: line.slice(0, 300), url, name, email: email.toLowerCase() });
  }
  return out;
}
// Width and height from an image's header, so the email can say how big the logo is (Outlook needs it).
function imageSize(buf, type) {
  try {
    if (!buf) return null;
    if (type === "image/png" && buf.length > 24) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (type === "image/gif" && buf.length > 10) return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    if (type === "image/jpeg") { let i = 2; while (i + 9 < buf.length) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; i += 2 + len; } }
    if (type === "image/webp" && buf.length > 30) { const f = buf.toString("ascii", 12, 16);
      if (f === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (f === "VP8L") { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
      if (f === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)]; }
  } catch (e) { /* unreadable header: no size */ }
  return null;
}
// The logo's size on screen: at most maxH tall and maxW wide, keeping its shape.
function logoBox(p, maxH, maxW) {
  const s = imageSize(p.logo, p.logo_type); if (!s || !s[0] || !s[1]) return { w: maxH, h: maxH };
  let h = maxH, w = Math.round((maxH * s[0]) / s[1]); if (w > maxW) { w = maxW; h = Math.round((maxW * s[1]) / s[0]); }
  return { w, h };
}
// The logo for emails: PNG or JPEG when the site will give one (Outlook doesn't show WebP), else what the import found.
async function pickLogo(logos) {
  const top = (logos || [])[0]; if (!top) return null;
  for (let i = 0; i < 2; i++) { // image CDNs sometimes send WebP anyway on the first ask
    try { const img = await importer.fetchImage(top.url, 800000, "image/png,image/jpeg;q=0.9,image/gif;q=0.5"); if (img && /png|jpeg|gif/.test(img.type)) return img; } catch (e) { break; }
  }
  const m = String(top.dataUrl || "").match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  return m ? { type: m[1], body: Buffer.from(m[2], "base64") } : null;
}

/* ---------------- what the preview and the email show ---------------- */
const accentOf = (p) => (brand.isHex(p.accent) ? p.accent.toLowerCase() : brand.JF_ACCENT);
const nameOf = (p) => String((p.profile && p.profile.name) || p.name || p.domain || "Your gym").trim();
const ttOf = (p) => ((p.profile && p.profile.timetable) || []).filter((r) => r && DAYS.includes(r.day) && /^\d\d:\d\d$/.test(r.start || ""))
  .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start));
// The coming week in South Africa, from today: each day's label and whether it's today (what the members' Classes screen shows).
function weekOf(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((x) => [x.type, x.value]));
  const today = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)), dow = (new Date(today).getUTCDay() + 6) % 7;
  return [0, 1, 2, 3, 4, 5, 6].map((k) => { const i = (dow + k) % 7, x = new Date(today + k * 864e5); return { day: DAYS[i], name: k === 0 ? "Today" : k === 1 ? "Tomorrow" : DAYL[i], date: `${x.getUTCDate()} ${MON[x.getUTCMonth()]}`, today: k === 0 }; });
}
// A handful of their classes for the email: different classes first, spread over the week, in week order.
function sampleClasses(p, n = 6) {
  const rows = ttOf(p), out = [], seen = new Set(), days = new Set(), key = (r) => String(r.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const r of rows) { if (out.length >= n) break; if (!seen.has(key(r)) && !days.has(r.day)) { out.push(r); seen.add(key(r)); days.add(r.day); } }
  for (const r of rows) { if (out.length >= n) break; if (!out.includes(r) && !seen.has(key(r))) { out.push(r); seen.add(key(r)); } }
  for (const r of rows) { if (out.length >= Math.min(n, 4)) break; if (!out.includes(r)) out.push(r); }
  return out.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start));
}
const classLine = (r) => [r.level && !new RegExp(r.level.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(r.title) ? r.level : "", r.coach ? (/^coach\b/i.test(r.coach) ? r.coach : "Coach " + r.coach) : ""].filter(Boolean).join(" · ");
const initials = (n) => String(n || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();

/* ---------------- the email ---------------- */
const BENEFITS = [
  "Members book classes and check in on their phones. No more headcounts on WhatsApp.",
  "Fees keep a running balance, and reminders go out by themselves.",
  "Members send their EFT proof of payment in the app. You just tick it off.",
  "Kids and families share one parent login.",
  "Bring your members over from your WhatsApp group in a few taps.",
];
const defaultSubject = (p) => `${nameOf(p)} is already set up on JitsFlow`;
const tryUrl = (p, base) => `${base}/try/${p.token}`;
const optoutUrl = (p, base) => `${base}/try/${p.token}/optout`;
// One email, used for sending, copying and showing it to the admin. p: the prospect row; admin: { name, email }; base: the app's address.
// followup: the one reminder sent 5 or more days later.
function renderEmail(p, { admin = {}, base = "https://www.jitsflow.com", followup = false } = {}) {
  const gym = nameOf(p), acc = accentOf(p), btn = brand.button(acc), onBand = brand.textOn(acc), inkAcc = brand.ink(acc), url = tryUrl(p, base), out = optoutUrl(p, base);
  const sender = String(admin.name || "The JitsFlow team").trim(), who = first(p.owner_name), hi = who ? `Hi ${who},` : "Hi there,";
  const personal = String(p.personal_line || "").trim(), price = priceLine(), classes = followup ? [] : sampleClasses(p, 6);
  const subject = followup ? `Re: ${String(p.subject || "").trim() || defaultSubject(p)}` : String(p.subject || "").trim() || defaultSubject(p);
  const headline = followup ? `Did you see ${gym} on JitsFlow?` : ttOf(p).length ? `${gym}, your timetable is already on JitsFlow` : `${gym}, your gym is already on JitsFlow`;
  const intro = followup
    ? [`A quick follow-up on my earlier email. The page I made for ${gym} is still there, with your classes in it.`, `It's ${price.main.charAt(0).toLowerCase() + price.main.slice(1, -1)}, and one step makes it yours. If it's not for you, no problem: I won't email again.`]
    : [`I'm ${first(sender) || sender} from JitsFlow. I used ${ttOf(p).length ? "the classes" : "what's"} on your website to set ${gym} up on JitsFlow, so you can see what your members would get before you decide anything.`];
  const preheader = followup ? `${gym}'s page is still there if you'd like a look.` : `Your classes are already in. Have a look: it takes a minute.`;
  const F = "Arial,Helvetica,sans-serif", INK = "#111722", INK2 = "#4e5869", LINE = "#dfe4ec", BG = "#eef1f5";
  const P = (t, extra = "") => `<p style="margin:0 0 14px;font-family:${F};font-size:16px;line-height:1.55;color:${INK};${extra}">${t}</p>`;
  const box = p.logo ? logoBox(p, 52, 180) : null;
  const logoCell = box ? `<td style="vertical-align:middle;padding:0 14px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:10px;padding:5px;line-height:0;font-size:0">`
    + `<img src="${esc(base)}/try/${esc(p.token)}/logo" width="${box.w}" height="${box.h}" alt="${esc(gym)}" style="display:block;width:${box.w}px;height:${box.h}px;border:0;border-radius:6px;outline:none;text-decoration:none"></td></tr></table></td>` : "";
  const table = classes.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border:1px solid ${LINE};border-radius:10px;border-collapse:separate">
<tr><td colspan="3" style="padding:12px 14px 8px;font-family:${F};font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${inkAcc}">On your timetable</td></tr>
${classes.map((r, i) => `<tr><td style="padding:8px 0 8px 14px;border-top:1px solid ${LINE};font-family:${F};font-size:15px;color:${INK2};white-space:nowrap;width:44px">${esc(r.day)}</td><td style="padding:8px 10px;border-top:1px solid ${LINE};font-family:${F};font-size:15px;color:${INK2};white-space:nowrap;width:52px">${esc(r.start)}</td><td style="padding:8px 14px 8px 0;border-top:1px solid ${LINE};font-family:${F};font-size:15px;font-weight:700;color:${INK}">${esc(r.title)}${i === classes.length - 1 && ttOf(p).length > classes.length ? `<span style="font-weight:400;color:${INK2}"> and ${ttOf(p).length - classes.length} more</span>` : ""}</td></tr>`).join("\n")}
</table>` : "";
  const benefits = followup ? "" : `${P("<b>Less admin for you:</b>", "margin-bottom:8px")}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px">
${BENEFITS.map((b) => `<tr><td style="vertical-align:top;padding:3px 10px 5px 0;font-family:${F};font-size:16px;line-height:1.45;font-weight:700;color:${inkAcc}">&#10003;</td><td style="padding:3px 0 5px;font-family:${F};font-size:15px;line-height:1.45;color:${INK}">${esc(b)}</td></tr>`).join("\n")}
</table>${P(`<b>${esc(price.main)}</b> No card needed to start.`)}`;
  const label = `See ${gym} on JitsFlow`, vmlW = Math.min(520, Math.max(260, Math.round(label.length * 9.4) + 56));
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px"><tr><td align="center" bgcolor="${btn.bg}" style="border-radius:10px;background:${btn.bg}">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(url)}" style="height:50px;v-text-anchor:middle;width:${vmlW}px" arcsize="20%" stroke="f" fillcolor="${btn.bg}"><w:anchorlock/><center style="color:${btn.fg};font-family:${F};font-size:17px;font-weight:bold">${esc(label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${esc(url)}" style="display:inline-block;padding:15px 24px;font-family:${F};font-size:17px;line-height:1.25;font-weight:700;color:${btn.fg};text-decoration:none;border-radius:10px;background:${btn.bg}">${esc(label)}</a><!--<![endif]-->
</td></tr></table>`;
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${esc(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>:root{color-scheme:light only;supported-color-schemes:light only}@media (max-width:620px){.px{padding-left:20px!important;padding-right:20px!important}.h1{font-size:23px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${BG}" bgcolor="${BG}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${BG}">${esc(preheader)}${"&#8199;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="background:${BG}"><tr><td align="center" style="padding:24px 10px">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
<tr><td bgcolor="${acc}" class="px" style="background:${acc};border-radius:14px 14px 0 0;padding:20px 28px">
 <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logoCell}<td style="vertical-align:middle;font-family:${F};font-size:18px;line-height:1.3;font-weight:700;color:${onBand}">${esc(gym)}</td></tr></table>
</td></tr>
<tr><td bgcolor="#ffffff" class="px" style="background:#ffffff;border-radius:0 0 14px 14px;padding:28px 28px 8px">
 <h1 class="h1" style="margin:0 0 18px;font-family:${F};font-size:26px;line-height:1.2;font-weight:800;color:${INK}">${esc(headline)}</h1>
 ${P(esc(hi))}
 ${personal ? P(esc(personal)) : ""}
 ${intro.map((t) => P(esc(t))).join("\n ")}
 ${table}
 ${benefits}
 ${button}
 ${P(`Thanks,<br>${esc(sender)}<br><span style="color:${INK2};font-size:14px">JitsFlow &middot; <a href="${esc(base)}/" style="color:${INK2}">jitsflow.com</a></span>`)}
</td></tr>
<tr><td class="px" style="padding:16px 28px 8px;font-family:${F};font-size:12px;line-height:1.55;color:${INK2}">
 I found ${esc(gym)} on your public website (${esc(p.domain)}) and I'm writing to you directly. If you'd rather not hear from me, <a href="${esc(out)}" style="color:${INK2};text-decoration:underline">opt out here</a> and I'll delete the page I made.
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
  const text = [headline, "", hi, ...(personal ? ["", personal] : []), ...intro.flatMap((t) => ["", t]),
    ...(classes.length ? ["", "On your timetable:", ...classes.map((r) => `${r.day} ${r.start}  ${r.title}`), ...(ttOf(p).length > classes.length ? [`and ${ttOf(p).length - classes.length} more`] : [])] : []),
    ...(followup ? [] : ["", "Less admin for you:", ...BENEFITS.map((b) => "- " + b), "", `${price.main} No card needed to start.`]),
    "", `${label}: ${url}`, "", "Thanks,", sender, `JitsFlow · ${base}`, "", "--",
    `I found ${gym} on your public website (${p.domain}) and I'm writing to you directly. If you'd rather not hear from me, opt out here and I'll delete the page I made: ${out}`].join("\n");
  return { subject, html, text, preheader };
}

/* ---------------- the public pages ---------------- */
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@700;800&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">`;
const BASE_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#f3f5f8;color:#111722;font:17px/1.5 'Source Sans 3',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
a{color:var(--ink-acc)}.wrap{max-width:1080px;margin:0 auto;padding:0 16px}h1,h2{font-family:'Saira Condensed','Arial Narrow',Arial,sans-serif;font-weight:800;line-height:1.05;margin:0;letter-spacing:.005em}
.btn{display:inline-block;background:var(--btn);color:var(--on);font-weight:700;font-size:18px;line-height:1.25;text-decoration:none;padding:16px 22px;border-radius:12px;border:0;cursor:pointer;text-align:center;font-family:inherit}
.btn:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--ink-acc);outline-offset:3px}.small{font-size:15px;color:#4e5869}.muted{color:#4e5869}`;
function shell({ title, accent, body, extraCss = "", script = "" }) {
  const acc = brand.isHex(accent) ? accent : brand.JF_ACCENT, b = brand.button(acc);
  return `<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="${acc}">
<title>${esc(title)}</title><link rel="icon" href="/icons/icon-192.png">${FONTS}
<style>:root{--acc:${acc};--btn:${b.bg};--on:${b.fg};--on-acc:${brand.textOn(acc)};--ink-acc:${brand.ink(acc)};--tint:${brand.tint(acc, 0.09)};color-scheme:light}${BASE_CSS}${extraCss}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}
const SIMPLE_CSS = `.simple{max-width:560px;margin:12vh auto 0;padding:0 16px}.simple h1{font-size:40px;margin-bottom:12px}.simple p{margin:0 0 16px}.simple form{margin:20px 0}`;
function simplePage(title, h1, paras, { accent, extra = "" } = {}) {
  return shell({ title, accent, extraCss: SIMPLE_CSS, body: `<main class="simple"><h1>${esc(h1)}</h1>${paras.map((t) => `<p>${t}</p>`).join("")}${extra}<p class="small"><a href="/">jitsflow.com</a></p></main>` });
}
const notFoundPage = () => simplePage("Page not found · JitsFlow", "This page isn't here", ["The link may be old, or the page was removed. If you were sent it about your gym, reply to that email and we'll sort it out."]);

// The preview: the gym's own look, what its members would see on their phones, and one button to claim it.
function renderPreview(p, { base = "", now = new Date() } = {}) {
  const gym = nameOf(p), acc = accentOf(p), tt = ttOf(p), week = weekOf(now), price = priceLine(), prof = p.profile || {};
  const claim = `${base}/app/?claimgym=${encodeURIComponent(p.token)}`, cta = `Claim ${gym}, free for ${price.months} month${price.months === 1 ? "" : "s"}`;
  const logo = p.logo ? `${base}/try/${esc(p.token)}/logo` : null, lb = p.logo ? logoBox(p, 40, 150) : null, lbs = p.logo ? logoBox(p, 32, 110) : null;
  const MAX = 10; let shown = 0;
  const days = week.map((d) => ({ ...d, rows: tt.filter((r) => r.day === d.day) })).filter((d) => d.rows.length);
  const dayHtml = days.map((d) => { if (shown >= MAX) return ""; const rows = d.rows.slice(0, MAX - shown); shown += rows.length;
    return `<div class="dayh"><span>${esc(d.name)} ${esc(d.date)}</span></div>${rows.map((r) => `<div class="cls"><div class="t">${esc(r.start)}${r.end ? `<span>${esc(r.end)}</span>` : ""}</div><div class="c"><b>${esc(r.title)}</b>${classLine(r) ? `<span>${esc(classLine(r))}</span>` : ""}</div><span class="book">Book</span></div>`).join("")}`; }).join("");
  const more = tt.length - shown;
  const found = [tt.length ? "your classes" : "", (prof.coaches || []).length ? "coaches" : "", (prof.rates || []).length ? "prices" : ""].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1") || "what's";
  const coaches = (prof.coaches || []).slice(0, 6), rates = (prof.rates || []).filter((r) => Number(r.price) > 0).slice(0, 6);
  const gets = [
    ["Bookings and check-ins", "Members book their classes and check in on their phones. You see who's coming before class starts."],
    ["Fees that keep track", "Running balances for every member, and payment reminders that go out by themselves."],
    ["EFT proof of payment", "Members send their proof in the app. You tick it off; nothing to chase."],
    ["Kids and families", "One parent login books and pays for all their kids."],
    ["Belt progress and moves", "Stripes and belts for every member, plus a library of moves to study between classes."],
    ["Import from WhatsApp", "Bring your members over from your WhatsApp group in a few taps."],
  ];
  const css = `.band{background:var(--acc);color:var(--on-acc)}.band .wrap{display:flex;align-items:center;gap:12px;min-height:68px;padding-top:12px;padding-bottom:12px}
.chip{background:#fff;border-radius:10px;padding:4px;line-height:0;flex:none}.chip img{display:block;border-radius:6px}.bandname{font-weight:700;font-size:18px;line-height:1.2;min-width:0;overflow-wrap:anywhere}
.pv{margin-left:auto;font-size:13px;font-weight:600;border:1px solid currentColor;border-radius:99px;padding:3px 10px;white-space:nowrap;opacity:.9}
.grid{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "phone" "gets" "how";gap:28px;padding-top:28px;padding-bottom:28px}
.head{grid-area:head}.phone{grid-area:phone}.gets{grid-area:gets}.how{grid-area:how}
.eyebrow{margin:0 0 8px;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-acc)}
.head h1{font-size:44px;margin-bottom:14px}.lead{font-size:19px;margin:0 0 20px;color:#2b3342}.cta .small{margin:10px 0 0}.btn.big{display:block;width:100%;max-width:560px}
.device{background:#10141b;border-radius:38px;padding:10px;box-shadow:0 18px 40px rgba(17,23,34,.18);max-width:380px;margin:0 auto}
.screen{background:#fff;border-radius:30px;overflow:hidden}.ahead{display:flex;align-items:center;gap:10px;padding:18px 16px 12px;border-bottom:1px solid #e3e8ef}
.ahead img{display:block;border-radius:6px;flex:none}.aname{font-weight:700;line-height:1.2;overflow-wrap:anywhere}.asub{font-size:13px;color:#4e5869}
.mono{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-acc);padding:14px 16px 4px}
.dayh{display:flex;justify-content:space-between;align-items:center;padding:12px 16px 4px;font-size:14px;font-weight:700;color:#4e5869}.dayh em{font-style:normal;font-size:12px;background:var(--acc);color:var(--on-acc);border-radius:99px;padding:1px 8px}
.cls{display:flex;align-items:center;gap:10px;margin:6px 12px;padding:10px 12px;border:1px solid #e3e8ef;border-radius:14px}
.cls .t{font-weight:700;font-size:15px;width:46px;flex:none;line-height:1.15}.cls .t span{display:block;font-weight:400;font-size:12px;color:#4e5869}
.cls .c{min-width:0;flex:1;line-height:1.25}.cls .c b{display:block;font-size:15px;overflow-wrap:anywhere}.cls .c span{font-size:13px;color:#4e5869}
.book{flex:none;background:var(--btn);color:var(--on);font-size:13px;font-weight:700;border-radius:99px;padding:5px 12px}
.moreline{padding:6px 16px 2px;font-size:13px;color:#4e5869}.coach{display:flex;align-items:center;gap:10px;padding:6px 16px}.coach i{font-style:normal;flex:none;width:34px;height:34px;border-radius:50%;background:var(--tint);color:var(--ink-acc);display:grid;place-items:center;font-size:13px;font-weight:700}
.coach div{line-height:1.2;min-width:0}.coach b{display:block;font-size:15px}.coach span{font-size:13px;color:#4e5869}
.plan{display:flex;justify-content:space-between;gap:10px;margin:6px 12px;padding:10px 12px;background:var(--tint);border-radius:12px;font-size:15px}.plan b{font-weight:600;min-width:0;overflow-wrap:anywhere}.plan span{white-space:nowrap;font-weight:700}
.empty{margin:6px 16px;font-size:14px;color:#4e5869}.atabs{display:flex;justify-content:space-around;border-top:1px solid #e3e8ef;margin-top:16px;padding:10px 4px 16px;font-size:12px;color:#6b7486}.atabs .on{color:var(--ink-acc);font-weight:700}
.gets h2,.how h2{font-size:32px;margin-bottom:14px}.getl{list-style:none;margin:0;padding:0;display:grid;gap:12px}.getl li{background:#fff;border:1px solid #e3e8ef;border-radius:14px;padding:14px 16px 14px 48px;position:relative}
.getl li:before{content:"";position:absolute;left:16px;top:18px;width:18px;height:18px;border-radius:50%;background:var(--acc)}.getl b{display:block}.getl span{color:#4e5869;font-size:16px}
.price{margin:18px 0 0;padding:14px 16px;border-radius:14px;background:#fff;border:2px solid var(--acc)}.price b{font-size:19px}.price p{margin:4px 0 0}
.how ol{margin:0 0 20px;padding-left:22px}.how li{margin-bottom:8px}
.foot{padding-top:8px;padding-bottom:40px;font-size:15px;color:#4e5869;border-top:1px solid #dfe4ec}.foot details{margin:18px 0}.foot summary{cursor:pointer;color:#2b3342;font-weight:600}
.foot form{margin-top:10px}.rm{background:#fff;color:#b3261e;border:1px solid #b3261e;border-radius:10px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
@media (min-width:900px){.grid{grid-template-columns:minmax(0,1fr) 380px;grid-template-areas:"head phone" "gets phone" "how phone";column-gap:56px;padding-top:48px}.phone{position:sticky;top:24px;align-self:start}.head h1{font-size:58px}}
@media (max-width:400px){.head h1{font-size:38px}.pv{display:none}}`;
  const body = `<header class="band"><div class="wrap">${logo ? `<span class="chip"><img src="${logo}" width="${lb.w}" height="${lb.h}" alt=""></span>` : ""}<span class="bandname">${esc(gym)}</span><span class="pv">Private preview</span></div></header>
<main class="wrap grid">
 <section class="head"><p class="eyebrow">Made from ${esc(p.domain)}</p><h1>This is ${esc(gym)} on JitsFlow</h1>
  <p class="lead">We read ${esc(found)} on your website and set ${esc(gym)} up. This is what your members would see on their phones.</p>
  <div class="cta"><a class="btn big" href="${esc(claim)}">${esc(cta)}</a><p class="small">Then ${esc(rand(payfast.PRICE_CENTS()))} a month. No card needed to start.</p></div></section>
 <aside class="phone" aria-label="What your members see"><div class="device"><div class="screen">
  <div class="ahead">${logo ? `<img src="${logo}" width="${lbs.w}" height="${lbs.h}" alt="">` : ""}<div><div class="aname">${esc(gym)}</div><div class="asub">Classes</div></div></div>
  <div class="mono">This week</div>
  ${dayHtml || `<p class="empty">Your classes go here. Add them in a minute after you claim.</p>`}${more > 0 ? `<p class="moreline">and ${more} more class${more === 1 ? "" : "es"} this week</p>` : ""}
  ${coaches.length ? `<div class="mono">Coaches</div>${coaches.map((c) => `<div class="coach"><i>${esc(initials(c.name))}</i><div><b>${esc(c.name)}</b>${c.rank ? `<span>${esc(c.rank)}</span>` : ""}</div></div>`).join("")}` : ""}
  ${rates.length ? `<div class="mono">Plans</div>${rates.map((r) => `<div class="plan"><b>${esc(r.name)}</b><span>${esc(priceOf(r))}</span></div>`).join("")}` : ""}
  <nav class="atabs" aria-hidden="true"><span>Home</span><span class="on">Classes</span><span>Learn</span><span>Journal</span><span>Me</span></nav>
 </div></div></aside>
 <section class="gets"><h2>What you get</h2><ul class="getl">${gets.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join("")}</ul>
  <div class="price"><b>${esc(price.main)}</b><p class="small">No card needed to start. ${esc(price.fee)}</p></div></section>
 <section class="how"><h2>Claiming takes one step</h2><ol>
  <li>Make your account: your name, email and a password.</li>
  <li>${esc(gym)} is already filled in${tt.length ? ", with your timetable on the calendar" : ""}. Check it and change anything you like.</li>
  <li>Send your members the invite link, or bring them over from your WhatsApp group.</li></ol>
  <a class="btn big" href="${esc(claim)}">${esc(cta)}</a></section>
</main>
<footer class="wrap foot"><details><summary>Not your gym? Remove this page</summary><form method="post" action="${base}/try/${esc(p.token)}/remove"><p>This deletes this page and what we read from ${esc(p.domain)}, and we won't contact ${esc(p.domain)} again.</p><button class="rm" type="submit">Remove this page</button></form></details>
<p>A private page made for ${esc(gym)} by <a href="/">JitsFlow</a>. Only people with the link can see it. <a href="/privacy/">Privacy</a></p></footer>`;
  // A view counts once the page is open and on screen for a moment (email scanners that only fetch the link don't count).
  const script = `(function(){var s=0;function v(){if(s||document.visibilityState!=="visible")return;s=1;try{fetch(${JSON.stringify(`${base}/try/${p.token}/view`)},{method:"POST",headers:{"x-jf":"1"},credentials:"same-origin",keepalive:true})}catch(e){}}
setTimeout(v,1500);document.addEventListener("visibilitychange",function(){setTimeout(v,1500)})})();`;
  return shell({ title: `${gym} on JitsFlow`, accent: acc, body, extraCss: css, script });
}

/* ---------------- stored rows ---------------- */
const LIST_COLS = "id, token, website, domain, name, accent, owner_name, owner_email, personal_line, subject, status, import_state, import_error, method, views, last_viewed_at, sent_at, sent_to, followup_sent_at, claimed_at, claimed_gym_id, opted_out_at, created_at, logo is not null as has_logo, jsonb_array_length(coalesce(profile->'timetable','[]')) as n_classes, jsonb_array_length(coalesce(profile->'coaches','[]')) as n_coaches, jsonb_array_length(coalesce(profile->'rates','[]')) as n_rates";
function label(r) {
  if (r.status === "claimed") return "Claimed";
  if (r.status === "optedout") return "Opted out";
  if (r.import_state === "running") return "Reading website…";
  if (r.import_state === "failed" && !r.name) return "Couldn't read site";
  if (r.views > 0) return `Viewed ${r.views}×`;
  return r.status === "sent" ? "Sent" : "Draft";
}
const followupAt = (r) => (r.sent_at ? new Date(new Date(r.sent_at).getTime() + FOLLOWUP_DAYS * 864e5) : null);
function prospectOut(r, { base = "", blocked = false } = {}) {
  const fa = followupAt(r), canFollow = r.status === "sent" && !r.followup_sent_at && !blocked;
  return { id: String(r.id), name: r.name || r.domain, domain: r.domain, website: r.website, status: r.status, label: label(r), importing: r.import_state === "running", importError: r.import_error || null, method: r.method || null,
    views: r.views, lastViewedAt: r.last_viewed_at, sentAt: r.sent_at, sentTo: r.sent_to || null, followupSentAt: r.followup_sent_at, followupFrom: canFollow && fa ? fa.toISOString() : null, followupReady: !!(canFollow && fa && fa <= new Date()),
    claimedAt: r.claimed_at, optedOutAt: r.opted_out_at || null, claimedGymId: r.claimed_gym_id ? String(r.claimed_gym_id) : null, ownerName: r.owner_name || "", ownerEmail: r.owner_email || "", personalLine: r.personal_line || "", subject: r.subject || "",
    accent: r.accent || null, logo: r.has_logo && r.status !== "optedout" ? `${base}/try/${r.token}/logo` : null, previewUrl: r.status === "optedout" ? null : `${base}/try/${r.token}`, blocked: !!blocked,
    counts: { classes: Number(r.n_classes) || 0, coaches: Number(r.n_coaches) || 0, rates: Number(r.n_rates) || 0 }, createdAt: r.created_at };
}
// Is this gym (its website's domain) or this address on the do-not-contact list?
async function blocked(q, domain, email) {
  const e = String(email || "").toLowerCase(), ed = e.split("@")[1] || "";
  const r = await q("select 1 from outreach_dnc where (kind='domain' and value = any($1)) or (kind='email' and value=$2) limit 1", [[domain, ed].filter(Boolean), e]);
  return !!r.rows[0];
}
// Opted out ("don't email me") or removed ("not my gym"): what we read about the gym goes, the gym's name and domain stay so it's
// never made again, and the domain (and the address, if we had one) go on the do-not-contact list.
async function optOut(q, p, { withEmail }) {
  await q("insert into outreach_dnc(kind,value) values('domain',$1) on conflict do nothing", [p.domain]);
  if (withEmail && p.owner_email) await q("insert into outreach_dnc(kind,value) values('email',$1) on conflict do nothing", [String(p.owner_email).toLowerCase()]);
  await q(`update prospects set status=case when status='claimed' then status else 'optedout' end, profile='{}', logo=null, logo_type=null, owner_name='', owner_email=null, personal_line='', import_error=null, opted_out_at=now()
    where id=$1 and status<>'claimed'`, [p.id]);
}

/* ---------------- reading the gym's website (one at a time) ---------------- */
function makeQueue(q, log = () => {}) {
  const waiting = []; let busy = false;
  async function run(id) {
    const p = (await q("select id, website, status from prospects where id=$1", [id])).rows[0]; if (!p || p.status === "optedout") return;
    try {
      const r = await importer.importSite(p.website, { log });
      const img = await pickLogo(r.logos), prof = { ...r.profile }, b = prof.brand || {}; delete prof.brand;
      await q(`update prospects set name=$2, profile=$3, logo=$4, logo_type=$5, accent=$6, method=$7, import_state='done', import_error=null, imported_at=now(),
        subject=case when subject='' then $8 else subject end where id=$1 and status<>'optedout'`,
      [id, String(prof.name || "").slice(0, 100), prof, img ? img.body : null, img ? img.type : null, b.source === "site" && brand.isHex(b.accent) ? b.accent.toLowerCase() : null, r.method, defaultSubject({ profile: prof, name: prof.name, domain: "" })]);
    } catch (e) {
      const msg = e instanceof importer.ImportError ? e.message : "Couldn't read that site just now. Try Re-import in a minute.";
      if (!(e instanceof importer.ImportError)) log("outreach import: " + (e.message || e));
      await q("update prospects set import_state='failed', import_error=$2 where id=$1", [id, msg]);
    }
  }
  async function pump() {
    if (busy) return; busy = true;
    try { while (waiting.length) { const id = waiting.shift(); await run(id).catch((e) => log("outreach import: " + e.message)); } } finally { busy = false; }
  }
  return { add(id) { if (!waiting.includes(String(id))) waiting.push(String(id)); pump(); }, size: () => waiting.length + (busy ? 1 : 0) };
}

/* ---------------- /try/<token> ---------------- */
function makePublic(pool) {
  const r = express.Router(), q = (t, p) => pool.query(t, p);
  const seen = new Map(); // ip|token -> last counted view
  setInterval(() => { const now = Date.now(); for (const [k, t] of seen) if (now - t > 3600e3) seen.delete(k); }, 600e3).unref();
  const byToken = async (t) => (TOKEN_RE.test(t || "") ? (await q("select * from prospects where token=$1", [t])).rows[0] : null);
  const page = (res, status, html) => res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" }).send(html);
  const sessionEmail = async (req) => {
    const m = String(req.headers.cookie || "").match(/(?:^|;\s*)jf_s=([0-9a-f]{64})/); if (!m) return null;
    const x = (await q("select u.email from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now()", [sha(m[1])])).rows[0];
    return x ? x.email : null;
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const live = (p) => p && p.status !== "optedout" && p.import_state !== "running" && p.name;

  r.get("/:token", wrap(async (req, res) => {
    const p = await byToken(req.params.token);
    if (!live(p)) return page(res, 404, notFoundPage());
    if (p.status === "claimed") return page(res, 200, simplePage(`${nameOf(p)} on JitsFlow`, `${nameOf(p)} is on JitsFlow`, ["This gym has been claimed. If it's yours, sign in to run it."], { accent: accentOf(p), extra: `<p><a class="btn" href="/app/?signin=1">Sign in</a></p>` }));
    page(res, 200, renderPreview(p));
  }));
  r.get("/:token/logo", wrap(async (req, res) => {
    const p = await byToken(req.params.token);
    if (!p || !p.logo || p.status === "optedout") return res.status(404).set("Cache-Control", "no-store").type("text/plain").send("Not found");
    res.set({ "Content-Type": p.logo_type, "Cache-Control": "public, max-age=86400", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" }).send(p.logo);
  }));
  // The page's beacon. Counted once per visitor per 30 minutes; never for the admins themselves or for robots.
  r.post("/:token/view", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.headers["x-jf"] !== "1") return res.status(403).end();
    const p = await byToken(req.params.token); if (!live(p) || p.status === "claimed") return res.status(204).end();
    if (/bot|crawl|spider|preview|scan|slurp|facebookexternalhit|curl|wget|python|headless/i.test(String(req.headers["user-agent"] || ""))) return res.status(204).end();
    if (isAdmin(await sessionEmail(req))) return res.status(204).end();
    const k = `${req.ip}|${p.id}`, at = seen.get(k); if (at && Date.now() - at < 30 * 60e3) return res.status(204).end();
    seen.set(k, Date.now());
    await q("update prospects set views=views+1, last_viewed_at=now() where id=$1", [p.id]);
    res.status(204).end();
  }));
  // "Not your gym? Remove this page"
  r.post("/:token/remove", wrap(async (req, res) => {
    const p = await byToken(req.params.token);
    if (!p || p.status === "optedout") return page(res, 200, simplePage("Removed · JitsFlow", "This page is gone", ["We've deleted it and won't contact that website again."]));
    if (p.status === "claimed") return page(res, 409, simplePage("Claimed · JitsFlow", "This gym has been claimed", ["It belongs to an account now, so it can't be removed from here. Email hello@jitsflow.com if something's wrong."]));
    await optOut(q, p, { withEmail: false });
    page(res, 200, simplePage("Removed · JitsFlow", "This page is gone", [`We've deleted the page and what we read from ${esc(p.domain)}, and we won't contact ${esc(p.domain)} again. Sorry for the bother.`]));
  }));
  // The email's opt-out link: a page with one button (a scanner opening the link mustn't opt anyone out); the email's
  // List-Unsubscribe-Post header lets mail apps do it in one tap.
  r.get("/:token/optout", wrap(async (req, res) => {
    const p = await byToken(req.params.token);
    if (!p || p.status === "optedout") return page(res, 200, simplePage("Opted out · JitsFlow", "You're opted out", ["You won't get any more emails from us about this gym."]));
    page(res, 200, simplePage("Opt out · JitsFlow", "Stop emails from JitsFlow?", [`One tap and we won't email you about ${esc(nameOf(p))} again${p.status === "claimed" ? "" : ", and we'll delete the page we made"}.`],
      { accent: accentOf(p), extra: `<form method="post" action="/try/${esc(p.token)}/optout"><button class="btn" type="submit">Stop emails</button></form>` }));
  }));
  r.post("/:token/optout", wrap(async (req, res) => {
    const p = await byToken(req.params.token);
    if (p && p.status !== "optedout") {
      if (p.status === "claimed") { if (p.owner_email) await q("insert into outreach_dnc(kind,value) values('email',$1) on conflict do nothing", [String(p.owner_email).toLowerCase()]); }
      else await optOut(q, p, { withEmail: true });
    }
    page(res, 200, simplePage("Opted out · JitsFlow", "You're opted out", ["You won't get any more emails from us about this gym, and the page we made is deleted. Sorry for the bother."]));
  }));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => { console.error("try page:", err.message); page(res, 500, simplePage("JitsFlow", "Something went wrong", ["Try again in a minute."])); });
  return r;
}

module.exports = { adminEmails, isAdmin, newToken, TOKEN_RE, domainOf, parseLines, priceLine, imageSize, pickLogo, renderEmail, renderPreview, notFoundPage, defaultSubject,
  prospectOut, LIST_COLS, label, blocked, optOut, makeQueue, makePublic, sampleClasses, weekOf, FOLLOWUP_DAYS, tryUrl, optoutUrl, nameOf };
