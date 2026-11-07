"""Merge picked YouTube videos into src/videos.js, re-checking each one with YouTube first.

Usage: python3 tools/merge_videos.py pick1.json pick2.json ...
Each pick file maps an item id (technique id, or "pos:<position>") to
{"v": video id, "title": ..., "channel": ..., "nogi": bool} or null.
A video is kept only if YouTube's oEmbed answers 200 (exists and can be embedded).
"""
import json, os, re, sys, time, urllib.parse, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "videos.js")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def oembed(vid):
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + vid, safe="")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "JitsFlow video check"}), timeout=15) as r:
                return 200, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            time.sleep(1 + attempt)
    return 0, None


def main(paths):
    picks = {}
    for p in paths:
        with open(p, encoding="utf-8") as f:
            picks.update(json.load(f))
    kept, dropped, nulls = {}, [], []
    for key in sorted(picks):
        item = picks[key]
        if not item or not item.get("v"):
            nulls.append(key); continue
        vid = item["v"].strip()
        if not ID_RE.match(vid):
            dropped.append((key, vid, "bad id")); continue
        code, meta = oembed(vid)
        if code != 200:
            dropped.append((key, vid, "oEmbed %s" % code)); continue
        kept[key] = {"v": vid, "title": meta.get("title", "")[:140], "channel": meta.get("author_name", "")[:80], "nogi": item.get("nogi", True) is not False}
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("/* Picked YouTube videos per technique and position (checked with YouTube oEmbed). */\n")
        f.write("const VIDEO_PICKS=" + json.dumps(kept, ensure_ascii=False, indent=0, sort_keys=True) + ";\n")
    print("kept %d, null %d, dropped %d" % (len(kept), len(nulls), len(dropped)))
    for d in dropped:
        print("  dropped", *d)
    if nulls:
        print("  no video:", ", ".join(nulls))
    dupes = {}
    for k, v in kept.items():
        dupes.setdefault(v["v"], []).append(k)
    for vid, ks in dupes.items():
        if len(ks) > 1:
            print("  same video used for:", vid, ks)


if __name__ == "__main__":
    main(sys.argv[1:])
