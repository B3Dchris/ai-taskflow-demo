// Gym website import: safety checks, the plain read, and the Claude read with a stand-in client.
// Usage: node tests/importer.js   (no database or API key needed)
const { startGymSite } = require("./fixture-gym");
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };

(async () => {
  const site = await startGymSite();
  const im = require("../backend/importer");
  try {
    // ---- safety: only public http(s) sites
    delete process.env.JF_IMPORT_ALLOW_LOOPBACK;
    ok(await rejects(im.importSite(site.url), /isn't a public website/), "loopback sites are refused");
    ok(await rejects(im.importSite("http://localhost/"), /isn't a public website/), "localhost is refused");
    ok(await rejects(im.importSite("http://10.1.2.3/"), /isn't a public website/), "private network addresses are refused");
    ok(await rejects(im.importSite("http://[::1]/"), /isn't a public website/), "IPv6 loopback is refused");
    ok(await rejects(im.importSite("http://169.254.169.254/latest/"), /isn't a public website/), "cloud metadata address is refused");
    ok(await rejects(im.importSite("file:///etc/passwd"), /http/), "file: URLs are refused");
    ok(await rejects(im.importSite("https://example.com:8443/"), /isn't a public website/), "odd ports are refused");
    ok(await rejects(im.importSite("https://user:pw@example.com/"), /plain address/), "URLs with passwords are refused");
    ok(im.privateIp("::ffff:127.0.0.1") && im.privateIp("172.20.0.1") && im.privateIp("fd00::1") && !im.privateIp("8.8.8.8") && !im.privateIp("2606:4700::1111"), "private address check");

    process.env.JF_IMPORT_ALLOW_LOOPBACK = "1";
    ok(await rejects(im.safeGet(site.url + "/to-metadata"), /isn't a public website/), "a redirect to a private address is refused");
    const big = await im.safeGet(site.url + "/huge", { maxBytes: 100000 });
    ok(big.truncated && big.body.length === 100000, "big pages are cut off at the size limit");
    ok((await im.fetchImage(site.url + "/evil.svg")) === null, "SVG logos are refused (they can carry script)");
    ok((await im.fetchImage(site.url + "/img/site-logo.png")).type === "image/png", "PNG logos are accepted by their bytes");

    // ---- plain read (no API key)
    const r = await im.importSite(site.url.replace("127.0.0.1", "localhost"), { client: null });
    const p = r.profile;
    ok(r.method === "basic", "without a key it uses the plain read");
    ok(p.name === "Fourways Grappling Club", "gym name from the page title: " + p.name);
    ok(/Witkoppen Road/.test(p.address) && /Fourways, Johannesburg/.test(p.address), "address from the Location block: " + p.address);
    ok(!/@|555/.test(p.address), "contact line isn't mixed into the address");
    ok(!p.rates.some((x) => x.price < 10), "the injected 'R1' line on the home page isn't read as a price");
    ok(p.phone.replace(/\s/g, "") === "+27115550101" && p.email === "hello@fourwaysgrappling.example", "phone and email from links");
    ok(p.socials.instagram === "https://www.instagram.com/fourwaysgrappling/" && p.socials.whatsapp === "https://wa.me/27821234567" && !p.socials.facebook, "social links (share buttons ignored)");
    const tt = p.timetable, find = (d, s) => tt.find((x) => x.day === d && x.start === s);
    ok(find("Mon", "06:00") && find("Wed", "06:00") && find("Mon", "06:00").coach === "Thabo" && find("Mon", "06:00").title === "No-Gi Fundamentals", "list timetable under day headings, with coach");
    ok(find("Tue", "17:00") && find("Tue", "17:00").end === "17:45" && find("Thu", "18:00") && find("Thu", "18:00").end === "19:30" && find("Sat", "09:00"), "table timetable rows and am/pm times");
    ok(tt.length === 7, "7 class times found: " + tt.length);
    const rate = (n) => p.rates.find((x) => x.name.includes(n));
    ok(rate("Kids") && rate("Kids").price === 600 && rate("Kids").period === "month" && rate("Drop-in").period === "class" && rate("Joining").period === "once", "rates with periods: " + JSON.stringify(p.rates.map((x) => [x.name, x.price, x.period])));
    ok(p.rates.some((x) => x.price === 850 && x.period === "month" && x.currency === "ZAR"), "R 850 per month read as ZAR monthly");
    ok(!p.rates.some((x) => x.price === 450), "shop prices are left out");
    ok(p.coaches.length === 2 && p.coaches[0].name === "Thabo Nkosi" && /Black belt/.test(p.coaches[0].rank) && /15 years/.test(p.coaches[0].bio), "coaches with rank and bio");
    ok(r.logos.length >= 1 && /^data:image\/png;base64,/.test(r.logos[0].dataUrl) && /site-logo/.test(r.logos[0].url), "logo found and previewed");
    ok(r.logos.length === 1, "the same logo at two addresses is shown once");
    ok(!site.hits.includes("/shop") && r.pages.length === 5, "reads the useful pages, not the shop: " + r.pages.map((x) => x.url).join(" "));

    // ---- Claude read with a stand-in client
    let sent = null;
    const fake = (out, extra = {}) => ({ beta: { messages: { create: async (params) => { sent = params; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(out) }], ...extra }; } } } });
    const ai = { name: "Fourways Grappling Club", tagline: "BJJ for everyone.", address: "", phone: "", email: "", logo_choice: 1,
      socials: { instagram: "", facebook: "", youtube: "https://www.youtube.com/@fgc", tiktok: "", whatsapp: "", x: "" },
      timetable: [{ day: "Fri", start: "18:00", end: "19:00", title: "Competition class", coach: "Thabo", level: "Advanced" }, { day: "Funday", start: "1", end: "", title: "bad", coach: "", level: "" }],
      coaches: [{ name: "Thabo Nkosi", rank: "Black belt", bio: "" }], rates: [{ name: "Adult unlimited", price: 850, currency: "ZAR", period: "month", note: "" }], notes: "First class free." };
    const c = await im.importSite(site.url, { client: fake(ai) });
    ok(c.method === "claude", "with a client it uses the Claude read");
    ok(sent.model === "claude-opus-5-5" && sent.fallbacks === "default" && sent.betas.includes("server-side-fallback-2026-07-01"), "request uses the model with refusal fallbacks");
    ok(sent.output_config.format.type === "json_schema" && sent.output_config.effort === "medium" && sent.output_config.format.schema.properties.timetable, "request asks for structured output");
    const txt = sent.messages[0].content.find((b) => b.type === "text").text;
    ok(/<page url=".*\/timetable"/.test(txt) && /LOGO CANDIDATES/.test(txt) && /untrusted/.test(sent.system), "pages, logo candidates and an untrusted-content warning are sent");
    ok(c.profile.timetable.length === 1 && c.profile.timetable[0].day === "Fri", "Claude's timetable replaces the plain one; invalid rows dropped");
    ok(c.profile.phone && c.profile.socials.instagram && c.profile.socials.youtube && c.profile.notes === "First class free.", "blank Claude fields are filled from the plain read");
    ok(c.logos[0] && c.logos[0].url !== r.logos[0].url, "Claude's logo choice goes first");
    const refused = await im.importSite(site.url, { client: { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } } });
    ok(refused.method === "basic" && /declined/.test(refused.aiError) && refused.profile.timetable.length === 7, "a refusal falls back to the plain read");
    const broken = await im.importSite(site.url, { client: { beta: { messages: { create: async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); } } } } });
    ok(broken.method === "basic" && broken.profile.rates.length > 0, "an API error falls back to the plain read");

    // ---- cleaning what the browser sends back
    const cl = im.cleanProfile({ name: "x".repeat(500), website: "javascript:alert(1)", socials: { instagram: "javascript:alert(1)", facebook: "https://facebook.com/a" }, timetable: [{ day: "Mon", start: "25:00" }, { day: "Tue", start: "7:05", title: "<b>Hi</b>" }], rates: [{ name: "a", price: -5 }, { name: "b", price: "100", period: "weird" }] });
    ok(cl.name.length === 100 && cl.website === "" && !cl.socials.instagram && cl.socials.facebook, "unsafe links are dropped and text is capped");
    ok(cl.timetable.length === 1 && cl.timetable[0].start === "07:05" && cl.rates.length === 1 && cl.rates[0].period === "other", "bad times and prices are dropped");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  site.close();
  console.log(`importer: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
