#!/usr/bin/env python3
"""Smart-fill sprite metadata (shared spec for the HTML editor and the Unity editor).

usage: python sprite_meta.py [Assets/MapMaker]   -> writes Sprites/_sprite_meta.json
The same analysis is implemented in app.js (analyseSprite) and MapSpriteMeta.cs (Analyse) so sprites imported
at runtime get identical metadata.  Manual overrides: Sprites/_sprite_meta_overrides.json
  {"overrides": {"Coast/coast_01": {"tags": ["land","coast"], "addTags": ["ridge"], "removeTags": ["water"],
                                    "angle": 30, "size": "large", "type": "Land"}}}

Per sprite:
  key, biome (folder), w, h (px), type (Ground/Water/Land/Features/Peaks)
  coverage  opaque px / (w*h)                 aspect  w/h
  angle     principal axis, degrees CCW from +x, Unity convention (y up), in (-90, 90]
  major/minor  opaque extent along / across the principal axis (px, 2nd..98th percentile)
  elongation   major / minor
  size      small (<20k opaque px) | medium (<90k) | large
  fractions colour-class shares of opaque px; colors = up to 3 dominant class colours (#rrggbb)
  tags      water land coast river ridge peak forest lava sand snow marsh toxic rock feature elongated round
"""
import colorsys, json, math, os, sys
import numpy as np
from PIL import Image

CLASSES = ["dark", "snow", "rock", "water", "lava", "toxic", "forest", "marsh", "green", "sand", "earth", "other"]
SAMPLE = 128


def classify_pixels(rgb):
    """rgb: Nx3 float 0..1 -> class index per pixel (same rule order as the JS/C# ports)."""
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    mx = rgb.max(1); mn = rgb.min(1); d = mx - mn
    v = mx; s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm = nz & (mx == r); gm = nz & (mx == g) & ~rm; bm = nz & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    h = h * 60.0
    c = np.full(len(rgb), 11, np.int32)
    rules = [
        (v < 0.18, 0),
        ((s < 0.12) & (v > 0.80), 1),
        ((s < 0.20) & (v > 0.25), 2),
        ((h >= 175) & (h <= 250) & (s > 0.22) & (v > 0.20), 3),
        (((h < 22) | (h > 340)) & (s > 0.55) & (v > 0.45), 4),
        ((((h >= 75) & (h <= 110) & (s > 0.65) & (v > 0.60)) | ((h >= 260) & (h <= 320) & (s > 0.35))), 5),
        ((h >= 70) & (h <= 170) & (s > 0.25) & (v < 0.48), 6),
        ((h >= 40) & (h < 100) & (s > 0.15) & (s < 0.45) & (v > 0.18) & (v < 0.42), 7),
        ((h >= 60) & (h <= 170) & (s > 0.20), 8),
        ((h >= 25) & (h < 60) & (s > 0.18) & (s < 0.65) & (v > 0.55), 9),
        ((h >= 10) & (h < 45) & (s > 0.25), 10),
    ]
    done = np.zeros(len(rgb), bool)
    for m, k in rules:
        m = m & ~done; c[m] = k; done |= m
    return c


def tags_for(m):
    f = m["fractions"]; t = m["type"]; el = m["elongation"]; biome = m["biome"]
    landish = f["green"] + f["sand"] + f["earth"] + f["marsh"] + f["forest"] + f["rock"] * 0.5
    tags = set()
    if f["water"] > 0.30 or t == "Water": tags.add("water")
    if t in ("Ground", "Land") or (landish > 0.45 and f["water"] < 0.30): tags.add("land")
    if 0.06 < f["water"] < 0.65 and (f["sand"] + f["green"] + f["rock"] + f["earth"]) > 0.15: tags.add("coast")
    if biome in ("Coast", "CoastalCliffs") : tags.add("coast")
    if f["forest"] > 0.30 or (t == "Features" and f["forest"] + f["green"] > 0.5): tags.add("forest")
    if t == "Peaks" or (f["rock"] + f["snow"] > 0.45 and el < 1.8): tags.add("peak")
    if el >= 1.8 and (f["rock"] + f["snow"] + f["earth"] > 0.35 or t == "Peaks"): tags.add("ridge")
    if (f["water"] > 0.12 and el >= 2.0 and m["coverage"] < 0.6) or (biome == "TemperateRivers" and f["water"] > 0.10): tags.add("river")
    if f["lava"] > 0.05: tags.add("lava")
    if f["sand"] > 0.25: tags.add("sand")
    if f["snow"] > 0.18: tags.add("snow")
    if f["marsh"] > 0.30 or biome == "Swamp": tags.add("marsh")
    if f["toxic"] > 0.10 or biome == "Toxic": tags.add("toxic")
    if f["rock"] > 0.35: tags.add("rock")
    if t == "Features": tags.add("feature")
    if el >= 1.8: tags.add("elongated")
    if el < 1.3: tags.add("round")
    return sorted(tags)


