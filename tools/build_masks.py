#!/usr/bin/env python3
"""Builds assets/masks.js: per-sprite land / water masks used for plug-and-play merging.

usage: python tools/build_masks.py [path/to/Assets/MapMaker]

For every sprite:
  * ocean water (blue/teal pixels connected to the sprite's outline) -> a low-res alpha PNG ('k') that the
    editor uses to key that water out, so the piece blends into the map's own ocean;
  * enclosed water (ponds, lagoons fully ringed by land) is kept;
  * a coarse terrain-code grid ('g', RLE) for writing the piece into the land grid:
      .=transparent ~=ocean o=pond  S sand G grass D dirt F forest W swamp I ice R rock L lava
Run again after adding sprites (build_assets.py does it automatically)."""
import base64, glob, io, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

here = os.path.dirname(os.path.abspath(__file__))
root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', 'MapMaker2D', 'Assets', 'MapMaker')
LAND = [('S', 'sand'), ('G', 'grass'), ('D', 'dirt'), ('F', 'forest'), ('W', 'swamp'), ('I', 'ice'), ('R', 'rock'), ('L', 'lava')]
KEY_MAX, GRID_MAX = 160, 40


def tile_means():
    td = os.path.join(root, 'Terrain', 'Tiles'); out = []
    for ch, tid in LAND:
        fs = sorted(glob.glob(os.path.join(td, tid + '_*.png')))
        a = np.concatenate([np.asarray(Image.open(f).convert('RGB').resize((32, 32)), np.float32).reshape(-1, 3) for f in fs])
        out.append(a.mean(0))
    return np.array(out)


def water_score(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    s1 = np.clip((b - r - 6) / 22, 0, 1)            # bluer than red
    s2 = np.clip((b - g + 28) / 26, 0, 1)           # not much greener than blue (teal ok, grass no)
    s3 = np.clip((sat - 0.12) / 0.12, 0, 1)         # not grey / snow
    s4 = np.clip((165 - mx) / 30, 0, 1)             # sea is dark; ice / snow / foam are bright
    return s1 * s2 * s3 * s4


def rle(s):
    out, i = [], 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]: j += 1
        out.append(s[i] + (str(j - i) if j - i > 1 else '')); i = j
    return ''.join(out)


def analyse(path, means):
    im = Image.open(path).convert('RGBA'); W, H = im.size
    s = min(1.0, 640 / max(W, H))
    if s < 1: im = im.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS)
    a = np.asarray(im, np.float32); rgb, al = a[..., :3], a[..., 3] / 255
    h, w = al.shape; size = max(h, w)
    opaque = al > 0.5
    sc = water_score(rgb) * (al > 0.05)
    sig = max(1.0, size * 0.008)
    scs = ndi.gaussian_filter(sc, sig)
    wat = (scs > 0.42) & opaque
    wat = ndi.binary_opening(wat, iterations=max(1, int(size * 0.004)))
    wat = ndi.binary_closing(wat, iterations=max(1, int(size * 0.006))) & opaque
    lab, n = ndi.label(wat)
    # outline: transparent pixels or the image border
    outside = ~opaque; outside[0, :] = outside[-1, :] = outside[:, 0] = outside[:, -1] = True
    near_out = ndi.binary_dilation(outside, iterations=max(2, int(size * 0.01)))
    ocean = np.zeros_like(wat); pond = np.zeros_like(wat)
    if n:
        touch = np.unique(lab[near_out & wat]); touch = set(touch[touch > 0].tolist())
        areas = ndi.sum(wat, lab, range(1, n + 1))
        for i in range(1, n + 1):
            if areas[i - 1] < wat.size * 0.0015: continue
            (ocean if i in touch else pond)[lab == i] = True
    opa = max(1, opaque.sum()); ofr = ocean.sum() / opa; pfr = pond.sum() / opa
    rec = {'ocean': round(float(ofr), 3), 'pond': round(float(pfr), 3)}
    # soft key alpha for ocean water: blurred score inside a slightly grown ocean region
    if ofr > 0.02:
        region = ndi.binary_dilation(ocean, iterations=max(2, int(size * 0.012)))
        soft = np.clip((ndi.gaussian_filter(sc, sig * 0.6) - 0.25) / 0.4, 0, 1) * region
        soft = np.maximum(soft, ocean * 1.0)
        soft = ndi.gaussian_filter(soft, sig * 0.5)
        k = KEY_MAX / max(h, w); kw, kh = max(1, round(w * k)), max(1, round(h * k))
        km = Image.fromarray((np.clip(soft, 0, 1) * 255).astype(np.uint8), 'L').resize((kw, kh), Image.BILINEAR)
        b = io.BytesIO(); km.save(b, 'PNG', optimize=True)
        rec['k'] = 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()
    # coarse terrain grid
    g = GRID_MAX / max(h, w); gw, gh = max(1, round(w * g)), max(1, round(h * g))
    land = opaque & ~ocean & ~pond
    codes = []
    ys = np.linspace(0, h, gh + 1).astype(int); xs = np.linspace(0, w, gw + 1).astype(int)
    counts = {}
    for yi in range(gh):
        row = []
        for xi in range(gw):
            sl = (slice(ys[yi], max(ys[yi] + 1, ys[yi + 1])), slice(xs[xi], max(xs[xi] + 1, xs[xi + 1])))
            cov = al[sl].mean(); oc = ocean[sl].mean(); po = pond[sl].mean(); la = land[sl]
            if cov < 0.4: row.append('.'); continue
            if oc > 0.5: row.append('~'); continue
            if po > 0.5: row.append('o'); continue
            if la.sum() == 0: row.append('~' if oc >= po else 'o'); continue
            c = rgb[sl][la].mean(0)
            d = ((means - c) ** 2).sum(1); ch = LAND[int(d.argmin())][0]
            row.append(ch); counts[ch] = counts.get(ch, 0) + 1
        codes.append(row)
    # majority filter so single odd cells do not speckle the grid
    cg = np.array(codes); out = cg.copy()
    for yi in range(gh):
        for xi in range(gw):
            if cg[yi, xi] in '.~o': continue
            win = cg[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2].ravel()
            win = [c for c in win if c not in '.~o']
            if win: out[yi, xi] = max(set(win), key=win.count)
    rec['gw'], rec['gh'] = gw, gh
    rec['g'] = rle(''.join(''.join(r) for r in out))
    rec['dom'] = dict(LAND)[max(counts, key=counts.get)] if counts else ''
    return rec


def main():
    means = tile_means(); sd = os.path.join(root, 'Sprites'); out = {}
    for cat in sorted(d for d in os.listdir(sd) if os.path.isdir(os.path.join(sd, d)) and d[0] not in '._'):
        for f in sorted(glob.glob(os.path.join(sd, cat, '*.png')) + glob.glob(os.path.join(sd, cat, '*.webp'))):
            key = cat + '/' + os.path.splitext(os.path.basename(f))[0]
            out[key] = analyse(f, means)
    dst = os.path.join(here, '..', 'assets', 'masks.js')
    open(dst, 'w').write('window.MM_MASKS=' + json.dumps(out, separators=(',', ':')) + ';\n')
    nk = sum(1 for v in out.values() if 'k' in v)
    print(len(out), 'sprites,', nk, 'with ocean keys ->', dst, os.path.getsize(dst) // 1024, 'KB')


if __name__ == '__main__':
    main()
