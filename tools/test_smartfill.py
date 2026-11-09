"""Smart Fill + sprite import test: python tools/test_smartfill.py [outdir]  (needs playwright + Pillow)."""
import sys, os, pathlib, json
from playwright.sync_api import sync_playwright
from PIL import Image, ImageStat

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'test-output'); out.mkdir(parents=True, exist_ok=True)
sheet = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else root.parent / 'MapMaker2D/Assets/MapMaker/Tools~/sheets/grassland.jpg'
url = (root / 'index.html').as_uri()
errors, res, fails = [], {}, []
def ok(name, cond, info=''):
    res[name] = 'PASS' if cond else 'FAIL ' + str(info)
    if not cond: fails.append(name)

SETUP = '''() => {
  const S = MapMaker.sprites, pick = (cat, n) => Object.values(S).filter(s => s.cat === cat && s.type === 'Land').sort((a, b) => b.w * b.h - a.w * a.h)[n].key;
  const st = (id, key, x, y) => ({ id, spriteKey: key, position: { x, y }, rotation: 0, scale: { x: 0.8, y: 0.8 }, sortingLayer: 'Default', order: 20 });
  MapMaker.map = { version: 2, name: 'SmartFill test', nextId: 10, background: { mode: 'TiledSprite', tileSpriteKey: 'Backgrounds/ocean_tile', size: { x: 34, y: 19 }, center: { x: 0, y: 0 }, tileScale: 1 },
    effects: { shadows: true, foam: true, feather: true },
    stamps: [st(1, pick('Temperate', 2), -11, 4.5), st(2, pick('Alpine', 2), 10, 5), st(3, pick('Badlands', 2), 1, -5)] };
  return Promise.all(['Temperate', 'Alpine', 'Badlands'].map(MapMaker.loadCategory)).then(() => MapMaker.map.stamps.map(s => s.spriteKey));
}'''
with sync_playwright() as p:
    kw = {'headless': True}
    if os.path.exists('/usr/bin/google-chrome'): kw['executable_path'] = '/usr/bin/google-chrome'
    b = p.chromium.launch(**kw)
    ctx = b.new_context(viewport={'width': 1600, 'height': 960}, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    pg.goto(url); pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    ok('meta_loaded', pg.evaluate('Object.keys(window.MM_META).length') >= 800)
    res['anchors'] = pg.evaluate(SETUP)
    pg.wait_for_timeout(500)
    pg.screenshot(path=str(out / 'sf_0_anchors.png'))
    pg.keyboard.press('k')
    ok('tool_gen', pg.evaluate('document.getElementById("stTool").textContent') == 'Smart Fill')
    pg.evaluate('MapMaker.setSel([1,2,3])')
    def preview():
        pg.evaluate('MapMaker.refreshPreview()'); pg.wait_for_timeout(50)
        return pg.evaluate('MapMaker.gen.preview ? MapMaker.gen.preview.stamps.map(s => [s.spriteKey, s.position.x, s.position.y, s.rotation]) : null')
    counts = {}
    for style in ['land', 'ridge', 'river', 'coast']:
        pg.evaluate('o => MapMaker.setGenOpts(o)', {'style': style, 'seed': 7, 'width': 170})
        a = preview(); bb = preview()
        ok('connect_%s_preview' % style, a and len(a) > 5, a and len(a))
        ok('connect_%s_deterministic' % style, a == bb)
        pg.evaluate('Promise.all(Object.keys(MapMaker.categories).filter(c => MapMaker.categories[c].state === 1).map(MapMaker.loadCategory))'); pg.wait_for_timeout(700)
        pg.screenshot(path=str(out / ('sf_1_connect_%s_preview.png' % style)))
        pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
        n = pg.evaluate('MapMaker.map.stamps.length'); g = pg.evaluate('MapMaker.map.stamps.filter(s => s.genGroup).length')
        counts[style] = g
        ok('connect_%s_apply' % style, n == 3 + len(a) and g == len(a), (n, g, len(a)))
        pg.wait_for_timeout(500); pg.screenshot(path=str(out / ('sf_2_connect_%s_applied.png' % style)))
        pg.keyboard.press('Control+z'); pg.wait_for_timeout(100)
        ok('connect_%s_undo_one_step' % style, pg.evaluate('MapMaker.map.stamps.length') == 3)
        pg.evaluate('MapMaker.setSel([1,2,3])')
    res['connect_counts'] = counts
    # seed changes output
    pg.evaluate('MapMaker.setGenOpts({style: "land", seed: 7})'); a = preview()
    pg.evaluate('MapMaker.setGenOpts({seed: 8})'); bb = preview()
    ok('seed_changes_output', a != bb)
    # apply + regenerate (one undo step) + clear
    pg.keyboard.press('Enter'); n1 = pg.evaluate('MapMaker.map.stamps.length')
    before = pg.evaluate('JSON.stringify(MapMaker.map.stamps.filter(s => s.genGroup).map(s => s.position))')
    pg.evaluate('MapMaker.regenerate()')
    after = pg.evaluate('JSON.stringify(MapMaker.map.stamps.filter(s => s.genGroup).map(s => s.position))')
    ok('regenerate_changes', before != after and pg.evaluate('MapMaker.map.stamps.filter(s => s.genGroup === "g1").length') > 0)
    pg.keyboard.press('Control+z'); ok('regenerate_undo', pg.evaluate('JSON.stringify(MapMaker.map.stamps.filter(s => s.genGroup).map(s => s.position))') == before)
    pg.evaluate('MapMaker.clearGenerated()'); ok('clear_generated', pg.evaluate('MapMaker.map.stamps.length') == 3)
    pg.keyboard.press('Control+z'); ok('clear_undo', pg.evaluate('MapMaker.map.stamps.length') == n1)
    pg.evaluate('MapMaker.clearGenerated()')
    # grow
    pg.evaluate('MapMaker.setGenMode("grow")'); pg.evaluate('MapMaker.setSel([1])')
    pg.evaluate('MapMaker.setGenOpts({radius: 450, width: 180, seed: 3})')
    g = preview(); ok('grow_preview', g and len(g) > 8, g and len(g))
    pg.wait_for_timeout(500); pg.screenshot(path=str(out / 'sf_3_grow_preview.png'))
    pg.keyboard.press('Enter'); ok('grow_apply', pg.evaluate('MapMaker.map.stamps.filter(s => s.genGroup).length') == len(g))
    pg.wait_for_timeout(400); pg.screenshot(path=str(out / 'sf_4_grow_applied.png'))
    # fill region with a real mouse lasso
    pg.evaluate('MapMaker.setGenMode("fill")'); pg.evaluate('MapMaker.setSel([])')
    pg.evaluate('MapMaker.setGenOpts({width: 150, seed: 5, biomeMode: "pick", biome: "Tropical"})')
    box = pg.locator('#view').bounding_box()
    cx, cy = box['x'] + box['width'] * 0.62, box['y'] + box['height'] * 0.30
    import math
    pts = [(cx + 150 * math.cos(t / 24 * 2 * math.pi) * (1 + 0.25 * math.sin(3 * t / 24 * 2 * math.pi)), cy + 95 * math.sin(t / 24 * 2 * math.pi)) for t in range(25)]
    pg.mouse.move(*pts[0]); pg.mouse.down()
    for q in pts[1:]: pg.mouse.move(*q, steps=2)
    pg.mouse.up(); pg.wait_for_timeout(200)
    ok('fill_region_drawn', (pg.evaluate('MapMaker.gen.region ? MapMaker.gen.region.length : 0') or 0) >= 10)
    f = pg.evaluate('MapMaker.gen.preview ? MapMaker.gen.preview.stamps.length : 0'); ok('fill_preview', f > 8, f)
    ok('fill_biome_pick', pg.evaluate('MapMaker.gen.preview.stamps.every(s => s.spriteKey.startsWith("Tropical/"))'))
    pg.evaluate('MapMaker.loadCategory("Tropical")'); pg.wait_for_timeout(700)
    pg.screenshot(path=str(out / 'sf_5_fill_preview.png'))
    pg.keyboard.press('Enter'); pg.wait_for_timeout(400)
    pg.screenshot(path=str(out / 'sf_6_fill_applied.png'))
    ng = pg.evaluate('MapMaker.map.stamps.filter(s => s.genGroup).length'); ok('fill_apply', ng == len(g) + f)
    pg.keyboard.press('Control+z'); ok('fill_undo', pg.evaluate('MapMaker.map.stamps.filter(s => s.genGroup).length') == len(g))
    pg.keyboard.press('Control+y')
    # Esc cancels a preview
    pg.evaluate('MapMaker.setGenMode("connect")'); pg.evaluate('MapMaker.setSel([1,2,3])'); preview()
    pg.keyboard.press('Escape'); ok('esc_cancels', pg.evaluate('MapMaker.gen.preview') is None)
    # JSON carries genGroup
    j = json.loads(pg.evaluate('MapMaker.saveJsonText()'))
    ok('json_genGroup', sum(1 for s in j['stamps'] if s.get('genGroup')) == ng and all('genGroup' in s for s in j['stamps']))
    # ---- import a sprite sheet
    pg.keyboard.press('s')
    pg.set_input_files('#fileImport', str(sheet))
    pg.wait_for_selector('#importModal:not(.hidden) .imp', timeout=60000)
    np_ = pg.evaluate('MapMaker.imp.pieces.length'); nsel = pg.evaluate('MapMaker.imp.pieces.filter(p => p.on).length')
    res['import_pieces_found'] = np_; res['import_pieces_selected'] = nsel
    ok('import_found_pieces', np_ >= 5, np_)
    pg.select_option('#impCat', '__new'); pg.fill('#impNewCat', 'MyGrass')
    pg.click('#impGrid .imp.on >> nth=0'); nsel2 = pg.evaluate('MapMaker.imp.pieces.filter(p => p.on).length')
    ok('import_deselect', nsel2 == nsel - 1)
    pg.wait_for_timeout(300); pg.screenshot(path=str(out / 'sf_7_import_grid.png'))
    pg.click('#impConfirm')
    pg.wait_for_function('MapMaker.customKeys().length > 0', timeout=30000)
    ck = pg.evaluate('MapMaker.customKeys()'); res['imported'] = len(ck)
    ok('import_count', len(ck) == nsel2, (len(ck), nsel2))
    ok('import_in_new_biome', all(k.startswith('MyGrass/') for k in ck) and pg.evaluate('!!MapMaker.categories.MyGrass'))
    pg.wait_for_timeout(300)
    nthumb = pg.locator('#palette .th[data-key^="MyGrass/"] img').count()
    ok('my_sprites_tab', pg.evaluate('MapMaker.prefs.tab') == 'Mine' and nthumb == len(ck), nthumb)
    mt = pg.evaluate('k => MapMaker.metaOf(k)', ck[0]); res['import_meta_example'] = {k: mt[k] for k in ('angle', 'major', 'minor', 'coverage', 'size', 'tags')}
    ok('import_analysed', bool(mt.get('tags')) and mt.get('major', 0) > 0)
    pg.screenshot(path=str(out / 'sf_8_my_sprites.png'))
    # dense sheet (pieces touch): auto-switches to the dense cutter
    pg.keyboard.press('s'); pg.set_input_files('#fileImport', str(sheet.parent / 'alpine.jpg'))
    pg.wait_for_selector('#importModal:not(.hidden) .imp', timeout=60000)
    dn = pg.evaluate('[MapMaker.imp.pieces.length, MapMaker.imp.denseUsed]'); res['import_dense_alpine'] = dn
    ok('import_dense_sheet', dn[0] >= 80 and dn[1], dn)
    pg.screenshot(path=str(out / 'sf_7b_import_dense_grid.png'))
    pg.keyboard.press('Escape'); pg.wait_for_selector('#importModal.hidden', state='attached')
    ok('import_cancel_keeps', pg.evaluate('MapMaker.customKeys().length') == len(ck))
    # imported sprites take part in Smart Fill
    pg.keyboard.press('k'); pg.evaluate('MapMaker.setGenMode("connect")'); pg.evaluate('MapMaker.setSel([1,3])')
    pg.evaluate('MapMaker.setGenOpts({style: "land", biomeMode: "pick", biome: "MyGrass", seed: 2})')
    c2 = preview(); ok('fill_with_imported', c2 and all(k[0].startswith('MyGrass/') for k in c2), c2 and c2[:2])
    pg.keyboard.press('Enter'); pg.wait_for_timeout(400); pg.screenshot(path=str(out / 'sf_9_connect_imported.png'))
    # embed custom sprites in JSON
    pg.evaluate('MapMaker.prefs.embedCustom = true')
    j = json.loads(pg.evaluate('MapMaker.saveJsonText()'))
    ok('json_embeds_custom', len(j.get('customSprites', [])) > 0 and j['customSprites'][0]['png'].startswith('data:image/png'))
    pg.evaluate('MapMaker.prefs.embedCustom = false')
    # export PNG
    pg.click('#btnFinish'); pg.wait_for_selector('#exDownload:not([disabled])', timeout=90000)
    with pg.expect_download() as dl: pg.click('#exDownload')
    path = out / 'sf_export.png'; dl.value.save_as(str(path))
    im = Image.open(path); res['export_size'] = im.size
    ok('export_png', im.size == (3400, 1900) and max(ImageStat.Stat(im.convert('L')).stddev) > 10)
    pg.keyboard.press('Escape')
    # persistence: reload, imported sprites come back from IndexedDB
    pg.reload(); pg.wait_for_selector('body[data-ready="1"]', timeout=30000)
    ok('indexeddb_persist', pg.evaluate('MapMaker.customKeys().length') == len(ck))
    ok('autosave_custom_draws', pg.evaluate('MapMaker.map.stamps.filter(s => s.spriteKey.startsWith("MyGrass/")).every(s => MapMaker.sprites[s.spriteKey] && MapMaker.sprites[s.spriteKey].ready)'))
    b.close()
res['errors'] = errors
ok('no_js_errors', not errors, errors[:3])
print(json.dumps(res, indent=1))
print('FAILED: ' + ', '.join(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
