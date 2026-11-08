// Reading a WhatsApp group screenshot into students (kids with their parent). Claude is faked here.
"use strict";
const people = require("../backend/people");
let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
(async () => {
  const k = people.kidFromName;
  ok(JSON.stringify(k("Lerato's mom")) === JSON.stringify({ name: "Lerato", parentName: "Parent" }), "Lerato's mom → kid Lerato");
  ok(JSON.stringify(k("Sipho’s Dad Thabo")) === JSON.stringify({ name: "Sipho", parentName: "Thabo" }), "Sipho's Dad Thabo → kid Sipho, parent Thabo");
  ok(JSON.stringify(k("Thabo (Lwazi's dad)")) === JSON.stringify({ name: "Lwazi", parentName: "Thabo" }), "Thabo (Lwazi's dad)");
  ok(JSON.stringify(k("Mama Aya")) === JSON.stringify({ name: "Aya", parentName: "Parent" }), "Mama Aya → kid Aya");
  ok(k("Thabo Mokoena") === null && k("Damon") === null, "ordinary names stay adults");
  const rows = people.toRows([
    { kind: "student", name: "~ Thabo M", phone: "+27 82 123 4567", children: [] },
    { kind: "parent", name: "Nomsa", phone: "+27 82 444 5555", children: ["Aya", "Ben"] },
    { kind: "parent", name: "", phone: "+27 82 666 7777", children: [] },
    { kind: "student", name: "Lee", phone: "", children: [] },
    { kind: "student", name: "Lee", phone: "", children: [] },
    { kind: "student", name: "", phone: "12", children: [] },
    { kind: "parent", name: "Mama Kea", phone: "+27 83 555 0303", children: [] },
    { kind: "student", name: "Lindi's mum", phone: "", children: [] },
  ]);
  ok(rows.length === 7, "one row per student, duplicates and junk dropped: " + rows.length);
  ok(rows[0].name === "Thabo M" && rows[0].parentName === "", "the ~ display name is used for an unsaved number");
  ok(rows[1].name === "Aya" && rows[2].name === "Ben" && rows[1].parentName === "Nomsa" && rows[2].phone === rows[1].phone, "a parent of two gives two kids on one number");
  ok(rows[3].name === "" && rows[3].parentName === "Parent", "a parent with no kid named waits for the coach to type it");
  ok(rows[5].name === "Kea" && rows[5].parentName === "Parent" && rows[6].name === "Lindi", "\"Mama Kea\" and \"Lindi's mum\" become kids even when Claude doesn't split them");
  let sent;
  const client = { messages: { create: async (body) => { sent = body; return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ people: [{ kind: "parent", name: "Zanele", phone: "083 111 2222", children: ["Kea"] }] }) }] }; } } };
  const out = await people.readPeople({ client, images: [{ type: "image/jpeg", data: Buffer.from("x") }, { type: "image/png", data: Buffer.from("y") }] });
  ok(out.length === 1 && out[0].name === "Kea" && out[0].parentName === "Zanele", "screenshots come back as students");
  ok(sent.model === "claude-haiku-5-5" && sent.thinking.type === "disabled" && sent.output_config.effort === "low", "uses the small model, thinking off, low effort");
  ok(sent.messages[0].content.filter((c) => c.type === "image").length === 2 && /2 screenshots are one list/.test(sent.messages[0].content[2].text), "all screenshots go in one request as one list");
  ok(/untrusted/.test(sent.system), "screenshot text is treated as untrusted");
  console.log(`people: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f)); process.exit(fail ? 1 : 0);
})();
