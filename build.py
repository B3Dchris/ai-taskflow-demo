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


# Home page technique gallery: moves with a photo come first (in this order), then well-known moves shown with the
# app's drawing of the position they start from. Any move in the library can be listed; unknown ids are skipped.
GALLERY_TECH = ["back_control", "hw_guillotine", "duck_under", "arm_tri_def", "stance_motion", "kimura_trap_def", "bodylock_def",
                "triangle", "double_leg", "armbar_cg", "knee_cut", "hip_bump", "rnc", "kimura_sc", "elbow_knee", "darce", "omoplata",
                "smash_pass", "xguard_sweep", "japanese_necktie", "berimbolo", "mounted_guillotine", "back_handfight"]
GALLERY_MAX = 22
BELT_HEX = {"white": "#F4F4F0", "blue": "#1F4FB0", "purple": "#5E2D8C", "brown": "#6A4326", "black": "#151515"}
TIERS = ["Winning", "Advantage", "Neutral · top", "Neutral · bottom", "Defending", "Danger"]


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


def media_html(idx):
    """The picture galleries on the home page: technique cards (each with its video's thumbnail, or the founder's photo
    of it, and a play badge) and the position map (each position's video thumbnail), linking to their pages, where the
    video plays. Thumbnails load lazily from YouTube; they're all below the fold, so the headline stays the first paint."""
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    have = lambda *p: os.path.exists(os.path.join(ROOT, "web", *p))
    tech = {t["id"]: t for t in idx["tech"]}
    pos = idx["pos"]
    vids = video_picks()
    photo = lambda i: have("img", "thumbs", i + ".webp")
    play = '<span class="playb" aria-hidden="true"></span>'
    credit = lambda v: '<span class="vcred">Video: %s</span>' % esc(v["channel"]) if v.get("channel") else ""
    order = {t["id"]: n + 1 for n, t in enumerate(idx["tech"])}  # the card's number: its place in the library, white to black
    picks = [i for i in GALLERY_TECH if i in tech and (photo(i) or i in vids)]
    picks = ([i for i in picks if photo(i)] + [i for i in picks if not photo(i)])[:GALLERY_MAX]
    cards = []
    for i in picks:
        t, v = tech[i], vids.get(i, {})
        belt = t["belt"]
        if photo(i):
            pic = '<img src="/img/thumbs/%s.webp" alt="Photo: %s, shown by two grapplers" width="560" height="560" loading="lazy" decoding="async">' % (i, esc(t["n"]))
        else:
            pic = '<img src="%s" alt="%s video thumbnail" width="320" height="180" loading="lazy" decoding="async">' % (YT_THUMB % v["v"], esc(t["n"]))
        if v:
            pic += play + credit(v)
        cards.append('<li><a class="tcard" href="/techniques/%s/"><span class="tno" aria-hidden="true">No. %03d</span><span class="tpic">%s</span><span class="tmeta" style="--bc:%s">'
                     '<span class="tcat">%s · %s belt</span><b>%s</b></span></a></li>' % (t["slug"], order[i], pic, BELT_HEX.get(belt, "#1F4FB0"), esc(t["cat"]), belt.capitalize(), esc(t["n"])))
    cards.append('<li><a class="tcard more" href="/techniques/"><span>See all %d techniques</span><b aria-hidden="true">&rarr;</b></a></li>' % len(idx["tech"]))
    gallery = '<ul class="tgal" id="tgal" role="list">%s</ul>' % "".join(cards)
    chain = map_chain()
    tiers = []
    for r, name in enumerate(TIERS):
        ks = [k for k, v in pos.items() if v["r"] == r and (("pos:" + k) in vids or have("img", "fig", k + ".svg"))]
        if not ks:
            continue
        items = []
        for k in ks:
            v = vids.get("pos:" + k)
            fig = '<img src="/img/fig/%s.svg" alt="" width="400" height="300" loading="lazy" decoding="async">' % k if have("img", "fig", k + ".svg") else ""
            if v:  # the video's thumbnail, with the app's drawing of the position (you in blue) in the corner
                pic = ('<img src="%s" alt="%s video thumbnail" width="320" height="180" loading="lazy" decoding="async">%s<span class="pfig" aria-hidden="true">%s</span>'
                       % (YT_THUMB % v["v"], esc(pos[k]["l"]), play, fig))
            else:
                pic = fig.replace('alt=""', 'alt="Diagram of %s, you in blue"' % esc(pos[k]["L"]))
            step = ' data-step="%d"%s' % (chain.index(k) + 1, " data-tap" if k == chain[-1] else "") if k in chain else ""
            items.append('<li><a class="pcard%s" href="/positions/%s/"%s>%s<span class="pname">%s</span></a></li>' % ("" if v else " fig", pos[k]["slug"], step, pic, esc(pos[k]["l"])))
        tiers.append('<div class="tier t%d"><p class="tname">%s</p><ul role="list">%s</ul></div>' % (r, esc(name), "".join(items)))
    posmap = '<div class="posmap">%s</div>' % "".join(tiers) if tiers else ""
    counts = {b: sum(1 for t in idx["tech"] if t["belt"] == b) for b in ["blue", "purple", "brown", "black"]}
    return gallery, posmap, counts


