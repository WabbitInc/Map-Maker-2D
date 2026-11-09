"""Land squares + river maker test: python tools/test_land.py [outdir]  (needs playwright + Pillow)."""
import sys, os, pathlib, json, time
from playwright.sync_api import sync_playwright
from PIL import Image

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'test-output'); out.mkdir(parents=True, exist_ok=True)
url = (root / 'index.html').as_uri()
errors, res = [], {}

def wait_terrain(pg, t=60):
    t0 = time.time()
    pg.wait_for_timeout(300)
    while time.time() - t0 < t:
        if pg.evaluate('MapMaker.terrainPending()') == 0: break
        pg.wait_for_timeout(200)
    pg.wait_for_timeout(300)
    return round(time.time() - t0, 2)

with sync_playwright() as p:
    kw = {'headless': True}
    if os.path.exists('/usr/bin/google-chrome'): kw['executable_path'] = '/usr/bin/google-chrome'
    b = p.chromium.launch(**kw)
    pg = b.new_page(viewport={'width': 1600, 'height': 960}, accept_downloads=True)
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url)
    pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    pg.evaluate("MapMaker.map = {name:'Land test', background:{mode:'TiledSprite', tileSpriteKey:'Backgrounds/ocean_tile', size:{x:34,y:19}}, stamps:[]}")
    pg.click('.tool[data-tool="land"]')
    res['grid'] = pg.evaluate('[MapMaker.map.terrain.cols, MapMaker.map.terrain.rows, MapMaker.map.terrain.cellSize]')
    res['workers'] = pg.evaluate('MMTerrain.workerCount()')
    def scr(x, y):   # map px -> page px
        bb = pg.locator('#view').bounding_box(); s = pg.evaluate('MapMaker.toScreen(%f,%f)' % (x, y)); return bb['x'] + s['x'], bb['y'] + s['y']
    def stroke(pts, typ, size=3, mode='paint', alt=False):
        pg.click('.sw[data-type="%s"]' % typ)
        pg.evaluate('(function(){MapMaker.land.size=%d; MapMaker.land.mode="%s"; MapMaker.renderBrushCard();})()' % (size, mode))
        if alt: pg.keyboard.down('Alt')
        x, y = scr(*pts[0]); pg.mouse.move(x, y); pg.mouse.down()
        for q in pts[1:]:
            x, y = scr(*q); pg.mouse.move(x, y, steps=6)
        pg.mouse.up()
        if alt: pg.keyboard.up('Alt')
    # three grass islands, a sand bar, an ice cap, a forest patch
    stroke([(500, 650), (750, 560), (1000, 700), (900, 900), (620, 880), (560, 760)], 'grass', 9)
    stroke([(1450, 450), (1750, 380), (1950, 560), (1700, 760), (1550, 650)], 'grass', 10)
    stroke([(2350, 1150), (2650, 1080), (2850, 1300), (2600, 1480), (2400, 1350)], 'grass', 9)
    stroke([(1500, 1150), (1650, 1100), (1750, 1200)], 'grass', 6)
    stroke([(700, 760), (800, 740)], 'forest', 3)
    stroke([(1650, 520), (1750, 560)], 'rock', 3)
    stroke([(2900, 300), (3100, 260), (3200, 380)], 'ice', 4)
    stroke([(1100, 1500), (1300, 1550)], 'sand', 3)
    # rect + island modes
    stroke([(2200, 300), (2450, 520)], 'swamp', 1, 'rect')
    stroke([(300, 1300), (900, 1800)], 'grass', 1, 'island')
    # erase a little with Alt
    stroke([(1700, 640), (1750, 660)], 'grass', 2, 'paint', True)
    res['land_cells'] = pg.evaluate("(function(){var t=MapMaker.map.terrain,n=0;for(var i=0;i<t.cells.length;i++)if(t.types[t.cells[i]].kind!=='Water')n++;return n})()")
    res['paint_wait'] = wait_terrain(pg)
    pg.screenshot(path=str(out / 'land_1_painted.png'))
    # smart fill on the grid
    for op in ['connect', 'smooth']:
        pg.evaluate("MapMaker.smartLand('%s')" % op)
        if op == 'connect': wait_terrain(pg); pg.screenshot(path=str(out / 'land_2a_connect_only.png'))
    res['toast_connect'] = pg.inner_text('#toast')
    res['land_after_connect'] = pg.evaluate("(function(){var t=MapMaker.map.terrain,n=0;for(var i=0;i<t.cells.length;i++)if(t.types[t.cells[i]].kind!=='Water')n++;return n})()")
    wait_terrain(pg)
    pg.screenshot(path=str(out / 'land_2_connected.png'))
    # rivers: click points, Enter
    pg.click('.tool[data-tool="river"]')
    for q in [(1560, 470), (1640, 560), (1600, 640)]:
        x, y = scr(*q); pg.mouse.click(x, y)
    pg.keyboard.press('Enter')
    for q in [(2450, 1180), (2550, 1260), (2620, 1380), (2700, 1500)]:
        x, y = scr(*q); pg.mouse.click(x, y)
    pg.keyboard.press(']'); pg.keyboard.press(']')
    pg.keyboard.press('Enter')
    # branch from point 2 with ctrl-click
    x, y = scr(2550, 1260); pg.keyboard.down('Control'); pg.mouse.click(x, y); pg.keyboard.up('Control')
    x, y = scr(2420, 1350); pg.mouse.click(x, y); pg.keyboard.press('Enter')
    # a custom lava river, saved as a preset
    pg.keyboard.press('Escape')   # deselect so the preset applies to the next new river only
    pg.select_option('#brushBody select', 'Lava flow')
    for q in [(560, 640), (680, 720), (800, 760), (900, 830)]:
        x, y = scr(*q); pg.mouse.click(x, y)
    pg.keyboard.press('Enter')
    pg.evaluate("(function(){var r=MapMaker.map.rivers[MapMaker.map.rivers.length-1]; r.style.meander=1.1; r.style.lakeEnd=0.6;})()")
    res['preset_saved'] = pg.evaluate("MapMaker.savePreset('My lava')")
    res['rivers'] = pg.evaluate("MapMaker.map.rivers.map(function(r){return [r.name, r.points.length, r.parentId, r.presetName]})")
    res['river_wait'] = wait_terrain(pg)
    pg.screenshot(path=str(out / 'land_3_rivers.png'))
    # stickers on top
    pg.click('.tool[data-tool="land"]')
    pg.evaluate("MapMaker.decorateLand()")
    res['deco'] = pg.evaluate("MapMaker.map.stamps.filter(function(s){return s.genGroup==='terrain-deco'}).length")
    res['deco_toast'] = pg.inner_text('#toast')
    pg.wait_for_timeout(1500); wait_terrain(pg)
    pg.screenshot(path=str(out / 'land_4_stickers.png'))
    # zoom in on an island for detail
    pg.evaluate("(function(){var v=MapMaker.view; v.zoom=1.2; v.panX=-1300*1.2+300; v.panY=-380*1.2+200; MapMaker.setTool('land');})()")
    wait_terrain(pg)
    pg.screenshot(path=str(out / 'land_5_zoom.png'))
    # JSON round-trip
    txt = pg.evaluate('MapMaker.saveJsonText()'); d = json.loads(txt)
    res['json'] = {'version': d['version'], 'cells_is_rle': isinstance(d['terrain']['cells'], str), 'rle_len': len(d['terrain']['cells']), 'rivers': len(d['rivers']), 'presets': [q['name'] for q in d['riverPresets']], 'bytes': len(txt)}
    (out / 'land_map.json').write_text(txt)
    before = pg.evaluate("MMTerrain.encodeRle(MapMaker.map.terrain.cells)")
    pg.evaluate('MapMaker.map = JSON.parse(%s)' % json.dumps(txt))
    res['roundtrip_same'] = pg.evaluate("MMTerrain.encodeRle(MapMaker.map.terrain.cells)") == before
    # undo
    pg.evaluate("MapMaker.smartLand('grow'); MapMaker.undo()")
    res['undo_ok'] = pg.evaluate("MMTerrain.encodeRle(MapMaker.map.terrain.cells)") == before
    # export
    pg.evaluate("MapMaker.setTool('select')")
    pg.click('#btnFinish')
    t0 = time.time()
    pg.wait_for_selector('#exDownload:not([disabled])', timeout=180000)
    res['export_s'] = round(time.time() - t0, 1)
    res['export_info'] = pg.inner_text('#exInfo')
    pg.screenshot(path=str(out / 'land_6_export_dialog.png'))
    with pg.expect_download() as dl:
        pg.click('#exDownload')
    dl.value.save_as(str(out / 'land_export.png'))
    im = Image.open(out / 'land_export.png'); res['export_size'] = im.size
    im.convert('RGB').crop((1300, 250, 2300, 850)).save(out / 'land_export_crop.png')
    b.close()
res['errors'] = errors
print(json.dumps(res, indent=1))
checks = {'land_painted': res['land_cells'] > 500, 'connect_grew': res['land_after_connect'] > res['land_cells'], 'rivers': len(res['rivers']) == 4 and res['rivers'][2][2] == 2,
          'preset_saved': res['preset_saved'] is True, 'stickers': res['deco'] > 10, 'json_v3': res['json']['version'] == 3 and res['json']['cells_is_rle'],
          'roundtrip': res['roundtrip_same'], 'undo': res['undo_ok'], 'export': res['export_size'] == [3400, 1900] or tuple(res['export_size']) == (3400, 1900), 'no_errors': not errors}
bad = [k for k, v in checks.items() if not v]
print('ALL PASS' if not bad else 'FAILED: ' + ', '.join(bad))
sys.exit(1 if bad else 0)
