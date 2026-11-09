"""Headless smoke test: python tools/test_playwright.py [outdir]  (needs playwright + Pillow)."""
import sys, os, pathlib, json
from playwright.sync_api import sync_playwright
from PIL import Image, ImageStat

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'test-output'); out.mkdir(parents=True, exist_ok=True)
url = (root / 'index.html').as_uri()
errors = []
res = {}
with sync_playwright() as p:
    kw = {'headless': True}
    if os.path.exists('/usr/bin/google-chrome'): kw['executable_path'] = '/usr/bin/google-chrome'
    b = p.chromium.launch(**kw)
    pg = b.new_page(viewport={'width': 1600, 'height': 960}, accept_downloads=True)
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url)
    pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    pg.wait_for_timeout(800)
    res['example_stamps'] = pg.evaluate('MapMaker.map.stamps.length')
    pg.screenshot(path=str(out / 'ui_example.png'))
    # pick a sprite from the Grassland tab and place stamps by clicking
    pg.click('#tabs .tab[title="Grassland"]')
    pg.wait_for_selector('#palette .th[data-key] img', timeout=20000)
    pg.click('#palette .th[data-key]:nth-child(3)')
    box = pg.locator('#view').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    for dx, dy in [(-250, -120), (-150, 80), (200, 140)]:
        pg.mouse.move(cx + dx, cy + dy); pg.mouse.click(cx + dx, cy + dy)
    res['after_place'] = pg.evaluate('MapMaker.map.stamps.length')
    # scatter brush drag
    pg.evaluate('''() => { const k = Object.values(MapMaker.sprites).find(s => s.cat === 'Tropical' && s.type === 'Features').key;
        return MapMaker.loadCategory('Tropical').then(() => MapMaker.pickBrush(k)); }''')
    pg.keyboard.press('b')
    pg.mouse.move(cx - 300, cy + 220); pg.mouse.down()
    for i in range(20): pg.mouse.move(cx - 300 + i * 25, cy + 220 - i * 4)
    pg.mouse.up()
    res['after_scatter'] = pg.evaluate('MapMaker.map.stamps.length')
    # undo/redo
    pg.keyboard.press('Control+z'); res['after_undo'] = pg.evaluate('MapMaker.map.stamps.length')
    pg.keyboard.press('Control+y'); res['after_redo'] = pg.evaluate('MapMaker.map.stamps.length')
    # select tool: click + duplicate + rotate
    pg.keyboard.press('s'); pg.mouse.click(cx + 200, cy + 140)
    res['selected'] = pg.evaluate('document.getElementById("stSel").textContent')
    pg.keyboard.press('Control+d'); pg.keyboard.press('.')
    res['after_dup'] = pg.evaluate('MapMaker.map.stamps.length')
    # erase
    pg.keyboard.press('d'); pg.mouse.move(cx - 250, cy - 120); pg.mouse.down(); pg.mouse.move(cx - 245, cy - 118); pg.mouse.up()
    res['after_erase'] = pg.evaluate('MapMaker.map.stamps.length')
    pg.keyboard.press('s'); pg.mouse.move(cx + 200, cy + 140)
    pg.wait_for_timeout(600)
    pg.screenshot(path=str(out / 'ui_edited.png'))
    res['autosaved'] = pg.evaluate('!!localStorage.getItem("mapmaker.html.autosave.v1")')
    # JSON save
    with pg.expect_download() as dj: pg.click('#btnSave')
    j = json.loads(open(dj.value.path()).read()); res['json_version'] = j['version']; res['json_stamps'] = len(j['stamps']); res['json_key0'] = j['stamps'][0]['spriteKey']
    # finish & download
    pg.click('#btnFinish')
    pg.wait_for_selector('#exDownload:not([disabled])', timeout=60000)
    res['export_info'] = pg.inner_text('#exInfo')
    pg.screenshot(path=str(out / 'ui_export_modal.png'))
    with pg.expect_download() as dl: pg.click('#exDownload')
    d = dl.value; res['png_name'] = d.suggested_filename
    png = out / d.suggested_filename; d.save_as(str(png))
    # transparent 2x variant
    pg.check('#exTransparent'); pg.select_option('#exScale', '2')
    pg.wait_for_function('!document.getElementById("exDownload").disabled', timeout=90000)
    res['export_info_2x'] = pg.inner_text('#exInfo')
    with pg.expect_download() as dl2: pg.click('#exDownload')
    png2 = out / ('transparent2x-' + dl2.value.suggested_filename); dl2.value.save_as(str(png2))
    # reload -> autosave restore
    pg.keyboard.press('Escape'); pg.reload(); pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    res['after_reload'] = pg.evaluate('MapMaker.map.stamps.length')
    b.close()

im = Image.open(png); st = ImageStat.Stat(im.convert('RGB'))
res['png'] = {'path': str(png), 'size': im.size, 'mode': im.mode, 'bytes': png.stat().st_size, 'stddev': [round(x, 1) for x in st.stddev], 'colors_sampled': len(set(im.convert('RGB').resize((200, 112)).get_flattened_data()))}
im2 = Image.open(png2).convert('RGBA'); a = im2.getchannel('A')
res['png2'] = {'path': str(png2), 'size': im2.size, 'bytes': png2.stat().st_size, 'transparent_frac': round(sum(1 for v in a.resize((300, 170)).get_flattened_data() if v == 0) / (300 * 170), 3)}
im.convert('RGB').resize((im.width // 2, im.height // 2)).save(out / 'export_half_preview.jpg', quality=85)
res['errors'] = errors
print(json.dumps(res, indent=1))
ok = (res['png']['stddev'][0] > 5 and res['after_place'] == res['example_stamps'] + 3 and res['after_scatter'] > res['after_place'] and not errors
      and res['png_name'].startswith('map-') and res['after_reload'] == res['after_erase'])
print('PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
