// The pricing, terms, refunds, contact and secure-payments pages, and the legal footer every page carries.
// Business details come from src/business.json (tools/business.js); prices and the platform fee from the code that charges
// them (backend/payfast.js, backend/beta.js), so the pages can't drift from what Payfast and Paystack are asked to charge.
// JitsFlow's own gym plan is billed through Payfast. Members pay their gym through Paystack (card, Apple Pay, Capitec Pay) or by EFT.
// Member card payments say "coming soon" until JitsFlow's Paystack is live: each page carries both wordings (soonLive) and
// server.js keeps the one that applies when it starts (JF_PAYSTACK_LIVE=1 or a live PAYSTACK_SECRET_KEY: live; otherwise soon).
// Used by tools/seo.js: legalFooter() goes in its page frame, and legalPages() adds the pages with its frame and add().
"use strict";
const { load } = require("./business");
const payfast = require("../backend/payfast");
const beta = require("../backend/beta");

const UPDATED = "23 November 2026";
// Both wordings, for server.js to pick from (see the top of this file). Only in page text: never in an attribute or <head>.
const soonLive = (soon, live) => `<!--jf:soon-->${soon}<!--/jf:soon--><!--jf:live-->${live}<!--/jf:live-->`;
// How members pay their gym, in the words every page uses.
// The official Apple Pay and Google Pay marks (artwork from Apple's and Google's brand pages, unmodified), shown only where that way of
// paying is really on: Apple Pay once members' card payments are live on Paystack; Google Pay for gym plans once Payfast has switched it
// on for JitsFlow (JF_PAYFAST_GOOGLE_PAY=1, read by server.js, which drops the <!--jf:gpay--> block otherwise).
const payMarks = () => `<!--jf:live--><figure class="paymarks"><img src="/img/pay/apple-pay-mark.svg" alt="Apple Pay" width="54" height="35" loading="lazy" decoding="async"><figcaption>Members' card payments</figcaption></figure><!--/jf:live-->` +
  `<!--jf:gpay--><figure class="paymarks"><img src="/img/pay/google-pay-mark.png" alt="Google Pay" width="66" height="35" loading="lazy" decoding="async"><figcaption>Gym plans</figcaption></figure><!--/jf:gpay-->`;
const memberPay = (fee) => soonLive(
  `Members pay their gym by EFT with their own reference today. Card, Apple Pay and Capitec Pay are coming soon: card payments will be processed by Paystack and paid by Paystack directly into the gym's bank account, so JitsFlow never holds membership money. JitsFlow's ${fee}% platform fee and Paystack's processing fee will be deducted from each card payment.`,
  `Members pay their gym by card, Apple Pay, Capitec Pay or EFT. Card payments are processed by Paystack and paid by Paystack directly into the gym's bank account; JitsFlow never holds membership money. JitsFlow's ${fee}% platform fee and Paystack's processing fee are deducted from each card payment.`);
const PS_PRICING = `<a href="https://paystack.com/za/pricing" rel="noopener">paystack.com/za/pricing</a>`; // change when the terms, refund policy or pricing text changes
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rand = (c) => "R" + (c % 100 ? (c / 100).toFixed(2) : String(Math.round(c / 100)));

function facts() {
  const { biz } = load();
  return { biz, price: rand(payfast.PRICE_CENTS()), months: payfast.TRIAL_MONTHS(), fee: payfast.FEE_PCT(), betaMonths: beta.FREE_MONTHS, betaPrice: rand(beta.AFTER_CENTS) };
}
// "B3D Projects (Pty) Ltd (trading as B-3 Data)", or the trading name when the legal name isn't filled in.
const entity = (b) => b.legalName ? esc(b.legalName) + (b.tradingAs ? ` (trading as ${esc(b.tradingAs)})` : "") : esc(b.tradingName);
const mail = (b) => b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : "";
const tel = (b) => b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ""))}">${esc(b.phone)}</a>` : "";

