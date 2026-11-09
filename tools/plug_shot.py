"""Headless export of the coast layout: before (plug off) / after (plug on + Auto-fill). python tools/plug_shot.py outdir"""
import sys, pathlib, json, time, base64
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'test-output' / 'plug'); out.mkdir(parents=True, exist_ok=True)
LAYOUT = [('Coast/coast_01', 700, 420, 0), ('Coast/coast_06', 330, 480, 0), ('Coast/coast_03', 360, 640, 0),
          ('Coast/coast_04', 470, 900, 0), ('Coast/coast_02', 1050, 900, 0), ('Coast/coast_05', 1000, 650, 0)]
errors = []
JS_EXPORT = """async (name) => { const r = await MapMaker.renderExportFull(MapMaker.map, 0.6, false, true); return r.canvas.toDataURL('image/png'); }"""
def save(pg, name):
    d = pg.evaluate(JS_EXPORT, name); (out / name).write_bytes(base64.b64decode(d.split(',')[1]))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1600, 'height': 960})
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto((root / 'index.html').as_uri()); pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    def build(plug):
        st = []
        for i, (k, x, y, r) in enumerate(LAYOUT):
            st.append({'id': i + 1, 'spriteKey': k, 'position': {'x': (x - 800) / 100, 'y': -(y - 650) / 100}, 'rotation': r, 'scale': {'x': 1, 'y': 1}})
        pg.evaluate("m => { MapMaker.map = m; }", {'name': 'Coast', 'background': {'mode': 'TiledSprite', 'tileSpriteKey': 'Backgrounds/ocean_tile', 'size': {'x': 16, 'y': 13}}, 'stamps': st, 'plug': {'on': plug, 'variation': 0}})
        pg.evaluate("Promise.all([MapMaker.loadCategory('Coast')]).then(()=>MapMaker.plugKeysReady())"); pg.wait_for_timeout(800)
    build(False); save(pg, 'before.png')
    build(True); pg.evaluate("MapMaker.setSel([])"); r1 = pg.evaluate("MapMaker.map.terrain ? 'terrain' : 'none'")
    save(pg, 'merged.png')
    res = pg.evaluate("MapMaker.autoFill()"); save(pg, 'after.png')
    print(json.dumps({'terrain_after_build': r1, 'autofill': res, 'errors': errors}, indent=1))
    b.close()
