// Outgoing email through Resend (https://resend.com). Off unless RESEND_API_KEY is set.
"use strict";
const API_URL = () => process.env.RESEND_API_URL || "https://api.resend.com/emails"; // overridden in tests
const FROM = () => process.env.MAIL_FROM || "JitsFlow <no-reply@jitsflow.com>";
const REPLY_TO = () => process.env.MAIL_REPLY_TO || "hello@jitsflow.com";
// Links in emails always use this address, never the request's Host header (which a caller controls).
const appUrl = () => (process.env.APP_URL || "https://www.jitsflow.com").replace(/\/+$/, "");
const mailOn = () => !!process.env.RESEND_API_KEY;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Matches the website: navy "night" band with the belt-bar mark, white card, site blue, Saira Condensed headings.
// Table layout and inline styles so Gmail, Outlook and Apple Mail all render it; no images, so nothing is blocked.
const C = { night: "#0E1A33", nightTop: "#0A1020", bg: "#EEF1F5", card: "#FFFFFF", ink: "#111722", ink2: "#4E5869", line: "#D3DAE4", blue: "#1D4FB5", red: "#B3261E", black: "#151515" };
const F = { display: "'Saira Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif", body: "'Source Sans 3',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif", mono: "'IBM Plex Mono',Menlo,Consolas,monospace" };
function layout(title, paras, button, preheader) {
  const site = appUrl();
  const p = (t) => `<p style="margin:0 0 14px;font-family:${F.body};font-size:17px;line-height:1.55;color:${C.ink}">${escHtml(t)}</p>`;
  const btn = button ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px"><tr><td bgcolor="${C.blue}" style="border-radius:12px">
<a href="${escHtml(button.url)}" style="display:inline-block;padding:15px 24px;font-family:${F.body};font-size:17px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px">${escHtml(button.label)}</a></td></tr></table>
<p style="margin:14px 0 0;font-family:${F.body};font-size:13px;line-height:1.5;color:${C.ink2};word-break:break-all">Button not working? Open this link:<br><a href="${escHtml(button.url)}" style="color:${C.blue}">${escHtml(button.url)}</a></p>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=Saira+Condensed:wght@700;800&family=Source+Sans+3:wght@400;700&display=swap" rel="stylesheet">
</head><body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escHtml(preheader || paras[0] || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.night}" style="background:${C.night}"><tr><td align="center" style="padding:26px 20px 64px">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr>
  <td style="vertical-align:middle;width:44px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="26" height="12" bgcolor="${C.black}" style="font-size:0;line-height:0;border:1px solid #3A4458;border-right:0">&nbsp;</td><td width="10" height="12" bgcolor="${C.red}" style="font-size:0;line-height:0;border:1px solid #3A4458;border-left:0">&nbsp;</td></tr></table></td>
  <td style="vertical-align:middle;font-family:${F.display};font-size:26px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:#F4F6FB"><a href="${escHtml(site)}/" style="color:#F4F6FB;text-decoration:none">JitsFlow</a></td>
  <td align="right" style="vertical-align:middle;font-family:${F.mono};font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9FB0D0">No-gi technique library</td>
 </tr></table>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:-44px auto 0"><tr><td style="padding:0 14px">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:16px"><tr><td style="padding:28px 24px 26px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr><td width="56" height="6" bgcolor="${C.blue}" style="font-size:0;line-height:0;border-radius:3px">&nbsp;</td></tr></table>
  <h1 style="margin:0 0 16px;font-family:${F.display};font-size:32px;line-height:1.05;font-weight:800;text-transform:uppercase;color:${C.ink}">${escHtml(title)}</h1>
  ${paras.map(p).join("\n  ")}
  ${btn}
 </td></tr></table>
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px 6px 34px;font-family:${F.body};font-size:13px;line-height:1.6;color:${C.ink2}">
  <a href="${escHtml(site)}/techniques/" style="color:${C.ink2}">Techniques</a> &nbsp;·&nbsp; <a href="${escHtml(site)}/app/" style="color:${C.ink2}">Open the app</a> &nbsp;·&nbsp; <a href="mailto:${escHtml(REPLY_TO())}" style="color:${C.ink2}">${escHtml(REPLY_TO())}</a><br>
  JitsFlow · No-gi technique library and flow map. Reply to this email if you need help.
 </td></tr></table>
</td></tr></table>
</td></tr></table></body></html>`;
  const text = [title, "", ...paras, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", "JitsFlow · " + site].join("\n");
  return { html, text };
}

async function send({ to, subject, title, paras, button, preheader, replyTo }) {
  if (!mailOn()) return { sent: false, reason: "off" };
  const { html, text } = layout(title || subject, paras, button, preheader);
  const r = await fetch(API_URL(), {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: replyTo || REPLY_TO(), subject, html, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`); }
  return { sent: true, id: (await r.json().catch(() => ({}))).id };
}
// Fire-and-forget for emails nobody waits on (welcome mails). Failures are logged, never shown.
const sendLater = (msg) => { send(msg).catch((e) => console.warn("mail:", e.message)); };