const LINKS = [["Pricing", "/pricing/"], ["Terms", "/terms/"], ["Refunds", "/refunds/"], ["Privacy", "/privacy/"], ["Secure payments", "/security/"], ["Contact", "/contact/"]];
// The legal line under the links: who runs JitsFlow, and who processes payments. year: the build's.
function legalLine() {
  const { biz: b } = facts();
  const parts = [`© ${new Date().getFullYear()} ${esc(b.tradingName)}${b.legalName ? `, a product of ${entity(b)}` : ""}`, b.regNo ? `Company registration number ${esc(b.regNo)}` : "",
    esc(b.address), mail(b), "Payments are processed securely by Payfast (JitsFlow plans) and Paystack (members' card payments to their gym" + soonLive(", coming soon).", ").")];
  return parts.filter(Boolean).join(" · ");
}
// For the content pages' frame (tools/seo.js).
const legalFooter = () => `<nav class="foot legal" aria-label="Pricing and policies">${LINKS.map(([n, u]) => `<a href="${u}">${n}</a>`).join("")}</nav>\n<p class="legalline">${legalLine()}</p>`;
// For the home and coaches pages (build.py fills @@LEGAL_FOOT@@ with it): their footer's own markup.
const landingFooter = () => `<span class="footlinks legal">${LINKS.map(([n, u]) => `<a href="${u}">${n}</a>`).join(" · ")}</span>\n    <span class="legalline">${legalLine()}</span>`;

// schema.org Organization, with the address split into its parts when it ends "…, <city>, <code>, <country>".
function orgLd(SITE) {
  const { biz: b } = facts();
  const m = b.address.match(/^(.*?),\s*([^,]+),\s*(\d{4}),\s*([^,]+)$/);
  const address = b.address ? { "@type": "PostalAddress", ...(m ? { streetAddress: m[1], addressLocality: m[2], postalCode: m[3] } : { streetAddress: b.address, addressLocality: b.city }), addressCountry: "ZA" } : undefined;
  return { "@context": "https://schema.org", "@type": "Organization", name: b.tradingName, url: SITE + "/", ...(b.legalName ? { legalName: b.legalName } : {}),
    ...(b.email ? { email: b.email } : {}), ...(b.phone ? { telephone: b.phone } : {}), ...(address ? { address } : {}),
    ...(b.regNo ? { identifier: { "@type": "PropertyValue", propertyID: "CIPC company registration number", value: b.regNo } } : {}),
    contactPoint: { "@type": "ContactPoint", contactType: "customer support", ...(b.email ? { email: b.email } : {}), ...(b.phone ? { telephone: b.phone } : {}), areaServed: "ZA", availableLanguage: "English" } };
}

const policyLinks = (skip) => `<p class="small muted">${LINKS.filter(([, u]) => u !== skip).map(([n, u]) => `<a href="${u}">${n}</a>`).join(" · ")}</p>`;
const updated = `<p class="small muted">Last updated: ${UPDATED}</p>`;

