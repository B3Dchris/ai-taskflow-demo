// Outgoing email through Resend (https://resend.com). Off unless RESEND_API_KEY is set.
"use strict";
const API_URL = () => process.env.RESEND_API_URL || "https://api.resend.com/emails"; // overridden in tests
const FROM = () => process.env.MAIL_FROM || "JitsFlow <no-reply@jitsflow.com>";
const REPLY_TO = () => process.env.MAIL_REPLY_TO || "hello@jitsflow.com";
// Links in emails always use this address, never the request's Host header (which a caller controls).
const appUrl = () => (process.env.APP_URL || "https://www.jitsflow.com").replace(/\/+$/, "");
const mailOn = () => !!process.env.RESEND_API_KEY;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function layout(title, paras, button) {
  const html = `<!doctype html><html><body style="margin:0;background:#EEF1F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;padding:28px 18px"><div style="font-weight:800;letter-spacing:.04em;font-size:18px;color:#1D4ED8;margin-bottom:18px">JITSFLOW</div>
<div style="background:#fff;border-radius:14px;padding:24px 22px;border:1px solid #DDE3EC"><h1 style="font-size:22px;margin:0 0 12px">${escHtml(title)}</h1>
${paras.map((p) => `<p style="font-size:16px;line-height:1.5;margin:0 0 12px">${escHtml(p)}</p>`).join("")}
${button ? `<p style="margin:20px 0 8px"><a href="${escHtml(button.url)}" style="display:inline-block;background:#1D4ED8;color:#fff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">${escHtml(button.label)}</a></p>
<p style="font-size:13px;color:#6B7280;word-break:break-all;margin:12px 0 0">Or open this link: ${escHtml(button.url)}</p>` : ""}</div>
<p style="font-size:12px;color:#6B7280;margin-top:16px">JitsFlow · Your no-gi game, mapped. Reply to this email if you need help.</p></div></body></html>`;
  const text = [title, "", ...paras, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", "JitsFlow"].join("\n");
  return { html, text };
}

async function send({ to, subject, title, paras, button }) {
  if (!mailOn()) return { sent: false, reason: "off" };
  const { html, text } = layout(title || subject, paras, button);
  const r = await fetch(API_URL(), {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: REPLY_TO(), subject, html, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`); }
  return { sent: true, id: (await r.json().catch(() => ({}))).id };
}
// Fire-and-forget for emails nobody waits on (welcome mails). Failures are logged, never shown.
const sendLater = (msg) => { send(msg).catch((e) => console.warn("mail:", e.message)); };

const templates = {
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