def analyse(im, key, biome, typ):
    """im: PIL RGBA at original size."""
    W, H = im.size
    k = min(1.0, SAMPLE / max(W, H))
    sm = im.resize((max(1, round(W * k)), max(1, round(H * k))), Image.BILINEAR) if k < 1 else im
    a = np.asarray(sm, np.float32) / 255.0
    w, h = sm.size
    op = a[:, :, 3] >= 0.5
    n = int(op.sum())
    m = {"key": key, "biome": biome, "w": W, "h": H, "type": typ, "coverage": round(n / float(w * h), 4), "aspect": round(W / float(H), 4)}
    if n < 3:
        m.update(angle=0.0, major=float(W), minor=float(H), elongation=round(max(W, H) / max(1.0, min(W, H)), 3), fractions={c: 0.0 for c in CLASSES}, colors=[])
    else:
        ys, xs = np.nonzero(op)
        sx = W / float(w); sy = H / float(h)
        X = (xs + 0.5) * sx; Y = (ys + 0.5) * sy                     # original px, y down
        cx, cy = X.mean(), Y.mean(); dx, dy = X - cx, Y - cy
        cxx, cyy, cxy = (dx * dx).mean(), (dy * dy).mean(), (dx * dy).mean()
        th = 0.5 * math.atan2(2 * cxy, cxx - cyy)                    # image angle (y down)
        u = dx * math.cos(th) + dy * math.sin(th); v = -dx * math.sin(th) + dy * math.cos(th)
        major = float(np.percentile(u, 98) - np.percentile(u, 2)) + sx
        minor = float(np.percentile(v, 98) - np.percentile(v, 2)) + sy
        if minor > major: major, minor = minor, major; th += math.pi / 2
        ang = -math.degrees(th)                                       # Unity CCW, y up
        while ang > 90: ang -= 180
        while ang <= -90: ang += 180
        rgb = a[:, :, :3][op]
        cl = classify_pixels(rgb)
        cnt = np.bincount(cl, minlength=len(CLASSES))
        fr = {c: round(float(cnt[i]) / n, 4) for i, c in enumerate(CLASSES)}
        order = [i for i in np.argsort(-cnt) if cnt[i] > 0][:3]
        cols = []
        for i in order:
            mc = rgb[cl == i].mean(0)
            cols.append("#%02x%02x%02x" % tuple(int(round(x * 255)) for x in mc))
        m.update(angle=round(ang, 2), major=round(major, 1), minor=round(max(1.0, minor), 1), elongation=round(major / max(1.0, minor), 3), fractions=fr, colors=cols)
    area = m["coverage"] * W * H
    m["size"] = "small" if area < 20000 else "medium" if area < 90000 else "large"
    m["tags"] = tags_for(m)
    return m


def apply_override(m, o):
    if not o: return m
    for k in ("angle", "size", "type", "major", "minor", "elongation"):
        if k in o: m[k] = o[k]
    if "tags" in o: m["tags"] = sorted(set(o["tags"]))
    if "addTags" in o: m["tags"] = sorted(set(m["tags"]) | set(o["addTags"]))
    if "removeTags" in o: m["tags"] = sorted(set(m["tags"]) - set(o["removeTags"]))
    m["override"] = True
    return m


def load_overrides(sprites_dir):
    p = os.path.join(sprites_dir, "_sprite_meta_overrides.json")
    if not os.path.exists(p):
        json.dump({"_comment": "Per-sprite smart-fill overrides. Keys: tags (replace), addTags, removeTags, angle (deg CCW), size (small|medium|large), type, major, minor, elongation.",
                   "overrides": {}}, open(p, "w"), indent=1)
        return {}
    return json.load(open(p)).get("overrides", {})


def build(sprites_dir, entries):
    """entries: list of (key, biome, type, PIL image). Returns list of meta dicts; writes _sprite_meta.json."""
    ov = load_overrides(sprites_dir)
    metas = [apply_override(analyse(im, key, biome, typ), ov.get(key)) for key, biome, typ, im in entries]
    out = {"_comment": "Generated by sprite_meta.py (Map Maker smart fill). Do not edit; use _sprite_meta_overrides.json.", "version": 1, "sprites": metas}
    with open(os.path.join(sprites_dir, "_sprite_meta.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    return metas


if __name__ == "__main__":
    import glob
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    sd = os.path.join(root, "Sprites")
    types = {}
    tp = os.path.join(sd, "_sprite_types.json")
    if os.path.exists(tp):
        for t in json.load(open(tp))["types"]: types[t["key"]] = t["type"]
    ent = []
    for cat in sorted(d for d in os.listdir(sd) if os.path.isdir(os.path.join(sd, d)) and d[0] not in "._"):
        for f in sorted(glob.glob(os.path.join(sd, cat, "*.png")) + glob.glob(os.path.join(sd, cat, "*.webp"))):
            key = cat + "/" + os.path.splitext(os.path.basename(f))[0]
            im = Image.open(f).convert("RGBA")
            ent.append((key, cat, types.get(key) or "Land", im))
    ms = build(sd, ent)
    print(len(ms), "sprites ->", os.path.join(sd, "_sprite_meta.json"))
