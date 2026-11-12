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
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="96x96" href="/icons/favicon-96.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
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


def fill_landing(landing, img):
    hero = '<img class="heroart" src="/img/hero.jpg" alt="" aria-hidden="true">' if img["hero"] else ""
    return landing.replace("@@NIGHT_CLASS@@", " has-art" if img["hero"] else "").replace("@@HERO_ART@@", hero)


# Home page technique row: moves with a photo come first (in this order), then well-known moves shown with their
# video's thumbnail. Any move in the library can be listed; unknown ids are skipped.
GALLERY_TECH = ["back_control", "hw_guillotine", "duck_under", "arm_tri_def", "stance_motion", "kimura_trap_def", "bodylock_def",
                "triangle", "double_leg", "armbar_cg", "knee_cut", "hip_bump", "rnc", "kimura_sc", "elbow_knee", "darce", "omoplata",
                "smash_pass", "xguard_sweep", "japanese_necktie", "berimbolo", "mounted_guillotine", "back_handfight"]
GALLERY_MAX = 22
BELT_HEX = {"white": "#F4F4F0", "blue": "#1F4FB0", "purple": "#5E2D8C", "brown": "#6A4326", "black": "#151515"}
TIERS = ["Winning", "Advantage", "Neutral", "Neutral", "Defending", "Danger"]  # the position cards' label, best to worst


def video_picks():
    """The app's picked YouTube video per technique and per position ("pos:<id>"), from src/videos.js."""
    picks = {}
    for block in re.findall(r"(?:VIDEO_PICKS=|Object\.assign\(VIDEO_PICKS,)(\{.*?\n\})\)?;", read("src", "videos.js"), re.S):
        for k, v in json.loads(block).items():
            v = {"v": v} if isinstance(v, str) else v
            if v.get("v"):
                picks[k] = v
    return picks


YT_THUMB = "https://i.ytimg.com/vi/%s/mqdefault.jpg"  # 320x180, straight from YouTube (allowed by the site's img-src)


def site_index():
    path = os.path.join(ROOT, "dist", "site-index.json")
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {"tech": [], "pos": {}}


TIER_HEX = ["#1D7748", "#3C9A6A", "#1D4FB5", "#6B7FA8", "#C27A12", "#B3261E"]


def media_html(idx):
    """The two picture rows on the home page, built from one small card: a 16:9 thumbnail (the move's YouTube video, or
    the founder's photo of it) with a play badge and the video's channel, then the name and a coloured dot (the belt for
    a technique, how good the position is for a position). Each links to its page, where the video plays. Thumbnails
    load lazily from YouTube; they're all below the fold, so the headline stays the first paint."""
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    have = lambda *p: os.path.exists(os.path.join(ROOT, "web", *p))
    tech = {t["id"]: t for t in idx["tech"]}
    pos = idx["pos"]
    vids = video_picks()
    photo = lambda i: have("img", "thumbs", i + ".webp")
    play = '<span class="playb" aria-hidden="true"></span>'
    credit = lambda v: '<span class="vcred">Video: %s</span>' % esc(v["channel"]) if v.get("channel") else ""
    yt = lambda v, alt: '<img src="%s" alt="%s" width="320" height="180" loading="lazy" decoding="async">' % (YT_THUMB % v["v"], esc(alt))

    def card(href, pic, name, dot, meta, cls=""):
        return ('<li><a class="card%s" href="%s"><span class="thumb">%s</span><span class="cbody"><b>%s</b>'
                '<span class="cmeta"><i class="dot" style="--bc:%s" aria-hidden="true"></i>%s</span></span></a></li>') % (cls, href, pic, esc(name), dot, esc(meta))
    picks = [i for i in GALLERY_TECH if i in tech and (photo(i) or i in vids)]
    picks = ([i for i in picks if photo(i)] + [i for i in picks if not photo(i)])[:GALLERY_MAX]
    cards = []
    for i in picks:
        t, v = tech[i], vids.get(i, {})
        if photo(i):
            pic = '<img src="/img/thumbs/%s.webp" alt="Photo: %s, shown by two grapplers" width="400" height="225" loading="lazy" decoding="async">' % (i, esc(t["n"]))
        else:
            pic = yt(v, t["n"] + " video thumbnail")
        if v:
            pic += play + credit(v)
        cards.append(card("/techniques/%s/" % t["slug"], pic, t["n"], BELT_HEX.get(t["belt"], "#1F4FB0"), t["belt"].capitalize() + " belt"))
    cards.append('<li><a class="card more" href="/techniques/"><span class="thumb"><span>All %d</span></span><span class="cbody"><b>See every technique</b>'
                 '<span class="cmeta">Technique library &rarr;</span></span></a></li>' % len(idx["tech"]))
    gallery = '<ul class="cards row" id="tgal" role="list">%s</ul>' % "".join(cards)
    items = []
    for r, name in enumerate(TIERS):  # best to worst
        for k in [k for k, v in pos.items() if v["r"] == r]:
            v = vids.get("pos:" + k)
            if v:
                pic = yt(v, pos[k]["l"] + " video thumbnail") + play
            elif have("img", "fig", k + ".svg"):  # no video yet: the app's drawing of the position (you in blue)
                pic = '<img class="fig" src="/img/fig/%s.svg" alt="Diagram of %s, you in blue" width="400" height="300" loading="lazy" decoding="async">' % (k, esc(pos[k]["L"]))
            else:
                continue
            items.append(card("/positions/%s/" % pos[k]["slug"], pic, pos[k]["l"], TIER_HEX[r], name))
    posmap = '<ul class="cards grid" id="posgrid" role="list">%s</ul>' % "".join(items) if items else ""
    return gallery, posmap


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
    gallery, posmap = media_html(site_index())
    landing = landing.replace("@@TECH_GALLERY@@", gallery).replace("@@POS_MAP@@", posmap)
    counts = json.load(open(os.path.join(ROOT, "dist", "counts.json")))
    landing = landing.replace("@@NPOS@@", str(counts["positions"])).replace("@@NTECH@@", str(counts["techniques"]))
    landing = landing.replace("@@LDJSON@@", landing_ld(landing))
    assert "@@" not in landing, "unfilled placeholder in landing page"
    write(landing, "web", "index.html")
    # Coaches page: same look as the landing page (its stylesheet is shared), own copy and FAQ.
    css = re.search(r"<style>\n(.*?)</style>", read("src", "landing.html"), re.S).group(1)
    js = re.search(r'<script id="media-js">\n(.*?)</script>', read("src", "landing.html"), re.S).group(1)
    coaches = read("src", "coaches.html").replace("@@LANDING_CSS@@", css).replace("@@MEDIA_JS@@", js).replace("@@NTECH@@", str(json.load(open(os.path.join(ROOT, "dist", "counts.json")))["techniques"]))
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
