// The business details for the legal pages and footers (src/business.json), filled in by the founder.
// A value in [square brackets] is a placeholder and counts as empty: pages leave that line off, and build.py warns.
// Usage: require("./business").load()  ->  { biz, missing, empty }  (missing: required and empty; empty: optional and empty)
//        node tools/business.js         prints the warning (build.py runs it after building). JF_BUSINESS_JSON: another file.
"use strict";
const fs = require("fs"); const path = require("path");

const FILE = () => process.env.JF_BUSINESS_JSON || path.resolve(__dirname, "..", "src", "business.json");
const FIELDS = ["legalName", "tradingAs", "tradingName", "entityType", "regNo", "directors", "vatNo", "vatNote", "priceNote", "address", "city", "country", "email", "phone", "hours"];
// Shown when filled in, never warned about.
const OPTIONAL = ["tradingAs", "directors", "phone", "hours"];
const LABEL = { legalName: "legal name", tradingAs: "trading as", directors: "director(s)", entityType: "entity type", regNo: "registration number", vatNote: "VAT statement (vatNote, or a vatNo)",
  address: "physical address", email: "support email", phone: "phone number", city: "city", country: "country" };
const blank = (v) => typeof v !== "string" || !v.trim() || /^\[.*\]$/s.test(v.trim());

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch (e) { raw = {}; }
  const biz = {};
  for (const k of FIELDS) biz[k] = blank(raw[k]) ? "" : raw[k].trim();
  biz.tradingName = biz.tradingName || "JitsFlow";
  const sole = /sole/i.test(biz.entityType);
  // What ECTA s43 and Payfast's merchant terms expect on the site. A sole proprietor has no registration number.
  const need = ["legalName", "entityType", ...(sole ? [] : ["regNo"]), "address", "city", "country", "email"];
  const missing = need.filter((k) => !biz[k]).map((k) => LABEL[k] || k);
  if (!biz.vatNo && !biz.vatNote) missing.push(LABEL.vatNote);
  const empty = OPTIONAL.filter((k) => !biz[k]);
  return { biz, missing, empty };
}

module.exports = { load, FILE };

if (require.main === module) {
  const { missing, empty } = load();
  if (missing.length) {
    const bar = "!".repeat(78);
    console.warn(`\n${bar}\n!! BUSINESS DETAILS MISSING in ${path.relative(process.cwd(), FILE()) || FILE()}\n!! Payfast's site review needs these on /contact/, /terms/ and in the footer:\n${missing.map((m) => "!!   - " + m).join("\n")}\n!! Those lines are left off the pages until they're filled in.\n${bar}\n`);
  } else console.log("business details: complete" + (empty.length ? ` (optional, left off the pages: ${empty.join(", ")})` : ""));
}