const templates = {
  offWaitlist: (name, gym, cls, when) => ({ subject: `You're in: ${cls}`, title: "A spot opened up",
    paras: [`Hi ${name},`, `Someone cancelled, so you've moved off the waitlist and you're booked for ${cls} at ${gym}: ${when}.`, "Can't make it any more? Cancel in the app so the next person gets the spot."],
    button: { label: "See your bookings", url: appUrl() + "/app/#book" } }),
  cancelled: (name, gym, cls, when) => ({ subject: `Cancelled: ${cls}`, title: "Class cancelled",
    paras: [`Hi ${name},`, `${gym} has cancelled ${cls} on ${when}. Your booking has been removed.`, "Have a look for another class to book."],
    button: { label: "Book another class", url: appUrl() + "/app/#book" } }),
  message: (name, coach, gym, subject, text) => ({ subject, title: subject,
    paras: [`Hi ${name},`, ...String(text).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean), `${coach}, ${gym}`],
    preheader: String(text).slice(0, 120), button: { label: "Open JitsFlow", url: appUrl() + "/app/#book" } }),
  reset: (name, url) => ({ subject: "Reset your JitsFlow password", title: "Reset your password",
    paras: [`Hi ${name},`, "Someone asked to reset the password for your JitsFlow account. If it was you, tap the button. The link works once and expires in 1 hour.", "If it wasn't you, ignore this email. Your password stays the same."],
    button: { label: "Choose a new password", url } }),
  welcomeStudent: (name, gym) => ({ subject: "Welcome to JitsFlow", title: `Welcome, ${name}`,
    paras: [gym ? `You're in ${gym} on JitsFlow. Your progress, training log and class sign-ups are saved to your account, so they're on any phone you sign in on.` : "Your progress and training log are now saved to your account, so they're on any phone you sign in on.",
      "Start by rating what you know: it takes 5–10 minutes and shows you what to drill next.", "Tip: on iPhone, open the app in Safari, tap Share, then Add to Home Screen."],
    button: { label: "Open JitsFlow", url: appUrl() + "/app/" } }),
  welcomeCoach: (name, gym, invite) => ({ subject: `${gym} is set up on JitsFlow`, title: `${gym} is ready`,
    paras: [`Hi ${name},`, "Send your students this invite link. It opens JitsFlow with your gym code filled in:", invite,
      "In the Coach tab you can import your timetable from your website, plan classes, see who's coming and what they need to work on, and keep your roster and payments."],
    button: { label: "Open the Coach tab", url: appUrl() + "/app/#coach" } }),
  invite: (coach, gym, url) => ({ subject: `${coach} invited you to ${gym} on JitsFlow`, title: `Join ${gym} on JitsFlow`,
    paras: [`${coach} invited you to ${gym}'s JitsFlow.`, "JitsFlow is a no-gi study app: every technique from white to black belt with videos, a flow map of attacks and escapes, and a training log. Your coach uses it to plan classes around what the group needs.", "Tap the button to create your free account. Your gym code is already filled in."],
    button: { label: `Join ${gym}`, url } }),
};

module.exports = { send, sendLater, templates, mailOn, appUrl, layout };
