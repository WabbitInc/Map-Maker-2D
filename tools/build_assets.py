#!/usr/bin/env python3
"""Builds assets/*.js (base64 WebP data URIs + smart-fill metadata) from a sprites folder.

usage: python build_assets.py [path/to/Assets/MapMaker] [--max 512] [--quality 80] [--no-unity-meta]

Adding sprites: drop transparent PNG/WebP files into  <root>/Sprites/<Biome>/  (a new folder = a new biome tab)
and re-run.  Categories are discovered automatically; known biomes keep their usual order, new ones follow
alphabetically.  Layer type comes from Sprites/_sprite_types.json, falling back to a size/colour heuristic.
Smart-fill metadata (sprite_meta.py) is written to assets/meta.js and to <root>/Sprites/_sprite_meta.json
(the same file the Unity editor reads).  Manual overrides: <root>/Sprites/_sprite_meta_overrides.json.

Sprites are embedded as data URIs inside <script> files so the page works from file:// without tainting the canvas."""
import argparse, base64, glob, io, json, os, re, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sprite_meta

KNOWN = [("Coast", "coast"), ("Grassland", "grass"), ("Islands", "island"), ("Ponds", "pond"), ("JungleVolcanic", "jv"),
         ("Alpine", "alp"), ("Ashlands", "ash"), ("TemperateRivers", "trv"), ("Tropical", "trop"), ("Temperate", "temp"),
         ("CoastalCliffs", "cliff"), ("Badlands", "bad"), ("Toxic", "tox"), ("Swamp", "swamp")]
LABELS = {"JungleVolcanic": "Jungle & Volcanic", "TemperateRivers": "Temperate Rivers", "CoastalCliffs": "Coastal Cliffs"}


def label(cat): return LABELS.get(cat) or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", cat).replace("_", " ")


def webp_uri(im, q):
    b = io.BytesIO(); im.save(b, "WEBP", quality=q, method=6, alpha_quality=90)
    return "data:image/webp;base64," + base64.b64encode(b.getvalue()).decode()


def guess_type(cat, w, h, meta=None):
    t = {"Grassland": "Ground", "Ponds": "Water", "Coast": "Water", "Islands": "Land"}.get(cat)
    if t: return t
    if meta and meta["fractions"].get("water", 0) > 0.45: return "Water"
    return "Features" if w * h < 12000 else "Land"


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=os.path.join(here, "..", "..", "MapMaker2D", "Assets", "MapMaker"))
    ap.add_argument("--max", type=int, default=512); ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--no-unity-meta", action="store_true", help="do not write Sprites/_sprite_meta.json")
    a = ap.parse_args()
    out = os.path.join(here, "..", "assets"); os.makedirs(out, exist_ok=True)
    sd = os.path.join(a.root, "Sprites")
    types = {}
    tp = os.path.join(sd, "_sprite_types.json")
    if os.path.exists(tp):
        for t in json.load(open(tp))["types"]: types[t["key"]] = t["type"]
    folders = [d for d in os.listdir(sd) if os.path.isdir(os.path.join(sd, d)) and d[0] not in "._"]
    known = [c for c, _ in KNOWN if c in folders]
    cats = known + sorted(set(folders) - set(known))
    prefixes = dict(KNOWN)
    for old in glob.glob(os.path.join(out, "sprites_*.js")): os.remove(old)
    manifest = {"categories": [], "sprites": []}
    entries = []; total = 0
    for cat in cats:
        files = sorted(glob.glob(os.path.join(sd, cat, "*.png")) + glob.glob(os.path.join(sd, cat, "*.webp")))
        if not files: continue
        data = {}
        for f in files:
            key = cat + "/" + os.path.splitext(os.path.basename(f))[0]
            src = Image.open(f).convert("RGBA"); w, h = src.size
            im = src
            if max(w, h) > a.max:
                s = a.max / max(w, h); im = src.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
            t = types.get(key)
            if not t:
                t = guess_type(cat, w, h, sprite_meta.analyse(src, key, cat, "Land"))
            data[key] = webp_uri(im, a.quality)
            manifest["sprites"].append([key, w, h, t])
            entries.append((key, cat, t, src))
        js = "MM.registerSprites(" + json.dumps(cat) + "," + json.dumps(data, separators=(",", ":")) + ");\n"
        open(os.path.join(out, "sprites_" + cat + ".js"), "w").write(js); total += len(js)
        manifest["categories"].append({"name": cat, "label": label(cat), "prefix": prefixes.get(cat, cat.lower()[:6]), "count": len(files)})
        print(cat, len(files), round(len(js) / 1e6, 2), "MB")
    metas = sprite_meta.build(sd, entries) if not a.no_unity_meta else [sprite_meta.analyse(im, k, c, t) for k, c, t, im in entries]
    # compact meta for the browser: key -> [angle, major, minor, coverage, size, tags, colors]
    compact = {m["key"]: [m["angle"], m["major"], m["minor"], m["coverage"], m["size"], m["tags"], m["colors"]] for m in metas}
    open(os.path.join(out, "meta.js"), "w").write("window.MM_META=" + json.dumps(compact, separators=(",", ":")) + ";\n")
    bg = {}
    for name in ("ocean_tile", "grass_tile"):
        im = Image.open(os.path.join(a.root, "Backgrounds", name + ".png")).convert("RGBA")
        bg["Backgrounds/" + name] = {"uri": webp_uri(im, 88), "w": im.size[0], "h": im.size[1]}
    open(os.path.join(out, "backgrounds.js"), "w").write("window.MM_BACKGROUNDS=" + json.dumps(bg) + ";\n")
    open(os.path.join(out, "manifest.js"), "w").write("window.MM_MANIFEST=" + json.dumps(manifest, separators=(",", ":")) + ";\n")
    ex = json.load(open(os.path.join(a.root, "Samples", "SampleMap.json")))
    open(os.path.join(out, "example.js"), "w").write("window.MM_EXAMPLE=" + json.dumps(ex, separators=(",", ":")) + ";\n")
    print("sprites total", round(total / 1e6, 2), "MB;", len(metas), "metadata entries")


if __name__ == "__main__":
    main()
