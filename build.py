"""Build JitsFlow.

Reads src/app.html (the app) and the technique files in src/content-*.js, then writes:
  dist/jitsflow-claude.html  the claude.ai version (published as an Artifact)
  web/index.html             the landing page (from src/landing.html)
  web/app/index.html + sw.js the app on the website (installable, works offline)

Usage: python3 build.py
"""
import hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
CONTENT = ["content-defense.js", "content-purple.js", "content-brown.js", "content-black.js", "content-extra.js", "videos.js"]


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
    return (src.replace("/*@@ADV_TECH@@*/", "\n".join(parts)).replace("/*@@ACCOUNTS@@*/", read("src", "accounts.js")))


def check_js(html):
    tmp = os.path.join(ROOT, "dist", "_check.js")
    for js in re.findall(r"<script>(.*?)</script>", html, re.S):
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
<script>/* iPhone/iPad: stop Safari zooming in on a text box (and staying zoomed). iOS still allows pinch-zoom with this; Android wouldn't, so it's iOS only. */
(function(){var n=navigator,ios=/iP(hone|od|ad)/.test(n.userAgent)||(n.platform==="MacIntel"&&n.maxTouchPoints>1);if(ios){var m=document.querySelector('meta[name=viewport]');m.setAttribute("content",m.getAttribute("content")+",maximum-scale=1")}})();</script>
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
    tdir = os.path.join(ROOT, "web", "img", "techniques")
    tech = sorted(f[:-4] for f in os.listdir(tdir) if f.endswith(".jpg")) if os.path.isdir(tdir) else []
    return {"pos": pos, "belts": belts, "hero": have("hero.jpg"), "names": names, "tech": tech}


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


def page_ld(page, url):
    """FAQ structured data for a marketing page, read from its own <details> blocks."""
    strip = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h)).strip()
    faq = [{"@type": "Question", "name": strip(q), "acceptedAnswer": {"@type": "Answer", "text": strip(a)}}
           for q, a in re.findall(r"<details><summary>(.*?)</summary><p>(.*?)</p></details>", page, re.S)]
    data = {"@context": "https://schema.org", "@type": "FAQPage", "url": "https://www.jitsflow.com" + url, "mainEntity": faq}
    return '<script type="application/ld+json">%s</script>' % json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")


def build_web(app):
    # Everything before the app's own markup (title, meta, font links, styles) goes in <head>.
    cut = app.index('<main class="wrap app"')
    head_bits, body = app[:cut], app[cut:]
    head_bits = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\n?', "", head_bits)
    img = images(app)
    jfi = json.dumps({"pos": img["pos"], "belts": img["belts"], "hero": img["hero"], "tech": img["tech"]})
    html = HEAD + "<script>window.JF_IMG=%s;window.JF_BUILD=\"@BUILD@\";</script>\n" % jfi + head_bits + "</head>\n<body>\n" + body + "\n" + SW_REGISTER + "\n</body>\n</html>\n"
    # The app's build id: an app left open asks the server for it (/api/status) and reloads when it has changed.
    html = html.replace("@BUILD@", hashlib.sha256(html.encode()).hexdigest()[:10])
    write(html, "web", "app", "index.html")
    landing = fill_landing(read("src", "landing.html"), img)
    landing = landing.replace("@@NTECH@@", str(json.load(open(os.path.join(ROOT, "dist", "counts.json")))["techniques"])).replace("@@LDJSON@@", landing_ld(landing))
    assert "@@" not in landing, "unfilled placeholder in landing page"
    write(landing, "web", "index.html")
    # Coaches page: same look as the landing page (its stylesheet is shared), own copy and FAQ.
    css = re.search(r"<style>\n(.*?)</style>", read("src", "landing.html"), re.S).group(1)
    coaches = read("src", "coaches.html").replace("@@LANDING_CSS@@", css).replace("@@NTECH@@", str(json.load(open(os.path.join(ROOT, "dist", "counts.json")))["techniques"]))
    coaches = coaches.replace("@@LDJSON@@", page_ld(coaches, "/coaches/"))
    assert "@@" not in coaches, "unfilled placeholder in coaches page"
    write(coaches, "web", "coaches", "index.html")
    version = hashlib.sha256((html + landing + coaches).encode()).hexdigest()[:10]
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
