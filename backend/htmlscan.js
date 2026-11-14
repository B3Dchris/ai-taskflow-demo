// Reading HTML and CSS from other people's websites in linear time.
// A regular expression like /<a\b[^>]*>([\s\S]*?)<\/a>/g looks for its closer from every opener: a page of 60,000 openers
// with no closer takes billions of steps and freezes the server. Everything here walks the text once, finds each closer
// at most once, and stops looking for a closer that isn't there.
"use strict";

const MAX_HTML = 300 * 1024; // a page is read up to here (gym pages are far smaller; the rest is usually scripts)
const MAX_CSS = 150 * 1024; // a stylesheet is read up to here
const RAW = new Set(["script", "style"]); // their content is text, not tags (a "<a>" in a script isn't a link)

const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122); // A-Z a-z
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58; // 0-9 - _ :
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

// The page as a list of tags, comments and the text between them, read once from left to right:
//   { kind: "tag", name, close, attr, i, j }   attr: the text after the name ("href=x class=y"); i..j: where it is in html
//   { kind: "raw", name, text }                  the content of a <script> or <style>, right after its opening tag
// A tag runs to the next ">", as the old patterns read it. Text is everything else (html.slice(prev.j, next.i)).
function tokens(html) {
  const s = String(html || "").slice(0, MAX_HTML), n = s.length, out = [];
  let pos = 0, gt = -1; // gt: the next ">" at or after pos (found once, reused until pos passes it)
  while (pos < n) {
    const lt = s.indexOf("<", pos); if (lt < 0) break;
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); const j = e < 0 ? n : e + 3; out.push({ kind: "comment", i: lt, j }); pos = j; continue; }
    const close = s.charCodeAt(lt + 1) === 47, k = lt + (close ? 2 : 1);
    if (!isNameStart(s.charCodeAt(k))) { pos = lt + 1; continue; }
    if (gt < k) { gt = s.indexOf(">", k); if (gt < 0) break; } // no ">" left: no tag can end, the rest is text
    let e = k; while (e < gt && isNameChar(s.charCodeAt(e))) e++;
    const name = s.slice(k, e).toLowerCase(), j = gt + 1;
    out.push({ kind: "tag", name, close, attr: s.slice(e, gt), i: lt, j });
    pos = j;
    if (!close && RAW.has(name)) {
      // Its content runs to its closer (</script>, </script >); with none, to the end of the page (as a browser reads it).
      const re = new RegExp(`</${name}\\s*>`, "gi"); re.lastIndex = j; const m = re.exec(s);
      const end = m ? m.index : n;
      out.push({ kind: "raw", name, text: s.slice(j, end), i: j, j: end });
      pos = end;
    }
  }
  return { s, list: out };
}

// The attributes of a tag (attr: the text after its name), names in lower case, values decoded. Linear: no backtracking.
function attrs(attr, decode = (v) => v) {
  const s = String(attr || ""), n = s.length, out = {};
  let i = 0;
  while (i < n) {
    while (i < n && !isNameChar(s.charCodeAt(i))) i++;
    let k = i; while (k < n && isNameChar(s.charCodeAt(k))) k++;
    if (k === i) break;
    const name = s.slice(i, k).toLowerCase(); i = k;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (s[i] !== "=") continue;
    i++; while (i < n && isSpace(s.charCodeAt(i))) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      const e = s.indexOf(q, i + 1);
      if (e < 0) { i++; continue; } // an unclosed quote: no value here
      out[name] = decode(s.slice(i + 1, e)); i = e + 1;
    } else {
      let e = i; while (e < n && !isSpace(s.charCodeAt(e)) && s[e] !== ">" && s[e] !== '"' && s[e] !== "'") e++;
      if (e > i) out[name] = decode(s.slice(i, e));
      i = Math.max(e, i + 1);
    }
  }
  return out;
}

// For each opening tag named `name` (at index k in list), the index of the first closing tag of that name after it, or -1.
// One pass from the end, so it's linear however many openers have no closer.
function closers(list, names) {
  const want = new Set(names), at = new Map(), next = new Map(); // name -> index of the nearest closer to the right
  for (let k = list.length - 1; k >= 0; k--) {
    const t = list[k]; if (t.kind !== "tag" || !want.has(t.name)) continue;
    if (t.close) next.set(t.name, k); else at.set(k, next.has(t.name) ? next.get(t.name) : -1);
  }
  return at;
}

// CSS without its /* comments */ (an unclosed one runs to the end), up to MAX_CSS.
function stripCssComments(css) {
  const s = String(css || "").slice(0, MAX_CSS); let out = "", pos = 0;
  for (;;) { const a = s.indexOf("/*", pos); if (a < 0) { out += s.slice(pos); break; } out += s.slice(pos, a) + " "; const b = s.indexOf("*/", a + 2); if (b < 0) break; pos = b + 2; }
  return out;
}
// Every "selector { declarations }" block in CSS, innermost ones only (as /([^{}]*)\{([^{}]*)\}/g found them), in linear time.
function cssBlocks(css) {
  const out = [], parts = String(css || "").split("}");
  for (let p = 0; p < parts.length - 1; p++) { // the last part has no closing brace
    const part = parts[p], i = part.lastIndexOf("{"); if (i < 0) continue;
    const before = part.lastIndexOf("{", i - 1);
    out.push([part.slice(before + 1, i), part.slice(i + 1)]);
  }
  return out;
}

module.exports = { tokens, attrs, closers, stripCssComments, cssBlocks, MAX_HTML, MAX_CSS };
