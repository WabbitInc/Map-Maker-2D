"""Packs the seamless terrain tiles (shared with the Unity package) into assets/terrain_tiles.js as JPEG data URIs."""
import base64, io, json, os, sys
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', 'MapMaker2D', 'Assets', 'MapMaker', 'Terrain', 'Tiles')
out = {}
for f in sorted(os.listdir(src)):
    if not f.endswith('.png'): continue
    im = Image.open(os.path.join(src, f)).convert('RGB')
    b = io.BytesIO(); im.save(b, 'JPEG', quality=90, subsampling=0)
    out[f[:-4]] = 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
    # extra variants (_4.._7) for more variety: rotations/flips of the seamless tiles stay seamless,
    # plus a slight brightness / warmth shift so repeats are harder to spot. HTML-only (Unity tiles untouched).
    name, _, idx = f[:-4].rpartition('_')
    if idx.isdigit() and int(idx) < 4 and not os.path.exists(os.path.join(src, '%s_%d.png' % (name, int(idx) + 4))):
        ops = [Image.Transpose.ROTATE_90, Image.Transpose.FLIP_LEFT_RIGHT, Image.Transpose.ROTATE_270, Image.Transpose.TRANSPOSE]
        v = im.transpose(ops[int(idx)])
        r, g, bb = v.split(); sh = [(1.04, 1.03, 0.98), (0.95, 0.96, 0.97), (1.02, 0.99, 0.95), (0.97, 1.01, 1.02)][int(idx)]
        v = Image.merge('RGB', [c.point(lambda q, m=m: min(255, int(q * m))) for c, m in zip((r, g, bb), sh)])
        b = io.BytesIO(); v.save(b, 'JPEG', quality=86, subsampling=0)
        out['%s_%d' % (name, int(idx) + 4)] = 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
dst = os.path.join(here, '..', 'assets', 'terrain_tiles.js')
open(dst, 'w').write('window.MM_TILES=' + json.dumps(out, separators=(',', ':')) + ';\n')
print(len(out), 'tiles ->', dst, os.path.getsize(dst) // 1024, 'KB')
