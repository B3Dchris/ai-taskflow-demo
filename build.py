"""Build JitsFlow.

Reads src/app.html (the app) and the technique files in src/content-*.js, then writes:
  dist/jitsflow-claude.html  the claude.ai version (published as an Artifact)
  web/index.html             the landing page (from src/landing.html)
  web/app/index.html + sw.js the app on the website (installable, works offline)

Usage: python3 build.py
"""
import base64, hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
CONTENT = ["content-defense.js", "content-purple.js", "content-brown.js", "content-black.js", "videos.js"]


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def write(text, *p):
    path = os.path.join(ROOT, *p)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def build_app():
    src = read("src", "app.html")
    parts = []
    for name in CONTENT:
        if os.path.exists(os.path.join(SRC, name)):
            parts.append("/* --- %s --- */\n" % name + read("src", name).strip())
    assert src.count("/*@@ADV_TECH@@*/") == 1, "content marker missing from src/app.html"
    assert src.count("/*@@ACCOUNTS@@*/") == 1, "accounts marker missing from src/app.html"
    logo = os.path.join(ROOT, "web", "img", "partner-logo.png")
    uri = "data:image/png;base64," + base64.b64encode(open(logo, "rb").read()).decode() if os.path.exists(logo) else ""
    return (src.replace("/*@@ADV_TECH@@*/", "\n".join(parts)).replace("/*@@ACCOUNTS@@*/", read("src", "accounts.js"))
            .replace("__PARTNER_LOGO__", uri))


def check_js(html):
    js = re.search(r"<script>(.*)</script>", html, re.S).group(1)
    tmp = os.path.join(ROOT, "dist", "_check.js")
    write(js, "dist", "_check.js")
    try:
        subprocess.run(["node", "--check", tmp], check=True)
    finally:
        os.remove(tmp)


