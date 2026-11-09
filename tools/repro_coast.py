"""Reproduces the user's report: Coast stickers placed next to each other + Smart Fill. python tools/repro_coast.py [outdir] [tag]"""
import sys, os, pathlib, json, time
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'test-output' / 'fit'); out.mkdir(parents=True, exist_ok=True)
tag = sys.argv[2] if len(sys.argv) > 2 else 'run'
errors, res = [], {}
# layout like the screenshot (map px on a 2000x1600 map): key, x, y, rot
LAYOUT = [('Coast/coast_01', 700, 420, 0), ('Coast/coast_06', 330, 480, 0), ('Coast/coast_03', 360, 640, 0),
          ('Coast/coast_04', 470, 900, 0), ('Coast/coast_02', 1050, 900, 0), ('Coast/coast_05', 1000, 650, 0)]
def wait_idle(pg, t=60):
    t0 = time.time(); pg.wait_for_timeout(250)
    while time.time() - t0 < t:
        if pg.evaluate('MapMaker.terrainPending()') == 0: break
        pg.wait_for_timeout(150)
    pg.wait_for_timeout(250)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path='/usr/bin/google-chrome')
    pg = b.new_page(viewport={'width': 1600, 'height': 960})
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto((root / 'index.html').as_uri()); pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    pg.evaluate("MapMaker.map = {name:'Coast test', background:{mode:'TiledSprite', tileSpriteKey:'Backgrounds/ocean_tile', size:{x:16,y:13}}, stamps:[]}")
    pg.evaluate("MapMaker.fit()")
    pg.click('#tabs .tab[title="Coast"]'); pg.wait_for_selector('#palette .th[data-key="Coast/coast_01"] img', timeout=20000)
    pg.keyboard.press('p')
    def scr(x, y):
        bb = pg.locator('#view').bounding_box(); s = pg.evaluate('MapMaker.toScreen(%f,%f)' % (x, y)); return bb['x'] + s['x'], bb['y'] + s['y']
    for k, x, y, r in LAYOUT:   # place like a user: pick thumbnail, click map
        pg.click('#palette .th[data-key="%s"]' % k); sx, sy = scr(x, y); pg.mouse.click(sx, sy)
    res['placed'] = pg.evaluate('MapMaker.map.stamps.length')
    pg.wait_for_timeout(600); wait_idle(pg)
    pg.screenshot(path=str(out / (tag + '_1_placed.png')))
    # sticker Smart Fill, nothing selected
    pg.keyboard.press('Escape'); pg.keyboard.press('k'); pg.wait_for_timeout(300)
    res['sf_nosel_msg'] = pg.evaluate("(document.getElementById('genMsg')||{}).textContent || ''")
    res['sf_nosel_hint'] = pg.evaluate("(document.getElementById('genHint')||{}).textContent || ''")
    # box-select all pieces, like the screenshot
    a = scr(150, 250); c = scr(1400, 1100)
    pg.mouse.move(*a); pg.mouse.down(); pg.mouse.move(*c, steps=8); pg.mouse.up(); pg.wait_for_timeout(400)
    res['sf_sel_msg'] = pg.evaluate("(document.getElementById('genMsg')||{}).textContent || ''")
    pg.screenshot(path=str(out / (tag + '_2_sf_preview.png')))
    pg.keyboard.press('Enter'); pg.wait_for_timeout(1200); wait_idle(pg)
    res['after_apply'] = pg.evaluate('MapMaker.map.stamps.length')
    pg.screenshot(path=str(out / (tag + '_3_sf_applied.png')))
    # land Smart Fill
    pg.keyboard.press('l'); pg.wait_for_timeout(300)
    btns = pg.evaluate("Array.from(document.querySelectorAll('#brushBody button')).map(b=>b.textContent.trim())")
    res['land_buttons'] = btns
    for name in ['Connect', 'Grow']:
        loc = pg.locator('#brushBody button', has_text=name).first
        if loc.count(): loc.click(); pg.wait_for_timeout(300); res['land_' + name] = pg.inner_text('#toast')
    wait_idle(pg)
    pg.screenshot(path=str(out / (tag + '_4_land_fill.png')))
    hook = pg.evaluate("typeof MapMaker.autoFill")
    if hook == 'function':
        pg.evaluate("MapMaker.undo(); MapMaker.undo(); MapMaker.undo(); MapMaker.setTool('select')"); wait_idle(pg)
        res['auto_count_before'] = pg.evaluate('MapMaker.map.stamps.length')
        pg.screenshot(path=str(out / (tag + '_5_merged.png')))
        pg.click('#btnAutoFill'); pg.wait_for_timeout(500); wait_idle(pg)
        res['autofill_toast'] = pg.inner_text('#toast')
        pg.screenshot(path=str(out / (tag + '_6_autofill.png')))
    b.close()
res['errors'] = errors
print(json.dumps(res, indent=1))
