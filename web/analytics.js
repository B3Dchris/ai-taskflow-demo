/* JitsFlow analytics: Google Analytics 4, loaded only after the visitor taps Allow.
   The server adds this file (and window.JF_GA) to every page when GA_ID is set. */
(function () {
  var ID = window.JF_GA, KEY = "jf.consent";
  window.jfTrack = window.jfTrack || function () {};
  if (!ID) return;
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
  var loaded = false;
  function appPath() { return location.pathname.indexOf("/app") === 0 && location.hash.length > 1 ? "/app/" + location.hash.slice(1) : location.pathname; }
  window.jfTrack = function (name, params) { if (loaded) try { gtag("event", name, params || {}); } catch (e) {} };
  window.jfPage = function () { if (loaded) gtag("event", "page_view", { page_location: location.origin + appPath(), page_title: document.title }); };
  function load() {
    if (loaded) return; loaded = true;
    gtag("consent", "update", { analytics_storage: "granted" });
    gtag("js", new Date());
    gtag("set", { allow_google_signals: false, allow_ad_personalization_signals: false }); // no ads: don't send to Google's ad endpoints
    gtag("config", ID, { allow_google_signals: false, allow_ad_personalization_signals: false, page_location: location.origin + appPath() + location.search.replace(/([?&])(join|reset|signin|start|t|claim|paid|billing)=[^&]*/g, "$1").replace(/[?&]+$/, "") });
    var s = document.createElement("script"); s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ID);
    document.head.appendChild(s);
  }
  var css = ".jf-consent{position:fixed;left:12px;right:12px;z-index:9999;max-width:520px;margin:0 auto;background:#fff;color:#111722;border:1px solid #D3DAE4;border-radius:16px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.22);display:grid;gap:10px;font:15px/1.45 'Source Sans 3',-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".jf-consent p{margin:0}.jf-consent a{color:#1D4FB5}.jf-consent div{display:flex;gap:10px;flex-wrap:wrap}" +
    ".jf-consent button{font:inherit;font-weight:700;min-height:44px;padding:0 18px;border-radius:10px;border:1px solid #D3DAE4;background:#fff;color:#111722;cursor:pointer}" +
    ".jf-consent button.yes{background:#1D4FB5;border-color:#1D4FB5;color:#fff}" +
    "@media (prefers-color-scheme:dark){.jf-consent{background:#151A22;color:#E8EBF1;border-color:#2A323F}.jf-consent a{color:#82A5FF}.jf-consent button{background:#151A22;color:#E8EBF1;border-color:#2A323F}.jf-consent button.yes{background:#82A5FF;border-color:#82A5FF;color:#0C1220}}";
  function banner() {
    if (document.querySelector(".jf-consent") || get() === "yes" || get() === "no") return;
    if (!document.getElementById("jf-consent-css")) { var st = document.createElement("style"); st.id = "jf-consent-css"; st.textContent = css; document.head.appendChild(st); }
    // In the app, wait until no sheet (onboarding, a technique…) is open so the card never covers its buttons.
    var sheet = document.getElementById("sheet");
    if (sheet && !sheet.hidden) { setTimeout(banner, 2000); return; }
    var tabs = document.querySelector("nav.tabs"), lift = tabs && !tabs.hidden ? tabs.offsetHeight : 0;
    var b = document.createElement("div"); b.className = "jf-consent"; b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Analytics cookies");
    b.style.bottom = lift ? lift + 10 + "px" : "calc(12px + env(safe-area-inset-bottom,0px))";
    b.innerHTML = "<p>Can JitsFlow use Google Analytics cookies to count visits and see which techniques people study? It helps us decide what to add next. <a href=\"/privacy/\">Privacy</a></p><div><button class=\"yes\" type=\"button\">Allow</button><button type=\"button\">No thanks</button></div>";
    b.querySelector(".yes").onclick = function () { set("yes"); b.remove(); load(); };
    b.querySelectorAll("button")[1].onclick = function () { set("no"); b.remove(); };
    document.body.appendChild(b);
  }
  function start() {
    document.querySelectorAll("[data-consent-open]").forEach(function (a) {
      a.hidden = false;
      a.addEventListener("click", function (e) { e.preventDefault(); try { localStorage.removeItem(KEY); } catch (x) {} if (loaded) { gtag("consent", "update", { analytics_storage: "denied" }); } banner(); });
    });
    var c = get();
    if (c === "yes") load(); else if (c !== "no") setTimeout(banner, 1200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
