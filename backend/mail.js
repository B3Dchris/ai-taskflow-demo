// Outgoing email through Resend (https://resend.com). Off unless RESEND_API_KEY is set.
"use strict";
const API_URL = () => process.env.RESEND_API_URL || "https://api.resend.com/emails"; // overridden in tests
const FROM = () => process.env.MAIL_FROM || "JitsFlow <no-reply@jitsflow.com>";
const REPLY_TO = () => process.env.MAIL_REPLY_TO || "support@jitsflow.com";
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

// Header text (a subject, a sender's name) is one line: line breaks and other control characters could start a new header.
const oneLine = (v) => String(v == null ? "" : v).replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
// An address for a header: one line, and nothing that could add a second address or a header.
const addrLine = (v) => oneLine(v).replace(/[,;<>"]/g, "");
// headers: extra headers such as List-Unsubscribe (emails a gym sends: see stopLink in api.js).
async function send({ to, subject, title, paras, button, preheader, replyTo, headers }) {
  if (!mailOn()) return { sent: false, reason: "off" };
  if (!to) return { sent: false, reason: "no address" };
  subject = oneLine(subject).slice(0, 250); to = addrLine(to); if (replyTo) replyTo = addrLine(replyTo);
  if (headers) headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [oneLine(k).replace(/[^\w-]/g, ""), oneLine(v)]));
  const { html, text } = layout(title || subject, paras, button, preheader);
  const r = await fetch(API_URL(), {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: replyTo || REPLY_TO(), subject, html, text, ...(headers ? { headers } : {}) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`); }
  return { sent: true, id: (await r.json().catch(() => ({}))).id };
}
// An email made elsewhere (the outreach email to a gym owner): its own HTML and text, sent from a person ("Thabo from JitsFlow")
// at the usual address, with replies going to that person. headers: extra headers such as List-Unsubscribe.
async function sendRaw({ fromName, to, replyTo, subject, html, text, headers }) {
  if (!mailOn()) return { sent: false, reason: "off" };
  if (!to) return { sent: false, reason: "no address" };
  const addr = ((FROM().match(/<([^<>\s]+@[^<>\s]+)>/) || [])[1] || FROM()).trim();
  const name = oneLine(fromName).replace(/["<>\\]/g, "").trim().slice(0, 80);
  subject = oneLine(subject).slice(0, 250); to = addrLine(to); if (replyTo) replyTo = addrLine(replyTo);
  if (headers) headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [oneLine(k).replace(/[^\w-]/g, ""), oneLine(v)]));
  const r = await fetch(API_URL(), {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: name ? `"${name}" <${addr}>` : FROM(), to: [to], reply_to: replyTo || REPLY_TO(), subject, html, text, ...(headers ? { headers } : {}) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error(`Resend ${r.status}: ${body.slice(0, 200)}`); }
  return { sent: true, id: (await r.json().catch(() => ({}))).id };
}
// Fire-and-forget for emails nobody waits on (welcome mails). Failures are logged, never shown.
const sendLater = (msg) => { send(msg).catch((e) => console.warn("mail:", e.message)); };

const templates = {
  compRequest: (coach, student, comp, when, division) => ({ subject: `${student} wants to compete at ${comp}`, title: "Competition request",
    paras: [`Hi ${coach},`, `${student} asked to enter ${comp} (${when})${division ? `, ${division}` : ""}.`, "Approve or decline it in Members › Competitions."],
    button: { label: "Open Comps", url: appUrl() + "/app/#coach" } }),
  compDecision: (name, comp, when, entered, note) => ({ subject: entered ? `You're on the team for ${comp}` : `About ${comp}`, title: entered ? "You're on the team" : "Not this time",
    paras: [`Hi ${name},`, entered ? `Your coach has entered you for ${comp} (${when}).` : `Your coach hasn't entered you for ${comp} (${when}) this time.`, ...(note ? [`Coach's note: ${note}`] : []), entered ? "Check the details and the rest of the team in JitsFlow." : "Talk to your coach about what to work on for the next one."],
    button: { label: "See the competition", url: appUrl() + "/app/#book" } }),
  offWaitlist: (name, gym, cls, when) => ({ subject: `You're in: ${cls}`, title: "A spot opened up",
    paras: [`Hi ${name},`, `Someone cancelled, so you've moved off the waitlist and you're booked for ${cls} at ${gym}: ${when}.`, "Can't make it any more? Cancel in the app so the next person gets the spot."],
    button: { label: "See your bookings", url: appUrl() + "/app/#book" } }),
  moved: (name, gym, cls, was, now) => ({ subject: `Changed: ${cls}`, title: "Class time changed",
    paras: [`Hi ${name},`, `${gym} has moved ${cls}. It was ${was}; it's now ${now}. You're still booked.`, "Can't make the new time? Cancel in the app so someone else gets the spot."],
    button: { label: "See your bookings", url: appUrl() + "/app/#book" } }),
  // join: their own invite link, for someone the coach added who isn't on the app yet
  // kid: whose fees they are, when the reminder goes to a kid's parent ("Hi Thandi, ... R500 is due for Lerato for November").
  // stop: the link that stops this gym's emails to this address (as on its messages).
  // card: the gym takes cards in the app (Paystack): the button pays, and EFT is the other way.
  feeReminder: (name, gym, amount, month, ref, bankLines, join, parts, kid, stop, card) => ({ subject: `${gym}: ${kid ? `${kid}'s fees` : "fees"} for ${month}`, title: `Fees for ${month}`,
    paras: [`Hi ${name},`, `A friendly reminder that ${amount} is due${kid && kid !== name ? ` for ${kid}` : ""} for ${month}.`, ...(parts && parts.length ? [parts.join("\n")] : []), ...(card && !join ? ["Pay by card in the app: tap Pay now below."] : []), ...(bankLines.length ? [`${card && !join ? "Or pay" : "Pay"} by EFT to:\n${bankLines.join("\n")}`] : []), `Use your reference ${ref} so ${gym} knows it's you. Already paid? ${join ? "Join JitsFlow with the button below and send your proof of payment there." : "Send your proof of payment in the app."}`,
      ...(stop ? [`Sent by ${gym} through JitsFlow. Don't want emails from them? Stop them here: ${stop}`] : [])],
    button: join ? { label: "Join and send proof", url: join } : { label: card ? "Pay now" : "Pay or send proof", url: appUrl() + "/app/?pay=1" } }),
  // Brothers and sisters: one reminder to their parent, with one total, a line per kid and each kid's own reference.
  familyReminder: (name, gym, amount, month, lines, refs, bankLines, join, stop, card) => ({ subject: `${gym}: fees for ${month}`, title: `Fees for ${month}`,
    paras: [`Hi ${name},`, `A friendly reminder that ${amount} is due for your kids at ${gym}:`, lines.join("\n"), ...(card && !join ? ["Pay by card in the app: tap Pay now below."] : []), ...(bankLines.length ? [`${card && !join ? "Or pay" : "Pay"} by EFT to:\n${bankLines.join("\n")}`] : []),
      `Pay it all in one go if you like, with any one of these references. ${gym} splits it between them:\n${refs.join("\n")}`,
      `Already paid? ${join ? "Join JitsFlow with the button below and send your proof of payment there." : "Send your proof of payment in the app."}`,
      ...(stop ? [`Sent by ${gym} through JitsFlow. Don't want emails from them? Stop them here: ${stop}`] : [])],
    button: join ? { label: "Join and send proof", url: join } : { label: card ? "Pay now" : "Pay or send proof", url: appUrl() + "/app/?pay=1" } }),
  // To a member the head coach paused because they stopped coming. Their fees are on hold; booking again starts them.
  missYou: (name, gym) => ({ subject: `We miss you at ${gym}`, title: "We miss you",
    paras: [`Hi ${name},`, `We haven't seen you on the mat for a while, and we miss you.`, "We've put your monthly fees on hold while you're away, so nothing new builds up.",
      "Whenever you're ready, book a class in the app. Your membership starts again by itself."],
    button: { label: "Book a class", url: appUrl() + "/app/#book" } }),
  cancelled: (name, gym, cls, when) => ({ subject: `Cancelled: ${cls}`, title: "Class cancelled",
    paras: [`Hi ${name},`, `${gym} has cancelled ${cls} on ${when}. Your booking has been removed.`, "Have a look for another class to book."],
    button: { label: "Book another class", url: appUrl() + "/app/#book" } }),
  // stop: the link that stops this gym's emails to this address (emails a gym sends: messages and invites).
  message: (name, coach, gym, subject, text, stop) => ({ subject, title: subject,
    paras: [`Hi ${name},`, ...String(text).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean), `${coach}, ${gym}`, ...(stop ? [`Sent by ${gym} through JitsFlow. Don't want emails from them? Stop them here: ${stop}`] : [])],
    preheader: String(text).slice(0, 120), button: { label: "Open JitsFlow", url: appUrl() + "/app/#book" } }),
  // A reset asked for an email a coach added to someone in their gym who has no login yet: it names the gym, since setting a password
  // joins it. signup: where to sign up on their own instead.
  resetJoin: (name, gym, url, signup) => ({ subject: "Set your JitsFlow password", title: "Set a password",
    paras: [`Hi ${name},`, `There's no JitsFlow login for this email yet: ${gym} added you to JitsFlow as a member with it.`,
      `If you train at ${gym}, tap the button to set a password. You'll be on the app as a member of ${gym}. The link works once and expires in 1 hour.`,
      `Not a member of ${gym}? Don't use the button. Sign up on your own instead (${gym} won't see your account): ${signup}`, "If you didn't ask for this, ignore this email."],
    button: { label: `Set a password and join ${gym}`, url } }),
  reset: (name, url) => ({ subject: "Reset your JitsFlow password", title: "Reset your password",
    paras: [`Hi ${name},`, "Someone asked to reset the password for your JitsFlow account. If it was you, tap the button. The link works once and expires in 1 hour.", "If it wasn't you, ignore this email. Your password stays the same."],
    button: { label: "Choose a new password", url } }),
  welcomeStudent: (name, gym) => ({ subject: "Welcome to JitsFlow", title: `Welcome, ${name}`,
    paras: [gym ? `You're in ${gym} on JitsFlow. Your progress, training log and class sign-ups are saved to your account, so they're on any phone you sign in on.` : "Your progress and training log are now saved to your account, so they're on any phone you sign in on.",
      "Start by rating what you know: it takes 5–10 minutes and shows you what to drill next.", "Tip: on iPhone, open the app in Safari, tap Share, then Add to Home Screen."],
    button: { label: "Open JitsFlow", url: appUrl() + "/app/" } }),
  // Subjects never carry text a sign-up or a coach typed (gym or coach names): these go to addresses nobody has checked yet.
  // The welcome doesn't carry the gym's name either (it's typed by whoever signed up), and doubles as the email check (verify).
  welcomeCoach: (name, invite, verify) => ({ subject: "Your gym is set up on JitsFlow", title: "Your gym is ready",
    paras: [`Hi ${name},`, ...(verify ? ["First, confirm this is your email with the button below. Then JitsFlow can send your invites and messages to your members for you."] : []),
      "Send your students this invite link. It opens JitsFlow with your gym code filled in:", invite,
      "In JitsFlow you can import your timetable from your website, plan classes, see who's coming and what they need to work on, and keep your roster and payments.",
      ...(verify ? ["Didn't sign up for JitsFlow? Ignore this email. Nothing happens unless you tap the button."] : [])],
    button: verify ? { label: "Confirm your email", url: verify } : { label: "Open JitsFlow", url: appUrl() + "/app/#coach" } }),
  verify: (name, url) => ({ subject: "Confirm your email for JitsFlow", title: "Confirm your email",
    paras: [`Hi ${name},`, "Tap the button to confirm this is your email address. The link works once and expires in 24 hours.", "Didn't ask for this? Ignore this email. Nothing happens unless you tap the button."],
    button: { label: "Confirm my email", url } }),
  invite: (coach, gym, url, stop) => ({ subject: "You're invited to join your gym on JitsFlow", title: `Join ${gym} on JitsFlow`,
    paras: [`${coach} invited you to ${gym}'s JitsFlow.`, "JitsFlow is a no-gi study app: every technique from white to black belt with videos, a flow map of attacks and escapes, and a training log. Your coach uses it to plan classes around what the group needs.", "Tap the button to create your free account. Your gym code is already filled in.",
      ...(stop ? [`Not expecting this? Stop emails from ${gym}: ${stop}`] : [])],
    button: { label: `Join ${gym}`, url } }),
  // Payment news for the head coach.
  proofIn: (coach, student, amount) => ({ subject: "A proof of payment to check", title: "Proof of payment received",
    paras: [`Hi ${coach},`, `${student} sent a proof of payment${amount ? ` for ${amount}` : ""}.`, "Check it and confirm it in Money › Payments. It doesn't count as paid until you do."],
    button: { label: "Check the payment", url: appUrl() + "/app/#coach-money" } }),
  // short: a pack paid for with less than its price (the pack's name and price). It's kept as an ordinary payment, with no lessons.
  // via: who processed it (PayFast, or Paystack, which pays the gym's share into its bank account).
  cardPaid: (coach, student, amount, what, short, via = "PayFast") => ({ subject: "A card payment came in", title: "Card payment received",
    paras: [`Hi ${coach},`, `${student} paid ${amount} ${via === "Paystack" ? "by card through Paystack" : "by card or Instant EFT through PayFast"}${what ? ` for ${what}` : ""}.`,
      ...(via === "Paystack" ? ["Paystack pays your share into your bank account, normally 2 working days after the payment."] : []),
      short ? `That's less than ${short.name} costs (${short.price}), so it's recorded as an ordinary payment and no private lessons were added. If that's right, open the payment and pick the pack.` : "It's marked as paid already. There's nothing to check."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  // Card autopay. who: who it pays for ("you", "Lerato", "you and Lerato"), dueDay: "the 1st".
  autopayOn: (name, gym, who, dueDay, via = "PayFast") => ({ subject: "Your fees are paid automatically", title: "Automatic payments are on",
    paras: [`Hi ${name},`, `Your card is saved with ${via} to pay ${gym}'s fees for ${who}.`, `On ${dueDay} of each month we charge only what's owed. Nothing is charged if it's already paid, or while a membership is paused.`, "You get a receipt each time. To stop, open Me in the app and tap Stop."],
    button: { label: "Open JitsFlow", url: appUrl() + "/app/#me" } }),
  autopayPaid: (name, gym, who, amount, ref, via = "PayFast") => ({ subject: `Receipt: ${amount} to ${gym}`, title: "Payment received",
    paras: [`Hi ${name},`, `We charged ${amount} to your saved card: ${gym}'s fees for ${who}.`, `${via} reference: ${ref}.`, "It's marked as paid. There's nothing else to do."],
    button: { label: "See your payments", url: appUrl() + "/app/#me" } }),
  autopayFailed: (name, gym, who, amount, why) => ({ subject: "Your card payment didn't go through", title: "Payment didn't go through",
    paras: [`Hi ${name},`, `We tried to charge ${amount} to your saved card for ${gym}'s fees for ${who}, but it didn't go through${why ? ` (${why})` : ""}.`, "Please pay this month in the app, by card or EFT. Your card stays saved and we try again next month."],
    button: { label: "Pay now", url: appUrl() + "/app/#me" } }),
  autopayFailedCoach: (coach, who, amount, why) => ({ subject: "An automatic card payment didn't go through", title: "Card payment failed",
    paras: [`Hi ${coach},`, `${who}'s automatic card payment of ${amount} didn't go through${why ? ` (${why})` : ""}.`, "We've asked them to pay another way. They show as owing in Money until they do."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  autopayOverLimit: (name, gym, who, amount, limit) => ({ subject: "Your card wasn't charged: please check the amount", title: "Card not charged",
    paras: [`Hi ${name},`, `${gym}'s fees for ${who} this month come to ${amount}. That's more than your saved card pays without asking you (${limit}), so we didn't charge it.`,
      "If the amount is right, pay it in the app, by card or EFT. If it isn't, ask your coach. Your card stays saved for next month."],
    button: { label: "Open the app", url: appUrl() + "/app/#me" } }),
  autopayOverLimitCoach: (coach, who, amount, limit) => ({ subject: "An automatic card payment wasn't charged", title: "Card not charged",
    paras: [`Hi ${coach},`, `${who}'s fees this month come to ${amount}, more than their saved card pays without them saying so (${limit}). We didn't charge the card.`,
      "We've asked them to pay by hand. If the amount is wrong, fix it in their profile. They show as owing in Money until they pay."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  payfastReconnect: (coach) => ({ subject: "Connect PayFast again", title: "PayFast needs reconnecting",
    paras: [`Hi ${coach},`, "We can't use your gym's PayFast details any more, so card payments in the app are paused. Nothing is wrong with your PayFast account.",
      "Open Money › Settings › Card and Instant EFT (PayFast) and enter your Merchant ID, Merchant Key and passphrase again. Card payments work again straight away. If a member paid by card in the meantime, check PayFast and record it by hand."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  payfastBrokenAdmin: (gym, id, what) => ({ subject: `PayFast keys can't be read for ${gym}`, title: "PayFast needs reconnecting",
    paras: [`The PayFast keys saved for ${gym} (gym ${id}) can't be decrypted. Usually that means JF_SECRET was changed (or DATABASE_URL, before JF_SECRET was set). Put the old value in JF_SECRET_OLD and restart, or ask the head coach to connect PayFast again (they've been emailed).`,
      ...(what ? [`What happened: ${what}.`] : [])] }),
  // The team: a PayFast change JitsFlow couldn't make after a day of tries (cancel a plan or saved card, or change a plan's amount).
  payfastOpAdmin: (what, error) => ({ subject: "PayFast needs a hand: " + what, title: "PayFast change didn't go through",
    paras: [`JitsFlow tried for a day to ${what} with PayFast, and PayFast didn't confirm it.`, ...(error ? [`PayFast's last answer: ${error}`] : []),
      "Do it by hand in PayFast (Subscriptions), then mark it done on the dashboard."], button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  // The team: a PayFast payment that wasn't what JitsFlow expected (see payfast_flags).
  payfastFlagAdmin: (gym, line, via = "PayFast") => ({ subject: `Check a ${via} payment for ${gym}`, title: `${via} payment to check`,
    paras: [line, via === "Paystack" ? "Check it in Paystack, then mark it seen on the dashboard." : "It's recorded as what was really paid, never more. Check it in PayFast, then mark it seen on the dashboard."], button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  autopayUnsure: (coach, who, amount) => ({ subject: "Check an automatic card payment", title: "Card payment not confirmed",
    paras: [`Hi ${coach},`, `We asked PayFast to charge ${who}'s saved card ${amount}, but PayFast hasn't confirmed it after a day.`, "Check your PayFast account, then tap \"It went through\" or \"It didn't\" at the top of Money. There's no need to record it by hand. If PayFast confirms it later, it's recorded then."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  autopayByHand: (coach, who, amount, day, via = "PayFast") => ({ subject: "A card payment came in after all", title: "Card payment confirmed",
    paras: [`Hi ${coach},`, `${via} has now confirmed ${who}'s automatic card payment of ${amount}.`, `You recorded a payment for ${who} by hand on ${day}, so we didn't record this one again.`, `If that was a different payment, they paid twice: record this one in Money too, or refund it ${via === "Paystack" ? "from Money" : "in PayFast"}.`],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  autopayAfterLeft: (coach, who, amount, still) => ({ subject: "A card payment came in after a member left", title: "Card payment after leaving",
    paras: [`Hi ${coach},`, `PayFast charged ${who}'s saved card ${amount} after they left your gym. It's recorded in Money${still ? `, and they now owe ${still}` : ", and they owe nothing now"}.`, "If they shouldn't pay it, refund it in PayFast and delete the payment in Money."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  autopayEnded: (name, gym) => ({ subject: "Automatic card payments stopped", title: "Automatic payments stopped",
    paras: [`Hi ${name},`, `${gym} changed how it takes card payments, so your saved card is no longer charged automatically.`, "To keep paying automatically, open Pay in the app and save your card again."],
    button: { label: "Open JitsFlow", url: appUrl() + "/app/#me" } }),
  // Paystack: members' card payments, paid by Paystack straight into the gym's bank account.
  cardReceipt: (name, gym, amount, what, ref) => ({ subject: `Receipt: ${amount} to ${gym}`, title: "Payment received",
    paras: [`Hi ${name},`, `You paid ${gym} ${amount} by card${what ? ` for ${what}` : ""}.`, `Paystack reference: ${ref}.`, "It's marked as paid. There's nothing else to do."],
    button: { label: "See your payments", url: appUrl() + "/app/#me" } }),
  psVerifyAdmin: (gym, bank, last4, changed) => ({ subject: `Card payouts to verify: ${gym}`, title: "A payout account to verify",
    paras: [`${gym} ${changed ? "changed" : "added"} the bank account Paystack pays its card payments into (${bank}, ending ${last4}).`,
      "Check the subaccount in Paystack's dashboard (Subaccounts), then tap Mark verified on the JitsFlow dashboard. Card payments switch on for the gym then."],
    button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  psActiveCoach: (coach, gym) => ({ subject: "Card payments are on", title: "Card payments are on",
    paras: [`Hi ${coach},`, `${gym}'s members can now pay by card, Apple Pay and Capitec Pay in the app. EFT works as before.`,
      "Paystack pays your share of each payment straight into your bank account, normally 2 working days after the payment. Each payment shows as paid in Money by itself."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  psRefunded: (coach, who, amount) => ({ subject: "A card refund went through", title: "Refund done",
    paras: [`Hi ${coach},`, `Paystack refunded ${amount} to ${who}'s card. It's taken off what they paid in Money.`], button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  psRefundFailed: (coach, who, amount, why) => ({ subject: "A card refund didn't go through", title: "Refund failed",
    paras: [`Hi ${coach},`, `Paystack couldn't refund ${amount} to ${who}'s card${why ? ` (${why})` : ""}. Nothing changed in Money.`, "Pay it back another way (an EFT to them), or reply to this email and we'll help."],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  refundMember: (name, gym, amount) => ({ subject: `Refund: ${amount} from ${gym}`, title: "Refund on its way",
    paras: [`Hi ${name},`, `${gym} refunded ${amount} to the card you paid with. Depending on your bank, it shows on your statement within about 5 to 10 working days.`] }),
  psDisputeCoach: (coach, who, amount, ref, due) => ({ subject: "A member disputed a card payment", title: "Card payment disputed",
    paras: [`Hi ${coach},`, `${who}'s bank says they dispute their card payment of ${amount} (Paystack reference ${ref}). It's marked Disputed in Money.`,
      `If the payment was right, reply to this email with what shows it (the member's attendance, your membership terms, messages with them)${due ? ` before ${due}` : " as soon as you can"}. JitsFlow passes it to Paystack, which answers the bank. If you don't answer in time, the bank usually gives the money back to the member.`,
      "If they should get the money back, tell us and we'll accept it."], button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  psDisputeAdmin: (gym, who, amount, ref, due) => ({ subject: `Chargeback at ${gym}`, title: "A card payment is disputed",
    paras: [`${who} disputed a card payment of ${amount} at ${gym} (Paystack reference ${ref}).${due ? ` Paystack needs an answer before ${due}.` : ""}`,
      "The head coach has been asked for their evidence. Answer in Paystack's dashboard (Disputes), then mark it done on the JitsFlow dashboard."],
    button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  psDisputeResolved: (coach, who, amount, lost) => ({ subject: lost ? "A disputed card payment went back to the member" : "You kept a disputed card payment", title: lost ? "Dispute lost" : "Dispute won",
    paras: [`Hi ${coach},`, lost ? `The bank gave ${who}'s ${amount} back to them, so it no longer counts as paid in Money.` : `The bank decided ${who}'s payment of ${amount} stays with you. Nothing changes in Money.`],
    button: { label: "Open Money", url: appUrl() + "/app/#coach-money" } }),
  // To a coach: a private booked or cancelled, a member left, or a new member picked their plan. Fixed subjects; the line says who and when.
  coachNews: (kind, name, line) => { const t = { booked: "A private lesson was booked", cancelled: "A private lesson was cancelled", left: "A member left your gym", joined: "A new member picked a plan", resumed: "A member is training again", kidask: "A parent asked to add a kid", unlinked: "A parent deleted their login", duplicate: "A new member may be on your list already", ownaccount: "A member made their own JitsFlow account" }[kind];
    return { subject: t, title: t, paras: [`Hi ${name},`, line], button: { label: "Open JitsFlow", url: appUrl() + "/app/#coach" } }; },
  privateBooked: (name, gym, when) => ({ subject: "Your private lesson is booked", title: "Private lesson booked",
    paras: [`Hi ${name},`, `You're booked for a private lesson at ${gym}: ${when}.`, "It's free to cancel in the app until it starts."],
    button: { label: "See your bookings", url: appUrl() + "/app/#book" } }),
  headCoach: (name, gym, by) => ({ subject: "You're now the head coach", title: "You're the head coach",
    paras: [`Hi ${name},`, `${by} made you the head coach of ${gym} on JitsFlow.`, "You now see the Money tab: fees, payments, bank details and PayFast. Payment emails come to you."],
    button: { label: "Open JitsFlow", url: appUrl() + "/app/#coach" } }),
  // To the platform admins: a gym claimed its preview (see backend/outreach.js).
  prospectClaimed: (gym, who, email, site) => ({ subject: `${gym} claimed JitsFlow`, title: `${gym} claimed JitsFlow`,
    paras: [`${who} (${email}) claimed ${gym} from its preview${site ? ` (${site})` : ""}. They're its head coach now, with the timetable, coaches and prices from the preview.`, "Say hello: a quick welcome from a person goes a long way."],
    button: { label: "Open Outreach", url: appUrl() + "/app/#me" } }),
  // To the platform admins: a gym applied for the beta, or a beta gym sent feedback (see the Beta section of the team's dashboard).
  betaApplied: (gym, who, email, note) => ({ subject: `${gym} applied for the beta`, title: `${gym} applied for the beta`,
    paras: [`${who} (${email}) applied for the JitsFlow beta for ${gym}.`, note ? `What they'd want built: ${note}` : "They didn't say what they'd want built.", "Accept or decline it in the Beta section of the dashboard."],
    button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  betaFeedback: (gym, who, email, text, shot) => ({ subject: `Beta feedback from ${gym}`, title: `Feedback from ${gym}`,
    paras: [`${who} (${email}) sent feedback${shot ? " with a screenshot" : ""}:`, text || "(No text, just the screenshot.)", "It's in the feedback inbox in the Beta section of the dashboard."],
    button: { label: "Open the dashboard", url: appUrl() + "/app/#me" } }),
  // Bank or PayFast details changed (to the head coach), or the coaches changed (to every active coach). Fixed subjects.
  gymChange: (kind, name, who, detail) => { const t = {
      bank: ["Your gym's bank details changed", `${who} changed the bank details your students pay into.`],
      payfast: ["Your gym's PayFast account changed", `${who} connected a PayFast account (Merchant ID ${detail}). Students' card payments now go to that account.`],
      payout: ["Your gym's card payout account changed", `${who} set the bank account Paystack pays your members' card payments into: ${detail}. Card payments pause until JitsFlow has checked it, usually within a day.`],
      removed: ["A coach was removed from your gym", `${who} removed ${detail} as a coach. They can't see your roster or payments any more, and your coach code has changed.`],
      inactive: ["A coach was marked inactive", `${who} marked ${detail} as inactive. They can't use the coach tools until a coach switches them back on.`] }[kind];
    return { subject: t[0], title: t[0], paras: [`Hi ${name},`, t[1], "Didn't expect this? Open JitsFlow now and check your payment details and who your coaches are."],
      button: { label: "Open JitsFlow", url: appUrl() + "/app/#coach" } }; },
};

module.exports = { oneLine, send, sendRaw, sendLater, templates, mailOn, appUrl, layout };
