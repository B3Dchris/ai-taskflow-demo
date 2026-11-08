#!/usr/bin/env python3
"""Add photos to the app: python3 tools/add-images.py <folder or files...>

Each file is named after the position or move it shows (e.g. hip_bump.jpg, sc_top.png, "Hip bump sweep.jpeg").
Positions go to web/img/positions/, moves to web/img/techniques/, belts (belt-blue…) to web/img/belts/.
Every image is centre-cropped to a square, resized to 1000 px and saved as a JPEG (quality 82).
Then run python3 build.py so the app lists them."""
import json, os, re, sys
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POS = ["back_top", "mount_top", "sc_top", "fhl_top", "turtle_top", "ashi", "standing", "open_top", "cg_top", "hg_top",
       "seated", "bfly_bot", "cg_bot", "hg_bot", "sc_bot", "fhl_bot", "turtle_bot", "ashi_def", "mount_bot", "back_bot"]

def tech_names():
    """Move ids and names from the built app, so a file can be named either way."""
    html = open(os.path.join(ROOT, "dist", "jitsflow-claude.html"), encoding="utf-8").read()
    return {m.group(1): m.group(2) for m in re.finditer(r'\bT\("([a-z0-9_]+)","([^"]+)"', html)}

def key(s): return re.sub(r"[^a-z0-9]+", "", s.lower())

def main(args):
    names = tech_names(); by_key = {key(i): i for i in list(names) + POS}; by_key.update({key(n): i for i, n in names.items()})
    files = []
    for a in args: files += [os.path.join(a, f) for f in sorted(os.listdir(a))] if os.path.isdir(a) else [a]
    done, skipped = [], []
    for f in files:
        stem = os.path.splitext(os.path.basename(f))[0]
        belt = re.match(r"^belt[-_ ]?(blue|purple|brown|black)$", stem, re.I)
        # "move-" / "pos-" settle names used by both a move and a position (ashi_def)
        pre = re.match(r"^(move|pos)[-_ ](.+)$", stem, re.I)
        if pre and not belt:
            want = pre.group(2); ident = want if (want in names if pre.group(1).lower() == "move" else want in POS) else None
            kind = "techniques" if pre.group(1).lower() == "move" else "positions"
        else:
            ident = None if belt else by_key.get(key(stem)); kind = None
        if not belt and not ident: skipped.append(os.path.basename(f)); continue
        try: im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        except Exception: skipped.append(os.path.basename(f) + " (not an image)"); continue
        im = ImageOps.fit(im, (1000, 1000), Image.LANCZOS, centering=(0.5, 0.45))
        sub, name = ("belts", belt.group(1).lower()) if belt else (kind or ("positions" if ident in POS else "techniques"), ident)
        out = os.path.join(ROOT, "web", "img", sub, name + ".jpg"); os.makedirs(os.path.dirname(out), exist_ok=True)
        im.save(out, "JPEG", quality=82, optimize=True, progressive=True); done.append(f"{sub}/{name}.jpg")
    print(f"added {len(done)}:", *done, sep="\n  ")
    if skipped: print(f"skipped {len(skipped)} (name doesn't match a position or move):", *skipped, sep="\n  ")

if __name__ == "__main__":
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    main(sys.argv[1:])