RESET = (":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
         "body{margin:0;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}"
         "img{max-width:100%}[hidden]{display:none!important}")

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="JitsFlow: a no-gi technique library and flow map to study between classes. Every position, attack chain and escape from white to black belt.">
<link rel="canonical" href="https://www.jitsflow.com/app/">
<meta property="og:image" content="https://www.jitsflow.com/og/home.jpg">
<meta name="theme-color" content="#1D4FB5">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="JitsFlow">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta property="og:title" content="JitsFlow">
<meta property="og:description" content="No-gi technique library and flow map.">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/icons/favicon.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>%s</style>
""" % RESET

SW_REGISTER = """<script>
if("serviceWorker" in navigator&&(location.protocol==="https:"||location.hostname==="localhost")){
  window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
}
</script>"""


GALLERY = ["back_top", "mount_top", "sc_top", "fhl_top", "turtle_top", "ashi", "standing", "open_top", "cg_top", "hg_top",
           "seated", "bfly_bot", "cg_bot", "hg_bot", "sc_bot", "fhl_bot", "turtle_bot", "ashi_def", "mount_bot", "back_bot"]


def images(app):
    """Which optional images exist in web/img (positions, belts, hero), plus position names from the app."""
    def have(*p):
        return os.path.exists(os.path.join(ROOT, "web", "img", *p))
    names = dict(re.findall(r'\b([a-z_]+):\{l:"[^"]*",L:"([^"]+)"', app))
    pos = [k for k in GALLERY if have("positions", k + ".jpg")]
    belts = [b for b in ["blue", "purple", "brown", "black"] if have("belts", b + ".jpg")]
    return {"pos": pos, "belts": belts, "hero": have("hero.jpg"), "partner": have("partner-logo.png"), "names": names}


ROLE = {"back_top": "You're behind", "ashi": "You're attacking", "open_top": "You're passing", "standing": "Neutral", "back_bot": "They're behind", "ashi_def": "Defending your leg", "fhl_bot": "Defending"}


def fill_landing(landing, img):
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    hero = '<img class="heroart" src="/img/hero.jpg" alt="" aria-hidden="true">' if img["hero"] else ""
    belts = ""
    if len(img["belts"]) == 4:
        belts = '<div class="beltcards">' + "".join(
            '<img src="/img/belts/%s.jpg" alt="%s belt" loading="lazy" width="300" height="300">' % (b, b.capitalize()) for b in img["belts"]) + "</div>"
    gallery = ""
    if len(img["pos"]) >= 6:
        cards = "".join(
            '<figure><img src="/img/positions/%s.jpg" alt="%s" loading="lazy" width="600" height="600"><figcaption>%s<span>%s</span></figcaption></figure>'
            % (k, esc(img["names"].get(k, k)), esc(img["names"].get(k, k)), ROLE.get(k, "You on top" if k.endswith("_top") else "You underneath"))
            for k in img["pos"])
        gallery = ('<section class="block wrap" id="positions" style="padding-top:0"><div class="intro"><p class="eyebrow">Every position</p>'
                   '<h2>Know where you are.</h2><p class="muted">%d positions, from best to worst, each with your goals, the dangers, '
                   'and every move that starts there.</p></div><div class="gallery">%s</div></section>') % (len(img["pos"]), cards)
    partner = ('<a class="partner" href="https://www.jpbuys.com/academy" target="_blank" rel="noopener">%s<span><small>In partnership with</small><b>JPB Martial Arts Academy</b></span></a>'
               % ('<img src="/img/partner-logo.png" alt="" width="80" height="40">' if img["partner"] else ""))
    landing = landing.replace("@@PARTNER@@", partner)
    return (landing.replace("@@NIGHT_CLASS@@", " has-art" if img["hero"] else "").replace("@@HERO_ART@@", hero)
            .replace("@@BELT_CARDS@@", belts).replace("@@POS_GALLERY@@", gallery))


def landing_ld(landing):
    """Structured data for the home page: the site, the app, and the FAQ (read from the page itself)."""
    strip = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h)).strip()
    faq = [{"@type": "Question", "name": strip(q), "acceptedAnswer": {"@type": "Answer", "text": strip(a)}}
           for q, a in re.findall(r"<details><summary>(.*?)</summary><p>(.*?)</p></details>", landing, re.S)]
    site = "https://www.jitsflow.com"
    data = [
        {"@context": "https://schema.org", "@type": "WebSite", "name": "JitsFlow", "url": site + "/"},
        {"@context": "https://schema.org", "@type": "WebApplication", "name": "JitsFlow", "url": site + "/app/",
         "applicationCategory": "SportsApplication", "operatingSystem": "iOS, Android, any modern browser",
         "description": "A no-gi Brazilian Jiu-Jitsu study app: technique library, flow chart of positions, attack chains and escapes, belt curriculum and training log.",
         "offers": {"@type": "Offer", "price": "0", "priceCurrency": "ZAR"}, "image": site + "/og/home.jpg"},
        {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faq},
    ]
    return "\n".join('<script type="application/ld+json">%s</script>' % json.dumps(d, ensure_ascii=False).replace("<", "\\u003c") for d in data)


def build_web(app):
    # Everything before the app's own markup (title, meta, font links, styles) goes in <head>.
    cut = app.index('<div class="wrap app"')
    head_bits, body = app[:cut], app[cut:]
    head_bits = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\n?', "", head_bits)
    img = images(app)
    jfi = json.dumps({"pos": img["pos"], "belts": img["belts"], "hero": img["hero"], "partner": img["partner"]})
    html = HEAD + "<script>window.JF_IMG=%s;</script>\n" % jfi + head_bits + "</head>\n<body>\n" + body + "\n" + SW_REGISTER + "\n</body>\n</html>\n"
    write(html, "web", "app", "index.html")
    landing = fill_landing(read("src", "landing.html"), img)
    landing = landing.replace("@@NTECH@@", str(json.load(open(os.path.join(ROOT, "dist", "counts.json")))["techniques"])).replace("@@LDJSON@@", landing_ld(landing))
    assert "@@" not in landing, "unfilled placeholder in landing page"
    write(landing, "web", "index.html")
    version = hashlib.sha256((html + landing).encode()).hexdigest()[:10]
    write(read("tools", "sw.template.js").replace("__VERSION__", version), "web", "sw.js")
    return version


if __name__ == "__main__":
    app = build_app()
    check_js(app)
    write(app, "dist", "jitsflow-claude.html")
    with open(os.path.join(ROOT, "web", "analytics.js"), "w", encoding="utf-8") as f:
        f.write(read("src", "analytics.js"))
    # Public pages (techniques, positions, belts, glossary), share cards, sitemap. Needs Node + Playwright.
    try:
        subprocess.run(["node", os.path.join(ROOT, "tools", "seo.js")], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        sys.exit("SEO pages failed to build (%s). Install Playwright: npm i -D playwright" % e)
    v = build_web(app)
    print("built dist/jitsflow-claude.html and web/ (version %s)" % v)