def map_chain():
    """The position map's lit chain (numbered cards; web/js/belt.js draws the line): one of the app's attack chains from
    standing, the branch that goes through the most positions before a submission, at most 4 reactions deep. Today:
    standing, front headlock, turtle, back control, then the tap."""
    path = os.path.join(ROOT, "web", "data", "chains-demo.json")
    if not os.path.exists(path):
        return []
    d = json.load(open(path, encoding="utf-8"))
    chains, moves, best = d["chains"], d["tech"], []

    def carry_on(p):  # a move that ends in a new position goes on with that position's chains ("Start:" setups opened)
        out = []
        for r in chains.get(p, []):
            out += r[2:] if r[1].startswith("Start:") else [r]
        return out

    def walk(raw, ps, depth, seen):
        m = moves.get(raw[0])
        if not m:
            return
        ps = ps if ps and ps[-1] == m["f"] else ps + [m["f"]]
        if m["c"] == "sub":
            if len(ps) > len(best):
                best[:] = ps
            return
        if depth >= 4:
            return
        for k in raw[2:] or ([] if m["t"] == "sub" else carry_on(m["t"])):
            if k[0] not in seen:
                walk(k, ps, depth + 1, seen | {k[0]})
    for r in chains.get("standing", []):
        walk(r, [], 0, {r[0]})
    return best if len(best) >= 3 else []


def notebook_html(idx):
    """The closed guard chain tree, typeset like a page of a coach's notebook, two branches deep, each move linking to its page."""
    path = os.path.join(ROOT, "web", "data", "chains-demo.json")
    chains = json.load(open(path, encoding="utf-8"))["chains"].get("cg_bot", [])
    site = {t["id"]: t for t in idx["tech"]}
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")

    def line(r, depth):
        t = site.get(r[0])
        if not t:
            return ""
        w = re.sub(r"^Start:\s*", "", r[1])
        kids = "".join(line(k, depth + 1) for k in r[2:]) if depth < 2 else ""
        return '<li><span class="nb-if%s">%s</span> <a href="/techniques/%s/">%s</a>%s</li>' % (
            " start" if r[1].startswith("Start:") else "", esc(w[:1].lower() + w[1:]), t["slug"], esc(t["n"]), '<ol>%s</ol>' % kids if kids else "")
    return '<ol class="notebook" aria-label="Attack chains from closed guard">%s</ol>' % "".join(line(r, 0) for r in chains)


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
    gallery, posmap, belts = media_html(site_index())
    landing = landing.replace("@@TECH_GALLERY@@", gallery).replace("@@POS_MAP@@", posmap)
    assert os.path.exists(os.path.join(ROOT, "web", "data", "chains-demo.json")), "no chains for the home page: run node tools/landing-media.js --only chains"
    landing = landing.replace("@@NOTEBOOK@@", notebook_html(site_index()))
    counts = json.load(open(os.path.join(ROOT, "dist", "counts.json")))
    landing = landing.replace("@@NPOS@@", str(counts["positions"])).replace("@@NTERMS@@", str(counts["terms"]))
    for b, n in belts.items():
        landing = landing.replace("@@N_%s@@" % b.upper(), str(n))
    landing = landing.replace("@@NTECH@@", str(json.load(open(os.path.join(ROOT, "dist", "counts.json")))["techniques"])).replace("@@LDJSON@@", landing_ld(landing))
    # The home page's WebGL belt (web/js/belt.js, served as is): its hash goes in the address so a new version is fetched at once.
    landing = landing.replace("@@BELT_V@@", hashlib.sha256(open(os.path.join(ROOT, "web", "js", "belt.js"), "rb").read()).hexdigest()[:10])
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