function legalPages({ frame, add, SITE }) {
  const { biz: b, price, months, fee, betaMonths, betaPrice } = facts();
  const crumbs = (n, u) => [["JitsFlow", "/"], [n, u]];
  const contactLine = [mail(b), tel(b)].filter(Boolean).join(" or ");

  // --- pricing
  add("/pricing/", frame({ url: "/pricing/", type: "website", title: `Pricing: free for students, ${price}/month for gyms | JitsFlow`, image: "/og/coaches.jpg",
    desc: `JitsFlow is free for students. Gyms get ${months} months free, then ${price} a month, billed monthly by card through Payfast. No contract, cancel any time. All prices in South African rand.`,
    crumbs: crumbs("Pricing", "/pricing/"),
    ld: [{ "@context": "https://schema.org", "@type": "Product", name: "JitsFlow for gyms", description: "Gym management software for Brazilian Jiu-Jitsu gyms: timetable, bookings, members, fees and reminders.", brand: { "@type": "Brand", name: "JitsFlow" },
      offers: { "@type": "Offer", price: (payfast.PRICE_CENTS() / 100).toFixed(2), priceCurrency: "ZAR", url: SITE + "/pricing/", availability: "https://schema.org/InStock",
        priceSpecification: { "@type": "UnitPriceSpecification", price: (payfast.PRICE_CENTS() / 100).toFixed(2), priceCurrency: "ZAR", billingDuration: "P1M", unitText: "month" } } }],
    body: `<article class="stack-lg"><header class="stack"><p class="eyebrow">Pricing</p><h1>Simple pricing</h1>
<p class="lead">Free for students. For gyms, the first ${months} months are free, then it's ${price} a month per gym. No card needed to start, no contract, and you can cancel any time.</p></header>
<section class="stack"><h2>Prices</h2>
<div class="tablewrap"><table class="ptable"><thead><tr><th scope="col">Who</th><th scope="col">Price</th><th scope="col">How it's paid</th></tr></thead><tbody>
<tr><th scope="row">Students and gym members</th><td><b>Free</b></td><td class="mut">Nothing to pay. JitsFlow never charges students for the app.</td></tr>
<tr><th scope="row">Gyms</th><td><b>${months} months free, then ${price}/month</b></td><td class="mut">Per gym. Billed monthly by card through Payfast, only once you add a card.</td></tr>
<tr><th scope="row">Gyms in the JitsFlow beta</th><td><b>${betaMonths} months free, then ${betaPrice}/month</b></td><td class="mut">For gyms accepted into the beta, while they stay in it.</td></tr>
<tr><th scope="row">Member fees paid by EFT</th><td><b>No JitsFlow fee</b></td><td class="mut">Members pay the gym's bank account with their own reference.</td></tr>
<tr><th scope="row">Member fees paid by card</th><td><b>${fee}% platform fee</b></td><td class="mut">${soonLive("Card, Apple Pay and Capitec Pay are coming soon, through Paystack.", "Card, Apple Pay and Capitec Pay, through Paystack.")} Paystack pays the rest straight into the gym's bank account. Paystack's processing fee applies too (${PS_PRICING}).</td></tr>
</tbody></table></div>
<div class="paymarks-row">${payMarks()}</div>
${b.priceNote ? `<p>${esc(b.priceNote)}</p>` : b.vatNote ? `<p>All prices are in South African rand (ZAR). ${esc(b.vatNote)}.</p>` : `<p>All prices are in South African rand (ZAR).</p>`}</section>
<section class="stack"><h2>What a gym gets</h2><ul class="ticks">
<li>Timetable and calendar: plan a class once and repeat it weekly, or copy a whole week forward. Import it from your website.</li>
<li>Bookings, waitlists and check-in, and class limits per membership plan.</li>
<li>Members, kids and parents on one login, and coach invites.</li>
<li>Membership plans and fees with running balances, fee reminders, and EFT with each member's own reference and proof of payment.</li>
<li>Attendance insights, competitions and WhatsApp invites.</li>
<li>The no-gi study app for every member: techniques, positions and a belt curriculum.</li></ul></section>
<section class="stack"><h2>How billing works</h2><ol class="steps">
<li><span><b>Start free.</b> Start your gym with no card. Your first ${months} months are free.</span></li>
<li><span><b>Add a card when you're ready.</b> In the app: Gym tab › Your JitsFlow plan › Add a card. You enter your card on Payfast's secure checkout. Nothing is charged during your free months.</span></li>
<li><span><b>Monthly billing.</b> Payfast charges ${price} on the day after your free months end, then on about the same date each month. The app shows the date your free months end. If you add a card after that, the first charge is on the day you add it.</span></li>
<li><span><b>Cancel any time.</b> Gym tab › Your JitsFlow plan › Cancel plan. Payfast won't charge your card again. There's no cancellation fee and no notice period.</span></li></ol>
<p>If you don't add a card, nothing is charged and nothing locks: the app reminds the head coach that the free months are over. After you cancel, your gym and its data stay in JitsFlow, and you can add a card again whenever you like. We don't refund part-months; see the <a href="/refunds/">refund policy</a>. If we ever change the price, we'll tell you by email at least 30 days before the new price applies.</p></section>
<section class="stack"><h2>Member payments</h2>
<p>${memberPay(fee)}</p>
<p>The gym is the seller of its memberships, and JitsFlow is the software in between. The gym doesn't need a payment account of its own: it gives its bank account in the app once, and we check it before card payments switch on.</p>
<ul class="ticks"><li><b>EFT with a reference:</b> free. Members pay the gym's bank account with their own reference and send a proof of payment in the app.</li>
<li><b>Card, Apple Pay and Capitec Pay:</b> ${soonLive("coming soon, on Paystack's secure checkout.", "on Paystack's secure checkout (Apple Pay on devices that support it).")} Paystack pays the gym's share into the gym's bank account, normally 2 working days after each payment.</li>
<li><b>JitsFlow's ${fee}% platform fee</b> is split off by Paystack at the time of each card payment. The member pays the gym's normal price; the fee comes out of what the gym receives, and so does Paystack's processing fee (see ${PS_PRICING}).</li></ul>
<p>JitsFlow's own gym plan is billed separately, through Payfast (above).</p></section>
<section class="panel cta"><h2>Start your gym</h2><p>Paste your gym's website and your timetable, coaches and prices are in. ${months} months free, no card needed.</p><a class="btn primary" href="/app/?start=1" data-ev="start_gym">Start your gym</a></section>
<p>Questions about pricing? ${contactLine || "See the contact page"}. Read the <a href="/terms/">terms of service</a>, the <a href="/refunds/">refund and cancellation policy</a> and how <a href="/security/">payments are kept secure</a>.</p>
</article>` }), 0.6);

  // --- terms of service
  const who = `${entity(b)}${b.entityType ? `, a ${esc(b.entityType.toLowerCase())} registered in ${esc(b.country || "South Africa")}` : ""}${b.regNo ? ` (company registration number ${esc(b.regNo)})` : ""}`;
  add("/terms/", frame({ url: "/terms/", type: "website", title: "Terms of service | JitsFlow", image: "/og/home.jpg",
    desc: `The terms for using JitsFlow: accounts, the gym plan (${price}/month after ${months} free months, billed through Payfast), member payments, acceptable use, safety and your rights under South African law.`,
    crumbs: crumbs("Terms", "/terms/"),
    body: `<article class="stack-lg legal-doc"><header class="stack"><p class="eyebrow">Terms of service</p><h1>Terms of service</h1>
<p class="lead">The rules for using JitsFlow, in plain English. By creating an account or using the app or website, you agree to them.</p>${updated}</header>
<section><h2>1. Who we are</h2><p>JitsFlow (www.jitsflow.com) is a product of ${who}. In these terms, "we" and "us" means that company, and "you" means the person using JitsFlow (or, for a gym, the gym and the coach who runs its account).</p>
<ul>${b.address ? `<li>Physical address, also our address for service of legal documents: ${esc(b.address)}</li>` : ""}${b.email ? `<li>Email: ${mail(b)}</li>` : ""}${b.phone ? `<li>Phone: ${tel(b)}</li>` : ""}${b.vatNo ? `<li>VAT number: ${esc(b.vatNo)}</li>` : b.vatNote ? `<li>${esc(b.vatNote)}</li>` : ""}<li>Website: <a href="/">www.jitsflow.com</a></li></ul>
<p>The <a href="/contact/">contact page</a> has these details too, and the disclosures section 43 of the Electronic Communications and Transactions Act (ECTA) asks for are in these terms, the <a href="/pricing/">pricing page</a>, the <a href="/refunds/">refund policy</a>, the <a href="/security/">secure payments page</a> and the <a href="/privacy/">privacy notice</a>. You can save or print any of these pages from your browser.</p></section>
<section><h2>2. The service</h2><p>JitsFlow is a no-gi Brazilian Jiu-Jitsu study app (free for students) and software that gyms use to run their timetable, bookings, members, fees and payment reminders. It's a digital service: there are no physical goods and nothing is shipped. You get access as soon as you sign up, and a gym's plan applies as soon as it's set up.</p></section>
<section><h2>3. Accounts</h2><ul><li>Give accurate details, keep your password to yourself, and tell us if you think someone else has used your account.</li>
<li>If you're under 18, you need a parent's or guardian's permission to create an account. Gyms that add children must have a parent's permission first (see the <a href="/privacy/">privacy notice</a>).</li>
<li>A coach who sets up a gym confirms they're allowed to act for that gym, and accepts these terms for it.</li></ul></section>
<section><h2>4. Gym plans and billing</h2><ul>
<li><b>Free months:</b> a new gym's first ${months} months are free. No card is needed to start, and nothing is charged unless the head coach adds a card.</li>
<li><b>Price:</b> after the free months, ${price} a month per gym, in South African rand.${b.priceNote ? " " + esc(b.priceNote) : ""} Gyms accepted into the JitsFlow beta get ${betaMonths} months free, then ${betaPrice} a month while they stay in the beta.</li>
<li><b>Recurring billing:</b> when you add a card, you authorise a monthly charge of the plan price through Payfast, until you cancel. The first charge is on the day after your free months end (the app shows this date), or on the day you add the card if they've already ended, and then on about the same date every month. There's no fixed term and no contract.</li>
<li><b>Failed payments:</b> if a payment doesn't go through, the app asks the head coach to add a card again. We don't lock your gym out while it's sorted.</li>
<li><b>Price changes:</b> we'll give you at least 30 days' notice by email before a new price applies to your plan. If you don't want to continue at the new price, cancel before it applies.</li>
<li><b>Cancelling:</b> cancel any time in the app: Gym tab › Your JitsFlow plan › Cancel plan, or email us. Payfast won't charge your card again. Your gym keeps its access at least until the end of the month you've paid for, and its data stays until you delete the gym. See the <a href="/refunds/">refund and cancellation policy</a>.</li></ul></section>
<section><h2>5. Member payments</h2><ul>
<li>Members pay their gym, not JitsFlow. The gym is the merchant (the seller) for its memberships, class packs and other fees. The gym sets its prices and its own membership terms.</li>
<li>${memberPay(fee)}</li>
<li>JitsFlow provides the software: the Pay sheet, reminders and records. We aren't a party to the agreement between a member and their gym.</li>
<li>JitsFlow charges the gym a ${fee}% platform fee on each member card payment. Paystack splits it off at the time of payment, and deducts its own processing fee (${PS_PRICING}). Payments by EFT with the member's reference carry no JitsFlow fee.</li>
<li>A gym that takes card payments gives its bank account in the app and confirms it's the gym's own account. We check it before card payments switch on, and Paystack may hold the first payout to a new or changed account until it's verified.</li>
<li>Questions or disputes about membership fees, refunds, classes or cancellations are between the member and the gym. We'll help where we can: email us.</li></ul></section>
<section><h2>6. Acceptable use</h2><p>Don't use JitsFlow to break the law, send spam, harass anyone, upload things you don't have the right to share, collect other people's details without permission, get into accounts or data that aren't yours, overload or probe our systems, or copy the app or its content in bulk.</p></section>
<section><h2>7. Your content and data</h2><p>What you add (notes, training logs, a gym's timetable, members and payments) stays yours. You let us store and show it only to run JitsFlow for you. For the details a gym keeps about its members, the gym is responsible for them under the Protection of Personal Information Act (POPIA) and we process them on the gym's behalf. How we handle personal information is in the <a href="/privacy/">privacy notice</a>.</p>
<p>JitsFlow support can access a gym's account to help when needed. Every change is logged, and the gym's owner is told.</p></section>
<section><h2>8. Techniques and videos</h2><p>The technique text, flow map and curriculum are ours. Technique videos are embedded from YouTube and belong to their creators; they're shown with YouTube's player and remain subject to YouTube's terms.</p></section>
<section><h2>9. Train safely</h2><p>Jiu-Jitsu is a contact sport with a real risk of injury. JitsFlow is a study aid: it doesn't replace a qualified coach and isn't medical advice. Learn and drill techniques under a qualified coach, tap early, release submissions when your partner taps, and see a doctor about injuries. You train at your own risk.</p></section>
<section><h2>10. Availability and changes</h2><p>We work to keep JitsFlow running, but it may sometimes be unavailable for maintenance or reasons beyond our control. The study parts of the app keep working offline. We may improve or change features; if we remove something a paying gym relies on, we'll tell you first.</p></section>
<section><h2>11. Our liability</h2><p>As far as the law allows, we aren't liable for indirect or consequential losses (like lost profits), and our total liability to a gym is limited to what it paid us in the 12 months before the claim. Nothing in these terms limits rights you have under the Consumer Protection Act or ECTA that can't be limited, or our liability for gross negligence or fraud.</p></section>
<section><h2>12. Ending your account</h2><p>You can delete your account any time in the app (Settings › Your account › Delete account), and a head coach can delete their gym in the Gym tab. We may suspend or close an account that breaks these terms, after warning you where that's reasonable. If we stop offering JitsFlow, we'll give gyms at least 30 days' notice and stop billing.</p></section>
<section><h2>13. Your consumer rights</h2><p>Where ECTA's cooling-off right applies to you (section 44), you may cancel a paid plan within 7 days of the agreement without a reason or penalty, and we'll refund what you paid. Payment security and privacy are described on the <a href="/security/">secure payments</a> and <a href="/privacy/">privacy</a> pages.</p></section>
<section><h2>14. Law and disputes</h2><p>These terms are governed by the law of the Republic of South Africa. If something goes wrong, email us first and we'll try to sort it out. If we can't, either of us may take it to the South African courts with jurisdiction, and you may also approach the National Consumer Commission or another consumer body where the Consumer Protection Act applies.</p></section>
<section><h2>15. Changes to these terms</h2><p>We may update these terms. The date at the top shows the latest version. If a change matters for paying gyms, we'll tell them by email or in the app at least 30 days before it applies.</p></section>
<section><h2>16. Contact</h2><p>${contactLine ? `Questions about these terms: ${contactLine}.` : ""}${b.address ? ` Post: ${entity(b)}, ${esc(b.address)}.` : ""}</p></section>
${policyLinks("/terms/")}</article>` }), 0.3);

  // --- refunds and cancellation
  add("/refunds/", frame({ url: "/refunds/", type: "website", title: "Refund and cancellation policy | JitsFlow", image: "/og/home.jpg",
    desc: "Cancel your JitsFlow gym plan any time, with no further charges. Billing errors and duplicate charges are refunded in full. Membership fee refunds are handled by your gym.",
    crumbs: crumbs("Refunds", "/refunds/"),
    body: `<article class="stack-lg legal-doc"><header class="stack"><p class="eyebrow">Refunds and cancellation</p><h1>Refund and cancellation policy</h1>
<p class="lead">Cancel your gym's plan any time and you won't be charged again. If we charged you by mistake, we refund it in full.</p>${updated}</header>
<section><h2>Your gym's JitsFlow plan</h2><ul>
<li><b>Cancel any time</b> in the app: Gym tab › Your JitsFlow plan › Cancel plan, or email ${mail(b) || "us"}. There's no cancellation fee and no notice period, and Payfast won't charge your card again.</li>
<li><b>After you cancel</b>, your gym keeps its access at least until the end of the month you've paid for. Its data stays until you delete the gym, and you can add a card again any time.</li>
<li><b>No part-month refunds:</b> the monthly fee covers the month it's charged for, so we don't refund the unused part of a month.</li>
<li><b>Billing errors and duplicate charges</b> are refunded in full, to the card you paid with, through Payfast. Refunds usually reach your account within 7 to 10 business days after we confirm the error, depending on your bank.</li>
<li>Where ECTA's 7-day cooling-off right applies to you, you can cancel within 7 days of the agreement and get a full refund.</li></ul></section>
<section><h2>How to ask for a refund</h2><p>Email ${mail(b) || "us"} with your gym's name, the date and amount of the charge, and what went wrong. We'll check it with Payfast and confirm by email, and the refund goes back to the card that was charged. Refunds are never more than the original payment, and never to a different card.</p></section>
<section><h2>Membership fees you pay your gym</h2><ul>
<li>Your gym is the seller of its memberships, so refunds of membership fees, class packs and other fees are up to your gym and its own terms. Contact your gym first.</li>
<li>A gym refunds a card payment in the app (Money), in full or in part, back to the card it was paid with, through Paystack. Paystack reverses the payment's split (the gym's share and JitsFlow's ${fee}% platform fee) under its own refund rules.</li>
<li>If you can't sort it out with your gym, email us and we'll help where we can.</li></ul></section>
<section><h2>Chargebacks</h2><p>Please contact us (for your gym's plan) or your gym (for membership fees) before disputing a card payment with your bank. Most problems are quicker to fix directly. If a chargeback is raised, it's handled under the card schemes' rules by Payfast (for a gym's plan) or Paystack (for membership fees). For membership fees the gym gives its evidence, which we pass to Paystack, and we give the processor the records it asks for.</p></section>
<section><h2>Delivery</h2><p>JitsFlow is a digital service. Access is immediate after you sign up or pay, and there are no physical goods, so nothing is shipped and there are no delivery fees. Prices are in South African rand${b.priceNote && /not vat/i.test(b.priceNote) ? ", with no VAT added" : ""}.</p></section>
${policyLinks("/refunds/")}</article>` }), 0.3);

  // --- contact
  const rows = [["Trading name", esc(b.tradingName)], ["Company", b.legalName ? esc(b.legalName) : ""], ["Trading as", esc(b.tradingAs)], ["Company registration number", esc(b.regNo)],
    ["Directors", esc(b.directors)], ["VAT", b.vatNo ? `VAT number ${esc(b.vatNo)}` : esc(b.vatNote)], ["Physical address", esc(b.address)], ["Email", mail(b)], ["Phone", tel(b)], ["Hours", esc(b.hours)],
    ["Website", `<a href="/">www.jitsflow.com</a>`]].filter(([, v]) => v);
  add("/contact/", frame({ url: "/contact/", type: "website", title: "Contact JitsFlow", image: "/og/home.jpg",
    desc: `Contact JitsFlow${b.email ? " at " + b.email : ""}. Business details${b.legalName ? " for " + b.legalName : ""}, and links to our terms, refund policy, pricing and privacy notice.`,
    crumbs: crumbs("Contact", "/contact/"), ld: [orgLd(SITE)],
    body: `<article class="stack-lg"><header class="stack"><p class="eyebrow">Contact</p><h1>Contact us</h1>
<p class="lead">Questions about your account, your gym's plan, a payment or a refund? ${b.email ? `Email ${mail(b)}${b.phone ? ` or call ${tel(b)}` : ""}${b.hours ? ` (${esc(b.hours)})` : ""}.` : ""}</p></header>
<section class="stack"><h2>Business details</h2><dl class="biz">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
${b.legalName ? `<p class="small muted">JitsFlow is a product of ${entity(b)}.</p>` : ""}</section>
<section class="panel"><h2>Payments</h2><p>Payments are processed securely by Payfast (JitsFlow plans) and Paystack (members' card payments to their gym${soonLive(", coming soon).", ").")} JitsFlow never sees or stores your card number. <a href="/security/">How payments are kept secure</a>.</p>
<p>${memberPay(facts().fee)}</p></section>
<section class="stack"><h2>Policies</h2><ul class="links"><li><a href="/pricing/">Pricing</a></li><li><a href="/terms/">Terms of service</a></li><li><a href="/refunds/">Refund and cancellation policy</a></li><li><a href="/privacy/">Privacy notice</a></li><li><a href="/security/">Secure payments</a></li></ul></section>
<p class="small muted">Membership fees are paid to your gym. For a refund of a membership fee, contact your gym first; we'll help if you can't sort it out.</p>
</article>` }), 0.4);

  // --- secure payments
  add("/security/", frame({ url: "/security/", type: "website", title: "Secure payments | JitsFlow", image: "/og/home.jpg",
    desc: "Card payments on JitsFlow go through Payfast's and Paystack's secure checkouts. JitsFlow never sees or stores your card number. HTTPS everywhere.",
    crumbs: crumbs("Secure payments", "/security/"),
    body: `<article class="stack-lg legal-doc"><header class="stack"><p class="eyebrow">Secure payments</p><h1>Secure payments</h1>
<p class="lead">Card payments go through Payfast (a gym's JitsFlow plan) and Paystack (members paying their gym), both PCI DSS compliant payment processors. Your card details go to them only, never to JitsFlow.</p></header>
<section><h2>How it works</h2><ul>
<li>When you pay or add a card, JitsFlow sends you to Payfast's or Paystack's secure checkout, where you enter your card or choose another payment method. Both are PCI DSS compliant, the card industry's security standard.</li>
<li>JitsFlow never sees, receives or stores your full card number or security code (CVV).</li>
<li>For monthly billing or a saved card, Payfast or Paystack gives us a token (Paystack calls it an authorization): a reference that lets us ask them to charge that card. A token isn't your card number and is useless outside the processor. Saved-card tokens are encrypted when we store them.</li>
<li>We only mark a payment as paid when the processor's notification about it has a valid signature and the processor confirms it directly, for the amount and account the checkout asked for.</li>
<li>Membership money is paid by Paystack straight into the gym's bank account. JitsFlow never holds it. A gym's bank and ID details are encrypted when we store them, and shown only by their last 4 digits.</li>
<li>The whole site uses HTTPS (encrypted connections), and browsers are told to always use it (HSTS).</li></ul></section>
<section><h2>Ways to pay</h2><p>Gym plans are paid to JitsFlow by card (Visa and Mastercard) or another method Payfast offers at its checkout. Which ones you see depends on your device. All amounts are in South African rand (ZAR).</p>
<p>${memberPay(facts().fee)} Paystack's checkout shows the methods it offers on your device.</p><div class="paymarks-row">${payMarks()}</div></section>
<section><h2>Spotted a problem?</h2><p>If you see a charge you don't recognise, or think something isn't secure, email ${mail(b) || "us"} straight away.</p></section>
${policyLinks("/security/")}</article>` }), 0.3);
}

module.exports = { legalFooter, landingFooter, legalPages, LINKS, UPDATED, facts, soonLive, memberPay };
