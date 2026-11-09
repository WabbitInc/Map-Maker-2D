/* Map Maker 2D — standalone HTML editor. Vanilla JS + Canvas 2D, works from file://.
 * Data model = Unity MapJson v2 (MapMaker.MapJson.MapDto), so saved JSON loads in the Unity editor and vice versa.
 * Coordinates: Unity units, y up, map rectangle centred on background.center with background.size.
 * Canvas "map pixels": 100 px = 1 unit, origin top-left of the map rectangle, y down. */
(function () {
'use strict';

var PPU = 100;
var TYPES = ['Unknown', 'Ground', 'Water', 'Land', 'Features', 'Peaks'];
var LAYERS = ['Default', 'Ground', 'Water', 'Land', 'Features', 'Peaks'];
var TR = window.MMTerrain;
var LS_AUTOSAVE = 'mapmaker.html.autosave.v1', LS_PREFS = 'mapmaker.html.prefs.v1';
var MAN = window.MM_MANIFEST || { categories: [], sprites: [] };
var BGS = window.MM_BACKGROUNDS || {};

// ------------------------------------------------------------------ sprite registry
var SPR = {};            // key -> {key, cat, name, w, h, type, uri, img, ready, mask}
var CATS = {};           // name -> {name, label, count, keys[], state: 0 none / 1 loading / 2 loaded, waiters[]}
var catOrder = [];
MAN.categories.forEach(function (c) { CATS[c.name] = { name: c.name, label: c.label, prefix: c.prefix, count: c.count, keys: [], state: 0, waiters: [] }; catOrder.push(c.name); });
MAN.sprites.forEach(function (r) {
  var key = r[0], cat = key.split('/')[0];
  SPR[key] = { key: key, cat: cat, name: key.split('/')[1], w: r[1], h: r[2], type: r[3], uri: null, img: null, ready: false, fx: {} };
  if (CATS[cat]) CATS[cat].keys.push(key);
});
var listeners = [];
function onSpritesChanged(fn) { listeners.push(fn); }
function fireSprites() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

window.MM = {
  registerSprites: function (cat, data) {
    var c = CATS[cat]; var pending = 0;
    Object.keys(data).forEach(function (key) {
      var s = SPR[key]; if (!s) return;
      s.uri = data[key]; var img = new Image(); s.img = img; pending++;
      img.onload = img.onerror = function () { s.ready = img.naturalWidth > 0; if (--pending === 0) done(); };
      img.src = s.uri;
    });
    function done() { if (!c) return; c.state = 2; var w = c.waiters; c.waiters = []; w.forEach(function (f) { f(); }); fireSprites(); }
    if (pending === 0) done();
  }
};

function loadCategory(cat) {
  var c = CATS[cat];
  if (!c) return Promise.resolve();
  if (c.state === 2) return Promise.resolve();
  return new Promise(function (res) {
    c.waiters.push(res);
    if (c.state === 1) return;
    c.state = 1; showLoading(true);
    var el = document.createElement('script');
    el.src = 'assets/sprites_' + cat + '.js';
    el.onerror = function () { c.state = 2; toast('Could not load sprites for ' + cat); var w = c.waiters; c.waiters = []; w.forEach(function (f) { f(); }); };
    document.head.appendChild(el);
  }).then(function () { if (!catOrder.some(function (n) { return CATS[n].state === 1; })) showLoading(false); });
}
function loadForMap(m) {
  var need = {};
  m.stamps.forEach(function (s) { var c = (s.spriteKey || '').split('/')[0]; if (CATS[c]) need[c] = 1; });
  return Promise.all(Object.keys(need).map(loadCategory));
}

// background tiles
var BGIMG = {};
Object.keys(BGS).forEach(function (k) { var i = new Image(); i.onload = function () { invalidate(); }; i.src = BGS[k].uri; BGIMG[k] = i; });

// ------------------------------------------------------------------ map model (Unity MapDto)
function col(r, g, b, a) { return { r: r, g: g, b: b, a: a }; }
function v2(x, y) { return { x: x, y: y }; }
function defaultEffects() {
  return { shadows: true, shadowColor: col(0, 0.03, 0.08, 0.5), shadowOffset: v2(0.12, -0.18), shadowBlur: 7, shadowTypes: 29,
    feather: true, featherWidth: 6, featherTypes: 21, foam: true, foamColor: col(0.93, 0.97, 1, 0.9), foamWidth: 10, foamTypes: 5,
    foamOnlyOverBackground: true, coastCategories: 'Coast,Islands', sortMode: 0, ySortLayers: '' };
}
function newMap(wPx, hPx, bgKind) {
  var m = { version: 3, name: 'Untitled Map', nextId: 1,
    background: { mode: 'TiledSprite', color: col(0.11, 0.27, 0.42, 1), tileSpriteKey: 'Backgrounds/ocean_tile', tileSpriteGuid: '',
      size: v2((wPx || 3400) / PPU, (hPx || 1900) / PPU), center: v2(0, 0), tileScale: 1, sortingLayer: 'Default', order: -1000 },
    effects: defaultEffects(), stamps: [], terrain: null, rivers: [], riverPresets: [], plug: defaultPlug() };
  if (bgKind) setBgKind(m, bgKind);
  return m;
}
function normalizeMap(d) {
  var m = newMap();
  if (!d || typeof d !== 'object') throw new Error('Not a Map Maker JSON file.');
  m.name = d.name || 'Untitled Map';
  m.version = 2;
  var b = d.background || {};
  var mode = b.mode;
  if (mode === 0 || mode === '0') mode = 'None'; else if (mode === 1 || mode === '1') mode = 'SolidColor'; else if (mode === 2 || mode === '2') mode = 'TiledSprite';
  if (['None', 'SolidColor', 'TiledSprite'].indexOf(mode) < 0) mode = 'SolidColor';
  Object.assign(m.background, b, { mode: mode });
  m.background.size = v2(num(b.size && b.size.x, 34), num(b.size && b.size.y, 19));
  m.background.center = v2(num(b.center && b.center.x, 0), num(b.center && b.center.y, 0));
  m.background.color = Object.assign(col(0.11, 0.27, 0.42, 1), b.color || {});
  if (!(m.background.tileScale > 0)) m.background.tileScale = 1;
  m.effects = Object.assign(defaultEffects(), d.effects || {});
  if (!d.effects) { m.effects.shadows = m.effects.feather = m.effects.foam = false; }   // v1 files: effects off (as in Unity)
  var maxId = 0;
  m.stamps = (d.stamps || []).filter(function (s) { return s && typeof s === 'object'; }).map(function (s) {
    var o = { id: s.id | 0, spriteKey: s.spriteKey || '', spriteGuid: s.spriteGuid || '', position: v2(num(s.position && s.position.x, 0), num(s.position && s.position.y, 0)),
      rotation: num(s.rotation, 0), scale: v2(num(s.scale && s.scale.x, 1), num(s.scale && s.scale.y, 1)), flipX: !!s.flipX, flipY: !!s.flipY,
      sortingLayer: s.sortingLayer || 'Default', order: s.order | 0, tint: Object.assign(col(1, 1, 1, 1), s.tint || {}), type: s.type || '',
      shadow: s.shadow | 0, feather: s.feather | 0, foam: s.foam | 0, genGroup: typeof s.genGroup === 'string' ? s.genGroup : '', merge: s.merge | 0 };
    if (s.vary && typeof s.vary === 'object') o.vary = { h: num(s.vary.h, 0), s: num(s.vary.s, 0), b: num(s.vary.b, 0), w: num(s.vary.w, 0), seed: s.vary.seed | 0 };
    maxId = Math.max(maxId, o.id); return o;
  });
  var seen = {};
  m.stamps.forEach(function (s) { if (!s.id || seen[s.id]) s.id = ++maxId; seen[s.id] = 1; });
  m.nextId = Math.max(d.nextId | 0, maxId + 1);
  normalizeTerrain(m, d);
  m.plug = Object.assign(defaultPlug(), d.plug && typeof d.plug === 'object' ? d.plug : {}, d.plug ? {} : { on: true });
  return m;
}
function num(v, d) { v = +v; return isFinite(v) ? v : d; }
function bgKind(m) {
  var b = m.background;
  if (b.mode === 'None') return 'transparent';
  if (b.mode === 'SolidColor') return 'solid';
  return b.tileSpriteKey === 'Backgrounds/grass_tile' ? 'grass' : 'ocean';
}
function setBgKind(m, k) {
  var b = m.background;
  if (k === 'transparent') b.mode = 'None';
  else if (k === 'solid') b.mode = 'SolidColor';
  else { b.mode = 'TiledSprite'; b.tileSpriteKey = k === 'grass' ? 'Backgrounds/grass_tile' : 'Backgrounds/ocean_tile'; }
}
function mapW(m) { return Math.max(1, Math.round(m.background.size.x * PPU)); }
function mapH(m) { return Math.max(1, Math.round(m.background.size.y * PPU)); }
// Unity units <-> map pixels
function toPx(m, p) { var b = m.background; return { x: (p.x - b.center.x) * PPU + mapW(m) / 2, y: mapH(m) / 2 - (p.y - b.center.y) * PPU }; }
function toUnits(m, x, y) { var b = m.background; return { x: round4((x - mapW(m) / 2) / PPU + b.center.x), y: round4((mapH(m) / 2 - y) / PPU + b.center.y) }; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// ------------------------------------------------------------------ effect rules (port of MapSorting.cs)
function stampType(s) {
  var t = TYPES.indexOf(s.type);
  if (t <= 0) { var sp = SPR[s.spriteKey]; t = sp ? TYPES.indexOf(sp.type) : 3; }
  return t <= 0 ? 3 : t;
}
function typeBit(t) { return 1 << (Math.max(1, t) - 1); }
function isCoastCat(fx, s) {
  var cat = (s.spriteKey || '').split('/')[0].toLowerCase();
  return !!cat && (fx.coastCategories || '').split(',').some(function (c) { return c.trim().toLowerCase() === cat; });
}
function want(t, on, mask, s) { if (t === 1) return true; if (t === 2 || !on) return false; return (mask & typeBit(stampType(s))) !== 0; }
function wantShadow(fx, s) { return want(s.shadow, fx.shadows, fx.shadowTypes, s); }
function wantFeather(fx, s) { if (s.feather === 0 && isCoastCat(fx, s)) return false; return want(s.feather, fx.feather, fx.featherTypes, s); }
function wantFoamBase(fx, s) { if (s.foam === 0 && isCoastCat(fx, s)) return false; return want(s.foam, fx.foam, fx.foamTypes, s); }
var LAND_BITS = typeBit(1) | typeBit(3) | typeBit(5);
function layerRank(name) { var i = LAYERS.indexOf(name); return i < 0 ? 0 : i; }

// draw order: (sorting layer, [bottom y], order, list index)
function sortedStamps(m) {
  var arr = m.stamps.map(function (s, i) { return { s: s, i: i, l: layerRank(s.sortingLayer) }; });
  var ys = m.effects.sortMode === 1, ylayers = (m.effects.ySortLayers || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (ys) arr.forEach(function (a) { a.b = (ylayers.length === 0 || ylayers.indexOf(a.s.sortingLayer) >= 0) ? stampAabb(m, a.s).maxY : null; });
  arr.sort(function (a, b) {
    if (a.l !== b.l) return a.l - b.l;
    if (ys && a.b != null && b.b != null && a.b !== b.b) return a.b - b.b;
    if (a.s.order !== b.s.order) return a.s.order - b.s.order;
    return a.i - b.i;
  });
  return arr.map(function (a) { return a.s; });
}

// ------------------------------------------------------------------ geometry
function stampMatrix(m, s) {   // local (sprite px, centred, y down) -> map px
  var p = toPx(m, s.position), a = -s.rotation * Math.PI / 180, c = Math.cos(a), n = Math.sin(a);
  var sx = s.scale.x * (s.flipX ? -1 : 1), sy = s.scale.y * (s.flipY ? -1 : 1);
  return [c * sx, n * sx, -n * sy, c * sy, p.x, p.y];
}
function applyM(M, x, y) { return { x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] }; }
function invM(M, x, y) {
  var det = M[0] * M[3] - M[1] * M[2]; if (Math.abs(det) < 1e-12) return { x: 1e9, y: 1e9 };
  x -= M[4]; y -= M[5];
  return { x: (M[3] * x - M[2] * y) / det, y: (-M[1] * x + M[0] * y) / det };
}
function spriteSize(s) { var sp = SPR[s.spriteKey]; return sp ? { w: sp.w, h: sp.h } : { w: 100, h: 100 }; }
function stampCorners(m, s) {
  var M = stampMatrix(m, s), z = spriteSize(s), hw = z.w / 2, hh = z.h / 2;
  return [applyM(M, -hw, -hh), applyM(M, hw, -hh), applyM(M, hw, hh), applyM(M, -hw, hh)];
}
function stampAabb(m, s) {
  var c = stampCorners(m, s), r = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
  c.forEach(function (p) { r.minX = Math.min(r.minX, p.x); r.minY = Math.min(r.minY, p.y); r.maxX = Math.max(r.maxX, p.x); r.maxY = Math.max(r.maxY, p.y); });
  return r;
}
// alpha mask for picking / over-land tests (small, built lazily)
function mask(sp) {
  if (sp.mask || !sp.ready) return sp.mask;
  var k = Math.min(1, 96 / Math.max(sp.img.naturalWidth, sp.img.naturalHeight));
  var w = Math.max(1, Math.round(sp.img.naturalWidth * k)), h = Math.max(1, Math.round(sp.img.naturalHeight * k));
  var c = mkCanvas(w, h), x = c.getContext('2d');
  x.drawImage(sp.img, 0, 0, w, h);
  var d = x.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
  for (var i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  sp.mask = { w: w, h: h, a: a };
  return sp.mask;
}
function hitStamp(m, s, x, y, alphaMin) {
  var z = spriteSize(s), l = invM(stampMatrix(m, s), x, y);
  if (Math.abs(l.x) > z.w / 2 || Math.abs(l.y) > z.h / 2) return false;
  var sp = SPR[s.spriteKey]; if (!sp || !sp.ready) return true;
  var mk = mask(sp); if (!mk) return true;
  var u = Math.min(mk.w - 1, Math.floor((l.x / z.w + 0.5) * mk.w)), v = Math.min(mk.h - 1, Math.floor((l.y / z.h + 0.5) * mk.h));
  return mk.a[v * mk.w + u] > (alphaMin == null ? 40 : alphaMin);
}
function pickTop(m, x, y) {
  var list = sortedStamps(m);
  for (var i = list.length - 1; i >= 0; i--) if (hitStamp(m, list[i], x, y)) return list[i];
  return null;
}
function isOverLand(m, s, list) {
  var p = toPx(m, s.position), idx = list.indexOf(s);
  if (landAtPx(m, p.x, p.y)) return true;
  for (var i = 0; i < idx; i++) {
    var o = list[i]; if (o === s || !(LAND_BITS & typeBit(stampType(o)))) continue;
    if (hitStamp(m, o, p.x, p.y, 128)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ effect textures (cached per sprite)
function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
function cssColor(c, aMul) { return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + Math.max(0, Math.min(1, c.a * (aMul == null ? 1 : aMul))) + ')'; }
function silhouette(sp, color, pad) {   // canvas (img size + 2*pad) with a flat-colour copy of the sprite
  var iw = sp.img.naturalWidth, ih = sp.img.naturalHeight, c = mkCanvas(iw + pad * 2, ih + pad * 2), x = c.getContext('2d');
  x.drawImage(sp.img, pad, pad); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c;
}
function blurInto(dst, src, blurPx, passes) {   // shadowBlur trick: draws src's shadow only (src itself is drawn off-canvas)
  var x = dst.getContext('2d'), off = dst.width + src.width + 100;
  x.save(); x.shadowColor = '#000'; x.shadowBlur = Math.max(0, blurPx); x.shadowOffsetX = off;
  for (var i = 0; i < (passes || 1); i++) x.drawImage(src, -off + (dst.width - src.width) / 2, (dst.height - src.height) / 2);
  x.restore();
}
function tint(c, color) { var x = c.getContext('2d'); x.save(); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height); x.restore(); return c; }
function texScale(sp) { return sp.img.naturalWidth / sp.w; }   // embedded image px per source px (<= 1)

function shadowTex(sp, fx) {
  var key = 'sh' + fx.shadowBlur + cssColor(fx.shadowColor);
  if (sp.fx[key]) return sp.fx[key];
  var k = texScale(sp), blur = Math.max(0, fx.shadowBlur) * k, pad = Math.ceil(blur * 2 + 2);
  var sil = silhouette(sp, '#000', 0), c = mkCanvas(sil.width + pad * 2, sil.height + pad * 2);
  blurInto(c, sil, blur * 2, 1); tint(c, cssColor(fx.shadowColor, 1));
  // tint() replaced alpha-preserving colour; apply the colour's alpha
  var out = mkCanvas(c.width, c.height), ox = out.getContext('2d'); ox.globalAlpha = Math.max(0, Math.min(1, fx.shadowColor.a)); ox.drawImage(c, 0, 0);
  return (sp.fx[key] = { c: out, pad: pad / k });
}
function foamTex(sp, fx) {
  var key = 'fo' + fx.foamWidth + cssColor(fx.foamColor);
  if (sp.fx[key]) return sp.fx[key];
  var k = texScale(sp), wpx = Math.max(1, fx.foamWidth) * k, pad = Math.ceil(wpx * 2.5 + 2);
  var sil = silhouette(sp, '#000', 0), c = mkCanvas(sil.width + pad * 2, sil.height + pad * 2), x = c.getContext('2d');
  // dilate: tight blur repeated (pushes alpha outwards), then a soft outer blur
  blurInto(c, sil, wpx * 0.9, 4); blurInto(c, sil, wpx * 2.2, 2);
  // hard-ish edge: boost alpha
  var id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (var i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * 1.6);
  x.putImageData(id, 0, 0);
  tint(c, cssColor(fx.foamColor, 1));
  var out = mkCanvas(c.width, c.height), ox = out.getContext('2d'); ox.globalAlpha = Math.max(0, Math.min(1, fx.foamColor.a)); ox.drawImage(c, 0, 0);
  return (sp.fx[key] = { c: out, pad: pad / k });
}
function featherTex(sp, fx) {
  var key = 'fe' + fx.featherWidth;
  if (sp.fx[key]) return sp.fx[key];
  var k = texScale(sp), wpx = Math.max(0.5, fx.featherWidth) * k, iw = sp.img.naturalWidth, ih = sp.img.naturalHeight;
  var m = mkCanvas(iw, ih); blurInto(m, sp.img, wpx, 1);         // blurred alpha (black)
  var c = mkCanvas(iw, ih), x = c.getContext('2d');
  x.drawImage(sp.img, 0, 0);
  // feathered alpha = alpha * clamp(blurAlpha*2-0.6): interior stays 1, edges fade over ~width
  var md = m.getContext('2d').getImageData(0, 0, iw, ih).data, id = x.getImageData(0, 0, iw, ih), d = id.data;
  for (var i = 3; i < d.length; i += 4) { var f = Math.max(0, Math.min(1, md[i] / 255 * 1.8 - 0.55)); d[i] = d[i] * f; }
  x.putImageData(id, 0, 0);
  return (sp.fx[key] = { c: c, pad: 0 });
}
function clearFxCache() { Object.keys(SPR).forEach(function (k) { SPR[k].fx = {}; }); }

// ------------------------------------------------------------------ renderer (shared by editor + export)
var patCache = {};
function drawBackground(ctx, m, opts) {
  var b = m.background, W = mapW(m), H = mapH(m);
  if (opts.transparent || b.mode === 'None') return;
  if (b.mode === 'TiledSprite' && BGIMG[b.tileSpriteKey] && BGIMG[b.tileSpriteKey].complete && BGIMG[b.tileSpriteKey].naturalWidth) {
    var img = BGIMG[b.tileSpriteKey], tw = img.naturalWidth * b.tileScale, th = img.naturalHeight * b.tileScale;
    var pat = ctx.createPattern(img, 'repeat');
    // anchored at the bottom-left corner like Unity's tiled SpriteRenderer
    var oy = H - Math.ceil(H / th) * th;
    if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([b.tileScale, 0, 0, b.tileScale, 0, oy]));
    ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = cssColor(b.color); ctx.fillRect(0, 0, W, H);
  }
}
function drawTex(ctx, M, tex, z, k, dx, dy) {
  ctx.save();
  ctx.transform(M[0], M[1], M[2], M[3], M[4] + (dx || 0), M[5] + (dy || 0));
  var pw = tex.pad, w = z.w + pw * 2, h = z.h + pw * 2;
  ctx.drawImage(tex.c, -w / 2, -h / 2, w, h);
  ctx.restore();
}
/** Draws every stamp (and effects) in map-pixel space. ctx must already carry the view transform. */
function drawStamps(ctx, m, opts) {
  var list = sortedStamps(m), fx = m.effects, effects = opts.effects !== false;
  var overBg = effects && fx.foamOnlyOverBackground && m.background.mode !== 'None';
  var i = 0;
  while (i < list.length) {
    // one sorting layer at a time: foam under the layer, then shadow + stamp per stamp
    var l = layerRank(list[i].sortingLayer), j = i;
    while (j < list.length && layerRank(list[j].sortingLayer) === l) j++;
    if (effects) for (var a = i; a < j; a++) {
      var s = list[a], sp = SPR[s.spriteKey];
      if (!sp || !sp.ready || !wantFoamBase(fx, s) || plugSkipFx(m, s)) continue;
      if (s.foam === 0 && fx.foamOnlyOverBackground && isOverLand(m, s, list)) continue;
      drawTex(ctx, stampMatrix(m, s), foamTex(sp, fx), sp);
    }
    for (var b = i; b < j; b++) drawOne(ctx, m, list[b], fx, effects, opts);
    i = j;
  }
}
function drawOne(ctx, m, s, fx, effects, opts) {
  var sp = SPR[s.spriteKey], M = stampMatrix(m, s);
  if (!sp || !sp.ready) {
    if (opts.placeholders) {
      var z = spriteSize(s); ctx.save(); ctx.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.fillStyle = sp ? 'rgba(216,178,90,0.15)' : 'rgba(216,90,90,0.25)'; ctx.fillRect(-z.w / 2, -z.h / 2, z.w, z.h);
      ctx.restore();
    }
    return;
  }
  var alpha = s.tint && s.tint.a != null ? Math.max(0, Math.min(1, s.tint.a)) : 1;
  if (opts.ghost) alpha *= 0.6; else if (s._ghost) alpha *= 0.78;
  ctx.save(); ctx.globalAlpha = alpha;
  var pt = plugTex(m, s, sp), skip = pt && plugSkipFx(m, s);
  if (effects && !skip && wantShadow(fx, s)) drawTex(ctx, M, shadowTex(sp, fx), sp, 0, fx.shadowOffset.x * PPU, -fx.shadowOffset.y * PPU);
  if (pt) { drawTex(ctx, M, pt, sp); ctx.restore(); return; }
  var tex = effects && wantFeather(fx, s) ? featherTex(sp, fx) : null;
  ctx.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
  ctx.drawImage(tex ? tex.c : sp.img, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
  ctx.restore();
}

/** Full-resolution export: returns a canvas with the whole map rectangle. */
function renderExport(m, scale, transparent, effects) {
  var W = mapW(m), H = mapH(m), maxSide = 16384, maxArea = 16384 * 16384 / 2;
  scale = Math.min(scale, maxSide / Math.max(W, H), Math.sqrt(maxArea / (W * H)));
  var c = mkCanvas(Math.round(W * scale), Math.round(H * scale)), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(c.width / W, 0, 0, c.height / H, 0, 0);
  drawBackground(ctx, m, { transparent: transparent });
  drawStamps(ctx, m, { effects: effects });
  return { canvas: c, scale: scale };
}

// ================================================================== editor
var $ = function (id) { return document.getElementById(id); };
var canvas = $('view'), vctx = canvas.getContext('2d');
var map = newMap();
var sel = [];                       // selected stamp ids
var tool = 'place';
var brush = { key: null, rotation: 0, scale: 1, flipX: false, flipY: false, layer: 'Default' };
var scatter = { radius: 140, density: 3, spacing: 0.6, minDist: 45, rotRand: 180, scaleMin: 0.8, scaleMax: 1.2, flipX: true, flipY: false, source: 'current' };
var eraser = { radius: 60 };
var prefs = { grid: false, snap: false, gridSize: 50, thumb: 76, names: false, favs: [], recent: [], tab: 'All', previewFx: true, shuffle: false, rotStep: 15 };
var view = { zoom: 0.25, panX: 0, panY: 0 };
var undoStack = [], redoStack = [];
var mouse = { sx: -1, sy: -1, x: 0, y: 0, inside: false };
var drag = null;                    // active pointer interaction
var spaceDown = false, dirty = false, hoverId = 0;

try { Object.assign(prefs, JSON.parse(localStorage.getItem(LS_PREFS) || '{}')); } catch (e) { }
function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); } catch (e) { } }

function byId(id) { for (var i = 0; i < map.stamps.length; i++) if (map.stamps[i].id === id) return map.stamps[i]; return null; }
function selStamps() { return sel.map(byId).filter(Boolean); }
function setSel(ids) { sel = ids.slice(); renderSel(); invalidate(); if (tool === 'gen') schedulePreview(); }
function invalidate() { if (!dirty) { dirty = true; requestAnimationFrame(frame); } }

// ---- undo / autosave
function snap() { return JSON.stringify(map, jsonReplacer); }
function checkpoint() { undoStack.push(snap()); if (undoStack.length > 150) undoStack.shift(); redoStack = []; updateUndoButtons(); }
function dropCheckpoint() { undoStack.pop(); updateUndoButtons(); }
function restore(json) { map = normalizeMap(JSON.parse(json)); sel = sel.filter(byId); afterMapChange(true); }
function undo() { if (!undoStack.length) return; endDrag(); redoStack.push(snap()); restore(undoStack.pop()); toast('Undo'); }
function redo() { if (!redoStack.length) return; endDrag(); undoStack.push(snap()); restore(redoStack.pop()); toast('Redo'); }
function updateUndoButtons() { $('btnUndo').disabled = !undoStack.length; $('btnRedo').disabled = !redoStack.length; }
var saveTimer = 0;
function changed() { if (map && map.plug) ensurePlugTerrain(); invalidate(); clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 400); updateStatus(); }
function autosave() {
  try { localStorage.setItem(LS_AUTOSAVE, snap()); $('stSaved').textContent = 'Autosaved ' + new Date().toLocaleTimeString(); }
  catch (e) { $('stSaved').textContent = 'Autosave failed (storage full?)'; }
}
function afterMapChange(keepView) {
  loadForMap(map).then(invalidate);
  renderSel(); renderMapCard(); renderFxCard(); changed(); updateUndoButtons();
  if (!keepView) fit();
  if (tool === 'gen') { gen.preview = null; schedulePreview(); renderBrushCard(); }
}

// ---- view
function resize() {
  var r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  invalidate();
}
function fit() {
  var r = canvas.getBoundingClientRect(), W = mapW(map), H = mapH(map);
  view.zoom = Math.max(0.02, Math.min((r.width - 60) / W, (r.height - 60) / H));
  view.panX = (r.width - W * view.zoom) / 2; view.panY = (r.height - H * view.zoom) / 2;
  updateZoom(); invalidate();
}
function zoomAt(f, sx, sy) {
  var z = Math.max(0.02, Math.min(8, view.zoom * f)); f = z / view.zoom;
  view.panX = sx - (sx - view.panX) * f; view.panY = sy - (sy - view.panY) * f; view.zoom = z;
  updateZoom(); invalidate();
}
function zoomCenter(f) { var r = canvas.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
function updateZoom() { $('btnZoomPct').textContent = Math.round(view.zoom * 100) + '%'; }
function toWorld(sx, sy) { return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom }; }
function toScreen(x, y) { return { x: x * view.zoom + view.panX, y: y * view.zoom + view.panY }; }
function snapPt(p, force) {
  if (!(prefs.snap || force)) return p;
  var g = Math.max(1, prefs.gridSize); return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// ---- stamp ops
function layerMaxOrder(layer) { var mx = -1; map.stamps.forEach(function (s) { if (s.sortingLayer === layer) mx = Math.max(mx, s.order); }); return mx; }
function addStamp(key, px, py, rot, sc, fx, fy, layer) {
  var sp = SPR[key];
  var s = { id: map.nextId++, spriteKey: key, spriteGuid: '', position: toUnits(map, px, py), rotation: round4(rot), scale: v2(round4(sc), round4(sc)),
    flipX: !!fx, flipY: !!fy, sortingLayer: layer || 'Default', order: layerMaxOrder(layer || 'Default') + 1, tint: col(1, 1, 1, 1),
    type: sp ? sp.type : '', shadow: 0, feather: 0, foam: 0 };
  applyVariation(s, true);
  map.stamps.push(s); return s;
}
function setPx(s, x, y) { s.position = toUnits(map, x, y); }
function deleteSel() {
  if (!sel.length) return; checkpoint();
  var ids = {}; sel.forEach(function (i) { ids[i] = 1; });
  map.stamps = map.stamps.filter(function (s) { return !ids[s.id]; });
  toast('Deleted ' + sel.length); setSel([]); changed();
}
function duplicateSel() {
  var list = selStamps(); if (!list.length) return; checkpoint();
  var off = prefs.snap ? prefs.gridSize : 30, ids = [];
  sortedStamps(map).filter(function (s) { return list.indexOf(s) >= 0; }).forEach(function (s) {
    var c = JSON.parse(JSON.stringify(s)); c.id = map.nextId++;
    var p = toPx(map, s.position); setPx(c, p.x + off, p.y + off);
    c.order = layerMaxOrder(c.sortingLayer) + 1; map.stamps.push(c); ids.push(c.id);
  });
  setSel(ids); changed(); toast('Duplicated ' + ids.length);
}
function groupCenter(list) {
  var r = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
  list.forEach(function (s) { var p = toPx(map, s.position); r.minX = Math.min(r.minX, p.x); r.maxX = Math.max(r.maxX, p.x); r.minY = Math.min(r.minY, p.y); r.maxY = Math.max(r.maxY, p.y); });
  return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
}
function rotateSel(deg) {   // deg: Unity (CCW positive)
  var list = selStamps(); if (!list.length) return; checkpoint();
  var c = groupCenter(list), a = -deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  list.forEach(function (s) {
    var p = toPx(map, s.position), dx = p.x - c.x, dy = p.y - c.y;
    if (list.length > 1) setPx(s, c.x + dx * co - dy * si, c.y + dx * si + dy * co);
    s.rotation = round4(normDeg(s.rotation + deg));
  });
  renderSel(); changed();
}
function scaleSel(f) {
  var list = selStamps(); if (!list.length) return; checkpoint();
  var c = groupCenter(list);
  list.forEach(function (s) {
    var p = toPx(map, s.position);
    if (list.length > 1) setPx(s, c.x + (p.x - c.x) * f, c.y + (p.y - c.y) * f);
    s.scale = v2(round4(clampScale(s.scale.x * f)), round4(clampScale(s.scale.y * f)));
  });
  renderSel(); changed();
}
function flipSel(axis) {
  var list = selStamps(); if (!list.length) return; checkpoint();
  var c = groupCenter(list);
  list.forEach(function (s) {
    var p = toPx(map, s.position);
    if (axis === 'x') { s.flipX = !s.flipX; if (list.length > 1) { setPx(s, 2 * c.x - p.x, p.y); s.rotation = round4(normDeg(-s.rotation)); } }
    else { s.flipY = !s.flipY; if (list.length > 1) { setPx(s, p.x, 2 * c.y - p.y); s.rotation = round4(normDeg(-s.rotation)); } }
  });
  renderSel(); changed();
}
function nudgeSel(dx, dy) {
  var list = selStamps(); if (!list.length) return; checkpoint();
  list.forEach(function (s) { var p = toPx(map, s.position); setPx(s, p.x + dx, p.y + dy); });
  renderSel(); changed();
}
function orderSel(mode) {   // 'front' | 'back' | 'up' | 'down'
  var list = selStamps(); if (!list.length) return; checkpoint();
  var all = sortedStamps(map);
  var layers = {}; list.forEach(function (s) { layers[s.sortingLayer] = 1; });
  Object.keys(layers).forEach(function (L) {
    var inL = all.filter(function (s) { return s.sortingLayer === L; });
    var mine = inL.filter(function (s) { return list.indexOf(s) >= 0; }), rest = inL.filter(function (s) { return list.indexOf(s) < 0; });
    var res;
    if (mode === 'front') res = rest.concat(mine);
    else if (mode === 'back') res = mine.concat(rest);
    else {
      res = inL.slice();
      if (mode === 'up') { for (var i = res.length - 2; i >= 0; i--) if (list.indexOf(res[i]) >= 0 && list.indexOf(res[i + 1]) < 0) { var t = res[i]; res[i] = res[i + 1]; res[i + 1] = t; } }
      else { for (var k = 1; k < res.length; k++) if (list.indexOf(res[k]) >= 0 && list.indexOf(res[k - 1]) < 0) { var u = res[k]; res[k] = res[k - 1]; res[k - 1] = u; } }
    }
    res.forEach(function (s, n) { s.order = n; });   // compact orders 0..n-1 within the layer
  });
  if (map.effects.sortMode === 1) toast('Sort by Y is on: order only breaks ties');
  renderSel(); changed();
}
function normDeg(d) { d = d % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }
function clampScale(v) { return Math.max(0.05, Math.min(20, v)); }

// ---- brush helpers
function pickBrush(key, keepTool) {
  if (!SPR[key]) return;
  brush.key = key; loadCategory(SPR[key].cat).then(invalidate);
  prefs.recent = [key].concat(prefs.recent.filter(function (k) { return k !== key; })).slice(0, 30); savePrefs();
  if (!keepTool && tool !== 'scatter') setTool('place');
  markPaletteSelection(); renderBrushCard(); invalidate();
}
function randomFrom(list) { return list.length ? list[Math.floor(Math.random() * list.length)] : null; }
function shuffleBrush() { if (!brush.key) return; var c = CATS[SPR[brush.key].cat]; var k = randomFrom(c.keys); if (k) { brush.key = k; markPaletteSelection(); renderBrushCard(); } }
function scatterSource() {
  if (scatter.source === 'favs') return prefs.favs.filter(function (k) { return SPR[k]; });
  if (scatter.source === 'tab') return visibleKeys();
  return brush.key ? [brush.key] : [];
}

// ---- tools
function setTool(t) {
  endDrag(); if (tool === 'gen' && t !== 'gen') { gen.preview = null; clearTimeout(gen.timer); }
  if (tool === 'river' && t !== 'river') finishRiver();
  tool = t;
  if (t === 'land' && !map.terrain) { checkpoint(); ensureTerrain(); changed(); }
  Array.prototype.forEach.call(document.querySelectorAll('.tool'), function (b) { b.classList.toggle('on', b.dataset.tool === t); });
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
  renderBrushCard(); updateStatus(); invalidate();
  if (t === 'gen') refreshPreview();
}
function selFrame() {   // {pts:[4 corners], c, up:{x,y}} in map px
  var list = selStamps(); if (!list.length) return null;
  var pts;
  if (list.length === 1) pts = stampCorners(map, list[0]);
  else {
    var r = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
    list.forEach(function (s) { var a = stampAabb(map, s); r.minX = Math.min(r.minX, a.minX); r.minY = Math.min(r.minY, a.minY); r.maxX = Math.max(r.maxX, a.maxX); r.maxY = Math.max(r.maxY, a.maxY); });
    pts = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
  }
  var c = { x: (pts[0].x + pts[2].x) / 2, y: (pts[0].y + pts[2].y) / 2 };
  var top = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  var ux = top.x - c.x, uy = top.y - c.y, ul = Math.hypot(ux, uy) || 1;
  var rotH = { x: top.x + ux / ul * 30 / view.zoom, y: top.y + uy / ul * 30 / view.zoom };
  return { pts: pts, c: c, top: top, rot: rotH };
}
function handleAt(sx, sy) {
  var f = selFrame(); if (!f) return null;
  var r = toScreen(f.rot.x, f.rot.y); if (Math.hypot(sx - r.x, sy - r.y) < 10) return { kind: 'rotate', f: f };
  for (var i = 0; i < 4; i++) { var p = toScreen(f.pts[i].x, f.pts[i].y); if (Math.abs(sx - p.x) < 8 && Math.abs(sy - p.y) < 8) return { kind: 'scale', f: f }; }
  return null;
}
function captureSel() { return selStamps().map(function (s) { return { s: s, p: toPx(map, s.position), rot: s.rotation, sc: v2(s.scale.x, s.scale.y) }; }); }

function canvasPos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
canvas.addEventListener('pointerdown', function (e) {
  canvas.focus();
  var sp = canvasPos(e), w = toWorld(sp.x, sp.y);
  if (drag) endDrag();
  if (e.button === 1 || (e.button === 0 && spaceDown) || e.button === 2) {
    drag = { kind: 'pan', sx: sp.x, sy: sp.y, px: view.panX, py: view.panY }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; e.preventDefault(); return;
  }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  var add = e.shiftKey || e.ctrlKey || e.metaKey;
  if (tool === 'land') { landDown(e, w); return; }
  if (tool === 'river') { riverDown(e, w, sp); return; }
  if (tool === 'select') {
    var h = handleAt(sp.x, sp.y);
    if (h) { checkpoint(); drag = { kind: h.kind, c: h.f.c, start: w, items: captureSel(), changed: false }; return; }
    var hit = pickTop(map, w.x, w.y);
    if (hit) {
      if (add) { var i = sel.indexOf(hit.id); if (i >= 0) { sel.splice(i, 1); setSel(sel); return; } setSel(sel.concat([hit.id])); }
      else if (sel.indexOf(hit.id) < 0) setSel([hit.id]);
      checkpoint(); drag = { kind: 'move', start: w, anchor: toPx(map, hit.position), items: captureSel(), changed: false, alt: e.altKey };
    } else {
      drag = { kind: 'box', start: w, cur: w, add: add, base: add ? sel.slice() : [] };
      if (!add) setSel([]);
    }
  } else if (tool === 'place') {
    if (!brush.key) { toast('Pick a sprite in the palette first'); return; }
    var p = snapPt(w); checkpoint();
    var s = addStamp(brush.key, p.x, p.y, brush.rotation, brush.scale, brush.flipX, brush.flipY, brush.layer);
    if (prefs.shuffle) shuffleBrush();
    prefs.recent = [s.spriteKey].concat(prefs.recent.filter(function (k) { return k !== s.spriteKey; })).slice(0, 30);
    setSel([s.id]); changed();
    drag = { kind: 'placed' };
  } else if (tool === 'scatter') {
    if (!scatterSource().length) { toast(scatter.source === 'favs' ? 'No favourites yet (click ☆ on thumbnails)' : 'Pick a sprite in the palette first'); return; }
    checkpoint(); drag = { kind: 'scatter', last: w, dist: 0, added: 0 };
    drag.added += dab(w); changed();
  } else if (tool === 'gen') {
    if (gen.mode === 'fill') { drag = { kind: 'lasso', pts: [w] }; return; }
    var gh = pickTop(map, w.x, w.y);
    if (gh) { var gi = sel.indexOf(gh.id); if (gi >= 0) sel.splice(gi, 1); else sel.push(gh.id); setSel(sel); drag = { kind: 'placed' }; }
    else drag = { kind: 'box', start: w, cur: w, add: add, base: add ? sel.slice() : [] };
  } else if (tool === 'erase') {
    checkpoint(); drag = { kind: 'erase', removed: 0 };
    drag.removed += eraseAt(w); changed();
  }
});
canvas.addEventListener('pointermove', function (e) {
  var sp = canvasPos(e), w = toWorld(sp.x, sp.y);
  mouse.sx = sp.x; mouse.sy = sp.y; mouse.x = w.x; mouse.y = w.y; mouse.inside = true;
  updatePos();
  if (!drag) {
    if (tool === 'select') {
      var h = handleAt(sp.x, sp.y);
      canvas.style.cursor = spaceDown ? 'grab' : h ? (h.kind === 'rotate' ? 'alias' : 'nwse-resize') : 'default';
      var hit = h ? null : pickTop(map, w.x, w.y), id = hit ? hit.id : 0;
      if (id !== hoverId) { hoverId = id; invalidate(); }
      if (hit && !h) canvas.style.cursor = 'move';
    } else invalidate();
    return;
  }
  var d = drag;
  if (d.kind === 'land' || d.kind === 'landrect') { landMove(w); return; }
  if (d.kind === 'rvpt') { riverMove(w); return; }
  if (d.kind === 'pan') { view.panX = d.px + sp.x - d.sx; view.panY = d.py + sp.y - d.sy; invalidate(); return; }
  if (d.kind === 'move') {
    var dx = w.x - d.start.x, dy = w.y - d.start.y;
    if (prefs.snap !== e.ctrlKey) { var a = snapPt({ x: d.anchor.x + dx, y: d.anchor.y + dy }, true); dx = a.x - d.anchor.x; dy = a.y - d.anchor.y; }
    d.items.forEach(function (it) { setPx(it.s, it.p.x + dx, it.p.y + dy); });
    d.alt = e.altKey; fitDuringDrag(d);
    d.changed = d.changed || Math.abs(dx) + Math.abs(dy) > 0.5; invalidate(); return;
  }
  if (d.kind === 'rotate') {
    var a0 = Math.atan2(d.start.y - d.c.y, d.start.x - d.c.x), a1 = Math.atan2(w.y - d.c.y, w.x - d.c.x);
    var deg = (a1 - a0) * 180 / Math.PI;                     // screen clockwise
    if (e.shiftKey || prefs.snap) deg = Math.round(deg / prefs.rotStep) * prefs.rotStep;
    var r = deg * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    d.items.forEach(function (it) {
      var ox = it.p.x - d.c.x, oy = it.p.y - d.c.y;
      setPx(it.s, d.c.x + ox * co - oy * si, d.c.y + ox * si + oy * co);
      it.s.rotation = round4(normDeg(it.rot - deg));
    });
    d.changed = true; d.deg = deg; invalidate(); return;
  }
  if (d.kind === 'scale') {
    var l0 = Math.hypot(d.start.x - d.c.x, d.start.y - d.c.y) || 1, f = Math.hypot(w.x - d.c.x, w.y - d.c.y) / l0;
    if (e.shiftKey) f = Math.round(f * 10) / 10;
    f = Math.max(0.05, f);
    d.items.forEach(function (it) {
      setPx(it.s, d.c.x + (it.p.x - d.c.x) * f, d.c.y + (it.p.y - d.c.y) * f);
      it.s.scale = v2(round4(clampScale(it.sc.x * f)), round4(clampScale(it.sc.y * f)));
    });
    d.changed = true; invalidate(); return;
  }
  if (d.kind === 'box') { d.cur = w; invalidate(); return; }
  if (d.kind === 'lasso') { var lp = d.pts[d.pts.length - 1]; if (Math.hypot(w.x - lp.x, w.y - lp.y) > 5 / view.zoom) d.pts.push(w); invalidate(); return; }
  if (d.kind === 'scatter') {
    var step = Math.max(4, scatter.radius * scatter.spacing);
    d.dist += Math.hypot(w.x - d.last.x, w.y - d.last.y); d.last = w;
    if (d.dist >= step) { d.dist = 0; d.added += dab(w); changed(); }
    invalidate(); return;
  }
  if (d.kind === 'erase') { var n = eraseAt(w); if (n) { d.removed += n; changed(); } invalidate(); }
});
canvas.addEventListener('pointerup', function (e) { if (drag) finishDrag(e); });
canvas.addEventListener('pointercancel', function () { endDrag(); });
canvas.addEventListener('lostpointercapture', function () { if (drag && drag.kind !== 'placed') endDrag(); });
canvas.addEventListener('pointerleave', function () { mouse.inside = false; hoverId = 0; invalidate(); });
canvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  var sp = canvasPos(e);
  if (e.ctrlKey && Math.abs(e.deltaY) < 50) zoomAt(Math.exp(-e.deltaY * 0.01), sp.x, sp.y);     // pinch
  else zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, sp.x, sp.y);
}, { passive: false });

function finishDrag(e) {
  var d = drag; drag = null;
  if (!d) return;
  if (d.kind === 'land' || d.kind === 'landrect') { landFinish(d); return; }
  if (d.kind === 'rvpt') { riverFinish(d); return; }
  if (d.kind === 'pan') { canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; return; }
  if (d.kind === 'box') {
    var x0 = Math.min(d.start.x, d.cur.x), x1 = Math.max(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y), y1 = Math.max(d.start.y, d.cur.y);
    var ids = d.base.slice();
    if (x1 - x0 > 2 / view.zoom || y1 - y0 > 2 / view.zoom)
      map.stamps.forEach(function (s) { var p = toPx(map, s.position); if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && ids.indexOf(s.id) < 0) ids.push(s.id); });
    setSel(ids); invalidate(); return;
  }
  if (d.kind === 'lasso') {
    var lp2 = simplify(d.pts, 6 / view.zoom);
    if (lp2.length >= 3) { gen.region = lp2; renderBrushCard(); refreshPreview(); } else invalidate();
    return;
  }
  if (d.kind === 'move' && d.changed && d.fit && !d.alt) { var fs = d.items[0].s, fp = toPx(map, fs.position); setPx(fs, fp.x + d.fit.dx, fp.y + d.fit.dy); toast('Snapped to the neighbouring coastline (hold Alt to place freely)'); }
  if (d.kind === 'move' || d.kind === 'rotate' || d.kind === 'scale') { if (!d.changed) dropCheckpoint(); else changed(); renderSel(); return; }
  if (d.kind === 'scatter') { if (!d.added) dropCheckpoint(); else toast('Scattered ' + d.added); renderSel(); return; }
  if (d.kind === 'erase') { if (!d.removed) dropCheckpoint(); else toast('Erased ' + d.removed); return; }
}
function endDrag() {   // abort-safe: keeps what was done (still one undo step)
  if (!drag) return;
  finishDrag();
}

function dab(w) {
  var src = scatterSource(); if (!src.length) return 0;
  var added = 0, R = scatter.radius;
  for (var n = 0; n < scatter.density; n++) {
    var ok = false, px, py;
    for (var t = 0; t < 8 && !ok; t++) {
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R;
      px = w.x + Math.cos(a) * r; py = w.y + Math.sin(a) * r;
      if (prefs.snap) { var q = snapPt({ x: px, y: py }); px = q.x; py = q.y; }
      ok = true;
      if (scatter.minDist > 0) for (var i = 0; i < map.stamps.length; i++) {
        var s = map.stamps[i]; if (scatter.source === 'current' && src.indexOf(s.spriteKey) < 0 && false) continue;
        var p = toPx(map, s.position);
        if (src.indexOf(s.spriteKey) >= 0 && Math.hypot(p.x - px, p.y - py) < scatter.minDist) { ok = false; break; }
      }
    }
    if (!ok) continue;
    var key = randomFrom(src);
    var rot = brush.rotation + (Math.random() * 2 - 1) * scatter.rotRand;
    var lo = Math.min(scatter.scaleMin, scatter.scaleMax), hi = Math.max(scatter.scaleMin, scatter.scaleMax);
    var sc = brush.scale * (lo + Math.random() * (hi - lo));
    addStamp(key, px, py, normDeg(rot), sc, scatter.flipX ? Math.random() < 0.5 : brush.flipX, scatter.flipY ? Math.random() < 0.5 : brush.flipY, brush.layer);
    added++;
  }
  return added;
}
function eraseTargets(w) {
  var R = eraser.radius;
  return map.stamps.filter(function (s) { var p = toPx(map, s.position); return Math.hypot(p.x - w.x, p.y - w.y) <= R || hitStamp(map, s, w.x, w.y); });
}
function eraseAt(w) {
  var t = eraseTargets(w); if (!t.length) return 0;
  map.stamps = map.stamps.filter(function (s) { return t.indexOf(s) < 0; });
  var gone = t.map(function (s) { return s.id; }); sel = sel.filter(function (i) { return gone.indexOf(i) < 0; }); renderSel();
  return t.length;
}

// ---- keyboard
function typing(e) { var t = e.target; return t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); }
window.addEventListener('keydown', function (e) {
  if (document.querySelector('.modal:not(.hidden)')) { if (e.key === 'Escape') closeModals(); return; }
  if (typing(e)) return;
  var k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === ' ') { spaceDown = true; if (!drag) canvas.style.cursor = 'grab'; e.preventDefault(); return; }
  if (ctrl) {
    var lk = k.toLowerCase();
    if (lk === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
    else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { redo(); e.preventDefault(); }
    else if (lk === 'd') { duplicateSel(); e.preventDefault(); }
    else if (lk === 'a') { setTool('select'); setSel(map.stamps.map(function (s) { return s.id; })); e.preventDefault(); }
    else if (lk === 's') { saveJson(); e.preventDefault(); }
    return;
  }
  if (e.altKey) return;
  var hasSel = tool === 'select' && sel.length > 0, handled = true;
  switch (k) {
    case 's': case 'S': if (!e.shiftKey) setTool('select'); else handled = false; break;
    case 'p': case 'P': setTool('place'); break;
    case 'b': case 'B': setTool('scatter'); break;
    case 'd': case 'D': setTool('erase'); break;
    case 'k': case 'K': setTool('gen'); break;
    case 'l': case 'L': setTool('land'); break;
    case 'v': case 'V': setTool('river'); break;
    case 'Enter': if (tool === 'gen') applyGen(); else if (tool === 'river') finishRiver(); else handled = false; break;
    case 'Escape': if (tool === 'river' && rv.drawing) finishRiver(); else if (tool === 'river' && rv.id) { rv.id = 0; rv.pt = -1; renderBrushCard(); invalidate(); } else if (tool === 'gen' && (gen.preview || gen.region)) cancelGen(); else if (tool !== 'select') setTool('select'); else setSel([]); break;
    case 'Delete': case 'Backspace': if (tool === 'river') deleteRiverPoint(); else deleteSel(); break;
    case '[': case ']': {
      var up = k === ']';
      if (tool === 'river') { riverWidthStep(up ? 1.15 : 1 / 1.15); break; }
      if (tool === 'land') { land.size = Math.max(1, Math.min(24, land.size + (up ? 1 : -1))); saveLand(); renderBrushCard(); invalidate(); break; }
      if (hasSel) scaleSel(up ? 1.1 : 1 / 1.1);
      else if (tool === 'scatter' && e.shiftKey) scatter.density = Math.max(1, Math.min(30, scatter.density + (up ? 1 : -1)));
      else if (tool === 'scatter') scatter.radius = Math.max(10, Math.min(2000, Math.round(scatter.radius * (up ? 1.15 : 1 / 1.15))));
      else if (tool === 'erase') eraser.radius = Math.max(5, Math.min(2000, Math.round(eraser.radius * (up ? 1.15 : 1 / 1.15))));
      else brush.scale = round4(clampScale(brush.scale * (up ? 1.1 : 1 / 1.1)));
      if (!hasSel) renderBrushCard(); invalidate(); break;
    }
    case '{': case '}': if (tool === 'scatter') { scatter.density = Math.max(1, Math.min(30, scatter.density + (k === '}' ? 1 : -1))); renderBrushCard(); } break;
    case ',': case '.': case '<': case '>': {
      var deg = (k === ',' || k === '<' ? 1 : -1) * prefs.rotStep;   // ',' = counter-clockwise
      if (hasSel) rotateSel(deg); else { brush.rotation = normDeg(brush.rotation + deg); renderBrushCard(); invalidate(); }
      break;
    }
    case 'm': case 'M':
      if (hasSel) flipSel(e.shiftKey ? 'y' : 'x');
      else { if (e.shiftKey) brush.flipY = !brush.flipY; else brush.flipX = !brush.flipX; renderBrushCard(); invalidate(); }
      break;
    case 'g': case 'G': toggleSnap(); break;
    case 'f': case 'F': fit(); break;
    case 't': case 'T': if (sel.length) fitSelected(); break;
    case 'r': case 'R': randomPick(); break;
    case '+': case '=': zoomCenter(1.25); break;
    case '-': case '_': zoomCenter(0.8); break;
    case '0': view.zoom = 1; zoomCenter(1); break;
    case '?': openHelp(); break;
    case 'PageUp': orderSel(e.shiftKey ? 'front' : 'up'); break;
    case 'PageDown': orderSel(e.shiftKey ? 'back' : 'down'); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      if (!sel.length) { handled = false; break; }
      var st = e.shiftKey ? 10 : (prefs.snap ? prefs.gridSize : 1);
      nudgeSel(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0); break;
    }
    default: handled = false;
  }
  if (handled) e.preventDefault();
});
window.addEventListener('keyup', function (e) { if (e.key === ' ') { spaceDown = false; if (!drag) canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; } });
window.addEventListener('blur', function () { spaceDown = false; endDrag(); });

// ================================================================== drawing (editor view)
var checkerPat = null;
function frame() {
  dirty = false;
  var dpr = window.devicePixelRatio || 1, ctx = vctx, W = mapW(map), H = mapH(map), z = view.zoom;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.panX, dpr * view.panY);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = z < 0.5 ? 'medium' : 'high';
  // map sheet with drop shadow
  ctx.save(); ctx.shadowColor = '#000c'; ctx.shadowBlur = 30 * dpr; ctx.fillStyle = '#15120e'; ctx.fillRect(0, 0, W, H); ctx.restore();
  if (map.background.mode === 'None') {
    if (!checkerPat) { var cc = mkCanvas(40, 40), cx = cc.getContext('2d'); cx.fillStyle = '#2a2620'; cx.fillRect(0, 0, 40, 40); cx.fillStyle = '#1f1c17'; cx.fillRect(0, 0, 20, 20); cx.fillRect(20, 20, 20, 20); checkerPat = ctx.createPattern(cc, 'repeat'); }
    ctx.fillStyle = checkerPat; ctx.fillRect(0, 0, W, H);
  } else if (!hasTerrain(map)) drawBackground(ctx, map, {});
  drawTerrainLayer(ctx);
  drawStamps(ctx, tool === 'gen' && gen.preview ? Object.assign({}, map, { stamps: map.stamps.concat(gen.preview.stamps) }) : map, { effects: prefs.previewFx, placeholders: true });
  // dim everything outside the export rectangle
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(dpr * view.panX, dpr * view.panY, dpr * W * z, dpr * H * z); ctx.fillStyle = 'rgba(16,13,10,0.62)'; ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(216,178,90,0.75)'; ctx.lineWidth = 1.5 * dpr; ctx.strokeRect(dpr * view.panX, dpr * view.panY, dpr * W * z, dpr * H * z);
  ctx.restore();
  var px = 1 / z;   // one CSS pixel in map units
  if (prefs.grid) {
    var g = Math.max(1, prefs.gridSize); while (g * z < 7) g *= 2;
    ctx.save(); ctx.beginPath(); ctx.strokeStyle = 'rgba(255,240,200,0.16)'; ctx.lineWidth = px;
    for (var gx = 0; gx <= W; gx += g) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
    for (var gy = 0; gy <= H; gy += g) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke(); ctx.restore();
  }
  // hover + selection outlines
  if (tool === 'select' && hoverId && sel.indexOf(hoverId) < 0 && !drag) { var hs = byId(hoverId); if (hs) poly(ctx, stampCorners(map, hs), 'rgba(255,240,200,0.55)', px, []); }
  var list = selStamps();
  list.forEach(function (s) { poly(ctx, stampCorners(map, s), 'rgba(240,210,130,0.9)', px * 1.2, [5 * px, 4 * px]); });
  if (tool === 'select' && list.length) {
    var f = selFrame();
    if (list.length > 1) poly(ctx, f.pts, 'rgba(240,210,130,0.6)', px, []);
    ctx.save(); ctx.strokeStyle = 'rgba(240,210,130,0.9)'; ctx.lineWidth = px; ctx.beginPath(); ctx.moveTo(f.top.x, f.top.y); ctx.lineTo(f.rot.x, f.rot.y); ctx.stroke(); ctx.restore();
    f.pts.forEach(function (p) { handle(ctx, p, px, false); });
    handle(ctx, f.rot, px, true);
  }
  drawGenOverlay(ctx, px);
  drawLandOverlay(ctx, px); drawRiverOverlay(ctx, px); drawFitOverlay(ctx, px);
  if (drag && drag.kind === 'box') {
    ctx.save(); ctx.fillStyle = 'rgba(216,178,90,0.12)'; ctx.strokeStyle = 'rgba(240,210,130,0.9)'; ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]);
    var bx = Math.min(drag.start.x, drag.cur.x), by = Math.min(drag.start.y, drag.cur.y), bw = Math.abs(drag.cur.x - drag.start.x), bh = Math.abs(drag.cur.y - drag.start.y);
    ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh); ctx.restore();
  }
  if (mouse.inside && !(drag && drag.kind === 'pan') && !spaceDown) {
    var m = { x: mouse.x, y: mouse.y };
    if (tool === 'place' && brush.key) {
      var p = snapPt(m), ghost = { id: -1, spriteKey: brush.key, position: toUnits(map, p.x, p.y), rotation: brush.rotation, scale: v2(brush.scale, brush.scale), flipX: brush.flipX, flipY: brush.flipY, tint: col(1, 1, 1, 1), sortingLayer: brush.layer, order: 0, type: '', shadow: 2, feather: 2, foam: 2 };
      drawOne(ctx, map, ghost, map.effects, false, { ghost: true, placeholders: true });
      poly(ctx, stampCorners(map, ghost), 'rgba(240,210,130,0.5)', px, [4 * px, 4 * px]);
    } else if (tool === 'scatter') circle(ctx, m, scatter.radius, 'rgba(240,210,130,0.9)', 'rgba(216,178,90,0.08)', px);
    else if (tool === 'erase') {
      eraseTargets(m).forEach(function (s) { poly(ctx, stampCorners(map, s), 'rgba(255,90,70,0.95)', px * 1.5, []); });
      circle(ctx, m, eraser.radius, 'rgba(255,110,90,0.95)', 'rgba(255,80,60,0.10)', px);
    }
  }
}
function poly(ctx, pts, color, lw, dash) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash || []);
  ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); ctx.stroke(); ctx.restore();
}
function handle(ctx, p, px, round) {
  ctx.save(); ctx.fillStyle = round ? '#f3dc97' : '#1d1912'; ctx.strokeStyle = '#f3dc97'; ctx.lineWidth = 1.5 * px;
  ctx.beginPath(); if (round) ctx.arc(p.x, p.y, 6 * px, 0, Math.PI * 2); else ctx.rect(p.x - 5 * px, p.y - 5 * px, 10 * px, 10 * px);
  ctx.fill(); ctx.stroke(); ctx.restore();
}
function circle(ctx, c, r, stroke, fill, px) {
  ctx.save(); ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(c.x, c.y, 2 * px, 0, Math.PI * 2); ctx.fillStyle = stroke; ctx.fill(); ctx.restore();
}

// ================================================================== status bar / toast
function updateStatus() {
  var names = { select: 'Select', place: 'Place', scatter: 'Scatter', erase: 'Erase', gen: 'Smart Fill', land: 'Land squares', river: 'River' };
  $('stTool').textContent = names[tool];
  $('stCount').textContent = map.stamps.length + ' stickers' + (map.rivers.length ? ' · ' + map.rivers.length + ' rivers' : '') + (hasTerrain(map) ? ' · ' + map.terrain.cols + '×' + map.terrain.rows + ' squares' : '');
  $('stSel').textContent = sel.length ? sel.length + ' selected' : '';
  var hints = { select: 'Click / drag-box to select · Shift adds · drag to move · corner = scale · knob = rotate (Shift: 15°)',
    place: 'Click to stamp · [ ] scale · , . rotate · M flip · Space-drag pans',
    scatter: 'Drag to paint · [ ] radius · Shift+[ ] density',
    erase: 'Drag over stamps to erase · [ ] radius',
    gen: 'Connect / Grow: click or box-select anchor stickers · Fill: drag a lasso · Enter applies · Esc cancels',
    land: 'Paint squares · Alt-drag erases · [ ] brush size · Smart Fill buttons in the panel',
    river: 'Click to add points · Enter / double-click finishes · drag points · Shift+click inserts · Ctrl+click branches · [ ] width · Del' };
  $('stHint').textContent = hints[tool];
}
function updatePos() { var u = toUnits(map, mouse.x, mouse.y); $('stPos').textContent = Math.round(mouse.x) + ', ' + Math.round(mouse.y) + ' px  (' + u.x.toFixed(2) + ', ' + u.y.toFixed(2) + ' u)'; }
var toastTimer = 0;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 1600); }
function showLoading(on) { $('loading').classList.toggle('hidden', !on); }

// ================================================================== small DOM builders
function el(tag, attrs, kids) {
  var e = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  });
  (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
var session = false;
function edit() { if (!session) { checkpoint(); session = true; } }   // first live change in a control = one undo step
function endEdit() { session = false; changed(); }
/** label + range + number box. get() / set(v) */
function slider(label, min, max, step, get, set, opts) {
  opts = opts || {};
  var r = el('input', { type: 'range', min: min, max: max, step: step }), n = el('input', { type: 'number', class: 'num', min: opts.nmin != null ? opts.nmin : min, max: opts.nmax != null ? opts.nmax : max, step: step });
  r.value = n.value = fmtNum(get());
  function apply(v, live) { v = +v; if (!isFinite(v)) return; if (!opts.noUndo) edit(); set(v); if (live) invalidate(); }
  r.addEventListener('input', function () { n.value = r.value; if (!opts.lazy) apply(r.value, true); });
  r.addEventListener('change', function () { apply(r.value, true); if (opts.after) opts.after(); endEdit(); });
  n.addEventListener('change', function () { r.value = n.value; apply(n.value, true); if (opts.after) opts.after(); endEdit(); });
  return el('div', { class: 'f' }, [el('label', { text: label, title: opts.title }), r, n]);
}
function fmtNum(v) { return Math.round(v * 1000) / 1000; }
function check(label, get, set, title) {
  var c = el('input', { type: 'checkbox' }); c.checked = !!get();
  c.addEventListener('change', function () { edit(); set(c.checked); endEdit(); });
  return el('label', { class: 'chk', title: title }, [c, ' ' + label]);
}
function seg(options, get, set) {   // options: [[value,label],...]
  var d = el('div', { class: 'seg' });
  options.forEach(function (o) {
    var b = el('button', { text: o[1], title: o[2] || o[1] }); if (get() === o[0]) b.classList.add('on');
    b.addEventListener('click', function () { set(o[0]); Array.prototype.forEach.call(d.children, function (x) { x.classList.remove('on'); }); b.classList.add('on'); });
    d.appendChild(b);
  });
  return d;
}
function row(label, ctrl, extra) { return el('div', { class: extra ? 'f' : 'f wide' }, [el('label', { text: label }), ctrl, extra]); }
function colorInput(get, set) {
  var c = get(), i = el('input', { type: 'color' });
  i.value = '#' + [c.r, c.g, c.b].map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2); }).join('');
  i.addEventListener('input', function () { edit(); var h = i.value; set({ r: parseInt(h.substr(1, 2), 16) / 255, g: parseInt(h.substr(3, 2), 16) / 255, b: parseInt(h.substr(5, 2), 16) / 255 }); clearFxCache(); invalidate(); });
  i.addEventListener('change', endEdit);
  return i;
}
function thumbEl(key, size) {
  var d = el('div', { class: 'th' }); if (size) d.style.width = d.style.height = size + 'px';
  var sp = SPR[key];
  if (sp && sp.uri) d.appendChild(el('img', { src: sp.uri, alt: '' })); else d.appendChild(el('div', { class: 'ph' }));
  return d;
}

// ================================================================== right panel
function renderSel() {
  updateStatus();
  var b = $('selBody'); b.innerHTML = '';
  var list = selStamps();
  if (!list.length) { b.appendChild(el('div', { class: 'hint', html: 'Nothing selected. Use <b>Select (S)</b> and click a stamp, drag a box, or press <b>Ctrl+A</b>.' })); return; }
  var s = list[0], multi = list.length > 1;
  var head = el('div', { class: 'selhead' }, [thumbEl(s.spriteKey, 56), el('div', {}, [
    el('div', { class: 'k', text: multi ? list.length + ' stamps' : s.spriteKey }),
    el('span', { class: 'badge', text: multi ? 'multi-edit: values from first' : TYPES[stampType(s)] + ' · #' + s.id })])]);
  b.appendChild(head);
  function all(fn) { list.forEach(fn); }
  if (!multi) {
    var p = toPx(map, s.position);
    b.appendChild(slider('X (px)', 0, mapW(map), 1, function () { return Math.round(p.x); }, function (v) { setPx(s, v, toPx(map, s.position).y); }, { nmin: -100000, nmax: 100000 }));
    b.appendChild(slider('Y (px)', 0, mapH(map), 1, function () { return Math.round(p.y); }, function (v) { setPx(s, toPx(map, s.position).x, v); }, { nmin: -100000, nmax: 100000 }));
  }
  b.appendChild(slider('Rotation°', -180, 180, 1, function () { return s.rotation; }, function (v) { all(function (t) { t.rotation = normDeg(v); }); }, { title: 'Degrees, counter-clockwise (Unity convention)' }));
  b.appendChild(slider('Scale', 0.1, 4, 0.01, function () { return s.scale.x; }, function (v) { all(function (t) { var k = t.scale.y / (t.scale.x || 1); t.scale = v2(round4(v), round4(v * k)); }); }, { nmin: 0.05, nmax: 20 }));
  b.appendChild(slider('Opacity', 0, 1, 0.01, function () { return s.tint.a; }, function (v) { all(function (t) { t.tint.a = v; }); }));
  b.appendChild(row('Flip', el('div', { class: 'btnrow', style: 'margin:0' }, [
    el('button', { class: 'mini' + (s.flipX ? ' on' : ''), text: '⇋ X', title: 'Flip horizontally (M)', onclick: function () { flipSel('x'); } }),
    el('button', { class: 'mini' + (s.flipY ? ' on' : ''), text: '⇵ Y', title: 'Flip vertically (Shift+M)', onclick: function () { flipSel('y'); } })])));
  var ls = el('select', {}, LAYERS.map(function (L) { return el('option', { value: L, text: L }); })); ls.value = LAYERS.indexOf(s.sortingLayer) >= 0 ? s.sortingLayer : 'Default';
  ls.addEventListener('change', function () { checkpoint(); all(function (t) { t.sortingLayer = ls.value; t.order = layerMaxOrder(ls.value) + 1; }); changed(); renderSel(); });
  b.appendChild(row('Layer', ls));
  b.appendChild(row('Order', el('div', { class: 'btnrow', style: 'margin:0' }, [
    el('button', { class: 'mini', text: '⤓', title: 'Send to back (Shift+PgDn)', onclick: function () { orderSel('back'); } }),
    el('button', { class: 'mini', text: '↓', title: 'Backward (PgDn)', onclick: function () { orderSel('down'); } }),
    el('button', { class: 'mini', text: '↑', title: 'Forward (PgUp)', onclick: function () { orderSel('up'); } }),
    el('button', { class: 'mini', text: '⤒', title: 'Bring to front (Shift+PgUp)', onclick: function () { orderSel('front'); } })]),
    multi ? null : el('span', { class: 'muted', text: '' + s.order })));
  var ts = el('select', {}, TYPES.map(function (t, i) { return el('option', { value: i ? t : '', text: i ? t : 'Auto (' + (SPR[s.spriteKey] ? SPR[s.spriteKey].type : 'Land') + ')' }); }));
  ts.value = s.type || ''; ts.addEventListener('change', function () { checkpoint(); all(function (t) { t.type = ts.value; }); changed(); });
  b.appendChild(row('Type', ts));
  [['Shadow', 'shadow'], ['Foam', 'foam'], ['Feather', 'feather']].forEach(function (f) {
    b.appendChild(row(f[0], seg([[0, 'Auto'], [1, 'On'], [2, 'Off']], function () { return s[f[1]]; }, function (v) { checkpoint(); all(function (t) { t[f[1]] = v; }); changed(); })));
  });
  plugSelRows(b, list, s, multi);
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini', text: '🎲 Re-roll', title: 'New random colour / warp variation', onclick: rerollVariation }),
    el('button', { class: 'mini', text: '⟲ Fit to neighbours (T)', title: 'Rotate / flip / nudge so the coastline lines up with neighbouring land', onclick: fitSelected }),
    el('button', { class: 'mini finish', text: '✦ Auto-fill selected', onclick: autoFill })]));
  if (!multi && SPR[s.spriteKey]) {
    var mt = metaOf(s.spriteKey), ti = el('input', { type: 'text', class: 'num', style: 'width:100%', title: 'Smart Fill tags for this sprite (space separated): land water coast ridge river peak forest feature …' });
    ti.value = (mt.tags || []).join(' ');
    ti.addEventListener('change', function () { prefs.metaOv = prefs.metaOv || {}; var tg = ti.value.trim().toLowerCase().split(/[\s,]+/).filter(Boolean); prefs.metaOv[s.spriteKey] = { tags: tg }; savePrefs(); catalogCache = null; toast('Smart Fill tags saved for ' + s.spriteKey); });
    b.appendChild(row('Fill tags', ti));
    if (s.genGroup) b.appendChild(el('div', { class: 'hint', text: 'Generated by Smart Fill · group ' + s.genGroup }));
  }
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini', text: '⧉ Duplicate', title: 'Ctrl+D', onclick: duplicateSel }),
    el('button', { class: 'mini', text: 'Use as brush', onclick: function () { pickBrush(s.spriteKey, true); brush.rotation = s.rotation; brush.scale = s.scale.x; brush.flipX = s.flipX; brush.flipY = s.flipY; brush.layer = s.sortingLayer; renderBrushCard(); } }),
    el('button', { class: 'mini danger', text: '✕ Delete', title: 'Delete', onclick: deleteSel })]));
}
function renderBrushCard() {
  var b = $('brushBody'); b.innerHTML = '';
  var titles = { select: 'Select tool', place: 'Sticker brush', scatter: 'Scatter brush', erase: 'Eraser', gen: 'Smart Fill (stickers)', land: 'Land squares', river: 'River maker' };
  $('brushTitle').textContent = titles[tool];
  if (tool === 'gen') { renderGenCard(b); return; }
  if (tool === 'land') { renderLandCard(b); return; }
  if (tool === 'river') { renderRiverCard(b); return; }
  if (tool === 'select') {
    b.appendChild(el('div', { class: 'hint', html: 'Drag stamps to move (Ctrl toggles snap). Corner squares scale, the round knob rotates — hold <b>Shift</b> to snap. <b>[ ]</b> scale, <b>, .</b> rotate, <b>M</b> flip, arrows nudge.' }));
    b.appendChild(slider('Rotate step', 1, 90, 1, function () { return prefs.rotStep; }, function (v) { prefs.rotStep = v; savePrefs(); }, { noUndo: true }));
    return;
  }
  if (tool === 'erase') {
    b.appendChild(slider('Radius', 5, 600, 1, function () { return eraser.radius; }, function (v) { eraser.radius = v; }, { noUndo: true, nmax: 4000 }));
    b.appendChild(el('div', { class: 'hint', text: 'Stamps whose pivot is inside the circle, or whose pixels are under the cursor, are highlighted red and removed.' }));
    return;
  }
  var sp = brush.key && SPR[brush.key];
  b.appendChild(el('div', { class: 'selhead' }, [thumbEl(brush.key, 56), el('div', {}, [el('div', { class: 'k', text: sp ? brush.key : 'No sprite — pick one in the palette' }), sp ? el('span', { class: 'badge', text: sp.type + ' · ' + sp.w + '×' + sp.h + ' px' }) : null])]));
  if (tool === 'scatter') {
    b.appendChild(row('Source', seg([['current', 'Sprite', 'Only the current sprite'], ['tab', 'Tab', 'Random sprites from the current palette tab/search'], ['favs', '★ Favs', 'Random favourites']], function () { return scatter.source; }, function (v) { scatter.source = v; })));
    b.appendChild(slider('Radius', 10, 800, 1, function () { return scatter.radius; }, function (v) { scatter.radius = v; }, { noUndo: true, nmax: 4000 }));
    b.appendChild(slider('Density', 1, 20, 1, function () { return scatter.density; }, function (v) { scatter.density = Math.round(v); }, { noUndo: true, title: 'Stamps attempted per dab' }));
    b.appendChild(slider('Spacing', 0.1, 2, 0.05, function () { return scatter.spacing; }, function (v) { scatter.spacing = v; }, { noUndo: true, title: 'Distance between dabs, × radius' }));
    b.appendChild(slider('Min dist', 0, 400, 1, function () { return scatter.minDist; }, function (v) { scatter.minDist = v; }, { noUndo: true, title: 'Minimum px between scattered stamps of the source set' }));
    b.appendChild(slider('Rand rot ±', 0, 180, 1, function () { return scatter.rotRand; }, function (v) { scatter.rotRand = v; }, { noUndo: true }));
    b.appendChild(slider('Scale min', 0.1, 3, 0.01, function () { return scatter.scaleMin; }, function (v) { scatter.scaleMin = v; }, { noUndo: true }));
    b.appendChild(slider('Scale max', 0.1, 3, 0.01, function () { return scatter.scaleMax; }, function (v) { scatter.scaleMax = v; }, { noUndo: true }));
    b.appendChild(row('Rand flip', el('div', { class: 'row' }, [
      check('X', function () { return scatter.flipX; }, function (v) { scatter.flipX = v; }), check('Y', function () { return scatter.flipY; }, function (v) { scatter.flipY = v; })])));
  }
  b.appendChild(slider(tool === 'scatter' ? 'Base rot°' : 'Rotation°', -180, 180, 1, function () { return brush.rotation; }, function (v) { brush.rotation = v; }, { noUndo: true }));
  b.appendChild(slider(tool === 'scatter' ? 'Base scale' : 'Scale', 0.1, 4, 0.01, function () { return brush.scale; }, function (v) { brush.scale = v; }, { noUndo: true, nmin: 0.05, nmax: 20 }));
  if (tool === 'place') b.appendChild(row('Flip', el('div', { class: 'btnrow', style: 'margin:0' }, [
    el('button', { class: 'mini' + (brush.flipX ? ' on' : ''), text: '⇋ X', onclick: function () { brush.flipX = !brush.flipX; renderBrushCard(); invalidate(); } }),
    el('button', { class: 'mini' + (brush.flipY ? ' on' : ''), text: '⇵ Y', onclick: function () { brush.flipY = !brush.flipY; renderBrushCard(); invalidate(); } })])));
  var ls = el('select', {}, LAYERS.map(function (L) { return el('option', { value: L, text: L }); })); ls.value = brush.layer;
  ls.addEventListener('change', function () { brush.layer = ls.value; });
  b.appendChild(row('Layer', ls));
}
var PRESETS = [['3400x1900', '3400 × 1900 (Unity default)'], ['1920x1080', '1920 × 1080 HD'], ['2560x1440', '2560 × 1440 QHD'], ['3840x2160', '3840 × 2160 4K'],
  ['2048x2048', '2048 × 2048 square'], ['4096x4096', '4096 × 4096 square'], ['2480x3508', '2480 × 3508 A4 portrait'], ['1080x1920', '1080 × 1920 portrait']];
function renderMapCard() {
  var b = $('mapBody'); b.innerHTML = '';
  var nm = el('input', { type: 'text', class: 'num', style: 'width:100%' }); nm.value = map.name;
  nm.addEventListener('change', function () { checkpoint(); map.name = nm.value || 'Untitled Map'; changed(); });
  b.appendChild(row('Name', nm));
  var W = mapW(map), H = mapH(map), cur = W + 'x' + H;
  var ps = el('select', {}, [el('option', { value: '', text: 'Custom…' })].concat(PRESETS.map(function (p) { return el('option', { value: p[0], text: p[1] }); })));
  ps.value = PRESETS.some(function (p) { return p[0] === cur; }) ? cur : '';
  var wi = el('input', { type: 'number', class: 'num', min: 64, max: 16384, step: 10, style: 'width:58px' }), hi = el('input', { type: 'number', class: 'num', min: 64, max: 16384, step: 10, style: 'width:58px' });
  wi.value = W; hi.value = H;
  function resizeTo(w, h) {
    w = Math.max(64, Math.min(16384, Math.round(w))); h = Math.max(64, Math.min(16384, Math.round(h)));
    if (w === mapW(map) && h === mapH(map)) return;
    checkpoint(); var ow = mapW(map), oh = mapH(map); map.background.size = v2(w / PPU, h / PPU);
    if (map.terrain) { var cpx = cellPxOf(map.terrain); fitTerrain(map, map.terrain, Math.round((w - ow) / 2 / cpx), Math.round((h - oh) / 2 / cpx)); }
    changed(); renderMapCard(); fit(); toast('Map is now ' + w + ' × ' + h + ' px');
  }
  ps.addEventListener('change', function () { if (ps.value) { var a = ps.value.split('x'); resizeTo(+a[0], +a[1]); } });
  b.appendChild(row('Size', ps));
  b.appendChild(el('div', { class: 'f wide' }, [el('label', { text: 'W × H px' }), el('div', { class: 'row', style: 'gap:3px' }, [wi, '×', hi,
    el('button', { class: 'mini', text: 'Apply', onclick: function () { resizeTo(+wi.value, +hi.value); } })])]));
  b.appendChild(el('div', { class: 'hint', text: '= ' + map.background.size.x + ' × ' + map.background.size.y + ' Unity units (100 px per unit). Stickers, rivers and land keep their world positions; the frame grows around the centre.' }));
  var k = bgKind(map);
  b.appendChild(row('Background', seg([['ocean', 'Ocean'], ['grass', 'Grass'], ['solid', 'Solid'], ['transparent', 'None', 'Transparent']], function () { return k; },
    function (v) { checkpoint(); setBgKind(map, v); changed(); renderMapCard(); })));
  if (k === 'solid') b.appendChild(row('Colour', colorInput(function () { return map.background.color; }, function (c) { Object.assign(map.background.color, c); })));
  b.appendChild(check('Embed my imported sprites in saved JSON', function () { return prefs.embedCustom; }, function (v) { prefs.embedCustom = v; savePrefs(); undoStack.pop(); updateUndoButtons(); }, 'Saved JSON carries PNG copies of the imported sprites it uses, so it opens on another computer (and in Unity)'));
  renderLandGridSection(b);
  if (k === 'ocean' || k === 'grass') b.appendChild(slider('Tile scale', 0.25, 4, 0.05, function () { return map.background.tileScale; }, function (v) { map.background.tileScale = Math.max(0.05, v); }));
}
function renderFxCard() {
  renderPlugCard();
  var b = $('fxBody'), fx = map.effects; b.innerHTML = '';
  var after = function () { clearFxCache(); invalidate(); };
  b.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' }, [
    check('Preview in editor', function () { return prefs.previewFx; }, function (v) { prefs.previewFx = v; savePrefs(); undoStack.pop(); updateUndoButtons(); }, 'Draw shadows / foam / feather while editing (export always uses the map settings)'),
    check('Sort by Y', function () { return fx.sortMode === 1; }, function (v) { fx.sortMode = v ? 1 : 0; }, 'Lower stamps draw in front (within a sorting layer)')]));
  function grp(title, key, kids) {
    var box = el('div', { class: 'sub' }, kids);
    var hd = check(title, function () { return fx[key]; }, function (v) { fx[key] = v; box.style.opacity = v ? 1 : 0.45; });
    box.style.opacity = fx[key] ? 1 : 0.45;
    b.appendChild(el('div', { style: 'margin-top:6px;font-weight:600' }, [hd])); b.appendChild(box);
  }
  grp('Drop shadows', 'shadows', [
    slider('Opacity', 0, 1, 0.01, function () { return fx.shadowColor.a; }, function (v) { fx.shadowColor.a = v; }, { lazy: true, after: after }),
    slider('Blur px', 0, 40, 0.5, function () { return fx.shadowBlur; }, function (v) { fx.shadowBlur = v; }, { lazy: true, after: after }),
    slider('Offset X', -1, 1, 0.01, function () { return fx.shadowOffset.x; }, function (v) { fx.shadowOffset.x = v; }, { title: 'Unity units (1 = 100 px)' }),
    slider('Offset Y', -1, 1, 0.01, function () { return fx.shadowOffset.y; }, function (v) { fx.shadowOffset.y = v; }, { title: 'Unity units, +y is up' }),
    row('Colour', colorInput(function () { return fx.shadowColor; }, function (c) { Object.assign(fx.shadowColor, c); })),
    typeMask('Types', 'shadowTypes')]);
  grp('Shore foam', 'foam', [
    slider('Width px', 1, 40, 0.5, function () { return fx.foamWidth; }, function (v) { fx.foamWidth = v; }, { lazy: true, after: after }),
    slider('Opacity', 0, 1, 0.01, function () { return fx.foamColor.a; }, function (v) { fx.foamColor.a = v; }, { lazy: true, after: after }),
    row('Colour', colorInput(function () { return fx.foamColor; }, function (c) { Object.assign(fx.foamColor, c); })),
    check('Only over open water', function () { return fx.foamOnlyOverBackground; }, function (v) { fx.foamOnlyOverBackground = v; }, 'Auto stamps skip foam when their pivot sits on land'),
    typeMask('Types', 'foamTypes')]);
  grp('Edge feather', 'feather', [
    slider('Width px', 0.5, 40, 0.5, function () { return fx.featherWidth; }, function (v) { fx.featherWidth = v; }, { lazy: true, after: after }),
    typeMask('Types', 'featherTypes')]);
  var cc = el('input', { type: 'text', class: 'num', style: 'width:100%', title: 'Biome folders treated as coastline art: Auto foam/feather is skipped for them' }); cc.value = fx.coastCategories;
  cc.addEventListener('change', function () { checkpoint(); fx.coastCategories = cc.value; changed(); });
  b.appendChild(row('Coast cats', cc));
  function typeMask(label, key) {
    var d = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' });
    TYPES.slice(1).forEach(function (t, i) { d.appendChild(check(t, function () { return fx[key] & (1 << i); }, function (v) { fx[key] = v ? fx[key] | (1 << i) : fx[key] & ~(1 << i); })); });
    return el('div', { class: 'f wide' }, [el('label', { text: label }), d]);
  }
}

// ================================================================== palette
var thumbObserver = null;
function allKeys() { var a = []; catOrder.forEach(function (c) { a = a.concat(CATS[c].keys); }); return a; }
function visibleKeys() {
  var q = $('search').value.trim().toLowerCase(), keys;
  if (prefs.tab === '★') keys = prefs.favs.filter(function (k) { return SPR[k]; });
  else if (prefs.tab === 'Recent') keys = prefs.recent.filter(function (k) { return SPR[k]; });
  else if (prefs.tab === 'All') keys = allKeys();
  else if (prefs.tab === 'Mine') keys = customKeys();
  else keys = CATS[prefs.tab] ? CATS[prefs.tab].keys.slice() : [];
  if (q) { var terms = q.split(/\s+/); keys = keys.filter(function (k) { var s = SPR[k], hay = (k + ' ' + (CATS[s.cat] ? CATS[s.cat].label : '') + ' ' + s.type).toLowerCase(); return terms.every(function (t) { return hay.indexOf(t) >= 0; }); }); }
  return keys;
}
function renderTabs() {
  var t = $('tabs'); t.innerHTML = '';
  var q = $('search').value.trim();
  function count(name) { var save = prefs.tab; prefs.tab = name; var n = visibleKeys().length; prefs.tab = save; return n; }
  [['All', 'All'], ['★', '★ Favs'], ['Recent', 'Recent'], ['Mine', 'My Sprites']].concat(catOrder.map(function (c) { return [c, CATS[c].label]; })).forEach(function (x) {
    var n = count(x[0]);
    if (q && !n && x[0] !== prefs.tab) return;
    var b = el('button', { class: 'tab' + (prefs.tab === x[0] ? ' on' : ''), title: x[1] }, [x[1], el('span', { class: 'c', text: '' + n })]);
    b.addEventListener('click', function () { prefs.tab = x[0]; savePrefs(); renderTabs(); renderPalette(); $('palette').scrollTop = 0; });
    t.appendChild(b);
  });
}
function renderPalette() {
  var p = $('palette'); p.innerHTML = '';
  var keys = visibleKeys();
  var total = Object.keys(SPR).length; $('palCount').textContent = '(' + keys.length + (keys.length !== total ? ' / ' + total : '') + ')';
  if (!keys.length) { p.appendChild(el('div', { class: 'empty', text: prefs.tab === '★' ? 'No favourites yet — hover a thumbnail and click ☆.' : prefs.tab === 'Recent' ? 'Sprites you use will appear here.' : prefs.tab === 'Mine' ? 'No imported sprites yet — click ⇪ Import below, or drop PNG / WebP sprites or a JPG/PNG sprite sheet on white anywhere on the page.' : 'No sprites match.' })); return; }
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function (ents) {
    ents.forEach(function (e) { if (e.isIntersecting) { var s = SPR[e.target.dataset.key]; if (s && CATS[s.cat] && CATS[s.cat].state === 0) loadCategory(s.cat); } });
  }, { root: p, rootMargin: '200px' }) : null;
  var groups = [], grouped = prefs.tab === 'All' || prefs.tab === 'Mine';
  if (prefs.tab === 'Mine') p.appendChild(el('div', { class: 'btnrow' }, [el('button', { class: 'mini', text: '⇪ Import more', onclick: function () { $('fileImport').click(); } }),
    el('button', { class: 'mini danger', text: 'Delete all my sprites', onclick: function () { if (confirm('Delete all ' + keys.length + ' imported sprites from this browser?')) deleteCustom(customKeys()).then(function () { toast('Deleted imported sprites'); }); } })]));
  if (grouped) catOrder.forEach(function (c) { var g = keys.filter(function (k) { return SPR[k].cat === c; }); if (g.length) groups.push([CATS[c].label, g]); });
  else groups.push([null, keys]);
  var size = prefs.thumb;
  groups.forEach(function (g) {
    if (g[0]) p.appendChild(el('div', { class: 'grp', text: g[0] + ' · ' + g[1].length }));
    var grid = el('div', { class: 'grid' }); grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + size + 'px,1fr))';
    g[1].forEach(function (k) {
      var s = SPR[k], fav = prefs.favs.indexOf(k) >= 0;
      var d = el('div', { class: 'th' + (k === brush.key ? ' on' : ''), title: k + '  (' + s.type + ', ' + s.w + '×' + s.h + ')', 'data-key': k });
      if (s.uri) d.appendChild(el('img', { src: s.uri, alt: '', draggable: 'false' })); else d.appendChild(el('div', { class: 'ph' }));
      if (prefs.names) d.appendChild(el('div', { class: 'nm', text: s.name }));
      var st = el('span', { class: 'star' + (fav ? ' fav' : ''), text: fav ? '★' : '☆', title: 'Favourite' });
      st.addEventListener('click', function (e) { e.stopPropagation(); toggleFav(k); st.classList.toggle('fav', prefs.favs.indexOf(k) >= 0); st.textContent = prefs.favs.indexOf(k) >= 0 ? '★' : '☆'; renderTabs(); if (prefs.tab === '★') renderPalette(); });
      d.appendChild(st);
      d.addEventListener('click', function () { pickBrush(k); });
      grid.appendChild(d);
      if (thumbObserver && !s.uri) thumbObserver.observe(d);
    });
    p.appendChild(grid);
  });
  if (!thumbObserver) keys.forEach(function (k) { loadCategory(SPR[k].cat); });
}
function fillThumbs() {   // sprites arrived: swap placeholders for images
  Array.prototype.forEach.call(document.querySelectorAll('#palette .th[data-key]'), function (d) {
    var ph = d.querySelector('.ph'), s = SPR[d.dataset.key];
    if (ph && s && s.uri) { d.replaceChild(el('img', { src: s.uri, alt: '', draggable: 'false' }), ph); if (thumbObserver) thumbObserver.unobserve(d); }
  });
  var bh = document.querySelector('#brushBody .selhead .th .ph'); if (bh) renderBrushCard();
  var sh = document.querySelector('#selBody .selhead .th .ph'); if (sh) renderSel();
}
function markPaletteSelection() { Array.prototype.forEach.call(document.querySelectorAll('#palette .th[data-key]'), function (d) { d.classList.toggle('on', d.dataset.key === brush.key); }); }
function toggleFav(k) { var i = prefs.favs.indexOf(k); if (i >= 0) prefs.favs.splice(i, 1); else prefs.favs.push(k); savePrefs(); }
function randomPick() { var k = randomFrom(visibleKeys()); if (k) { pickBrush(k); var d = document.querySelector('#palette .th[data-key="' + k.replace(/"/g, '') + '"]'); if (d) d.scrollIntoView({ block: 'nearest' }); } }
onSpritesChanged(function () { fillThumbs(); invalidate(); });

// ================================================================== files
function download(blob, name) {
  var url = URL.createObjectURL(blob), a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}
function stampName() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
function safeName(n) { return (n || 'map').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'map'; }
function saveJson() {
  var out = map, emb = prefs.embedCustom ? embedList(map) : [];
  if (emb.length) out = Object.assign({}, map, { customSprites: emb });
  download(new Blob([JSON.stringify(out, jsonReplacer, 2)], { type: 'application/json' }), safeName(map.name) + '.json'); toast('Saved ' + safeName(map.name) + '.json'); }
function openJsonText(text, label) {
  var m;
  var raw;
  try { raw = JSON.parse(text); m = normalizeMap(raw); } catch (e) { toast('Could not open: ' + e.message); return; }
  if (raw.customSprites && raw.customSprites.length) importEmbedded(raw.customSprites).then(function (n) { if (n) toast('Added ' + n + ' embedded sprites to My Sprites'); });
  checkpoint(); map = m; sel = []; afterMapChange(false);
  var embedded = {}; (raw.customSprites || []).forEach(function (r) { if (r && r.key) embedded[r.key] = 1; });
  var missing = m.stamps.filter(function (s) { return !SPR[s.spriteKey] && !embedded[s.spriteKey]; }).length;
  toast('Opened ' + (label || m.name) + ' · ' + m.stamps.length + ' stamps' + (missing ? ' (' + missing + ' unknown sprites shown red)' : ''));
}
$('fileOpen').addEventListener('change', function () {
  var f = this.files[0]; if (!f) return; var r = new FileReader();
  r.onload = function () { openJsonText(r.result, f.name); }; r.readAsText(f); this.value = '';
});
// drag & drop JSON onto the window
window.addEventListener('dragover', function (e) { e.preventDefault(); });
window.addEventListener('drop', function (e) { e.preventDefault(); var fl = e.dataTransfer.files, f = fl[0];
  var imgs = Array.prototype.filter.call(fl, function (x) { return /image\//.test(x.type) || /\.(png|webp|jpe?g)$/i.test(x.name); });
  if (imgs.length) { importFiles(imgs); return; }
  if (f && /json/i.test(f.type + f.name)) { var r = new FileReader(); r.onload = function () { openJsonText(r.result, f.name); }; r.readAsText(f); } });

// ================================================================== export
var exportBlob = null, exportUrl = null, exportToken = 0;
function openExport() { endDrag(); $('modal').classList.remove('hidden'); renderPreview(); }
function renderPreview() {
  var token = ++exportToken;
  $('exDownload').disabled = true; $('exBusy').classList.remove('hidden'); $('exBusy').textContent = 'Loading sprites…'; $('exInfo').textContent = '';
  loadForMap(map).then(function () {
    if (token !== exportToken) return;
    $('exBusy').textContent = 'Rendering…';
    setTimeout(function () {
      if (token !== exportToken) return;
      var t0 = performance.now();
      if (hasTerrain(map) || riverInputs(map).length) $('exBusy').textContent = 'Rendering land & rivers… 0%';
      renderExportFull(map, +$('exScale').value, $('exTransparent').checked, $('exEffects').checked,
        function (f) { if (token === exportToken) $('exBusy').textContent = 'Rendering land & rivers… ' + Math.round(f * 100) + '%'; },
        function () { return token !== exportToken; }).then(function (r) {
      if (token !== exportToken) return;
      $('exBusy').textContent = 'Encoding PNG…';
      r.canvas.toBlob(function (blob) {
        if (token !== exportToken) return;
        if (!blob) { $('exBusy').textContent = 'Export failed (canvas too large?)'; return; }
        if (exportUrl) URL.revokeObjectURL(exportUrl);
        exportBlob = blob; exportUrl = URL.createObjectURL(blob);
        $('exPreview').src = exportUrl; $('exBusy').classList.add('hidden'); $('exDownload').disabled = false;
        var missing = map.stamps.filter(function (s) { var sp = SPR[s.spriteKey]; return !sp || !sp.ready; }).length;
        $('exInfo').textContent = r.canvas.width + ' × ' + r.canvas.height + ' px · ' + (blob.size / 1048576).toFixed(2) + ' MB PNG · ' + map.stamps.length + ' stickers · rendered in ' + Math.round(performance.now() - t0) + ' ms' +
          (r.scale < +$('exScale').value ? ' · scale capped to ' + r.scale.toFixed(2) + '× (browser canvas limit)' : '') + (missing ? ' · ' + missing + ' missing sprites skipped' : '') +
          (hasTerrain(map) ? ' · ' + map.terrain.cols + '×' + map.terrain.rows + ' land squares' : '') + (map.rivers.length ? ' · ' + map.rivers.length + ' rivers' : '');
      }, 'image/png');
      }, function (e) { if (token === exportToken && e && e.message !== 'cancelled') $('exBusy').textContent = 'Render failed: ' + e.message; });
    }, 30);
  });
}
['exScale', 'exTransparent', 'exEffects'].forEach(function (id) { $(id).addEventListener('change', renderPreview); });
$('exRender').addEventListener('click', renderPreview);
$('exDownload').addEventListener('click', function () { if (!exportBlob) return; var n = 'map-' + stampName() + '.png'; download(exportBlob, n); toast('Downloaded ' + n); });
function closeModals() { $('modal').classList.add('hidden'); $('help').classList.add('hidden'); $('importModal').classList.add('hidden'); exportToken++; }
Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.addEventListener('click', closeModals); });
Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) { m.addEventListener('mousedown', function (e) { if (e.target === m) closeModals(); }); });

var KEYS = [['S / P / B / D / K', 'Select · Place sticker · Scatter brush · Eraser · Smart Fill (stickers)'], ['L', 'Land squares: paint / rect / fill / island · Alt-drag erases · [ ] size'], ['V', 'River maker: click points · Enter finishes · Shift+click inserts · Ctrl+click branches · [ ] width · Del'], ['Enter · Esc', 'Smart Fill: apply · cancel the preview'], ['Drop images', 'Import PNG/WebP sprites or a sprite sheet on white'], ['Click', 'Place stamp (Place) / select (Select)'], ['Drag', 'Move selection · box-select on empty space'],
  ['Shift / Ctrl + click', 'Add / remove from selection'], ['Corner / knob', 'Scale / rotate selection (Shift snaps)'], ['Ctrl+Z · Ctrl+Y', 'Undo · Redo (also Ctrl+Shift+Z)'],
  ['Delete', 'Delete selection'], ['Ctrl+D', 'Duplicate selection'], ['Ctrl+A', 'Select all'], ['[ ]', 'Scale selection / brush · brush radius'], ['Shift+[ ]', 'Scatter density'],
  [', .', 'Rotate selection / brush (CCW / CW)'], ['M · Shift+M', 'Flip X · Flip Y'], ['Arrows', 'Nudge 1 px (Shift: 10 px, snap: grid)'], ['PgUp / PgDn', 'Order forward / backward (Shift: front / back)'],
  ['G', 'Toggle snap'], ['F · 0', 'Fit · 100% zoom'], ['Wheel · + −', 'Zoom'], ['Space-drag · middle/right drag', 'Pan'], ['R', 'Random sprite from current tab'], ['Esc', 'Select tool / clear selection'], ['Ctrl+S', 'Save JSON'], ['?', 'This help']];
function openHelp() {
  var t = el('table', { class: 'keys' }, KEYS.map(function (k) { return el('tr', {}, [el('td', {}, [el('kbd', { text: k[0] })]), el('td', { text: k[1] })]); }));
  var h = $('helpBody'); h.innerHTML = ''; h.appendChild(t);
  h.appendChild(el('p', { class: 'hint', html: 'Maps autosave in this browser. <b>Save JSON</b> writes Unity MapJson v3 (stickers + land grid + rivers) (open it in Unity with the Map Maker window). 100 px = 1 Unity unit, y up in Unity. <b>Finish &amp; Download PNG</b> renders the full map at full resolution.' }));
  $('help').classList.remove('hidden');
}

// ================================================================== sprite metadata (smart fill) — mirrors tools/sprite_meta.py
var META = window.MM_META || {};
var CLS = ['dark', 'snow', 'rock', 'water', 'lava', 'toxic', 'forest', 'marsh', 'green', 'sand', 'earth', 'other'];
function metaOf(key) {
  var sp = SPR[key]; if (!sp) return null;
  if (!sp.meta) {
    var r = META[key];
    sp.meta = r ? { angle: r[0], major: r[1], minor: r[2], coverage: r[3], size: r[4], tags: r[5], colors: r[6] }
      : { angle: 0, major: Math.max(sp.w, sp.h), minor: Math.min(sp.w, sp.h), coverage: 0.7, size: 'medium', tags: sp.type === 'Water' ? ['water'] : sp.type === 'Features' ? ['feature'] : sp.type === 'Peaks' ? ['peak', 'ridge'] : ['land'] };
  }
  var ov = prefs.metaOv && prefs.metaOv[key];
  return ov ? Object.assign({}, sp.meta, ov) : sp.meta;
}
function classifyPx(r, g, b) {
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, v = mx, s = mx > 0 ? d / Math.max(mx, 1e-6) : 0, h = 0;
  if (d > 1e-6) { if (mx === r) h = (((g - b) / d) % 6 + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; }
  if (v < 0.18) return 0;
  if (s < 0.12 && v > 0.80) return 1;
  if (s < 0.20 && v > 0.25) return 2;
  if (h >= 175 && h <= 250 && s > 0.22 && v > 0.20) return 3;
  if ((h < 22 || h > 340) && s > 0.55 && v > 0.45) return 4;
  if ((h >= 75 && h <= 110 && s > 0.65 && v > 0.60) || (h >= 260 && h <= 320 && s > 0.35)) return 5;
  if (h >= 70 && h <= 170 && s > 0.25 && v < 0.48) return 6;
  if (h >= 40 && h < 100 && s > 0.15 && s < 0.45 && v > 0.18 && v < 0.42) return 7;
  if (h >= 60 && h <= 170 && s > 0.20) return 8;
  if (h >= 25 && h < 60 && s > 0.18 && s < 0.65 && v > 0.55) return 9;
  if (h >= 10 && h < 45 && s > 0.25) return 10;
  return 11;
}
function pctl(sorted, p) { var i = p / 100 * (sorted.length - 1), lo = Math.floor(i), hi = Math.min(sorted.length - 1, lo + 1); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
/** src: canvas or loaded image at its original size. Same rules as sprite_meta.py / MapSpriteMeta.cs */
function analyseSprite(src, biome, type) {
  var W = src.width || src.naturalWidth, H = src.height || src.naturalHeight, k = Math.min(1, 128 / Math.max(W, H));
  var w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k)), c = mkCanvas(w, h), x = c.getContext('2d');
  x.drawImage(src, 0, 0, w, h);
  var d = x.getImageData(0, 0, w, h).data, sx = W / w, sy = H / h, X = [], Y = [], cls = [], cnt = new Array(12).fill(0), sum = [];
  for (var i = 0; i < 12; i++) sum.push([0, 0, 0]);
  for (var py = 0; py < h; py++) for (var px = 0; px < w; px++) {
    var o = (py * w + px) * 4; if (d[o + 3] < 128) continue;
    X.push((px + 0.5) * sx); Y.push((py + 0.5) * sy);
    var r = d[o] / 255, g = d[o + 1] / 255, b = d[o + 2] / 255, ci = classifyPx(r, g, b); cnt[ci]++; sum[ci][0] += r; sum[ci][1] += g; sum[ci][2] += b;
  }
  var n = X.length, m = { biome: biome, w: W, h: H, type: type, coverage: Math.round(n / (w * h) * 1e4) / 1e4, aspect: W / H };
  if (n < 3) { m.angle = 0; m.major = W; m.minor = H; m.elongation = Math.max(W, H) / Math.max(1, Math.min(W, H)); m.fractions = {}; CLS.forEach(function (c) { m.fractions[c] = 0; }); m.colors = []; }
  else {
    var cx = 0, cy = 0; for (i = 0; i < n; i++) { cx += X[i]; cy += Y[i]; } cx /= n; cy /= n;
    var cxx = 0, cyy = 0, cxy = 0; for (i = 0; i < n; i++) { var dx = X[i] - cx, dy = Y[i] - cy; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; } cxx /= n; cyy /= n; cxy /= n;
    var th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), U = [], V = [];
    for (i = 0; i < n; i++) { dx = X[i] - cx; dy = Y[i] - cy; U.push(dx * Math.cos(th) + dy * Math.sin(th)); V.push(-dx * Math.sin(th) + dy * Math.cos(th)); }
    U.sort(function (a, b) { return a - b; }); V.sort(function (a, b) { return a - b; });
    var major = pctl(U, 98) - pctl(U, 2) + sx, minor = pctl(V, 98) - pctl(V, 2) + sy;
    if (minor > major) { var t = major; major = minor; minor = t; th += Math.PI / 2; }
    var ang = -th * 180 / Math.PI; while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;
    m.angle = Math.round(ang * 100) / 100; m.major = Math.round(major * 10) / 10; m.minor = Math.round(Math.max(1, minor) * 10) / 10; m.elongation = m.major / m.minor;
    m.fractions = {}; CLS.forEach(function (c, j) { m.fractions[c] = cnt[j] / n; });
    m.colors = cnt.map(function (v, j) { return [v, j]; }).filter(function (a) { return a[0] > 0; }).sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; }).slice(0, 3)
      .map(function (a) { var s = sum[a[1]]; return '#' + s.map(function (v) { return ('0' + Math.round(v / a[0] * 255).toString(16)).slice(-2); }).join(''); });
  }
  var area = m.coverage * W * H;
  m.size = area < 20000 ? 'small' : area < 90000 ? 'medium' : 'large';
  m.tags = tagsFor(m);
  return m;
}
function tagsFor(m) {
  var f = m.fractions, t = m.type, el = m.elongation, b = m.biome, T = {};
  var landish = f.green + f.sand + f.earth + f.marsh + f.forest + f.rock * 0.5;
  if (f.water > 0.30 || t === 'Water') T.water = 1;
  if (t === 'Ground' || t === 'Land' || (landish > 0.45 && f.water < 0.30)) T.land = 1;
  if ((f.water > 0.06 && f.water < 0.65 && f.sand + f.green + f.rock + f.earth > 0.15) || b === 'Coast' || b === 'CoastalCliffs') T.coast = 1;
  if (f.forest > 0.30 || (t === 'Features' && f.forest + f.green > 0.5)) T.forest = 1;
  if (t === 'Peaks' || (f.rock + f.snow > 0.45 && el < 1.8)) T.peak = 1;
  if (el >= 1.8 && (f.rock + f.snow + f.earth > 0.35 || t === 'Peaks')) T.ridge = 1;
  if ((f.water > 0.12 && el >= 2.0 && m.coverage < 0.6) || (b === 'TemperateRivers' && f.water > 0.10)) T.river = 1;
  if (f.lava > 0.05) T.lava = 1; if (f.sand > 0.25) T.sand = 1; if (f.snow > 0.18) T.snow = 1;
  if (f.marsh > 0.30 || b === 'Swamp') T.marsh = 1; if (f.toxic > 0.10 || b === 'Toxic') T.toxic = 1; if (f.rock > 0.35) T.rock = 1;
  if (t === 'Features') T.feature = 1; if (el >= 1.8) T.elongated = 1; if (el < 1.3) T.round = 1;
  return Object.keys(T).sort();
}
function guessImportType(m) { return m.fractions.water > 0.45 ? 'Water' : m.coverage * m.w * m.h < 12000 ? 'Features' : 'Land'; }

// ================================================================== smart fill tool (Connect / Grow / Fill region)
var SF = window.MMSmartFill;
var GEN_DEF = { style: 'land', width: 160, density: 0.5, jitter: 0.5, curve: 0.4, extra: 0, seed: 1, biomeMode: 'match', biome: '', features: 0.5, radius: 350, rotRand: 30 };
var gen = { mode: 'connect', o: Object.assign({}, GEN_DEF, prefs.genOpts || {}), preview: null, region: null, last: null, timer: 0 };
if (prefs.genMode) gen.mode = prefs.genMode;
var catalogCache = null;
function genCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = Object.keys(SPR).sort().map(function (k) { var s = SPR[k]; return { key: k, biome: s.cat, type: s.type, m: metaOf(k) }; });
  return catalogCache;
}
function isGen(s) { return !!s.genGroup; }
function genAnchors() {
  var list = selStamps().filter(function (s) { return !isGen(s); });
  if (!list.length) list = map.stamps.filter(function (s) { var t = stampType(s); return !isGen(s) && (t === 1 || t === 3 || t === 5 || (plugOn(map) && autoMerge(s))); });
  list = list.slice().sort(function (a, b) { return a.id - b.id; });
  return list.map(function (s) {
    var p = toPx(map, s.position), bb = stampAabb(map, s), sp = SPR[s.spriteKey];
    return { id: s.id, x: p.x, y: p.y, r: 0.5 * Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY), biome: sp ? sp.cat : 'Temperate', layer: s.sortingLayer, order: s.order };
  });
}
function regionBiome() {
  if (gen.o.biomeMode === 'pick' && gen.o.biome) return gen.o.biome;
  var r = gen.region; if (!r) return 'Temperate';
  var cx = 0, cy = 0; r.forEach(function (p) { cx += p.x; cy += p.y; }); cx /= r.length; cy /= r.length;
  var best = null, bd = Infinity;
  map.stamps.forEach(function (s) { if (isGen(s) || !SPR[s.spriteKey]) return; var p = toPx(map, s.position), d = Math.hypot(p.x - cx, p.y - cy); if (d < bd) { bd = d; best = s; } });
  return best ? SPR[best.spriteKey].cat : 'Temperate';
}
/** run the generator for the current mode -> {stamps, edges, anchors, info} or {error} */
function computeGen(o, anchorIds, region) {
  var anchors = genAnchors();
  if (anchorIds) anchors = anchorIdsToAnchors(anchorIds);
  var cat = genCatalog(), res;
  if (gen.mode === 'connect') {
    if (anchors.length < 2) return { error: 'Place or select 2+ land / coast stickers — or press ✦ Auto-fill to connect everything' };
    res = SF.connect(anchors, o, cat);
  } else if (gen.mode === 'grow') {
    if (!anchors.length) return { error: 'Select stamps to grow land around — or press ✦ Auto-fill' };
    res = SF.grow(anchors, o, cat);
  } else {
    if (!region || region.length < 3) return { error: 'Drag a lasso on the map to outline the region' };
    res = SF.fillRegion(region, Object.assign({}, o, { biome: regionBiome() }), cat);
    anchors = [];
  }
  return { stamps: placementsToStamps(res.placements, anchors), edges: res.edges || [], anchors: anchors };
}
function anchorIdsToAnchors(ids) {
  var save = sel; sel = ids.filter(byId); var a = genAnchors(); sel = save; return a;
}
function placementsToStamps(pl, anchors) {
  var cnt = {}, layer = 'Default', best = 0;
  anchors.forEach(function (a) { cnt[a.layer] = (cnt[a.layer] || 0) + 1; if (cnt[a.layer] > best) { best = cnt[a.layer]; layer = a.layer; } });
  var lo = anchors.length ? Math.min.apply(null, anchors.map(function (a) { return a.order; })) - 1 : layerMaxOrder(layer) + 1;
  var hi = Math.max(layerMaxOrder(layer), lo) + 1;
  return pl.map(function (p, i) {
    return { id: -1 - i, spriteKey: p.key, spriteGuid: '', position: toUnits(map, p.x, p.y), rotation: round4(p.rot), scale: v2(p.scale, p.scale), flipX: p.flipX, flipY: false,
      sortingLayer: layer, order: p.z === 'over' ? hi : lo, tint: col(1, 1, 1, 1), type: '', shadow: 0, feather: 0, foam: 0, genGroup: '', _ghost: true, vary: map.plug && map.plug.variation > 0 ? randVary() : undefined };
  });
}
function genHint() {
  if (gen.mode === 'fill') return 'Drag a <b>lasso</b> on the map to outline the area. Big pieces fill the inside, small ones the edge.';
  var na = genAnchors().length;
  return (sel.length ? '<b>' + na + '</b> anchor(s) selected.' : 'No selection: using all <b>' + na + '</b> land stamps.') + ' Click stamps to toggle them, drag a box to pick several (Shift adds).';
}
function schedulePreview() { clearTimeout(gen.timer); if (tool === 'gen') gen.timer = setTimeout(refreshPreview, 60); }
function refreshPreview() {
  if (tool !== 'gen') return;
  var r = computeGen(gen.o, null, gen.region);
  gen.preview = r.error ? null : r; gen.msg = r.error || (r.stamps.length + ' pieces — Apply (Enter) or Cancel (Esc)');
  if (gen.preview) { var need = {}; r.stamps.forEach(function (s) { need[s.spriteKey.split('/')[0]] = 1; }); Object.keys(need).forEach(function (c) { loadCategory(c).then(invalidate); }); }
  var m = $('genMsg'); if (m) m.textContent = gen.msg; var gh = $('genHint'); if (gh) gh.innerHTML = genHint(); var ab = $('genApply'); if (ab) ab.disabled = !gen.preview;
  invalidate();
}
function nextGroup() { var mx = 0; map.stamps.forEach(function (s) { var m = /^g(\d+)$/.exec(s.genGroup || ''); if (m) mx = Math.max(mx, +m[1]); }); return 'g' + (mx + 1); }
function commitStamps(list, group) {
  list.forEach(function (s) { delete s._ghost; s.id = map.nextId++; s.genGroup = group; map.stamps.push(s); });
}
function applyGen() {
  if (!gen.preview || !gen.preview.stamps.length) { toast(gen.msg || 'Nothing to apply'); return; }
  checkpoint();
  var g = nextGroup(), n = gen.preview.stamps.length;
  commitStamps(gen.preview.stamps, g);
  gen.last = { mode: gen.mode, o: Object.assign({}, gen.o), anchorIds: gen.preview.anchors.map(function (a) { return a.id; }), region: gen.region, group: g };
  gen.preview = null; gen.msg = 'Applied ' + n + ' pieces as group ' + g;
  changed(); renderBrushCard(); toast('Generated ' + n + ' stamps (' + g + ') — Ctrl+Z undoes');
}
function cancelGen() { clearTimeout(gen.timer); gen.preview = null; gen.region = null; gen.msg = 'Cancelled'; renderBrushCard(); invalidate(); }
function newSeed() { gen.o.seed = (Math.imul(gen.o.seed | 0 || 1, 1103515245) + 12345 >>> 0) % 100000; saveGenPrefs(); }
function regenerate() {
  newSeed();
  if (tool === 'gen' && (gen.preview || !gen.last)) { renderBrushCard(); refreshPreview(); return; }
  var L = gen.last; if (!L) { toast('Nothing generated yet'); return; }
  var save = { mode: gen.mode, o: gen.o }; gen.mode = L.mode;
  var o = Object.assign({}, L.o, { seed: gen.o.seed });
  checkpoint();
  map.stamps = map.stamps.filter(function (s) { return s.genGroup !== L.group; });
  var r = computeGen(o, L.anchorIds, L.region);
  gen.mode = save.mode;
  if (r.error) { toast(r.error); return; }
  commitStamps(r.stamps, L.group); L.o = o;
  changed(); renderBrushCard(); toast('Regenerated ' + L.group + ' with seed ' + o.seed);
}
function clearGenerated() {
  var n = map.stamps.filter(isGen).length; if (!n) { toast('No generated stamps'); return; }
  checkpoint(); map.stamps = map.stamps.filter(function (s) { return !isGen(s); }); sel = sel.filter(byId); gen.last = null;
  changed(); renderSel(); renderBrushCard(); toast('Removed ' + n + ' generated stamps');
}
function saveGenPrefs() { prefs.genOpts = gen.o; prefs.genMode = gen.mode; savePrefs(); }
function renderGenCard(b) {
  var o = gen.o, live = function () { saveGenPrefs(); schedulePreview(); };
  b.appendChild(el('button', { class: 'finish autofill', text: '✦ Auto-fill / Connect ' + (sel.length ? 'selected' : 'everything'), title: 'One click: merge stickers into one coastline, bridge gaps, connect islands (works with no selection)', onclick: autoFill }));
  function sl(label, min, max, step, k, title) { return slider(label, min, max, step, function () { return o[k]; }, function (v) { o[k] = v; live(); }, { noUndo: true, title: title }); }
  b.appendChild(row('Mode', seg([['connect', 'Connect', 'Join selected stamps with generated terrain (MST)'], ['grow', 'Grow', 'Grow land around the selected stamps'], ['fill', 'Fill region', 'Lasso an area and fill it with land']],
    function () { return gen.mode; }, function (v) { gen.mode = v; gen.preview = null; saveGenPrefs(); renderBrushCard(); refreshPreview(); })));
  b.appendChild(el('div', { id: 'genHint', class: 'hint', html: genHint() }));
  if (gen.mode === 'connect') {
    b.appendChild(row('Style', seg([['land', 'Land', 'Land bridge'], ['ridge', 'Ridge', 'Ridge / mountain chain'], ['river', 'River'], ['coast', 'Coast', 'Coastline']], function () { return o.style; }, function (v) { o.style = v; live(); })));
    b.appendChild(sl('Width px', 30, 600, 5, 'width', 'Thickness of the generated strip'));
    b.appendChild(sl('Density', 0, 1, 0.05, 'density', 'Overlap between pieces'));
    b.appendChild(sl('Jitter', 0, 1, 0.05, 'jitter', 'Path wobble + rotation noise'));
    b.appendChild(sl('Curve', 0, 1, 0.05, 'curve', 'How much the paths bend'));
    b.appendChild(sl('Extra links', 0, 1, 0.05, 'extra', '0 = minimum spanning tree; more adds loops'));
  } else {
    if (gen.mode === 'grow') b.appendChild(sl('Radius px', 50, 1500, 10, 'radius', 'How far land grows from each anchor'));
    b.appendChild(sl('Piece px', 30, 600, 5, 'width', 'Size of the biggest pieces'));
    b.appendChild(sl('Density', 0, 1, 0.05, 'density'));
    b.appendChild(sl('Rand rot ±', 0, 180, 1, 'rotRand'));
    if (gen.mode === 'fill') b.appendChild(el('div', { class: 'btnrow' }, [el('span', { class: 'muted', text: gen.region ? 'Region: ' + gen.region.length + ' points' : 'No region yet' }),
      gen.region ? el('button', { class: 'mini', text: 'Clear region', onclick: function () { gen.region = null; gen.preview = null; renderBrushCard(); refreshPreview(); } }) : null]));
  }
  b.appendChild(sl('Features', 0, 1.5, 0.05, 'features', 'Forests, hills, ponds and peaks sprinkled on generated land'));
  var biomes = catOrder.filter(function (c) { return CATS[c].keys.length; });
  var bs = el('select', {}, biomes.map(function (c) { return el('option', { value: c, text: CATS[c].label }); })); bs.value = o.biome || biomes[0];
  bs.addEventListener('change', function () { o.biome = bs.value; live(); });
  b.appendChild(row('Biome', seg([['match', 'Match', 'Use the anchors\' biomes (blends A → B), borrowing missing piece types from other biomes'], ['pick', 'Pick', 'Use only the chosen biome (e.g. your imported sprites)']], function () { return o.biomeMode; },
    function (v) { o.biomeMode = v; if (v === 'pick' && !o.biome) o.biome = bs.value; bs.disabled = v !== 'pick'; live(); })));
  bs.style.width = '100%'; b.appendChild(row('', bs));
  bs.disabled = o.biomeMode !== 'pick';
  var si = el('input', { type: 'number', class: 'num', min: 0, max: 99999, step: 1, style: 'width:70px', id: 'genSeed' }); si.value = o.seed;
  si.addEventListener('change', function () { o.seed = Math.max(0, +si.value | 0); live(); });
  b.appendChild(row('Seed', el('div', { class: 'row', style: 'gap:4px' }, [si, el('button', { class: 'mini', text: '🎲', title: 'New seed', onclick: function () { newSeed(); si.value = o.seed; refreshPreview(); } })])));
  b.appendChild(el('div', { id: 'genMsg', class: 'hint', text: gen.msg || '' }));
  var nGen = map.stamps.filter(isGen).length;
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { id: 'genApply', class: 'mini on', text: '✓ Apply', title: 'Enter', disabled: !gen.preview, onclick: applyGen }),
    el('button', { class: 'mini', text: 'Cancel', title: 'Esc', onclick: cancelGen }),
    el('button', { id: 'genRegen', class: 'mini', text: '↻ Regenerate', title: 'New seed (re-rolls the last applied group when no preview is showing)', onclick: regenerate }),
    el('button', { id: 'genClear', class: 'mini danger', text: 'Clear generated (' + nGen + ')', onclick: clearGenerated })]));
}
function drawGenOverlay(ctx, px) {
  if (tool !== 'gen') return;
  ctx.save();
  if (gen.mode !== 'fill') {
    var an = gen.preview ? gen.preview.anchors : genAnchors();
    ctx.strokeStyle = 'rgba(120,220,255,0.9)'; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]);
    an.forEach(function (a) { ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(10, a.r), 0, Math.PI * 2); ctx.stroke(); });
    if (gen.preview && gen.mode === 'connect') { ctx.strokeStyle = 'rgba(120,220,255,0.55)'; gen.preview.edges.forEach(function (e) { var a = an[e[0]], b = an[e[1]]; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }); }
  }
  var pts = drag && drag.kind === 'lasso' ? drag.pts : gen.mode === 'fill' ? gen.region : null;
  if (pts && pts.length > 1) {
    ctx.setLineDash([6 * px, 4 * px]); ctx.strokeStyle = 'rgba(120,220,255,0.95)'; ctx.fillStyle = 'rgba(120,220,255,0.08)'; ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
function simplify(pts, tol) { var out = [pts[0]]; for (var i = 1; i < pts.length; i++) { var l = out[out.length - 1]; if (Math.hypot(pts[i].x - l.x, pts[i].y - l.y) >= tol) out.push(pts[i]); } return out; }

// ================================================================== custom sprites: import, sheet cutter, IndexedDB
var DB_NAME = 'mapmaker-html', DB_STORE = 'sprites', dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise(function (res, rej) {
    if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
    var r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore(DB_STORE, { keyPath: 'key' }); };
    r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
  });
  return dbp;
}
function dbAll() { return db().then(function (d) { return new Promise(function (res, rej) { var q = d.transaction(DB_STORE).objectStore(DB_STORE).getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { rej(q.error); }; }); }); }
function dbPut(recs) { return db().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction(DB_STORE, 'readwrite'), s = t.objectStore(DB_STORE); recs.forEach(function (r) { s.put(r); }); t.oncomplete = function () { res(); }; t.onerror = function () { rej(t.error); }; }); }); }
function dbDel(keys) { return db().then(function (d) { return new Promise(function (res) { var t = d.transaction(DB_STORE, 'readwrite'), s = t.objectStore(DB_STORE); keys.forEach(function (k) { s.delete(k); }); t.oncomplete = res; t.onerror = res; }); }); }
function ensureCat(name, label) {
  if (CATS[name]) return CATS[name];
  CATS[name] = { name: name, label: label || name, prefix: name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'spr', count: 0, keys: [], state: 2, waiters: [], custom: true };
  catOrder.push(name); return CATS[name];
}
/** rec: {key, cat, label, name, w, h, type, uri, meta} */
function registerCustom(rec) {
  var c = ensureCat(rec.cat, rec.label);
  var s = SPR[rec.key] = SPR[rec.key] || { key: rec.key, cat: rec.cat, name: rec.name, fx: {} };
  Object.assign(s, { w: rec.w, h: rec.h, type: rec.type, uri: rec.uri, custom: true, ready: false, meta: rec.meta || null, mask: null, fx: {} });
  delete s.plug;
  if (c.keys.indexOf(rec.key) < 0) { c.keys.push(rec.key); c.count = c.keys.length; }
  catalogCache = null;
  return new Promise(function (res) { var img = new Image(); s.img = img; img.onload = img.onerror = function () { s.ready = img.naturalWidth > 0; res(s); }; img.src = rec.uri; });
}
function customKeys() { return Object.keys(SPR).filter(function (k) { return SPR[k].custom; }).sort(); }
function loadCustom() {
  return dbAll().then(function (recs) { return Promise.all(recs.map(registerCustom)); }).then(function (l) { if (l.length) { renderTabs(); renderPalette(); fireSprites(); } return l.length; })
    .catch(function (e) { console.warn('custom sprites unavailable:', e && e.message); return 0; });
}
function slug(s) { return (s || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'sprite'; }
function readImage(file) {
  return new Promise(function (res, rej) {
    var r = new FileReader();
    r.onload = function () { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { rej(new Error('Not an image: ' + file.name)); }; i.src = r.result; };
    r.onerror = function () { rej(r.error); }; r.readAsDataURL(file);
  });
}
/** JS port of Tools~/cut_sheets.py: border flood fill, soft feather band + un-mix from white, then either
 * grouped 8-connected pieces (sparse sheets) or, for dense sheets whose pieces touch, light-gap shadow
 * splitting + enclosed white pockets as background + eroded cores grown back over the visible pixels.
 * opt.dense: true | false | 'auto' (auto = sparse, switching to dense when the sparse cut finds giant clumps). */
function cutSheet(img, opt) {
  opt = Object.assign({ bg: 22, solid: 70, feather: 4, minArea: 1500, group: 3, pad: 4, alphaCut: 24, edgeMargin: 2, edgeMin: 6,
    dense: false, splitThreshold: 40, enclosedBg: 150, enclosedWhite: 9, erode: 5, assignPx: 10 }, opt || {});
  if (opt.dense === 'auto') {
    var sp = cutSheet(img, Object.assign({}, opt, { dense: false })), W0 = img.naturalWidth || img.width, H0 = img.naturalHeight || img.height;
    var clump = sp.some(function (p) { return p.area > W0 * H0 * 0.12; });
    if (!clump) { sp.dense = false; return sp; }
    var dn = cutSheet(img, Object.assign({}, opt, { dense: true, minArea: Math.min(opt.minArea, 600) }));
    dn.dense = true; return dn;
  }
  var W = img.naturalWidth || img.width, H = img.naturalHeight || img.height, c = mkCanvas(W, H), x = c.getContext('2d');
  x.drawImage(img, 0, 0); var id = x.getImageData(0, 0, W, H), d = id.data, N = W * H;
  var wh = new Float32Array(N), bg = new Uint8Array(N), q = new Int32Array(N), qh = 0, qt = 0, i, xx, yy;
  for (i = 0; i < N; i++) wh[i] = 255 - Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  function seed(j) { if (!bg[j] && wh[j] < opt.bg) { bg[j] = 1; q[qt++] = j; } }
  for (xx = 0; xx < W; xx++) { seed(xx); seed((H - 1) * W + xx); } for (yy = 0; yy < H; yy++) { seed(yy * W); seed(yy * W + W - 1); }
  while (qh < qt) {
    var j = q[qh++], jx = j % W, jy = (j - jx) / W;
    for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) { var nx = jx + ox, ny = jy + oy; if ((ox || oy) && nx >= 0 && ny >= 0 && nx < W && ny < H) seed(ny * W + nx); }
  }
  if (opt.dense && opt.enclosedBg > 0) {   // enclosed near-pure-white pockets walled off by touching pieces
    var seen = new Uint8Array(N);
    for (var e0 = 0; e0 < N; e0++) {
      if (bg[e0] || seen[e0] || wh[e0] >= opt.bg) continue;
      qh = qt = 0; q[qt++] = e0; seen[e0] = 1; var sumw = 0;
      while (qh < qt) { j = q[qh++]; sumw += wh[j]; jx = j % W; jy = (j - jx) / W;
        for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) { nx = jx + ox; ny = jy + oy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { var kk = ny * W + nx; if (!seen[kk] && !bg[kk] && wh[kk] < opt.bg) { seen[kk] = 1; q[qt++] = kk; } } } }
      if (qt >= opt.enclosedBg && sumw / qt < opt.enclosedWhite) for (var e1 = 0; e1 < qt; e1++) bg[q[e1]] = 1;
    }
  }
  // chamfer distance to background (3-4 weights / 3 ≈ px)
  var dist = new Float32Array(N), BIG = 1e9;
  for (i = 0; i < N; i++) dist[i] = bg[i] ? 0 : BIG;
  for (yy = 0; yy < H; yy++) for (xx = 0; xx < W; xx++) { i = yy * W + xx; if (!dist[i]) continue; var v = dist[i];
    if (xx > 0) v = Math.min(v, dist[i - 1] + 1); if (yy > 0) { v = Math.min(v, dist[i - W] + 1); if (xx > 0) v = Math.min(v, dist[i - W - 1] + 1.414); if (xx < W - 1) v = Math.min(v, dist[i - W + 1] + 1.414); } dist[i] = v; }
  for (yy = H - 1; yy >= 0; yy--) for (xx = W - 1; xx >= 0; xx--) { i = yy * W + xx; if (!dist[i]) continue; v = dist[i];
    if (xx < W - 1) v = Math.min(v, dist[i + 1] + 1); if (yy < H - 1) { v = Math.min(v, dist[i + W] + 1); if (xx < W - 1) v = Math.min(v, dist[i + W + 1] + 1.414); if (xx > 0) v = Math.min(v, dist[i + W - 1] + 1.414); } dist[i] = v; }
  var alpha = new Float32Array(N), lo = opt.bg * 0.5, span = opt.solid - lo;
  for (i = 0; i < N; i++) {
    if (bg[i]) { alpha[i] = 0; continue; }
    if (dist[i] <= opt.feather) { var r = Math.min(1, Math.max(0, (wh[i] - lo) / span)); r = r * r * (3 - 2 * r); var t = Math.min(1, dist[i] / opt.feather); alpha[i] = Math.max(r, t * t); }
    else alpha[i] = 1;
  }
  if (opt.dense && opt.splitThreshold > 0) {   // light grey shadow gaps connected to the background -> translucent
    var gap = new Uint8Array(N), gs = opt.splitThreshold - lo; qh = qt = 0;
    for (i = 0; i < N; i++) if (bg[i]) { gap[i] = 2; q[qt++] = i; }
    while (qh < qt) { j = q[qh++]; jx = j % W; jy = (j - jx) / W;
      for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) { nx = jx + ox; ny = jy + oy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { kk = ny * W + nx; if (!gap[kk] && wh[kk] < opt.splitThreshold) { gap[kk] = 1; q[qt++] = kk; } } } }
    for (i = 0; i < N; i++) if (gap[i] === 1) { r = Math.min(1, Math.max(0, (wh[i] - lo) / gs)); alpha[i] = Math.min(alpha[i], r * r * (3 - 2 * r)); }
  }
  for (i = 0; i < N; i++) {   // un-mix from white
    var a = alpha[i], o4 = i * 4;
    if (a <= 0) { d[o4] = d[o4 + 1] = d[o4 + 2] = d[o4 + 3] = 0; continue; }
    if (a < 0.999) for (var ch = 0; ch < 3; ch++) d[o4 + ch] = Math.max(0, Math.min(255, Math.round((d[o4 + ch] - (1 - a) * 255) / a)));
    d[o4 + 3] = Math.round(a * 255);
  }
  // grouping mask = solid dilated by `group` px (separable box max)
  var solid = new Uint8Array(N), tmp = new Uint8Array(N), grp = new Uint8Array(N), R = opt.group, cut = opt.alphaCut / 255;
  for (i = 0; i < N; i++) solid[i] = alpha[i] > cut ? 1 : 0;
  for (yy = 0; yy < H; yy++) { var run = -1e9; for (xx = 0; xx < W; xx++) { if (solid[yy * W + xx]) run = xx; tmp[yy * W + xx] = xx - run <= R ? 1 : 0; } run = 1e9; for (xx = W - 1; xx >= 0; xx--) { if (solid[yy * W + xx]) run = xx; if (run - xx <= R) tmp[yy * W + xx] = 1; } }
  for (xx = 0; xx < W; xx++) { run = -1e9; for (yy = 0; yy < H; yy++) { if (tmp[yy * W + xx]) run = yy; grp[yy * W + xx] = yy - run <= R ? 1 : 0; } run = 1e9; for (yy = H - 1; yy >= 0; yy--) { if (tmp[yy * W + xx]) run = yy; if (run - yy <= R) grp[yy * W + xx] = 1; } }
  var lab = new Int32Array(N), pieces = [], nl = 0;
  if (opt.dense) return densePieces();
  for (var s0 = 0; s0 < N; s0++) {
    if (!grp[s0] || lab[s0]) continue;
    nl++; qh = qt = 0; q[qt++] = s0; lab[s0] = nl;
    var p = { label: nl, x0: W, y0: H, x1: -1, y1: -1, area: 0, edge: 0 };
    while (qh < qt) {
      j = q[qh++]; jx = j % W; jy = (j - jx) / W;
      if (solid[j]) { p.area++; if (jx < p.x0) p.x0 = jx; if (jx > p.x1) p.x1 = jx; if (jy < p.y0) p.y0 = jy; if (jy > p.y1) p.y1 = jy;
        if (jx < opt.edgeMargin || jy < opt.edgeMargin || jx >= W - opt.edgeMargin || jy >= H - opt.edgeMargin) p.edge++; }
      for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) { nx = jx + ox; ny = jy + oy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { var k = ny * W + nx; if (grp[k] && !lab[k]) { lab[k] = nl; q[qt++] = k; } } }
    }
    if (p.area >= opt.minArea) pieces.push(p);
  }
  return emit();
  function densePieces() {
    // cores = solid pixels more than `erode` px inside the art (chamfer distance to non-solid)
    var dc = new Float32Array(N), E = opt.erode, cl = new Int32Array(N), ncore = 0, csz = [0];
    for (i = 0; i < N; i++) dc[i] = solid[i] ? BIG : 0;
    for (yy = 0; yy < H; yy++) for (xx = 0; xx < W; xx++) { i = yy * W + xx; if (!dc[i]) continue; var v2 = dc[i];
      if (xx > 0) v2 = Math.min(v2, dc[i - 1] + 1); else v2 = 1; if (yy > 0) { v2 = Math.min(v2, dc[i - W] + 1); if (xx > 0) v2 = Math.min(v2, dc[i - W - 1] + 1.414); if (xx < W - 1) v2 = Math.min(v2, dc[i - W + 1] + 1.414); } else v2 = 1; if (xx === W - 1) v2 = 1; dc[i] = v2; }
    for (yy = H - 1; yy >= 0; yy--) for (xx = W - 1; xx >= 0; xx--) { i = yy * W + xx; if (!dc[i]) continue; v2 = dc[i];
      if (xx < W - 1) v2 = Math.min(v2, dc[i + 1] + 1); if (yy < H - 1) { v2 = Math.min(v2, dc[i + W] + 1); if (xx < W - 1) v2 = Math.min(v2, dc[i + W + 1] + 1.414); if (xx > 0) v2 = Math.min(v2, dc[i + W - 1] + 1.414); } else v2 = 1; dc[i] = v2; }
    for (var c0 = 0; c0 < N; c0++) {
      if (dc[c0] <= E || cl[c0]) continue;
      ncore++; qh = qt = 0; q[qt++] = c0; cl[c0] = ncore;
      while (qh < qt) { j = q[qh++]; jx = j % W; jy = (j - jx) / W;
        for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) { nx = jx + ox; ny = jy + oy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { kk = ny * W + nx; if (!cl[kk] && dc[kk] > E) { cl[kk] = ncore; q[qt++] = kk; } } } }
      csz[ncore] = qt;
    }
    for (i = 0; i < N; i++) if (cl[i] && csz[cl[i]] < 30) cl[i] = 0;
    // grow every core back over the visible pixels (geodesic BFS, so it never jumps a transparent gap)
    var dd2 = new Int16Array(N), lim = E + opt.assignPx; qh = qt = 0;
    for (i = 0; i < N; i++) if (cl[i]) { lab[i] = cl[i]; q[qt++] = i; }
    while (qh < qt) { j = q[qh++]; if (dd2[j] >= lim) continue; jx = j % W; jy = (j - jx) / W;
      for (oy = -1; oy <= 1; oy++) for (ox = -1; ox <= 1; ox++) { nx = jx + ox; ny = jy + oy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { kk = ny * W + nx; if (!lab[kk] && alpha[kk] > 0) { lab[kk] = lab[j]; dd2[kk] = dd2[j] + 1; q[qt++] = kk; } } } }
    var st = {};
    for (i = 0; i < N; i++) { var L = lab[i]; if (!L || !solid[i]) continue; var P = st[L] || (st[L] = { label: L, x0: W, y0: H, x1: -1, y1: -1, area: 0, edge: 0 });
      jx = i % W; jy = (i - jx) / W; P.area++; if (jx < P.x0) P.x0 = jx; if (jx > P.x1) P.x1 = jx; if (jy < P.y0) P.y0 = jy; if (jy > P.y1) P.y1 = jy;
      if (jx < opt.edgeMargin || jy < opt.edgeMargin || jx >= W - opt.edgeMargin || jy >= H - opt.edgeMargin) P.edge++; }
    Object.keys(st).forEach(function (L) { if (st[L].area >= opt.minArea) pieces.push(st[L]); });
    return emit();
  }
  function emit() { return pieces.map(function (p) {
    var pad = opt.pad, x0 = p.x0 - pad, y0 = p.y0 - pad, w = p.x1 - p.x0 + 1 + 2 * pad, h = p.y1 - p.y0 + 1 + 2 * pad;
    w = Math.ceil(w / 4) * 4; h = Math.ceil(h / 4) * 4;
    var out = mkCanvas(w, h), ox2 = out.getContext('2d'), od = ox2.createImageData(w, h), dd = od.data;
    for (var yy2 = 0; yy2 < h; yy2++) for (var xx2 = 0; xx2 < w; xx2++) {
      var sx = x0 + xx2, sy = y0 + yy2; if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      var si = sy * W + sx; if (lab[si] !== p.label) continue;
      var so = si * 4, dO = (yy2 * w + xx2) * 4; dd[dO] = d[so]; dd[dO + 1] = d[so + 1]; dd[dO + 2] = d[so + 2]; dd[dO + 3] = d[so + 3];
    }
    ox2.putImageData(od, 0, 0);
    return { canvas: out, w: w, h: h, area: p.area, clipped: p.edge >= opt.edgeMin, x: x0, y: y0 };
  }).sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); }); }
}
function alphaPiece(img) {   // transparent sprite: crop to its alpha bounds
  var W = img.naturalWidth, H = img.naturalHeight, c = mkCanvas(W, H), x = c.getContext('2d'); x.drawImage(img, 0, 0);
  var d = x.getImageData(0, 0, W, H).data, x0 = W, y0 = H, x1 = -1, y1 = -1, transp = 0;
  for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) { var a = d[(yy * W + xx) * 4 + 3]; if (a < 250) transp++; if (a > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; } }
  if (transp < W * H * 0.01 || x1 < 0) return null;     // opaque image -> treat as a sheet
  var w = x1 - x0 + 1, h = y1 - y0 + 1, o = mkCanvas(w, h); o.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
  return { canvas: o, w: w, h: h, area: w * h, clipped: false, x: 0, y: 0 };
}
var imp = { sources: [], pieces: [], cat: '', newCat: '', prefix: '', type: '', bg: 22, minArea: 1500, dense: 'auto', erode: 5, denseUsed: false };
function importFiles(files) {
  files = Array.prototype.filter.call(files, function (f) { return /image\/(png|webp|jpe?g)/i.test(f.type) || /\.(png|webp|jpe?g)$/i.test(f.name); });
  if (!files.length) { toast('Drop PNG / WebP / JPG images'); return Promise.resolve(); }
  showLoading(true);
  return Promise.all(files.map(function (f) { return readImage(f).then(function (img) { return { name: f.name.replace(/\.[^.]+$/, ''), img: img }; }); })).then(function (srcs) {
    imp.sources = srcs; imp.prefix = slug(srcs[0].name).toLowerCase().slice(0, 12);
    var guess = catOrder.filter(function (c) { return slug(srcs[0].name).toLowerCase().replace(/_/g, '') === c.toLowerCase(); })[0];
    imp.cat = guess || imp.cat || '__new'; imp.newCat = guess ? '' : (imp.newCat || 'MySprites');
    recut(); showLoading(false); openImport();
  }).catch(function (e) { showLoading(false); toast(e.message); });
}
function recut() {
  imp.pieces = []; imp.denseUsed = false;
  imp.sources.forEach(function (s) {
    var single = alphaPiece(s.img);
    var list = single ? [single] : cutSheet(s.img, { bg: imp.bg, minArea: imp.minArea, dense: imp.dense, erode: imp.erode });
    if (list.dense) imp.denseUsed = true;
    list.forEach(function (p) { p.src = s.name; p.on = !p.clipped; imp.pieces.push(p); });
  });
}
function openImport() {
  var o = $('impOpts'); o.innerHTML = '';
  var cs = el('select', { id: 'impCat' }, catOrder.map(function (c) { return el('option', { value: c, text: CATS[c].label + (CATS[c].custom ? ' (mine)' : '') }); }).concat([el('option', { value: '__new', text: '+ New biome…' })]));
  cs.value = imp.cat; var nc = el('input', { id: 'impNewCat', type: 'text', class: 'num', style: 'width:130px', placeholder: 'Biome name' }); nc.value = imp.newCat;
  nc.style.display = imp.cat === '__new' ? '' : 'none';
  cs.addEventListener('change', function () { imp.cat = cs.value; nc.style.display = imp.cat === '__new' ? '' : 'none'; });
  nc.addEventListener('input', function () { imp.newCat = nc.value; });
  var pf = el('input', { id: 'impPrefix', type: 'text', class: 'num', style: 'width:100px' }); pf.value = imp.prefix; pf.addEventListener('input', function () { imp.prefix = pf.value; });
  var ts = el('select', { id: 'impType' }, [['', 'Auto']].concat(TYPES.slice(1).map(function (t) { return [t, t]; })).map(function (t) { return el('option', { value: t[0], text: t[1] }); })); ts.value = imp.type;
  ts.addEventListener('change', function () { imp.type = ts.value; });
  var thr = el('input', { type: 'number', class: 'num', min: 4, max: 80, step: 1, style: 'width:52px', title: 'Sheet background threshold (whiteness)' }); thr.value = imp.bg;
  var ma = el('input', { type: 'number', class: 'num', min: 50, max: 50000, step: 50, style: 'width:70px', title: 'Minimum piece area (px)' }); ma.value = imp.minArea;
  var dm = el('select', { id: 'impDense', title: 'Sparse: pieces sit apart on white. Dense: pieces touch each other (split along light gaps and thin bridges). Auto picks.' },
    [['auto', 'Auto'], ['false', 'Sparse'], ['true', 'Dense']].map(function (t) { return el('option', { value: t[0], text: t[1] }); })); dm.value = String(imp.dense);
  var er = el('input', { type: 'number', class: 'num', min: 1, max: 30, step: 1, style: 'width:48px', title: 'Dense sheets: erode N px to break the bridges between touching pieces (bigger = more splitting)' }); er.value = imp.erode;
  dm.addEventListener('change', function () { imp.dense = dm.value === 'auto' ? 'auto' : dm.value === 'true'; re(); }); er.addEventListener('change', function () { imp.erode = Math.max(1, +er.value || 5); re(); });
  function re() { imp.bg = +thr.value || 22; imp.minArea = +ma.value || 1500; showLoading(true); setTimeout(function () { recut(); showLoading(false); renderImpGrid(); }, 20); }
  thr.addEventListener('change', re); ma.addEventListener('change', re);
  o.appendChild(el('label', {}, ['Biome ', cs, ' ', nc])); o.appendChild(el('label', {}, ['Name ', pf])); o.appendChild(el('label', {}, ['Layer type ', ts]));
  o.appendChild(el('label', { title: 'Only used for sprite sheets on white' }, ['Sheet bg ', thr])); o.appendChild(el('label', {}, ['Min area ', ma]));
  o.appendChild(el('label', {}, ['Sheet ', dm])); o.appendChild(el('label', {}, ['Split ', er]));
  o.appendChild(el('button', { class: 'mini', text: 'All', onclick: function () { imp.pieces.forEach(function (p) { p.on = true; }); renderImpGrid(); } }));
  o.appendChild(el('button', { class: 'mini', text: 'None', onclick: function () { imp.pieces.forEach(function (p) { p.on = false; }); renderImpGrid(); } }));
  renderImpGrid(); $('importModal').classList.remove('hidden');
}
function renderImpGrid() {
  var g = $('impGrid'); g.innerHTML = '';
  imp.pieces.forEach(function (p, i) {
    if (!p.thumb) { var k = Math.min(1, 160 / Math.max(p.w, p.h)), t = mkCanvas(Math.max(1, Math.round(p.w * k)), Math.max(1, Math.round(p.h * k))); t.getContext('2d').drawImage(p.canvas, 0, 0, t.width, t.height); p.thumb = t.toDataURL(); }
    var d = el('div', { class: 'imp' + (p.on ? ' on' : ''), title: p.src + ' · ' + p.w + '×' + p.h + (p.clipped ? ' · touches the sheet edge (clipped)' : ''), 'data-i': i }, [
      el('div', { class: 'checker th' }, [el('img', { src: p.thumb, alt: '' })]), el('div', { class: 'nm', text: p.w + '×' + p.h + (p.clipped ? ' ✂' : '') })]);
    d.addEventListener('click', function () { p.on = !p.on; d.classList.toggle('on', p.on); updImpInfo(); });
    g.appendChild(d);
  });
  updImpInfo();
}
function updImpInfo() { var n = imp.pieces.filter(function (p) { return p.on; }).length; $('impInfo').textContent = imp.pieces.length + ' pieces found' + (imp.denseUsed ? ' (dense sheet: split touching pieces)' : '') + ' · ' + n + ' selected · click a tile to toggle'; $('impConfirm').textContent = 'Import ' + n; $('impConfirm').disabled = !n; }
function confirmImport() {
  var cat = imp.cat === '__new' ? slug(imp.newCat || 'MySprites') : imp.cat, label = imp.cat === '__new' ? (imp.newCat || 'My Sprites') : CATS[cat].label;
  var prefix = slug(imp.prefix || 'spr').toLowerCase(), n = 1, recs = [];
  imp.pieces.filter(function (p) { return p.on; }).forEach(function (p) {
    var key; do { key = cat + '/' + prefix + '_' + ('00' + n++).slice(-3); } while (SPR[key]);
    var k = Math.min(1, 768 / Math.max(p.w, p.h)), c = p.canvas;
    if (k < 1) { c = mkCanvas(Math.round(p.w * k), Math.round(p.h * k)); c.getContext('2d').drawImage(p.canvas, 0, 0, c.width, c.height); }
    var meta = analyseSprite(p.canvas, cat, imp.type || 'Land'), type = imp.type || guessImportType(meta);
    if (!imp.type) { meta.type = type; meta.tags = tagsFor(meta); }
    recs.push({ key: key, cat: cat, label: label, name: key.split('/')[1], w: p.w, h: p.h, type: type, uri: c.toDataURL('image/webp', 0.9), meta: meta, t: Date.now() });
  });
  closeModals();
  return Promise.all(recs.map(registerCustom)).then(function () {
    renderTabs(); renderPalette(); fireSprites();
    return dbPut(recs).then(function () { return true; }, function (e) { toast('Imported, but not saved: ' + e.message); return false; });
  }).then(function (saved) {
    prefs.tab = 'Mine'; savePrefs(); renderTabs(); renderPalette();
    if (saved !== false) toast('Imported ' + recs.length + ' sprites into ' + label + ' (saved in this browser)');
    imp.pieces = []; imp.sources = [];
  });
}
function deleteCustom(keys) {
  keys.forEach(function (k) { var s = SPR[k]; if (!s) return; var c = CATS[s.cat]; if (c) { c.keys = c.keys.filter(function (x) { return x !== k; }); c.count = c.keys.length; } delete SPR[k]; });
  catOrder = catOrder.filter(function (c) { return !CATS[c].custom || CATS[c].keys.length; });
  catalogCache = null; renderTabs(); renderPalette(); invalidate();
  return dbDel(keys);
}
/** PNG data URIs of the custom sprites used by the map (for 'embed custom sprites in saved JSON') */
function embedList(m) {
  var used = {}; m.stamps.forEach(function (s) { if (SPR[s.spriteKey] && SPR[s.spriteKey].custom) used[s.spriteKey] = 1; });
  return Object.keys(used).sort().map(function (k) {
    var s = SPR[k], uri = s.uri;
    if (s.ready && !/^data:image\/png/.test(uri)) { var c = mkCanvas(s.img.naturalWidth, s.img.naturalHeight); c.getContext('2d').drawImage(s.img, 0, 0); uri = c.toDataURL('image/png'); }
    return { key: k, category: s.cat, label: CATS[s.cat] ? CATS[s.cat].label : s.cat, w: s.w, h: s.h, type: s.type, png: uri, tags: (metaOf(k) || {}).tags || [] };
  });
}
function importEmbedded(list) {
  var recs = (list || []).filter(function (r) { return r && r.key && r.png && !SPR[r.key]; }).map(function (r) {
    return { key: r.key, cat: r.category || r.key.split('/')[0], label: r.label, name: r.key.split('/')[1], w: r.w, h: r.h, type: r.type || 'Land', uri: r.png, meta: null, t: Date.now() };
  });
  if (!recs.length) return Promise.resolve(0);
  return Promise.all(recs.map(registerCustom)).then(function (sps) {
    sps.forEach(function (s, i) { if (s.ready) { recs[i].meta = s.meta = analyseSprite(s.img, s.cat, s.type); } });
    renderTabs(); renderPalette(); fireSprites(); invalidate();
    return dbPut(recs).catch(function () { }).then(function () { return recs.length; });
  });
}

// ================================================================== land grid (square terrain) + rivers
var RIVER_LS = 'mapmaker.html.riverPresets.v1';
function jsonReplacer(k, v) { return v instanceof Uint8Array ? TR.encodeRle(v) : v; }
function hasTerrain(m) { return !!(m.terrain && m.terrain.enabled && m.terrain.cols > 0 && m.terrain.cells); }
function cellPxOf(t) { return t.cellSize * PPU; }   // map px per square
function typeIndex(t, id) { for (var i = 0; i < t.types.length; i++) if (t.types[i].id === id) return i; return -1; }
function waterMask(t) { return t.types.map(function (x) { return x.kind === 'Water'; }); }
function baseIndex(t) { var i = typeIndex(t, t.baseId); return i < 0 ? 0 : i; }
function makeTerrain(m, cellSize) {
  var t = { enabled: true, cellSize: cellSize || prefs.landCell || 0.32, cols: 0, rows: 0, pixelsPerUnit: 64, baseId: 'deep', cells: new Uint8Array(0), types: TR.defaultTypes(), look: TR.defaultLook(), showGrid: false };
  fitTerrain(m, t, 0, 0);
  return t;
}
/** Resizes the grid to cover the map. dx/dy = how many squares the old content moves right/down. */
function fitTerrain(m, t, dx, dy) {
  t = t || m.terrain; if (!t) return;
  var cs = t.cellSize, cols = Math.max(1, Math.min(1024, Math.ceil(m.background.size.x / cs - 0.001))), rows = Math.max(1, Math.min(1024, Math.ceil(m.background.size.y / cs - 0.001)));
  dx = dx | 0; dy = dy | 0;
  if (cols === t.cols && rows === t.rows && !dx && !dy && t.cells.length === cols * rows) return;
  var o = new Uint8Array(cols * rows).fill(baseIndex(t));
  for (var y = 0; y < t.rows; y++) for (var x = 0; x < t.cols; x++) {
    var nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    o[ny * cols + nx] = t.cells[y * t.cols + x];
  }
  t.cols = cols; t.rows = rows; t.cells = o;
}
/** New cell size: resample (nearest) so painted land stays where it is. */
function setCellSize(m, cs) {
  var t = m.terrain; cs = Math.max(0.08, Math.min(4, cs)); if (!t || Math.abs(cs - t.cellSize) < 1e-6) return;
  var old = { cols: t.cols, rows: t.rows, cells: t.cells, cs: t.cellSize };
  t.cellSize = cs; t.cols = 0; t.rows = 0; t.cells = new Uint8Array(0); fitTerrain(m, t, 0, 0);
  for (var y = 0; y < t.rows; y++) for (var x = 0; x < t.cols; x++) {
    var ox = Math.floor((x + 0.5) * cs / old.cs), oy = Math.floor((y + 0.5) * cs / old.cs);
    if (ox < old.cols && oy < old.rows) t.cells[y * t.cols + x] = old.cells[oy * old.cols + ox];
  }
}
function normalizeTerrain(m, d) {
  var dt = d.terrain;
  if (dt && typeof dt === 'object' && (dt.cols | 0) > 0 && (dt.rows | 0) > 0) {
    var t = { enabled: dt.enabled !== false, cellSize: num(dt.cellSize, 0.48), cols: dt.cols | 0, rows: dt.rows | 0, pixelsPerUnit: num(dt.pixelsPerUnit, 64), baseId: dt.baseId || 'deep',
      types: Array.isArray(dt.types) && dt.types.length ? dt.types.map(function (x) { var dflt = TR.defaultTypes().filter(function (y) { return y.id === x.id; })[0] || {}; return Object.assign({}, dflt, x, { tileKeys: (x.tileKeys && x.tileKeys.length ? x.tileKeys : dflt.tileKeys) || [] }); }) : TR.defaultTypes(),
      look: Object.assign(TR.defaultLook(), dt.look || {}), showGrid: !!dt.showGrid };
    var bi = Math.max(0, typeIndex(t, t.baseId));
    t.cells = typeof dt.cells === 'string' ? TR.decodeRle(dt.cells, t.cols * t.rows, bi) : new Uint8Array(t.cols * t.rows).fill(bi);
    for (var i = 0; i < t.cells.length; i++) if (t.cells[i] >= t.types.length) t.cells[i] = bi;
    m.terrain = t; fitTerrain(m, t, 0, 0);
  } else m.terrain = null;
  m.rivers = (Array.isArray(d.rivers) ? d.rivers : []).map(function (r, i) {
    return { id: (r.id | 0) || i + 1, name: r.name || 'River ' + (i + 1), parentId: r.parentId | 0, presetName: r.presetName || '', visible: r.visible !== false,
      style: Object.assign(TR.defaultRiverStyle(), r.style || {}),
      points: (r.points || []).map(function (p) { return { position: v2(num(p.position && p.position.x, 0), num(p.position && p.position.y, 0)), width: num(p.width, 0.25) }; }) };
  });
  m.riverPresets = (Array.isArray(d.riverPresets) ? d.riverPresets : []).filter(function (p) { return p && p.name; }).map(function (p) { return { name: p.name, style: Object.assign(TR.defaultRiverStyle(), p.style || {}) }; });
  m.version = 3;
}
function riverInputs(m) {
  return (m.rivers || []).filter(function (r) { return r.visible !== false && r.points.length >= 2; }).map(function (r) {
    return { id: r.id, style: r.style, visible: true, points: r.points.map(function (p) { return { px: toPx(m, p.position), width: p.width }; }) };
  });
}
function dummyTerrain(m) { return { cellSize: Math.max(m.background.size.x, m.background.size.y) + 1, cols: 1, rows: 1, baseId: 'deep', cells: new Uint8Array(1), types: TR.defaultTypes(), look: TR.defaultLook() }; }
function cellAtPx(m, x, y) {
  var t = m.terrain, cp = cellPxOf(t), cx = Math.floor(x / cp), cy = Math.floor(y / cp);
  return cx < 0 || cy < 0 || cx >= t.cols || cy >= t.rows ? -1 : cy * t.cols + cx;
}
function landAtPx(m, x, y) { if (!hasTerrain(m)) return false; var i = cellAtPx(m, x, y), cl = derivedCells(m); return i >= 0 && m.terrain.types[cl[i]].kind !== 'Water'; }

// ---------------------------------------------------------------- editor preview (chunked, async, cached)
var TL = { tiles: false, ctx: null, ctxKey: '', levels: {}, quick: null, quickSig: '', gen: 0, used: 0 };
var CHUNK = 256;
function fnv(h, v) { return Math.imul(h ^ v, 16777619) >>> 0; }
function strHash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); return h; }
function previewPPU() {
  var q = prefs.terrainQ || 'auto';
  if (q !== 'auto') return +q;
  var z = view.zoom * (window.devicePixelRatio || 1) * PPU;   // screen px per unit
  return z < 22 ? 25 : z < 60 ? 50 : 100;
}
function quickCanvas(t, cells) {
  cells = cells || t.cells;
  var sig = t.cols + 'x' + t.rows + ':' + strHash(TR.encodeRle(cells)) + ':' + t.types.length;
  if (TL.quick && TL.quickSig === sig) return TL.quick;
  var c = mkCanvas(t.cols, t.rows), x = c.getContext('2d'), im = x.createImageData(t.cols, t.rows);
  var rgb = t.types.map(function (ty) { var cc = ty.color || { r: .5, g: .5, b: .5 }; return [cc.r * 255, cc.g * 255, cc.b * 255]; });
  for (var i = 0; i < cells.length; i++) { var q = rgb[cells[i]] || rgb[0]; im.data[i * 4] = q[0]; im.data[i * 4 + 1] = q[1]; im.data[i * 4 + 2] = q[2]; im.data[i * 4 + 3] = 255; }
  x.putImageData(im, 0, 0); TL.quick = c; TL.quickSig = sig; return c;
}
function drawTerrainLayer(ctx) {
  var terr = hasTerrain(map), rin = riverInputs(map);
  if (!terr && !rin.length) return;
  var t = terr ? map.terrain : dummyTerrain(map), W = mapW(map), H = mapH(map), dcells = terr ? derivedCells(map) : t.cells;
  if (terr) { ctx.save(); ctx.imageSmoothingEnabled = false; var cp = cellPxOf(t); ctx.drawImage(quickCanvas(t, dcells), 0, 0, t.cols * cp, t.rows * cp); ctx.restore(); }
  if (!TL.tiles) return;
  var P = previewPPU(), k = P / PPU;
  var gkey = JSON.stringify([terr ? { c: t.cellSize, n: t.cols, r: t.rows, b: t.baseId, ty: t.types, l: t.look } : 0, P, rin]);
  if (gkey !== TL.ctxKey) {
    TL.ctxKey = gkey; TL.ctx = TR.prepare(t, rin, P, { riversOnly: !terr });
    TL.ctx.ghash = strHash(gkey.slice(0, 4000)) ^ strHash(gkey);
    TL.ctx.rhash = TL.ctx.rivers.map(function (r, i) { return strHash(JSON.stringify(rin[i]) || '' + i); });
  }
  var c = TL.ctx; c.cells = dcells;
  var lvl = TL.levels[P] || (TL.levels[P] = { P: P, chunks: {} });
  // visible rect in render px
  var vx0 = Math.max(0, -view.panX / view.zoom), vy0 = Math.max(0, -view.panY / view.zoom);
  var vx1 = Math.min(W, (canvas.clientWidth - view.panX) / view.zoom), vy1 = Math.min(H, (canvas.clientHeight - view.panY) / view.zoom);
  if (vx1 <= vx0 || vy1 <= vy0) return;
  // older quality levels first (stale but better than nothing)
  Object.keys(TL.levels).forEach(function (key) { if (+key !== P) drawLevel(ctx, TL.levels[key], vx0, vy0, vx1, vy1, null); });
  var RW = Math.ceil(W * k), RH = Math.ceil(H * k);
  var cx0 = Math.floor(vx0 * k / CHUNK), cy0 = Math.floor(vy0 * k / CHUNK), cx1 = Math.floor(Math.min(RW - 1, vx1 * k) / CHUNK), cy1 = Math.floor(Math.min(RH - 1, vy1 * k) / CHUNK);
  var cpR = c.s.cellPx, marg = terr ? Math.ceil((Math.min(110, Math.max(c.s.shallowWidth, c.s.foamWidth * 4, c.s.rimWidth * 2.5)) + 3 + cpR * 3) / cpR) + 1 : 0;
  TL.used++;
  for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
    var ox = cx * CHUNK, oy = cy * CHUNK, w = Math.min(CHUNK, RW - ox), h = Math.min(CHUNK, RH - oy);
    var sig = c.ghash, any = false;
    for (var ri = 0; ri < c.rivers.length; ri++) { var r = c.rivers[ri]; if (r.maxX >= ox && r.minX <= ox + w && r.maxY >= oy && r.minY <= oy + h) { sig = fnv(sig, c.rhash[ri]); any = true; } }
    if (!terr && !any) continue;
    if (terr) {
      var gx0 = Math.max(0, Math.floor(ox / cpR) - marg), gy0 = Math.max(0, Math.floor(oy / cpR) - marg), gx1 = Math.min(t.cols - 1, Math.floor((ox + w) / cpR) + marg), gy1 = Math.min(t.rows - 1, Math.floor((oy + h) / cpR) + marg);
      for (var gy = gy0; gy <= gy1; gy++) { var base = gy * t.cols; for (var gx = gx0; gx <= gx1; gx++) sig = fnv(sig, dcells[base + gx] + 1); }
    }
    var key = cx + ',' + cy, ch = lvl.chunks[key] || (lvl.chunks[key] = { ox: ox, oy: oy, w: w, h: h, canvas: null, sig: -1, want: -1 });
    ch.used = TL.used;
    if (ch.sig !== sig && ch.want !== sig) requestChunk(lvl, ch, sig, c);
  }
  drawLevel(ctx, lvl, vx0, vy0, vx1, vy1, null);
  pruneChunks();
}
function drawLevel(ctx, lvl, vx0, vy0, vx1, vy1) {
  var k = lvl.P / PPU;
  ctx.save(); ctx.imageSmoothingEnabled = true;
  for (var key in lvl.chunks) {
    var ch = lvl.chunks[key]; if (!ch.canvas) continue;
    var x = ch.ox / k, y = ch.oy / k, w = ch.w / k, h = ch.h / k;
    if (x > vx1 || y > vy1 || x + w < vx0 || y + h < vy0) continue;
    ctx.drawImage(ch.canvas, x, y, w + 0.6 / view.zoom, h + 0.6 / view.zoom);   // tiny overlap hides seams
  }
  ctx.restore();
}
function requestChunk(lvl, ch, sig, c) {
  ch.want = sig;
  TR.renderRect(c, ch.ox, ch.oy, ch.w, ch.h, function () { return ch.want !== sig; }).then(function (rgba) {
    if (ch.want !== sig) return;
    var cv = ch.canvas && ch.canvas.width === ch.w && ch.canvas.height === ch.h ? ch.canvas : mkCanvas(ch.w, ch.h);
    cv.getContext('2d').putImageData(new ImageData(rgba, ch.w, ch.h), 0, 0);
    ch.canvas = cv; ch.sig = sig; invalidate();
  }, function () { });
}
function pruneChunks() {
  var all = [];
  Object.keys(TL.levels).forEach(function (P) { var L = TL.levels[P]; Object.keys(L.chunks).forEach(function (k) { all.push([L, k, L.chunks[k].used || 0]); }); });
  if (all.length <= 420) return;
  all.sort(function (a, b) { return a[2] - b[2]; });
  for (var i = 0; i < all.length - 360; i++) { var ch = all[i][0].chunks[all[i][1]]; ch.want = -2; delete all[i][0].chunks[all[i][1]]; }
}
function resetTerrainCache() { Object.keys(TL.levels).forEach(function (P) { var L = TL.levels[P]; for (var k in L.chunks) L.chunks[k].want = -2; }); TL.levels = {}; TL.ctxKey = ''; }

// ---------------------------------------------------------------- export render (async, chunked, with progress)
function capScale(m, scale) { var W = mapW(m), H = mapH(m); return Math.min(scale, 16384 / Math.max(W, H), Math.sqrt(16384 * 16384 / 2 / (W * H))); }
function renderExportFull(m, scale, transparent, effects, onProgress, cancelled) {
  var terr = hasTerrain(m), rin = riverInputs(m);
  if (!terr && !rin.length) return Promise.resolve(renderExport(m, scale, transparent, effects));
  scale = capScale(m, scale);
  var W = mapW(m), H = mapH(m), cw = Math.round(W * scale), chh = Math.round(H * scale);
  return TR.loadTiles().then(function () {
    var t = terr ? Object.assign({}, m.terrain, { cells: derivedCells(m, true) }) : dummyTerrain(m), P = PPU * scale;
    var c = TR.prepare(t, rin, P, { transparentWater: transparent && terr, riversOnly: !terr });
    var out = mkCanvas(cw, chh), octx = out.getContext('2d');
    var layer = terr ? out : mkCanvas(cw, chh), lctx = layer.getContext('2d');
    var CH = 512, jobs = [], done = 0, list = [];
    for (var oy = 0; oy < chh; oy += CH) for (var ox = 0; ox < cw; ox += CH) {
      var w = Math.min(CH, cw - ox), h = Math.min(CH, chh - oy);
      if (!terr && !c.rivers.some(function (r) { return r.maxX >= ox && r.minX <= ox + w && r.maxY >= oy && r.minY <= oy + h; })) continue;
      list.push([ox, oy, w, h]);
    }
    list.forEach(function (q) {
      jobs.push(TR.renderRect(c, q[0], q[1], q[2], q[3], cancelled).then(function (rgba) {
        lctx.putImageData(new ImageData(rgba, q[2], q[3]), q[0], q[1]); done++; if (onProgress) onProgress(done / list.length);
      }));
    });
    return Promise.all(jobs).then(function () {
      octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
      octx.setTransform(cw / W, 0, 0, chh / H, 0, 0);
      if (!terr) { drawBackground(octx, m, { transparent: transparent }); octx.setTransform(1, 0, 0, 1, 0, 0); octx.drawImage(layer, 0, 0); octx.setTransform(cw / W, 0, 0, chh / H, 0, 0); }
      drawStamps(octx, m, { effects: effects });
      return { canvas: out, scale: scale };
    });
  });
}

// ---------------------------------------------------------------- land tool
var land = { type: 'grass', size: 3, round: true, mode: 'paint', seed: 1, density: 0.5, scale: 7, peaks: 0.3, forest: 0.35, growAmt: 2, rough: 0.5, linkW: 3, curve: 0.5, decoDensity: 0.5 };
if (prefs.land) Object.assign(land, prefs.land);
function saveLand() { prefs.land = land; savePrefs(); }
function ensureTerrain() {
  if (map.terrain) { if (!map.terrain.enabled) { map.terrain.enabled = true; } return map.terrain; }
  map.terrain = makeTerrain(map); toast('Created a ' + map.terrain.cols + ' × ' + map.terrain.rows + ' land grid'); renderMapCard();
  return map.terrain;
}
function landType(t, e) { if (e && e.altKey) return baseIndex(t); var i = typeIndex(t, land.type); return i < 0 ? 3 : i; }
function cellCoord(w) { var cp = cellPxOf(map.terrain); return { x: w.x / cp, y: w.y / cp }; }
function landDown(e, w) {
  checkpoint();
  var t = ensureTerrain(), c = cellCoord(w), ty = landType(t, e);
  if (land.mode === 'paint') {
    var ch = TR.brush(t.cells, t.cols, t.rows, c.x, c.y, land.size, land.round, ty);
    drag = { kind: 'land', last: c, type: ty, changed: ch }; changed();
  } else if (land.mode === 'rect' || land.mode === 'island') {
    drag = { kind: 'landrect', a: { x: Math.floor(c.x), y: Math.floor(c.y) }, b: { x: Math.floor(c.x), y: Math.floor(c.y) }, type: ty };
  } else if (land.mode === 'fill') {
    var n = TR.floodFill(t.cells, t.cols, t.rows, Math.floor(c.x), Math.floor(c.y), ty);
    if (!n) dropCheckpoint(); else { changed(); toast('Filled ' + n + ' squares'); }
    drag = { kind: 'placed' };
  } else if (land.mode === 'pick') {
    dropCheckpoint();
    var i = cellAtPx(map, w.x, w.y); if (i >= 0) { land.type = t.types[t.cells[i]].id; saveLand(); land.mode = 'paint'; renderBrushCard(); toast('Picked ' + t.types[t.cells[i]].name); }
    drag = { kind: 'placed' };
  }
}
function landMove(w) {
  var t = map.terrain, c = cellCoord(w);
  if (drag.kind === 'land') {
    var d = Math.hypot(c.x - drag.last.x, c.y - drag.last.y), n = Math.max(1, Math.ceil(d / 0.4));
    for (var i = 1; i <= n; i++) { var f = i / n; if (TR.brush(t.cells, t.cols, t.rows, drag.last.x + (c.x - drag.last.x) * f, drag.last.y + (c.y - drag.last.y) * f, land.size, land.round, drag.type)) drag.changed = true; }
    drag.last = c; changed();
  } else if (drag.kind === 'landrect') { drag.b = { x: Math.floor(c.x), y: Math.floor(c.y) }; invalidate(); }
}
function landFinish(d) {
  var t = map.terrain;
  if (d.kind === 'land') { if (!d.changed) dropCheckpoint(); else changed(); return; }
  var x0 = Math.max(0, Math.min(d.a.x, d.b.x)), y0 = Math.max(0, Math.min(d.a.y, d.b.y)), x1 = Math.min(t.cols - 1, Math.max(d.a.x, d.b.x)), y1 = Math.min(t.rows - 1, Math.max(d.a.y, d.b.y));
  if (land.mode === 'island') {
    if (x1 - x0 < 2 || y1 - y0 < 2) { x0 = Math.max(0, d.a.x - 6); y0 = Math.max(0, d.a.y - 5); x1 = Math.min(t.cols - 1, d.a.x + 6); y1 = Math.min(t.rows - 1, d.a.y + 5); }
    var before = t.cells.slice();
    t.cells = makeIslands(t, x0, y0, x1 - x0 + 1, y1 - y0 + 1, land.seed++); saveLand();
    if (!diffCount(before, t.cells)) { dropCheckpoint(); toast('No land generated — raise density'); } else changed();
    return;
  }
  var n = 0;
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) { var i = y * t.cols + x; if (t.cells[i] !== d.type) { t.cells[i] = d.type; n++; } }
  if (!n) dropCheckpoint(); else changed();
}
function diffCount(a, b) { var n = 0; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
function makeIslands(t, x, y, w, h, seed) {
  var main = landType(t), ix = function (id) { var i = typeIndex(t, id); return i < 0 ? 255 : i; };
  var coast = t.types[main].kind === 'Water' ? 255 : ix('sand'), peak = ix(t.types[main].id === 'ice' ? 'ice' : t.types[main].id === 'lava' ? 'lava' : 'rock'), forest = ix(t.types[main].id === 'swamp' ? 'swamp' : 'forest');
  if (t.types[main].id === 'sand' || t.types[main].id === 'ice') coast = 255;
  return TR.island(t.cells, t.cols, t.rows, waterMask(t), x, y, w, h, land.density, land.scale, main, coast, peak, land.peaks, forest, land.forest, seed);
}
function smartLand(op) {
  var t0 = map.terrain; if (!t0) { toast('Paint some land first'); return; }
  var useD = op !== 'clear' && op !== 'islands' && hasTerrain(map) && plugOn(map), painted = t0.cells, dc = useD ? derivedCells(map, true) : t0.cells;
  var t = useD ? Object.assign({}, t0, { cells: dc.slice() }) : t0;
  var before = t.cells.slice(), water = waterMask(t), msg = '';
  checkpoint();
  if (op === 'connect') {
    var r = TR.connect(t.cells, t.cols, t.rows, water, 3, land.linkW, land.curve, 0.45, landType(t), land.seed, 0.25);
    t.cells = r.cells; msg = r.blobs < 2 ? 'Need at least two islands to connect' : 'Connected ' + r.blobs + ' islands with ' + r.links + ' land bridges';
  } else if (op === 'grow') { t.cells = TR.grow(t.cells, t.cols, t.rows, water, land.growAmt, land.rough, typeIndex(t, 'sand'), land.seed, null); msg = 'Coastlines grown'; }
  else if (op === 'shrink') {   // erode: grow the water instead
    var inv = water.map(function (w) { return !w; });
    t.cells = TR.grow(t.cells, t.cols, t.rows, inv, land.growAmt, land.rough, baseIndex(t), land.seed, null); msg = 'Coastlines eroded';
  }
  else if (op === 'smooth') { t.cells = TR.smooth(t.cells, t.cols, t.rows, 2, null); msg = 'Smoothed'; }
  else if (op === 'beach') {   // sand ring between grass-like land and water
    var s = typeIndex(t, 'sand'), o = t.cells.slice();
    for (var y = 0; y < t.rows; y++) for (var x = 0; x < t.cols; x++) {
      var i = y * t.cols + x; if (water[t.cells[i]] || t.cells[i] === s) continue;
      var nearW = false; for (var dy = -1; dy <= 1 && !nearW; dy++) for (var dx = -1; dx <= 1; dx++) { var nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < t.cols && ny < t.rows && water[t.cells[ny * t.cols + nx]]) { nearW = true; break; } }
      if (nearW) o[i] = s;
    }
    t.cells = o; msg = 'Beaches added';
  }
  else if (op === 'islands') { t.cells = makeIslands(t, 0, 0, t.cols, t.rows, land.seed); msg = 'Islands generated'; }
  else if (op === 'clear') { t.cells = new Uint8Array(t.cols * t.rows).fill(baseIndex(t)); msg = 'Land cleared'; }
  land.seed = (land.seed + 1) % 100000; saveLand();
  var n = diffCount(before, t.cells);
  if (useD && n) { var pc = painted.slice(); for (var di = 0; di < pc.length; di++) if (t.cells[di] !== before[di]) pc[di] = t.cells[di]; t0.cells = pc; PG.sig = ''; }
  if (!n) { dropCheckpoint(); toast(msg && op === 'connect' ? msg : 'Nothing changed'); return; }
  changed(); toast(msg + ' · ' + n + ' squares changed');
}
/** Smart Fill with stickers on top of the land: trees on forest, rocks/peaks on rock & ice, marsh on swamp … */
var DECO = { forest: ['Temperate', ['forest', 'tree', 'feature']], grass: ['Temperate', ['feature', 'forest', 'tree']], dirt: ['Badlands', ['feature', 'ridge', 'peak']], swamp: ['Swamp', ['feature', 'forest', 'marsh']],
  ice: ['Alpine', ['peak', 'ridge', 'feature']], rock: ['Alpine', ['peak', 'ridge', 'feature']], lava: ['Ashlands', ['peak', 'feature', 'ridge']], sand: ['Tropical', ['feature', 'tree']] };
function riverSegs(m) {   // [x1,y1,x2,y2,halfWidthPx] for keeping stickers off rivers
  var out = [];
  riverInputs(m).forEach(function (r) {
    var st = r.style || {}, k = 0.5 + (st.meander || 0) * 0.8, lk = Math.max(st.lakeStart || 0, st.lakeEnd || 0) * PPU;
    for (var i = 1; i < r.points.length; i++) { var a = r.points[i - 1], b = r.points[i];
      out.push([a.px.x, a.px.y, b.px.x, b.px.y, Math.max(a.width, b.width) * PPU * k + (i === 1 || i === r.points.length - 1 ? lk : 0)]); }
  });
  return out;
}
function nearRiver(segs, x, y, margin) {
  for (var i = 0; i < segs.length; i++) { var g = segs[i], dx = g[2] - g[0], dy = g[3] - g[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - g[0]) * dx + (y - g[1]) * dy) / L)) : 0;
    if (Math.hypot(x - g[0] - t * dx, y - g[1] - t * dy) < g[4] + margin) return true; }
  return false;
}
function decorateLand() {
  var t0 = map.terrain; if (!hasTerrain(map)) { toast('Paint some land first'); return; }
  var dcl = derivedCells(map, true), dfrom = dcl !== t0.cells ? PG.from : null, t = Object.assign({}, t0, { cells: dcl });
  var cat = genCatalog(); if (!cat.length) { toast('No sprites loaded'); return; }
  var water = waterMask(t), rng = new TR.Rng(land.seed * 7 + 3), cp = cellPxOf(t), out = [], taken = {};
  function pool(id) {
    var d = DECO[id]; if (!d) return [];
    var feat = cat.filter(function (c) { var m = c.m || metaOf(c.key); return (c.type || '').match(/Features|Peaks/) && (m.size || 'medium') !== 'huge'; });
    for (var ti = 0; ti < d[1].length; ti++) {
      var tag = d[1][ti], inB = feat.filter(function (c) { return c.biome === d[0] && ((c.m || metaOf(c.key)).tags || []).indexOf(tag) >= 0; });
      if (inB.length) return inB;
    }
    var any = feat.filter(function (c) { return c.biome === d[0]; }); if (any.length) return any;
    return feat.filter(function (c) { return ((c.m || metaOf(c.key)).tags || []).indexOf(d[1][0]) >= 0; });
  }
  var segs = riverSegs(map);
  var pools = {}, prob = { forest: 0.9, grass: 0.22, dirt: 0.2, swamp: 0.35, ice: 0.25, rock: 0.5, lava: 0.35, sand: 0.06 };
  var step = Math.max(1, Math.round(0.6 / t.cellSize));   // one candidate per ~0.6 units
  for (var y = 0; y < t.rows; y += step) for (var x = 0; x < t.cols; x += step) {
    var jx = Math.min(t.cols - 1, x + Math.floor(rng.next() * step)), jy = Math.min(t.rows - 1, y + Math.floor(rng.next() * step)), i = jy * t.cols + jx, ty = t.types[t.cells[i]];
    if (water[t.cells[i]] || !prob[ty.id] || rng.next() > prob[ty.id] * land.decoDensity * 2.5) continue;
    if (dfrom && dfrom[i] === 1) continue;   // sticker art already has its own detail
    var coastal = false;   // keep stickers off the beach
    for (var dy = -1; dy <= 1 && !coastal; dy++) for (var dx = -1; dx <= 1; dx++) { var nx = jx + dx, ny = jy + dy; if (nx < 0 || ny < 0 || nx >= t.cols || ny >= t.rows || water[t.cells[ny * t.cols + nx]]) { coastal = true; break; } }
    if (coastal) continue;
    if (nearRiver(segs, (jx + 0.5) * cp, (jy + 0.5) * cp, cp * step)) continue;
    var p = pools[ty.id] || (pools[ty.id] = pool(ty.id)); if (!p.length) continue;
    var c = p[Math.floor(rng.next() * p.length)], sp = SPR[c.key]; if (!sp) continue;
    var px = (jx + 0.5) * cp, py = (jy + 0.5) * cp, target = cp * step * (1.1 + rng.next() * 0.8);
    var sc = Math.max(0.05, Math.min(1.5, target / Math.max(sp.w, sp.h)));
    out.push({ key: c.key, x: px, y: py, rot: 0, scale: sc, flipX: rng.next() < 0.5, layer: (c.type === 'Peaks' ? 'Peaks' : 'Features') });
  }
  checkpoint();
  var removed = map.stamps.length; map.stamps = map.stamps.filter(function (s) { return s.genGroup !== 'terrain-deco'; }); removed -= map.stamps.length;
  if (!out.length && !removed) { dropCheckpoint(); toast('No matching sticker sprites for these land types'); return; }
  out.forEach(function (o) {
    map.stamps.push({ id: map.nextId++, spriteKey: o.key, position: toUnits(map, o.x, o.y), rotation: o.rot, scale: v2(o.scale, o.scale), flipX: o.flipX, flipY: false, tint: col(1, 1, 1, 1),
      sortingLayer: LAYERS.indexOf(o.layer) >= 0 ? o.layer : 'Features', order: 0, type: '', shadow: 0, feather: 0, foam: 2, genGroup: 'terrain-deco' });
  });
  land.seed++; saveLand();
  loadForMap(map).then(invalidate); changed(); renderSel();
  toast('Decorated land with ' + out.length + ' stickers' + (removed ? ' (replaced ' + removed + ')' : ''));
}
function swatchGrid(t, get, set, filter) {
  var d = el('div', { class: 'swatches' });
  t.types.forEach(function (ty) {
    if (filter && !filter(ty)) return;
    var cc = ty.color || { r: .5, g: .5, b: .5 }, th = TR.tileThumb((ty.tileKeys || [])[0]);
    var b = el('button', { class: 'sw' + (get() === ty.id ? ' on' : ''), title: ty.name + (ty.id === t.baseId ? ' (base / eraser)' : ''), 'data-type': ty.id, onclick: function () { set(ty.id); Array.prototype.forEach.call(d.children, function (x) { x.classList.toggle('on', x === b); }); } }, [
      el('span', { class: 'swi', style: 'background:' + cssColor(col(cc.r, cc.g, cc.b, 1)) + (th ? ' url(' + th + ') center/cover' : '') }), el('span', { class: 'swn', text: ty.name.replace(' Water', '').replace(' / Snow', '') })]);
    d.appendChild(b);
  });
  return d;
}
function renderLandCard(b) {
  var t = map.terrain || { types: TR.defaultTypes(), baseId: 'deep' };
  b.appendChild(el('div', { class: 'sub', text: 'Square' }));
  b.appendChild(swatchGrid(t, function () { return land.type; }, function (v) { land.type = v; if (land.mode === 'pick') land.mode = 'paint'; saveLand(); }));
  b.appendChild(row('Mode', seg([['paint', 'Paint', 'Paint squares (B)'], ['rect', 'Rect', 'Drag a rectangle'], ['fill', 'Fill', 'Flood-fill a region'], ['island', 'Island', 'Drag a box: generates a natural island inside'], ['pick', 'Pick', 'Pick a type from the map']],
    function () { return land.mode; }, function (v) { land.mode = v; saveLand(); invalidate(); })));
  b.appendChild(slider('Brush size', 1, 24, 1, function () { return land.size; }, function (v) { land.size = Math.round(v); saveLand(); }, { noUndo: true, title: 'Squares across · [ ] change it' }));
  b.appendChild(row('Shape', seg([[false, '■ Square'], [true, '● Round']], function () { return land.round; }, function (v) { land.round = v; saveLand(); invalidate(); })));
  b.appendChild(el('div', { class: 'hint', html: 'Paint squares — neighbours <b>mesh together</b> into coastline with a sandy rim and foam. <b>Alt</b>-drag erases (paints deep water). Right/middle-drag pans.' }));
  b.appendChild(el('div', { class: 'sub', text: 'Smart Fill (land)' }));
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini', text: '⛓ Connect', title: 'Join separate islands with land bridges of the current type', onclick: function () { smartLand('connect'); } }),
    el('button', { class: 'mini', text: '⤢ Grow', title: 'Grow coastlines outward (with a sandy edge)', onclick: function () { smartLand('grow'); } }),
    el('button', { class: 'mini', text: '⤡ Erode', onclick: function () { smartLand('shrink'); } }),
    el('button', { class: 'mini', text: '≈ Smooth', title: 'Remove lone squares and jaggies', onclick: function () { smartLand('smooth'); } }),
    el('button', { class: 'mini', text: '⛱ Beaches', title: 'Ring the land with sand squares', onclick: function () { smartLand('beach'); } }),
    el('button', { class: 'mini', text: '🏝 Islands', title: 'Generate islands over the whole map (keeps what you painted)', onclick: function () { smartLand('islands'); } }),
    el('button', { class: 'mini', text: '🌲 Stickers', title: 'Decorate the land with sticker sprites (trees on forest, peaks on rock …). Re-run to re-roll.', onclick: decorateLand }),
    el('button', { class: 'mini danger', text: '✕ Clear', onclick: function () { smartLand('clear'); } })]));
  b.appendChild(slider('Bridge width', 1, 6, 1, function () { return land.linkW; }, function (v) { land.linkW = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Grow amount', 1, 6, 1, function () { return land.growAmt; }, function (v) { land.growAmt = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Island density', 0.1, 0.9, 0.01, function () { return land.density; }, function (v) { land.density = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Island size', 2, 20, 0.5, function () { return land.scale; }, function (v) { land.scale = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Peaks', 0, 1, 0.01, function () { return land.peaks; }, function (v) { land.peaks = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Forest', 0, 1, 0.01, function () { return land.forest; }, function (v) { land.forest = v; saveLand(); }, { noUndo: true }));
  b.appendChild(slider('Sticker density', 0.05, 1.5, 0.05, function () { return land.decoDensity; }, function (v) { land.decoDensity = v; saveLand(); }, { noUndo: true }));
  if (!map.terrain) return;
  var L = map.terrain.look;
  b.appendChild(el('div', { class: 'sub', text: 'Coast look' }));
  [['Rim (sand)', 'rimWidth', 0, 0.3, 0.005], ['Foam width', 'foamWidth', 0, 0.3, 0.005], ['Foam strength', 'foamStrength', 0, 1.5, 0.01], ['Edge noise', 'edgeNoise', 0, 1.5, 0.01],
   ['Shallows', 'shallowWidth', 0, 1.5, 0.01], ['Shallow tint', 'shallowStrength', 0, 1, 0.01], ['Coast shade', 'coastShade', 0, 0.6, 0.01], ['Texture size', 'variantScale', 0.5, 12, 0.1]].forEach(function (s) {
    b.appendChild(slider(s[0], s[2], s[3], s[4], function () { return L[s[1]]; }, function (v) { L[s[1]] = v; }, { lazy: true }));
  });
  b.appendChild(row('Foam colour', colorInput(function () { return L.foamColor; }, function (c) { L.foamColor = col(c.r, c.g, c.b, 1); })));
  b.appendChild(slider('Look seed', 0, 999, 1, function () { return L.seed; }, function (v) { L.seed = Math.round(v); }, { lazy: true }));
}
function renderLandGridSection(b) {
  b.appendChild(el('div', { class: 'sub', text: 'Land grid (squares)' }));
  var t = map.terrain;
  if (!t) {
    b.appendChild(el('div', { class: 'btnrow' }, [el('button', { class: 'mini', text: '▦ Create land grid', onclick: function () { checkpoint(); ensureTerrain(); changed(); renderMapCard(); if (tool !== 'land') setTool('land'); } })]));
    b.appendChild(el('div', { class: 'hint', text: 'Turns the background into ocean you paint land squares onto (L).' }));
    return;
  }
  b.appendChild(check('Land grid on', function () { return t.enabled; }, function (v) { t.enabled = v; renderMapCard(); }));
  b.appendChild(slider('Square size', 0.1, 2, 0.02, function () { return t.cellSize; }, function (v) { setCellSize(map, v); prefs.landCell = map.terrain.cellSize; savePrefs(); }, { lazy: true, title: 'Unity units per square (100 px per unit)', after: function () { renderMapCard(); } }));
  b.appendChild(el('div', { class: 'hint', text: t.cols + ' × ' + t.rows + ' squares · ' + Math.round(cellPxOf(t)) + ' px each' }));
  b.appendChild(check('Always show squares', function () { return t.showGrid; }, function (v) { t.showGrid = v; }));
  b.appendChild(row('Preview', seg([['auto', 'Auto'], ['25', 'Fast'], ['50', 'Normal'], ['100', 'Sharp']], function () { return prefs.terrainQ || 'auto'; }, function (v) { prefs.terrainQ = v; savePrefs(); invalidate(); })));
  b.appendChild(el('div', { class: 'btnrow' }, [el('button', { class: 'mini danger', text: '✕ Remove land grid', onclick: function () { checkpoint(); map.terrain = null; changed(); renderMapCard(); } })]));
}
function drawLandOverlay(ctx, px) {
  var t = map.terrain;
  if (t && t.enabled && (tool === 'land' || t.showGrid)) {
    var cp = cellPxOf(t);
    if (cp * view.zoom >= 6) {
      var W = mapW(map), H = mapH(map);
      var x0 = Math.max(0, Math.floor(-view.panX / view.zoom / cp)), x1 = Math.min(t.cols, Math.ceil((canvas.clientWidth - view.panX) / view.zoom / cp));
      var y0 = Math.max(0, Math.floor(-view.panY / view.zoom / cp)), y1 = Math.min(t.rows, Math.ceil((canvas.clientHeight - view.panY) / view.zoom / cp));
      ctx.save(); ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = px;
      for (var gx = x0; gx <= x1; gx++) { ctx.moveTo(gx * cp, y0 * cp); ctx.lineTo(gx * cp, Math.min(H, y1 * cp)); }
      for (var gy = y0; gy <= y1; gy++) { ctx.moveTo(x0 * cp, gy * cp); ctx.lineTo(Math.min(W, x1 * cp), gy * cp); }
      ctx.stroke(); ctx.restore();
    }
  }
  if (tool === 'land' && t && mouse.inside && !(drag && drag.kind === 'pan')) {
    var cp2 = cellPxOf(t), c = { x: mouse.x / cp2, y: mouse.y / cp2 };
    ctx.save(); ctx.strokeStyle = 'rgba(255,240,190,0.95)'; ctx.fillStyle = 'rgba(255,240,190,0.15)'; ctx.lineWidth = 1.5 * px;
    if (drag && drag.kind === 'landrect') {
      var ax = Math.min(drag.a.x, drag.b.x), ay = Math.min(drag.a.y, drag.b.y), bx = Math.max(drag.a.x, drag.b.x) + 1, by = Math.max(drag.a.y, drag.b.y) + 1;
      ctx.setLineDash([5 * px, 4 * px]); ctx.fillRect(ax * cp2, ay * cp2, (bx - ax) * cp2, (by - ay) * cp2); ctx.strokeRect(ax * cp2, ay * cp2, (bx - ax) * cp2, (by - ay) * cp2);
    } else if (land.mode === 'paint') {
      var s = land.size, r = s * 0.5, x0b = Math.floor(c.x - r + 0.5), y0b = Math.floor(c.y - r + 0.5);
      if (land.round && s > 2) { ctx.beginPath(); for (var yy = y0b; yy < y0b + s; yy++) for (var xx = x0b; xx < x0b + s; xx++) { var dx = xx + 0.5 - c.x, dy = yy + 0.5 - c.y; if (dx * dx + dy * dy <= r * r + 0.25) ctx.rect(xx * cp2, yy * cp2, cp2, cp2); } ctx.fill(); }
      else ctx.fillRect(x0b * cp2, y0b * cp2, s * cp2, s * cp2);
      ctx.strokeRect(x0b * cp2, y0b * cp2, s * cp2, s * cp2);
    } else { ctx.strokeRect(Math.floor(c.x) * cp2, Math.floor(c.y) * cp2, cp2, cp2); }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- river tool
var rv = { id: 0, pt: -1, drawing: false, width: 0.22, preset: 'Lowland river' };
function riverById(id) { for (var i = 0; i < map.rivers.length; i++) if (map.rivers[i].id === id) return map.rivers[i]; return null; }
function allPresets() {
  var ls = []; try { ls = JSON.parse(localStorage.getItem(RIVER_LS) || '[]'); } catch (e) { }
  var seen = {}, out = [];
  TR.BUILTIN_PRESETS.map(function (p) { return { name: p.name, style: p.style, builtin: true }; }).concat(map.riverPresets.map(function (p) { return { name: p.name, style: p.style, map: true }; }), ls.map(function (p) { return { name: p.name, style: p.style, mine: true }; }))
    .forEach(function (p) { if (!seen[p.name]) { seen[p.name] = 1; out.push(p); } else out.forEach(function (o, i) { if (o.name === p.name && !o.builtin) out[i] = Object.assign({}, o, p, { map: o.map || p.map, mine: o.mine || p.mine }); }); });
  return out;
}
function presetByName(n) { return allPresets().filter(function (p) { return p.name === n; })[0] || allPresets()[0]; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function newRiver(pt, parent) {
  var id = map.rivers.reduce(function (a, r) { return Math.max(a, r.id); }, 0) + 1, p = presetByName(rv.preset);
  var r = { id: id, name: (parent ? 'Branch ' : 'River ') + id, parentId: parent ? parent.id : 0, presetName: parent ? parent.presetName : p.name, visible: true,
    style: clone(parent ? parent.style : Object.assign(TR.defaultRiverStyle(), p.style)), points: [pt] };
  map.rivers.push(r); return r;
}
function riverHit(sp) {   // nearest point handle within 10 screen px; selected river first
  var best = null, bd = 11;
  var order = map.rivers.slice().sort(function (a, b) { return (b.id === rv.id) - (a.id === rv.id); });
  order.forEach(function (r) { r.points.forEach(function (p, i) { var q = toPx(map, p.position), s = toScreen(q.x, q.y); var d = Math.hypot(s.x - sp.x, s.y - sp.y); if (d < bd - (r.id === rv.id ? 0.5 : 0)) { bd = d; best = { r: r, i: i }; } }); });
  return best;
}
function segHit(r, w) {   // index to insert at, if the click is near a segment
  var best = -1, bd = 14 / view.zoom;
  for (var i = 0; i + 1 < r.points.length; i++) {
    var a = toPx(map, r.points[i].position), b = toPx(map, r.points[i + 1].position), dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    var f = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L)), d = Math.hypot(a.x + dx * f - w.x, a.y + dy * f - w.y);
    if (d < bd) { bd = d; best = i + 1; }
  }
  return best;
}
function riverDown(e, w, sp) {
  var hit = riverHit(sp), cur = riverById(rv.id), pt = { position: toUnits(map, w.x, w.y), width: rv.width };
  checkpoint();
  if (hit && (e.ctrlKey || e.metaKey)) {   // branch from this point
    var br = newRiver({ position: v2(hit.r.points[hit.i].position.x, hit.r.points[hit.i].position.y), width: hit.r.points[hit.i].width * 0.7 }, hit.r);
    rv.id = br.id; rv.pt = 0; rv.drawing = true; drag = { kind: 'rvpt', moved: true }; changed(); renderBrushCard(); toast('Branch started — click to add points, Enter to finish');
    return;
  }
  if (hit) { rv.id = hit.r.id; rv.pt = hit.i; if (rv.drawing && (!cur || hit.r.id !== cur.id)) rv.drawing = false; drag = { kind: 'rvpt', moved: false }; renderBrushCard(); invalidate(); return; }
  if (cur && e.shiftKey) { var at = segHit(cur, w); if (at > 0) { pt.width = (cur.points[at - 1].width + cur.points[at].width) / 2; cur.points.splice(at, 0, pt); rv.pt = at; drag = { kind: 'rvpt', moved: true }; changed(); renderBrushCard(); return; } }
  if (cur && rv.drawing) { if (rv.pt === 0 && cur.points.length > 1) { cur.points.unshift(pt); rv.pt = 0; } else { cur.points.push(pt); rv.pt = cur.points.length - 1; } }
  else { cur = newRiver(pt, null); rv.id = cur.id; rv.pt = 0; rv.drawing = true; }
  drag = { kind: 'rvpt', moved: true }; changed(); renderBrushCard();
}
function riverMove(w) { var r = riverById(rv.id); if (!r || !r.points[rv.pt]) return; r.points[rv.pt].position = toUnits(map, w.x, w.y); drag.moved = true; changed(); }
function riverFinish(d) { if (!d.moved) dropCheckpoint(); else { cleanupRivers(); changed(); renderBrushCard(); } }
function finishRiver() {
  if (!rv.drawing) return false;
  rv.drawing = false; cleanupRivers(); var r = riverById(rv.id); if (r) rv.pt = Math.min(rv.pt, r.points.length - 1);
  if (r && r.points.length < 2) { checkpoint(); map.rivers = map.rivers.filter(function (x) { return x !== r; }); rv.id = 0; changed(); toast('River needs at least two points'); }
  else if (r) toast(r.name + ' finished');
  renderBrushCard(); invalidate(); return true;
}
function cleanupRivers() {   // drop duplicate points (double-click, zero-length drags)
  map.rivers.forEach(function (r) { r.points = r.points.filter(function (p, i) { if (!i) return true; var q = r.points[i - 1]; return Math.hypot(p.position.x - q.position.x, p.position.y - q.position.y) > 0.02; }); });
}
function deleteRiverPoint() {
  var r = riverById(rv.id); if (!r) return false;
  checkpoint();
  if (rv.pt >= 0 && r.points.length > 1) { r.points.splice(rv.pt, 1); rv.pt = Math.min(rv.pt, r.points.length - 1); }
  else deleteRiver(r, true);
  changed(); renderBrushCard(); return true;
}
function deleteRiver(r, noCk) {
  if (!noCk) checkpoint();
  map.rivers = map.rivers.filter(function (x) { return x !== r && x.parentId !== r.id; });
  if (rv.id === r.id) { rv.id = 0; rv.pt = -1; rv.drawing = false; }
  if (!noCk) { changed(); renderBrushCard(); }
}
function riverWidthStep(f) {
  var r = riverById(rv.id);
  if (r && r.points[rv.pt]) { checkpoint(); r.points[rv.pt].width = Math.max(0.02, Math.min(5, r.points[rv.pt].width * f)); rv.width = r.points[rv.pt].width; changed(); renderBrushCard(); }
  else { rv.width = Math.max(0.02, Math.min(5, rv.width * f)); renderBrushCard(); invalidate(); }
}
function carveRivers(onlyId) {
  var list = map.rivers.filter(function (r) { return r.points.length >= 2 && (!onlyId || r.id === onlyId || r.parentId === onlyId); });
  if (!list.length) { toast('Draw a river first'); return; }
  checkpoint(); var t = ensureTerrain(), si = typeIndex(t, 'shallow'); if (si < 0) si = baseIndex(t);
  var P = 100, k = P / PPU, n = 0;
  list.forEach(function (r) {
    var sh = TR.buildShape({ id: r.id, style: r.style, visible: true, points: r.points.map(function (p) { return { px: toPx(map, p.position), width: p.width }; }) }, function (id) { return typeIndex(t, id); }, P, k);
    if (sh) n += TR.stampRiver(t.cells, t.cols, t.rows, cellPxOf(t) * k, sh, si, 0);
  });
  if (!n) { dropCheckpoint(); toast('River is already in the grid'); return; }
  changed(); toast('Carved ' + n + ' shallow-water squares into the land grid');
}
function savePreset(name) {
  var r = riverById(rv.id); if (!r || !name) return false;
  name = String(name).trim(); if (!name) return false;
  var ls = []; try { ls = JSON.parse(localStorage.getItem(RIVER_LS) || '[]'); } catch (e) { }
  ls = ls.filter(function (p) { return p.name !== name; }); ls.push({ name: name, style: clone(r.style) });
  try { localStorage.setItem(RIVER_LS, JSON.stringify(ls)); } catch (e) { }
  checkpoint(); map.riverPresets = map.riverPresets.filter(function (p) { return p.name !== name; }); map.riverPresets.push({ name: name, style: clone(r.style) });
  r.presetName = name; rv.preset = name; changed(); renderBrushCard(); toast('Saved river preset “' + name + '”'); return true;
}
function deletePreset(name) {
  var ls = []; try { ls = JSON.parse(localStorage.getItem(RIVER_LS) || '[]'); } catch (e) { }
  try { localStorage.setItem(RIVER_LS, JSON.stringify(ls.filter(function (p) { return p.name !== name; }))); } catch (e) { }
  checkpoint(); map.riverPresets = map.riverPresets.filter(function (p) { return p.name !== name; }); changed();
  rv.preset = 'Lowland river'; renderBrushCard(); toast('Deleted preset “' + name + '”');
}
function renderRiverCard(b) {
  var r = riverById(rv.id);
  b.appendChild(el('div', { class: 'hint', html: 'Click to drop points (drag while clicking to place). <b>Enter</b>/double-click finishes. Drag points to bend · <b>Shift</b>+click a segment inserts · <b>Ctrl</b>+click a point branches · <b>[ ]</b> width · <b>Del</b> removes a point.' }));
  var ps = el('select', {}, allPresets().map(function (p) { return el('option', { value: p.name, text: p.name + (p.builtin ? '' : ' ★') }); }));
  ps.value = r ? (r.presetName || rv.preset) : rv.preset;
  ps.addEventListener('change', function () {
    rv.preset = ps.value; var p = presetByName(ps.value), cur = riverById(rv.id);
    if (cur) { checkpoint(); cur.style = Object.assign(TR.defaultRiverStyle(), clone(p.style)); cur.presetName = p.name; changed(); }
    renderBrushCard();
  });
  b.appendChild(row('Preset', ps));
  b.appendChild(slider('New width', 0.02, 2, 0.01, function () { return rv.width; }, function (v) { rv.width = v; }, { noUndo: true, title: 'Width (units) of the next point you drop' }));
  // list
  b.appendChild(el('div', { class: 'sub', text: 'Rivers (' + map.rivers.length + ')' }));
  var lst = el('div', { class: 'rvlist' });
  map.rivers.forEach(function (x) {
    lst.appendChild(el('div', { class: 'rvrow' + (x.id === rv.id ? ' on' : '') }, [
      el('button', { class: 'mini', text: (x.visible ? '👁' : '—'), title: 'Show / hide', onclick: function () { checkpoint(); x.visible = !x.visible; changed(); renderBrushCard(); } }),
      el('span', { class: 'rvname', text: (x.parentId ? '↳ ' : '') + x.name + ' · ' + x.points.length + ' pts', onclick: function () { rv.id = x.id; rv.pt = x.points.length - 1; rv.drawing = false; renderBrushCard(); invalidate(); } }),
      el('button', { class: 'mini danger', text: '✕', title: 'Delete river (and its branches)', onclick: function () { deleteRiver(x); } })]));
  });
  if (!map.rivers.length) lst.appendChild(el('div', { class: 'muted', text: 'No rivers yet — click on the map to start one.' }));
  b.appendChild(lst);
  if (!r) return;
  var st = r.style;
  b.appendChild(el('div', { class: 'sub', text: 'Selected: ' + r.name }));
  var nm = el('input', { type: 'text', class: 'num', style: 'width:100%' }); nm.value = r.name;
  nm.addEventListener('change', function () { checkpoint(); r.name = nm.value || r.name; changed(); renderBrushCard(); });
  b.appendChild(row('Name', nm));
  if (r.points[rv.pt]) b.appendChild(slider('Point ' + (rv.pt + 1) + ' width', 0.02, 3, 0.01, function () { return r.points[rv.pt].width; }, function (v) { r.points[rv.pt].width = v; rv.width = v; }));
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini' + (rv.drawing ? ' on' : ''), text: rv.drawing ? '✓ Finish (Enter)' : '✎ Continue', onclick: function () { if (rv.drawing) finishRiver(); else { rv.drawing = true; rv.pt = r.points.length - 1; renderBrushCard(); } } }),
    el('button', { class: 'mini', text: '⇄ Reverse', onclick: function () { checkpoint(); r.points.reverse(); rv.pt = r.points.length - 1 - rv.pt; changed(); renderBrushCard(); } }),
    el('button', { class: 'mini', text: '▦ Carve into land', title: 'Write this river (and its branches) into the land grid as shallow-water squares', onclick: function () { carveRivers(r.id); } }),
    el('button', { class: 'mini danger', text: '✕ Delete', onclick: function () { deleteRiver(r); } })]));
  function S(label, k, min, max, step, title) { b.appendChild(slider(label, min, max, step, function () { return st[k]; }, function (v) { st[k] = v; }, { lazy: true, title: title })); }
  b.appendChild(el('div', { class: 'sub', text: 'River style (custom)' }));
  S('Taper source', 'taperStart', 0, 2, 0.01, 'Width multiplier at the first point (1 = no taper)');
  S('Taper mouth', 'taperEnd', 0, 2, 0.01, 'Width multiplier at the last point');
  S('Meander', 'meander', 0, 1.5, 0.01, 'How much the river wiggles');
  S('Wiggle length', 'meanderWave', 0.2, 5, 0.05, 'Units between bends');
  S('Lake at source', 'lakeStart', 0, 3, 0.01, 'Lake radius (units) at the first point');
  S('Lake at mouth', 'lakeEnd', 0, 3, 0.01, 'Lake radius (units) at the last point');
  var t = map.terrain || { types: TR.defaultTypes() };
  var bank = el('select', {}, [el('option', { value: '', text: 'None' })].concat(t.types.filter(function (x) { return x.kind !== 'Water'; }).map(function (x) { return el('option', { value: x.id, text: x.name }); })));
  bank.value = st.bankId || ''; bank.addEventListener('change', function () { checkpoint(); st.bankId = bank.value; changed(); });
  b.appendChild(row('Bank', bank));
  S('Bank width', 'bankWidth', 0, 0.4, 0.005);
  b.appendChild(row('Water', seg([[0, 'Ocean', 'Same colour as the sea'], [1, 'Lighter', 'Lighter, fresher water'], [2, 'Custom', 'Pick a colour (lava, swamp …)']], function () { return st.waterMode | 0; }, function (v) { checkpoint(); st.waterMode = v; changed(); renderBrushCard(); })));
  if ((st.waterMode | 0) === 2) b.appendChild(row('Colour', colorInput(function () { return st.customColor; }, function (c) { st.customColor = col(c.r, c.g, c.b, 1); })));
  b.appendChild(el('div', { class: 'row' }, [check('Foam edges', function () { return st.foam; }, function (v) { st.foam = v; }), check('Ripples', function () { return st.ripples; }, function (v) { st.ripples = v; })]));
  S('Foam width', 'foamWidth', 0, 0.15, 0.002);
  S('Shape seed', 'seed', 0, 999, 1);
  var isMine = !TR.BUILTIN_PRESETS.some(function (p) { return p.name === (r.presetName || ''); }) && r.presetName;
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini', text: '★ Save as preset…', onclick: function () { var n = prompt('Preset name', r.presetName && isMine ? r.presetName : r.name + ' style'); if (n) savePreset(n); } }),
    isMine ? el('button', { class: 'mini danger', text: '✕ Delete preset', onclick: function () { deletePreset(r.presetName); } }) : null]));
}
function drawRiverOverlay(ctx, px) {
  if (tool !== 'river') return;
  map.rivers.forEach(function (r) {
    var on = r.id === rv.id, pts = r.points.map(function (p) { return toPx(map, p.position); });
    ctx.save(); ctx.strokeStyle = on ? 'rgba(255,230,150,0.95)' : 'rgba(200,230,255,0.6)'; ctx.lineWidth = (on ? 1.6 : 1) * px; ctx.setLineDash(on ? [] : [5 * px, 4 * px]);
    ctx.beginPath(); pts.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.stroke(); ctx.setLineDash([]);
    pts.forEach(function (p, i) {
      var sel2 = on && i === rv.pt;
      if (on) { ctx.beginPath(); ctx.arc(p.x, p.y, r.points[i].width * PPU / 2, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,230,150,0.35)'; ctx.lineWidth = px; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, (sel2 ? 6 : 4) * px, 0, Math.PI * 2); ctx.fillStyle = sel2 ? '#f3dc97' : i === 0 ? '#9fd8ff' : '#1d1912'; ctx.fill();
      ctx.strokeStyle = on ? '#f3dc97' : '#cfe6ff'; ctx.lineWidth = 1.5 * px; ctx.stroke();
    });
    if (on && rv.drawing && mouse.inside && pts.length && !drag) {
      var end = rv.pt === 0 && pts.length > 1 ? pts[0] : pts[pts.length - 1];
      ctx.setLineDash([4 * px, 4 * px]); ctx.strokeStyle = 'rgba(255,230,150,0.7)'; ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
    }
    ctx.restore();
  });
  if (mouse.inside && !drag) { ctx.save(); ctx.beginPath(); ctx.arc(mouse.x, mouse.y, rv.width * PPU / 2, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(160,220,255,0.8)'; ctx.lineWidth = px; ctx.setLineDash([3 * px, 3 * px]); ctx.stroke(); ctx.restore(); }
}
canvas.addEventListener('dblclick', function () { if (tool === 'river') finishRiver(); });

// ================================================================== wiring + init
Array.prototype.forEach.call(document.querySelectorAll('.tool'), function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); }); });
$('btnUndo').addEventListener('click', undo); $('btnRedo').addEventListener('click', redo);
function toggleSnap() { prefs.snap = !prefs.snap; $('btnSnap').classList.toggle('on', prefs.snap); savePrefs(); toast('Snap ' + (prefs.snap ? 'on' : 'off')); invalidate(); }
$('btnSnap').addEventListener('click', toggleSnap);
$('btnGrid').addEventListener('click', function () { prefs.grid = !prefs.grid; this.classList.toggle('on', prefs.grid); savePrefs(); invalidate(); });
$('gridSize').addEventListener('change', function () { prefs.gridSize = Math.max(5, Math.min(1000, +this.value || 50)); this.value = prefs.gridSize; savePrefs(); invalidate(); });
$('btnZoomIn').addEventListener('click', function () { zoomCenter(1.25); }); $('btnZoomOut').addEventListener('click', function () { zoomCenter(0.8); });
$('btnZoomPct').addEventListener('click', function () { var f = 1 / view.zoom; zoomCenter(f); });
$('btnFit').addEventListener('click', fit); $('btnHelp').addEventListener('click', openHelp); $('btnFinish').addEventListener('click', openExport);
$('btnNew').addEventListener('click', function () {
  if ((map.stamps.length || map.rivers.length || hasTerrain(map)) && !confirm('Start a new empty map? (You can undo this.)')) return;
  checkpoint(); var keep = { w: mapW(map), h: mapH(map), bg: bgKind(map) }; var hadT = map.terrain ? map.terrain.cellSize : 0; map = newMap(keep.w, keep.h, keep.bg); if (hadT) map.terrain = makeTerrain(map, hadT); rv.id = 0; rv.drawing = false; sel = []; afterMapChange(false); toast('New map');
});
$('btnOpen').addEventListener('click', function () { $('fileOpen').click(); });
$('btnSave').addEventListener('click', saveJson);
$('btnExample').addEventListener('click', function () { if (window.MM_EXAMPLE) openJsonText(JSON.stringify(window.MM_EXAMPLE), 'example map'); });
$('search').addEventListener('input', function () { renderTabs(); renderPalette(); });
$('thumbSize').addEventListener('input', function () { prefs.thumb = +this.value; Array.prototype.forEach.call(document.querySelectorAll('#palette .grid'), function (g) { g.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + prefs.thumb + 'px,1fr))'; }); });
$('thumbSize').addEventListener('change', savePrefs);
$('showNames').addEventListener('change', function () { prefs.names = this.checked; savePrefs(); renderPalette(); });
$('shuffle').addEventListener('change', function () { prefs.shuffle = this.checked; savePrefs(); });
$('btnRandom').addEventListener('click', randomPick);
$('btnImport').addEventListener('click', function () { $('fileImport').click(); });
$('fileImport').addEventListener('change', function () { var f = Array.prototype.slice.call(this.files); this.value = ''; if (f.length) importFiles(f); });
$('impConfirm').addEventListener('click', confirmImport);
window.addEventListener('resize', resize);
window.addEventListener('beforeunload', autosave);

function init() {
  $('gridSize').value = prefs.gridSize; $('thumbSize').value = prefs.thumb; $('showNames').checked = prefs.names; $('shuffle').checked = prefs.shuffle;
  $('btnSnap').classList.toggle('on', prefs.snap); $('btnGrid').classList.toggle('on', prefs.grid);
  if (prefs.tab !== 'All' && prefs.tab !== '★' && prefs.tab !== 'Recent' && prefs.tab !== 'Mine' && !CATS[prefs.tab]) prefs.tab = 'All';
  var restored = false;
  try { var a = localStorage.getItem(LS_AUTOSAVE); if (a) { map = normalizeMap(JSON.parse(a)); restored = true; } } catch (e) { }
  if (!restored) map = window.MM_EXAMPLE ? normalizeMap(window.MM_EXAMPLE) : newMap();
  brush.key = prefs.recent.filter(function (k) { return SPR[k]; })[0] || (map.stamps[0] && SPR[map.stamps[0].spriteKey] ? map.stamps[0].spriteKey : MAN.sprites.length ? MAN.sprites[0][0] : null);
  if (brush.key) loadCategory(SPR[brush.key].cat);
  resize(); renderTabs(); renderPalette(); setTool(map.stamps.length ? 'select' : 'place');
  renderSel(); renderMapCard(); renderFxCard(); updateUndoButtons(); fit();
  TR.loadTiles().then(function () { TL.tiles = true; invalidate(); });
  Promise.all([loadForMap(map), loadCustom()]).then(function () { return loadForMap(map); }).then(function () { map.stamps.forEach(function (s) { plugInfo(s.spriteKey); }); return plugKeysReady(); }).then(function () { PG.sig = ''; invalidate(); document.body.dataset.ready = '1'; });
  var ab = $('btnAutoFill'); if (ab) ab.addEventListener('click', function () { autoFill(); });
  toast(restored ? 'Restored your autosaved map' : 'Loaded the example map — press Finish & Download when done');
}
// ================================================================== plug & play: water keying, merge into land, fit-to-neighbours, variation, remix
// Ocean water inside sticker art is keyed out (build-time masks in assets/masks.js, JS fallback for imported sprites),
// sticker land is written into a derived copy of the land grid (painted squares stay separate), gaps between nearby
// pieces are bridged, and the art is drawn feathered / colour-varied / mesh-warped toward its neighbours.
var MASKS = window.MM_MASKS || {};
var PLUG_CODES = '.~oSGDFWIRL', PLUG_LAND = ['sand', 'grass', 'dirt', 'forest', 'swamp', 'ice', 'rock', 'lava'];
var PLUG_RGB = [[200, 171, 121], [120, 124, 57], [102, 77, 52], [63, 75, 43], [80, 75, 53], [166, 172, 183], [109, 107, 105], [83, 46, 32]];
function defaultPlug() { return { on: true, gap: 0.8, warp: 0.5, variation: 0.35, snap: true, soft: 0.6 }; }
function plugOn(m) { return !!(m && m.plug && m.plug.on); }
function decodeCodes(str, n) {
  var out = new Uint8Array(n), i = 0, p = 0;
  while (p < str.length && i < n) {
    var ch = str[p++], num = '';
    while (p < str.length && str.charCodeAt(p) >= 48 && str.charCodeAt(p) <= 57) num += str[p++];
    var cnt = num ? +num : 1, code = Math.max(0, PLUG_CODES.indexOf(ch));
    for (var k = 0; k < cnt && i < n; k++) out[i++] = code;
  }
  return out;
}
function lumToAlpha(img, w, h) {   // grey key image -> canvas whose alpha = key
  w = w || img.naturalWidth || img.width; h = h || img.naturalHeight || img.height;
  var c = mkCanvas(w, h), x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
  var id = x.getImageData(0, 0, w, h), d = id.data;
  for (var i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; }
  x.putImageData(id, 0, 0); return c;
}
var plugKeyWait = [];
function plugInfo(key) {
  var sp = SPR[key]; if (!sp) return null;
  if (sp.plug !== undefined) return sp.plug;
  var rec = MASKS[key];
  if (!rec) { if (!sp.ready) return null; rec = analysePlugJS(sp); }
  var n = rec.gw * rec.gh, g = rec.codes || decodeCodes(rec.g || '', n), landN = 0;
  for (var i = 0; i < n; i++) if (g[i] >= 2) landN++;
  var info = { ocean: rec.ocean || 0, pond: rec.pond || 0, gw: rec.gw, gh: rec.gh, g: g, dom: rec.dom || 'grass', land: landN / Math.max(1, n), keyC: rec.keyC || null, k: rec.k || null };
  if (rec.k && !info.keyC) plugKeyWait.push(new Promise(function (res) {
    var im = new Image();
    im.onload = function () { info.keyC = lumToAlpha(im); sp.fx = {}; PG.sig = ''; invalidate(); res(); };
    im.onerror = function () { res(); }; im.src = rec.k;
  }));
  sp.plug = info; return info;
}
function plugKeysReady() { var w = plugKeyWait; plugKeyWait = []; return Promise.all(w); }
/** JS fallback for imported / remixed sprites: same water score as tools/build_masks.py, smaller resolution */
function analysePlugJS(sp) {
  var iw = sp.img.naturalWidth, ih = sp.img.naturalHeight, k = Math.min(1, 160 / Math.max(iw, ih)), w = Math.max(2, Math.round(iw * k)), h = Math.max(2, Math.round(ih * k));
  var c = mkCanvas(w, h), x = c.getContext('2d'); x.drawImage(sp.img, 0, 0, w, h);
  var d = x.getImageData(0, 0, w, h).data, n = w * h, sc = new Float32Array(n), al = new Uint8Array(n);
  function cl(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  for (var i = 0; i < n; i++) {
    var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    al[i] = d[i * 4 + 3] > 100 ? 1 : 0;
    sc[i] = al[i] ? cl((b - r - 6) / 22) * cl((b - g + 28) / 26) * cl((sat - 0.12) / 0.12) * cl((165 - mx) / 30) : 0;
  }
  for (var pass = 0; pass < 2; pass++) {   // 3x3 box blur
    var o = new Float32Array(n);
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) { var s = 0, q = 0; for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var X = xx + dx, Y = yy + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; s += sc[Y * w + X]; q++; } o[yy * w + xx] = s / q; }
    sc = o;
  }
  var wat = new Uint8Array(n); for (i = 0; i < n; i++) wat[i] = al[i] && sc[i] > 0.42 ? 1 : 0;
  // components touching the outline / transparency = ocean, others = pond
  var lab = new Int32Array(n).fill(-1), oceanC = [], nc = 0, stack = [];
  for (i = 0; i < n; i++) {
    if (!wat[i] || lab[i] >= 0) continue;
    var edge = false, cnt = 0; lab[i] = nc; stack.push(i);
    while (stack.length) {
      var p = stack.pop(), px = p % w, py = (p / w) | 0; cnt++;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) edge = true;
      for (var e = 0; e < 4; e++) {
        var nx = px + (e === 0 ? 1 : e === 1 ? -1 : 0), ny = py + (e === 2 ? 1 : e === 3 ? -1 : 0); if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var j = ny * w + nx; if (!al[j]) edge = true;
        if (wat[j] && lab[j] < 0) { lab[j] = nc; stack.push(j); }
      }
    }
    oceanC[nc++] = edge && cnt > n * 0.004;
  }
  var oceanN = 0, pondN = 0, kc = mkCanvas(w, h), kx = kc.getContext('2d'), kid = kx.createImageData(w, h);
  for (i = 0; i < n; i++) { var oc = lab[i] >= 0 && oceanC[lab[i]]; if (oc) { oceanN++; kid.data[i * 4 + 3] = 255; } else if (lab[i] >= 0) pondN++; }
  kx.putImageData(kid, 0, 0);
  var keyC = null;
  if (oceanN > n * 0.02) { keyC = mkCanvas(w, h); blurInto(keyC, kc, 1.2, 1); }
  // 40-cell code grid
  var gw = Math.max(1, Math.min(40, Math.round(40 * w / Math.max(w, h)))), gh = Math.max(1, Math.min(40, Math.round(40 * h / Math.max(w, h)))), codes = new Uint8Array(gw * gh), votes = new Array(PLUG_LAND.length);
  var domCnt = PLUG_LAND.map(function () { return 0; });
  for (var cy = 0; cy < gh; cy++) for (var cx = 0; cx < gw; cx++) {
    var x0 = Math.floor(cx * w / gw), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * w / gw)), y0 = Math.floor(cy * h / gh), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * h / gh));
    var tA = 0, tO = 0, tP = 0, tL = 0, R = 0, G = 0, B = 0;
    for (var yy2 = y0; yy2 < y1; yy2++) for (var xx2 = x0; xx2 < x1; xx2++) {
      var ii = yy2 * w + xx2;
      if (!al[ii]) tA++; else if (lab[ii] >= 0 && oceanC[lab[ii]]) tO++; else if (lab[ii] >= 0) tP++; else { tL++; R += d[ii * 4]; G += d[ii * 4 + 1]; B += d[ii * 4 + 2]; }
    }
    var best = Math.max(tA, tO, tP, tL), code = 0;
    if (best === tL && tL) {
      R /= tL; G /= tL; B /= tL; var bi = 0, bd = 1e9;
      PLUG_RGB.forEach(function (q, qi) { var dd = (q[0] - R) * (q[0] - R) + (q[1] - G) * (q[1] - G) + (q[2] - B) * (q[2] - B); if (dd < bd) { bd = dd; bi = qi; } });
      code = 3 + bi; domCnt[bi]++;
    } else if (best === tO) code = 1; else if (best === tP) code = 2; else code = 0;
    codes[cy * gw + cx] = code;
  }
  var dm = 0; domCnt.forEach(function (v, i2) { if (v > domCnt[dm]) dm = i2; });
  return { ocean: oceanN / n, pond: pondN / n, gw: gw, gh: gh, codes: codes, dom: PLUG_LAND[dm], keyC: keyC };
}
function autoMerge(s) {
  var t = stampType(s); if (t === 4 || t === 5) return false;
  var info = plugInfo(s.spriteKey); if (!info || info.land < 0.04) return false;
  return t === 1 || t === 3 || info.ocean > 0.02;
}
function isMerged(m, s) { if (!plugOn(m) || s.merge === 2) return false; return s.merge === 1 ? !!plugInfo(s.spriteKey) : autoMerge(s); }
function isKeyed(m, s) { if (!plugOn(m)) return false; var info = plugInfo(s.spriteKey); return !!(info && info.keyC && info.ocean > 0.02); }
function plugSkipFx(m, s) { return plugOn(m) && (isMerged(m, s) || isKeyed(m, s)); }
function mergedList(m) { return sortedStamps(m).filter(function (s) { return !s._ghost && SPR[s.spriteKey] && isMerged(m, s); }); }

// ---- small value noise (deterministic)
function hash2(x, y, s) { var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y, s) {
  var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** two-pass chamfer distance (in cells) to the nearest src cell; near = index of that cell */
function chamfer(src, cols, rows) {
  var n = cols * rows, d = new Float32Array(n), near = new Int32Array(n), D = 1.4142;
  for (var i = 0; i < n; i++) { if (src[i]) { d[i] = 0; near[i] = i; } else { d[i] = 1e9; near[i] = -1; } }
  function rel(i, j, c) { if (d[j] + c < d[i]) { d[i] = d[j] + c; near[i] = near[j]; } }
  for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
    i = y * cols + x;
    if (x > 0) rel(i, i - 1, 1);
    if (y > 0) { rel(i, i - cols, 1); if (x > 0) rel(i, i - cols - 1, D); if (x < cols - 1) rel(i, i - cols + 1, D); }
  }
  for (y = rows - 1; y >= 0; y--) for (x = cols - 1; x >= 0; x--) {
    i = y * cols + x;
    if (x < cols - 1) rel(i, i + 1, 1);
    if (y < rows - 1) { rel(i, i + cols, 1); if (x < cols - 1) rel(i, i + cols + 1, D); if (x > 0) rel(i, i + cols - 1, D); }
  }
  return { d: d, near: near };
}
/** Cut-off land at a sprite's rectangle edge gets a noisy, rounded coastline (art + land grid use the same function).
 *  Returns signed px distance past the noisy inset line (<0 = cut away). */
function edgeCut(sp, lx, ly) {
  var B = 0.085 * Math.max(sp.w, sp.h), e = Math.min(lx + sp.w / 2, sp.w / 2 - lx, ly + sp.h / 2, sp.h / 2 - ly);
  if (e > B * 1.05) return 1e9;
  var sd = strHash(sp.key) & 1023, sc = B * 1.3, n = 0.62 * vnoise(lx / sc, ly / sc, sd) + 0.38 * vnoise(lx / sc * 2.3, ly / sc * 2.3, sd + 7);
  return e - B * (0.2 + 0.8 * n);
}
function codeAt(info, sp, lx, ly) {   // local sprite px (centred) -> mask code (0 outside)
  var u = lx / sp.w + 0.5, v = ly / sp.h + 0.5;
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
  return info.g[Math.floor(v * info.gh) * info.gw + Math.floor(u * info.gw)];
}

// ---- derived land grid = painted squares + merged sticker land + bridges
var PG = { sig: '', cells: null, from: null, owner: null, pull: {}, time: 0, len: 0, timer: 0 };
function plugSig(m, list) {
  var t = m.terrain, p = m.plug, h = strHash(t.cols + 'x' + t.rows + ':' + t.cellSize + ':' + p.gap + ':' + p.warp + ':' + t.types.map(function (x) { return x.id; }).join());
  for (var i = 0; i < t.cells.length; i++) h = fnv(h, t.cells[i]);
  list.forEach(function (s) { var info = plugInfo(s.spriteKey); h = fnv(h, strHash(s.id + s.spriteKey + s.position.x + ',' + s.position.y + ',' + s.rotation + ',' + s.scale.x + ',' + s.scale.y + (s.flipX ? 'x' : '') + (s.flipY ? 'y' : '') + s.order + s.sortingLayer + (info && info.keyC ? 'k' : ''))); });
  return list.length + ':' + h;
}
function derivedCells(m, force) {
  if (!hasTerrain(m)) return m.terrain ? m.terrain.cells : null;
  var t = m.terrain;
  if (!plugOn(m)) return t.cells;
  var list = mergedList(m);
  if (!list.length) { PG.from = null; PG.owner = null; PG.pull = {}; PG.list = []; return t.cells; }
  var sig = plugSig(m, list);
  if (sig === PG.sig && PG.cells && PG.len === t.cells.length) return PG.cells;
  var now = performance.now();
  if (!force && drag && PG.cells && PG.len === t.cells.length && now - PG.time < 120) {
    clearTimeout(PG.timer); PG.timer = setTimeout(invalidate, 130); return PG.cells;
  }
  buildDerived(m, list); PG.sig = sig; PG.time = performance.now(); PG.len = t.cells.length;
  return PG.cells;
}
function buildDerived(m, list) {
  var t = m.terrain, cols = t.cols, rows = t.rows, n = cols * rows, cp = cellPxOf(t), p = m.plug;
  var out = t.cells.slice(), from = new Uint8Array(n), owner = new Int32Array(n), water = waterMask(t), land = new Uint8Array(n);
  for (var i = 0; i < n; i++) land[i] = water[out[i]] ? 0 : 1;
  var gi = Math.max(0, typeIndex(t, 'grass')), codeIdx = PLUG_LAND.map(function (id) { var k = typeIndex(t, id); return k < 0 ? gi : k; });
  var geo = [];
  list.forEach(function (s, li) {
    var sp = SPR[s.spriteKey], info = plugInfo(s.spriteKey); if (!sp || !info) return;
    var M = stampMatrix(m, s), bb = stampAabb(m, s), domI = codeIdx[Math.max(0, PLUG_LAND.indexOf(info.dom))];
    geo.push({ s: s, sp: sp, info: info, M: M, bb: bb });
    var x0 = Math.max(0, Math.floor(bb.minX / cp)), x1 = Math.min(cols - 1, Math.floor(bb.maxX / cp)), y0 = Math.max(0, Math.floor(bb.minY / cp)), y1 = Math.min(rows - 1, Math.floor(bb.maxY / cp));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var l = invM(M, (x + 0.5) * cp, (y + 0.5) * cp), code = codeAt(info, sp, l.x, l.y);
      if (code < 2 || edgeCut(sp, l.x, l.y) < 0) continue;
      var j = y * cols + x; out[j] = code === 2 ? domI : codeIdx[code - 3]; from[j] = 1; owner[j] = li + 1; land[j] = 1;
    }
  });
  // bridge small gaps (morphological closing with a noisy radius), only near sticker land
  var gapC = p.gap * PPU / cp;
  if (gapC >= 1) {
    var r = gapC / 2, d1 = chamfer(land, cols, rows), fromS = new Uint8Array(n); for (i = 0; i < n; i++) fromS[i] = from[i] === 1 ? 1 : 0;
    var dS = chamfer(fromS, cols, rows), dil = new Uint8Array(n), nz = new Float32Array(n), sc = Math.max(2, 1.2 / t.cellSize);
    for (i = 0; i < n; i++) { nz[i] = 0.7 + 0.6 * vnoise((i % cols) / sc, ((i / cols) | 0) / sc, 91); dil[i] = d1.d[i] <= r * nz[i] ? 0 : 1; }
    var d2 = chamfer(dil, cols, rows);
    for (i = 0; i < n; i++) {
      if (land[i] || d2.d[i] <= r * nz[i] || dS.d[i] > gapC * 1.2) continue;
      var nr = d1.near[i]; if (nr < 0) continue;
      out[i] = out[nr]; from[i] = 2; owner[i] = owner[nr];
    }
  }
  PG.cells = out; PG.from = from; PG.owner = owner; PG.list = list;
  // edge pull for the mesh warp: border vertices of each piece move toward neighbouring land across the water gap
  PG.pull = {};
  if (p.warp > 0) geo.forEach(function (g, gi2) { var pl = computePull(m, g, gi2 + 1, cols, rows, cp, owner, out, water); if (pl) PG.pull[g.s.id] = pl; });
}
var WARP_N = 8;
function computePull(m, g, me, cols, rows, cp, owner, cells, water) {
  var N = WARP_N, sp = g.sp, info = g.info, M = g.M, p = m.plug, disp = new Float32Array((N + 1) * (N + 1) * 2), any = false;
  var maxD = (p.gap * PPU + 40) * Math.max(0.2, p.warp) + 30, lim = 0.16 * Math.max(sp.w, sp.h), step = Math.max(4, cp * 0.5);
  function landAt(x, y) { var cx = Math.floor(x / cp), cy = Math.floor(y / cp); if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return 0; var j = cy * cols + cx; return water[cells[j]] ? 0 : owner[j] === me ? 1 : 2; }
  for (var j = 0; j <= N; j++) for (var i = 0; i <= N; i++) {
    if (i > 0 && i < N && j > 0 && j < N) continue;
    var lx = (i / N - 0.5) * sp.w, ly = (j / N - 0.5) * sp.h, nx = i === 0 ? -1 : i === N ? 1 : 0, ny = j === 0 ? -1 : j === N ? 1 : 0, nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
    // only edges where this piece's land is cut by its rectangle
    var c0 = codeAt(info, sp, lx - nx * sp.w * 0.04, ly - ny * sp.h * 0.04); if (c0 < 2) continue;
    var P0 = applyM(M, lx, ly), P1 = applyM(M, lx + nx * 10, ly + ny * 10), dl = Math.hypot(P1.x - P0.x, P1.y - P0.y) || 1, dx = (P1.x - P0.x) / dl, dy = (P1.y - P0.y) / dl;
    if (landAt(P0.x, P0.y) === 2) continue;   // already overlapping a neighbour
    var hit = -1;
    for (var tt = step; tt <= maxD; tt += step) { if (landAt(P0.x + dx * tt, P0.y + dy * tt) === 2) { hit = tt; break; } }
    if (hit < 0) continue;
    var gx = dx * (hit + step * 0.5) * p.warp, gy = dy * (hit + step * 0.5) * p.warp, L = invM(M, P0.x + gx, P0.y + gy), ux = L.x - lx, uy = L.y - ly, ul = Math.hypot(ux, uy);
    if (ul > lim) { ux *= lim / ul; uy *= lim / ul; }
    var k = (j * (N + 1) + i) * 2; disp[k] = ux; disp[k + 1] = uy; any = true;
  }
  if (!any) return null;
  // spread into the first interior ring so the stretch is gradual
  for (j = 1; j < N; j++) for (i = 1; i < N; i++) {
    var sx = 0, sy = 0, c = 0;
    [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]].forEach(function (q) { if (q[0] === 0 || q[0] === N || q[1] === 0 || q[1] === N) { var kk = (q[1] * (N + 1) + q[0]) * 2; sx += disp[kk]; sy += disp[kk + 1]; c++; } });
    if (c) { var k2 = (j * (N + 1) + i) * 2; disp[k2] = sx / c * 0.45; disp[k2 + 1] = sy / c * 0.45; }
  }
  var h = 2166136261; for (i = 0; i < disp.length; i++) h = fnv(h, Math.round(disp[i] / 2));
  disp.hash = h; return disp;
}

// ---- processed sticker textures (keyed + feathered + colour variation + mesh warp), small LRU
var PLRU = [];
function plugCache(sp, key, make) {
  var v = sp.fx[key]; if (v) return v;
  v = sp.fx[key] = make(); PLRU.push([sp, key]);
  while (PLRU.length > 140) { var o = PLRU.shift(); if (o[0].fx) delete o[0].fx[o[1]]; }
  return v;
}
function q2(v) { return Math.round(v * 100) / 100; }
function plugTex(m, s, sp) {
  if (!plugOn(m) || !sp.ready) return null;
  var info = plugInfo(s.spriteKey), keyed = !!(info && info.keyC && info.ocean > 0.02), merged = isMerged(m, s), p = m.plug;
  var v = s.vary, va = v ? p.variation : 0, pull = merged && !s._ghost ? PG.pull[s.id] : null;
  if (!keyed && !merged && !(va > 0)) return null;
  var fe = merged ? q2(p.soft) : 0, hue = va ? Math.round(v.h * 12 * va) : 0, sat = va ? q2(1 + v.s * 0.2 * va) : 1, bri = va ? q2(1 + v.b * 0.12 * va) : 1, wn = va ? q2(v.w * va) : 0;
  var colKey = hue || sat !== 1 || bri !== 1 ? hue + ',' + sat + ',' + bri : '';
  var bkey = 'pb|' + (keyed ? 1 : 0) + '|' + fe + '|' + colKey;
  var base = plugCache(sp, bkey, function () { return plugBase(sp, keyed ? info : null, fe, colKey ? [hue, sat, bri] : null); });
  if (!pull && wn < 0.02) return { c: base, pad: 0 };
  var seed = v ? v.seed | 0 : s.id;
  return plugCache(sp, 'pw|' + bkey + '|' + (pull ? pull.hash : 0) + '|' + wn + '|' + seed, function () { return plugWarp(base, sp, pull, wn, seed); });
}
function colorMatrix(hue, sat, bri) {   // CSS-style hue-rotate * saturate * brightness
  var a = hue * Math.PI / 180, c = Math.cos(a), n = Math.sin(a);
  var H = [0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
    0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140, 0.072 - c * 0.072 - n * 0.283,
    0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072];
  var s = sat, S = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  var R = [];
  for (var r = 0; r < 3; r++) for (var k = 0; k < 3; k++) R[r * 3 + k] = (S[r * 3] * H[k] + S[r * 3 + 1] * H[3 + k] + S[r * 3 + 2] * H[6 + k]) * bri;
  return R;
}
function plugBase(sp, info, fe, colv) {
  var iw = sp.img.naturalWidth, ih = sp.img.naturalHeight, c = mkCanvas(iw, ih), x = c.getContext('2d');
  x.drawImage(sp.img, 0, 0);
  if (info && info.keyC) { x.save(); x.globalCompositeOperation = 'destination-out'; x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(info.keyC, 0, 0, iw, ih); x.restore(); }
  if (!(fe > 0) && !colv) return c;
  var id = x.getImageData(0, 0, iw, ih), d = id.data;
  if (fe > 0) {
    var F = Math.max(2, fe * 0.055 * Math.max(iw, ih)), bl = mkCanvas(iw, ih); blurInto(bl, c, F, 1);
    var bd = bl.getContext('2d').getImageData(0, 0, iw, ih).data;
    var fw = 0.03 * Math.max(sp.w, sp.h);
    for (var i = 3; i < d.length; i += 4) {
      var f = (bd[i] / 255 - 0.22) / 0.62; f = f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
      if (f > 0) { var pi = (i - 3) / 4, ec = edgeCut(sp, ((pi % iw) + 0.5) / iw * sp.w - sp.w / 2, (Math.floor(pi / iw) + 0.5) / ih * sp.h - sp.h / 2);
        if (ec < 1e8) { var g = (ec + fw * 0.5) / fw; g = g <= 0 ? 0 : g >= 1 ? 1 : g * g * (3 - 2 * g); f *= g; } }
      d[i] = d[i] * f;
    }
  }
  if (colv) {
    var Mx = colorMatrix(colv[0], colv[1], colv[2]);
    for (var j = 0; j < d.length; j += 4) {
      if (!d[j + 3]) continue;
      var r = d[j], g = d[j + 1], b = d[j + 2];
      d[j] = Mx[0] * r + Mx[1] * g + Mx[2] * b; d[j + 1] = Mx[3] * r + Mx[4] * g + Mx[5] * b; d[j + 2] = Mx[6] * r + Mx[7] * g + Mx[8] * b;
    }
  }
  x.putImageData(id, 0, 0); return c;
}
function drawTri(ctx, img, s0, s1, s2, d0, d1, d2) {
  // affine map source triangle -> dest triangle, clip slightly expanded to hide hairline cracks
  var cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
  function ex(p) { var dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + dx / l * 0.9, y: p.y + dy / l * 0.9 }; }
  var e0 = ex(d0), e1 = ex(d1), e2 = ex(d2);
  var den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y); if (Math.abs(den) < 1e-9) return;
  var a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den, b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  var c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den, d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  var e = d0.x - a * s0.x - c * s0.y, f = d0.y - b * s0.x - d * s0.y;
  ctx.save(); ctx.beginPath(); ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.closePath(); ctx.clip();
  ctx.setTransform(a, b, c, d, e, f); ctx.drawImage(img, 0, 0); ctx.restore();
}
function plugWarp(base, sp, pull, wn, seed) {
  var iw = base.width, ih = base.height, k = iw / sp.w, N = WARP_N, mg = Math.ceil(0.2 * Math.max(iw, ih));
  var out = mkCanvas(iw + mg * 2, ih + mg * 2), x = out.getContext('2d'), amp = 0.035 * Math.max(iw, ih) * wn;
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  var S = [], D = [];
  for (var j = 0; j <= N; j++) for (var i = 0; i <= N; i++) {
    var sx = i / N * iw, sy = j / N * ih, q = (j * (N + 1) + i) * 2, dx = 0, dy = 0;
    if (pull) { dx += pull[q] * k; dy += pull[q + 1] * k; }
    if (amp) { dx += (vnoise(i * 0.55, j * 0.55, seed) - 0.5) * 2 * amp; dy += (vnoise(i * 0.55 + 17.3, j * 0.55 + 5.1, seed + 3) - 0.5) * 2 * amp; }
    S.push({ x: sx, y: sy }); D.push({ x: sx + dx + mg, y: sy + dy + mg });
  }
  for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
    var a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    drawTri(x, base, S[a], S[b], S[d], D[a], D[b], D[d]); drawTri(x, base, S[a], S[d], S[c], D[a], D[d], D[c]);
  }
  return { c: out, pad: mg / k, warped: true };
}

// ---- variation
function randVary(id) { var r = Math.random; return { h: q2(r() * 2 - 1), s: q2(r() * 2 - 1), b: q2(r() * 2 - 1), w: q2(r()), seed: (r() * 100000) | 0 }; }
function applyVariation(s, place) {
  var p = map.plug; if (!p || !p.on || !(p.variation > 0)) return s;
  s.vary = randVary();
  if (place) {
    var t = stampType(s);
    if (Math.random() < 0.5 * Math.min(1, p.variation * 2.5)) s.flipX = !s.flipX;
    var f = 1 + (Math.random() * 2 - 1) * 0.1 * p.variation; s.scale = v2(round4(s.scale.x * f), round4(s.scale.y * f));
    if (t === 4 || t === 5) s.vary.w = q2(s.vary.w * 0.4);   // keep trees / peaks recognisable
  }
  return s;
}
function rerollVariation() {
  var list = selStamps(); if (!list.length) { toast('Select stamps to re-roll'); return; }
  checkpoint(); list.forEach(function (s) { s.vary = randVary(); }); if (!(map.plug.variation > 0)) map.plug.variation = 0.35;
  changed(); toast('New variation for ' + list.length + ' stamp(s)');
}

// ---- auto terrain for merged stickers
function ensurePlugTerrain() {
  if (!plugOn(map) || map.terrain) return false;
  var k = bgKind(map); if (k === 'grass') return false;
  if (!map.stamps.some(function (s) { return !s._ghost && isMerged(map, s); })) return false;
  map.terrain = makeTerrain(map, 0.16); renderMapCard(); return true;
}

// ---- snap-fit (coastline alignment)
function fitOcc(m, excl) {
  var R = 8, W = mapW(m), H = mapH(m), gw = Math.ceil(W / R), gh = Math.ceil(H / R), occ = new Int8Array(gw * gh);
  m.stamps.forEach(function (o) {
    if (excl[o.id] || !isMerged(m, o) || o._ghost) return;
    var sp = SPR[o.spriteKey], info = plugInfo(o.spriteKey); if (!sp || !info) return;
    var M = stampMatrix(m, o), bb = stampAabb(m, o);
    for (var y = Math.max(0, Math.floor(bb.minY / R)); y <= Math.min(gh - 1, Math.floor(bb.maxY / R)); y++) for (var x = Math.max(0, Math.floor(bb.minX / R)); x <= Math.min(gw - 1, Math.floor(bb.maxX / R)); x++) {
      var l = invM(M, (x + 0.5) * R, (y + 0.5) * R), c = codeAt(info, sp, l.x, l.y), i = y * gw + x;
      if (c >= 2) occ[i] = 1; else if (c === 1 && occ[i] === 0) occ[i] = -1;
    }
  });
  if (hasTerrain(m)) {   // painted land counts as land
    var t = m.terrain, water = waterMask(t), cp = cellPxOf(t);
    for (var y2 = 0; y2 < gh; y2++) for (var x2 = 0; x2 < gw; x2++) { var ci = cellAtPx(m, (x2 + 0.5) * R, (y2 + 0.5) * R); if (ci >= 0 && !water[t.cells[ci]]) occ[y2 * gw + x2] = 1; }
  }
  return { R: R, gw: gw, gh: gh, occ: occ };
}
function fitPoints(s) {
  var sp = SPR[s.spriteKey], info = plugInfo(s.spriteKey); if (!sp || !info) return [];
  var pts = [], gw = info.gw, gh = info.gh, g = info.g;
  for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) {
    var c = g[y * gw + x]; if (!c) continue;
    var v = c >= 2 ? 1 : -1, shore = false;
    for (var dy = -1; dy <= 1 && !shore; dy++) for (var dx = -1; dx <= 1; dx++) { var X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; var c2 = g[Y * gw + X]; if (c2 && (c2 >= 2) !== (c >= 2)) { shore = true; break; } }
    pts.push({ x: ((x + 0.5) / gw - 0.5) * sp.w, y: ((y + 0.5) / gh - 0.5) * sp.h, v: v, w: shore ? 3 : 1 });
  }
  return pts;
}
function fitEval(F, M, pts, offs) {   // best offset for matrix M -> {dx, dy, sc, base, n}
  var R = F.R, gw = F.gw, gh = F.gh, occ = F.occ, wp = pts.map(function (p) { return applyM(M, p.x, p.y); });
  var best = null, base = null;
  offs.forEach(function (o) {
    var sc = 0, n = 0;
    for (var i = 0; i < pts.length; i++) {
      var x = Math.floor((wp[i].x + o[0]) / R), y = Math.floor((wp[i].y + o[1]) / R); if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      var c = occ[y * gw + x]; if (!c) continue; n += pts[i].w; sc += c * pts[i].v * pts[i].w;
    }
    var adj = sc - 0.004 * Math.hypot(o[0], o[1]) * Math.max(1, n * 0.05);
    var r = { dx: o[0], dy: o[1], sc: sc, adj: adj, n: n };
    if (!o[0] && !o[1]) base = r;
    if (!best || adj > best.adj) best = r;
  });
  best.base = base || { sc: 0, n: 0 }; return best;
}
function offsetsGrid(R, st) { var o = []; for (var y = -R; y <= R; y += st) for (var x = -R; x <= R; x += st) o.push([x, y]); return o; }
var FIT_OFFS = offsetsGrid(64, 8);
function fitGood(b) { return b && (b.dx || b.dy) && b.n >= 20 && b.sc - b.base.sc >= Math.max(4, 0.05 * b.n); }
function fitDuringDrag(d) {
  if (!plugOn(map) || !map.plug.snap || d.alt || d.items.length !== 1) { d.fit = null; return; }
  var s = d.items[0].s; if (!isMerged(map, s)) { d.fit = null; return; }
  var now = performance.now(); if (d.fitT && now - d.fitT < 45) return; d.fitT = now;
  if (!d.occ) { var ex = {}; ex[s.id] = 1; d.occ = fitOcc(map, ex); d.pts = fitPoints(s); }
  var b = fitEval(d.occ, stampMatrix(map, s), d.pts, FIT_OFFS);
  d.fit = fitGood(b) ? b : null;
}
function drawFitOverlay(ctx, px) {
  if (!drag || drag.kind !== 'move' || !drag.fit) return;
  var s = drag.items[0].s, g = Object.assign({}, s, { position: toUnits(map, toPx(map, s.position).x + drag.fit.dx, toPx(map, s.position).y + drag.fit.dy) });
  poly(ctx, stampCorners(map, g), 'rgba(110,230,140,0.95)', px * 2, [7 * px, 5 * px]);
  ctx.save(); ctx.fillStyle = 'rgba(110,230,140,0.95)'; ctx.font = (13 * px) + 'px sans-serif'; var c = stampCorners(map, g)[0]; ctx.fillText('snap: coastline fits', c.x + 4 * px, c.y - 6 * px); ctx.restore();
}
function fitSelected() {
  var list = selStamps().filter(function (s) { return isMerged(map, s); });
  if (!list.length) { toast('Select land / coast stickers (merged) to fit'); return; }
  checkpoint(); var moved = 0, offs = offsetsGrid(96, 8);
  list.forEach(function (s) {
    var ex = {}; ex[s.id] = 1; var F = fitOcc(map, ex), pts = fitPoints(s), best = null, keep = { rot: s.rotation, fx: s.flipX, p: toPx(map, s.position) };
    [0, -10, 10, -20, 20, -30, 30].forEach(function (dr) {
      [keep.fx, !keep.fx].forEach(function (fx) {
        s.rotation = normDeg(keep.rot + dr); s.flipX = fx;
        var b = fitEval(F, stampMatrix(map, s), pts, offs); b.rot = s.rotation; b.fx = fx; b.adj -= Math.abs(dr) * 0.15 + (fx !== keep.fx ? 2 : 0);
        if (!best || b.adj > best.adj) best = b;
      });
    });
    s.rotation = keep.rot; s.flipX = keep.fx;
    var base = fitEval(F, stampMatrix(map, s), pts, [[0, 0]]);
    if (best && best.n >= 20 && best.sc - base.sc >= Math.max(4, 0.05 * best.n)) { s.rotation = round4(best.rot); s.flipX = best.fx; setPx(s, keep.p.x + best.dx, keep.p.y + best.dy); moved++; }
  });
  if (!moved) { dropCheckpoint(); toast('Already the best fit (no neighbouring coastline to align with)'); return; }
  changed(); renderSel(); toast('Fitted ' + moved + ' sticker(s) to their neighbours');
}

// ---- Auto-fill / Connect (one click)
function autoFill() {
  if (!map.plug) map.plug = defaultPlug();
  checkpoint();
  var notes = [];
  if (!map.plug.on) { map.plug.on = true; notes.push('plug & play on'); }
  var picked = selStamps().filter(function (s) { return !s._ghost; }), targets = picked.length ? picked : map.stamps.slice(), forced = 0;
  targets.forEach(function (s) { var t = stampType(s), info = plugInfo(s.spriteKey); if (s.merge === 0 && !autoMerge(s) && t !== 4 && t !== 5 && info && info.land > 0.04) { s.merge = 1; forced++; } });
  var mergedT = targets.filter(function (s) { return isMerged(map, s); });
  if (!mergedT.length && !hasTerrain(map)) { dropCheckpoint(); toast('Nothing to connect — place some land / coast stickers (or paint land) first'); return { error: 'nothing' }; }
  if (!map.terrain) { map.terrain = makeTerrain(map, 0.16); notes.push('land grid created'); renderMapCard(); }
  else if (!map.terrain.enabled) map.terrain.enabled = true;
  var t = map.terrain, cols = t.cols, rows = t.rows, n = cols * rows, water = waterMask(t);
  PG.sig = ''; var der = derivedCells(map, true), base = der.slice();
  var lab = new Int32Array(n).fill(-1), keepBlob = {}, nb = 0;
  if (picked.length) {   // only connect the islands that contain selected stickers
    var ids = {}; PG.list.forEach(function (s, i) { if (picked.indexOf(s) >= 0) ids[i + 1] = 1; });
    for (var i = 0; i < n; i++) {
      if (water[der[i]] || lab[i] >= 0) continue;
      var st = [i], hit = false; lab[i] = nb;
      while (st.length) { var p = st.pop(), x = p % cols, y = (p / cols) | 0; if (PG.owner && ids[PG.owner[p]]) hit = true;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { var X = x + d[0], Y = y + d[1]; if (X < 0 || Y < 0 || X >= cols || Y >= rows) return; var j = Y * cols + X; if (!water[der[j]] && lab[j] < 0) { lab[j] = nb; st.push(j); } }); }
      keepBlob[nb++] = hit;
    }
    for (i = 0; i < n; i++) if (lab[i] >= 0 && !keepBlob[lab[i]]) base[i] = baseIndex(t);
  }
  // dominant land type of the targets for the bridges
  var cnt = {}; mergedT.forEach(function (s) { var d = plugInfo(s.spriteKey).dom; cnt[d] = (cnt[d] || 0) + 1; });
  var dom = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0] || land.type, ty = typeIndex(t, dom); if (ty < 0 || water[ty]) ty = Math.max(0, typeIndex(t, 'grass'));
  var linkW = Math.max(2, Math.round(land.linkW * 0.22 / t.cellSize)), minC = Math.max(3, Math.round(3 * Math.pow(0.32 / t.cellSize, 2)));
  var r = TR.connect(base, cols, rows, water, minC, linkW, land.curve, 0.45, ty, land.seed, 0.25);
  var added = 0;
  for (i = 0; i < n; i++) if (r.cells[i] !== base[i] && water[der[i]] && !water[r.cells[i]]) { t.cells[i] = r.cells[i]; added++; }
  land.seed = (land.seed + 1) % 100000; saveLand();
  PG.sig = ''; derivedCells(map, true);
  if (!added && !forced && !notes.length) { dropCheckpoint(); toast(r.blobs < 2 ? 'Already one island — nothing to connect' : 'Nothing changed'); invalidate(); return { blobs: r.blobs, links: 0, added: 0 }; }
  changed(); renderSel(); renderFxCard();
  var msg = 'Auto-fill: ' + mergedT.length + ' sticker(s) merged into the land' + (r.blobs >= 2 ? ', ' + r.blobs + ' islands joined with ' + r.links + ' bridge(s)' : '') + (added ? ' (' + added + ' squares)' : '') + (notes.length ? ' · ' + notes.join(', ') : '');
  toast(msg); return { blobs: r.blobs, links: r.links, added: added, merged: mergedT.length, msg: msg };
}

// ---- Remix: shape of one sticker x texture of a terrain type (or of a second sticker) -> My Sprites
function loadImg(uri) { return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = uri; }); }
function remixSprite(s, src) {
  var sp = SPR[s.spriteKey]; if (!sp || !sp.ready) return Promise.reject(new Error('sprite not loaded'));
  var info = plugInfo(s.spriteKey), texP;
  if (typeof src === 'string') { var uri = TR.tileThumb(src + '_0'); if (!uri) return Promise.reject(new Error('no tile for ' + src)); texP = loadImg(uri).then(function (im) { return { im: im, tile: true }; }); }
  else { var sp2 = SPR[src.spriteKey]; if (!sp2 || !sp2.ready) return Promise.reject(new Error('second sprite not loaded')); texP = Promise.resolve({ im: plugBase(sp2, plugInfo(src.spriteKey), 0, null), tile: false }); }
  return texP.then(function (tx) {
    var shape = plugBase(sp, info && info.keyC ? info : null, 0, null), iw = shape.width, ih = shape.height;
    var tc = mkCanvas(iw, ih), tctx = tc.getContext('2d');
    if (tx.tile) { var pat = tctx.createPattern(tx.im, 'repeat'), k = texScale(sp); if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0])); tctx.fillStyle = pat; tctx.fillRect(0, 0, iw, ih); }
    else {   // fill holes of the texture sprite with its mean colour, then cover
      var tw = tx.im.width, th = tx.im.height, sc = Math.max(iw / tw, ih / th) * 1.25;
      var md = tx.im.getContext('2d').getImageData(0, 0, tw, th).data, R = 0, G = 0, B = 0, N = 0;
      for (var i = 0; i < md.length; i += 16) if (md[i + 3] > 200) { R += md[i]; G += md[i + 1]; B += md[i + 2]; N++; }
      tctx.fillStyle = N ? 'rgb(' + (R / N | 0) + ',' + (G / N | 0) + ',' + (B / N | 0) + ')' : '#777'; tctx.fillRect(0, 0, iw, ih);
      tctx.drawImage(tx.im, (iw - tw * sc) / 2, (ih - th * sc) / 2, tw * sc, th * sc);
    }
    var sctx = shape.getContext('2d'), sd = sctx.getImageData(0, 0, iw, ih), d = sd.data, td = tctx.getImageData(0, 0, iw, ih).data;
    var bl = mkCanvas(iw, ih); blurInto(bl, shape, Math.max(3, 0.03 * Math.max(iw, ih)), 1); var bd = bl.getContext('2d').getImageData(0, 0, iw, ih).data;
    var sum = 0, cnt = 0; for (i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; cnt++; }
    var meanL = cnt ? sum / cnt : 128;
    for (i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      var L = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / meanL, sh = Math.max(0.35, Math.min(1.6, 0.4 + 0.6 * L));
      var qv = (bd[i + 3] / 255 - 0.55) / 0.37; qv = qv <= 0 ? 0 : qv >= 1 ? 1 : qv * qv * (3 - 2 * qv);   // keep the original beach / edge band
      d[i] = d[i] * (1 - qv) + td[i] * sh * qv; d[i + 1] = d[i + 1] * (1 - qv) + td[i + 1] * sh * qv; d[i + 2] = d[i + 2] * (1 - qv) + td[i + 2] * sh * qv;
    }
    sctx.putImageData(sd, 0, 0);
    var cat = 'MySprites', name = slug((s.spriteKey.split('/')[1] || 'spr') + '_x_' + (typeof src === 'string' ? src : src.spriteKey.split('/')[1])).toLowerCase(), key, nn = 1;
    do { key = cat + '/remix_' + name + (nn > 1 ? '_' + nn : ''); nn++; } while (SPR[key]);
    var meta = analyseSprite(shape, cat, 'Land'); meta.type = 'Land';
    var rec = { key: key, cat: cat, label: 'My Sprites', name: key.split('/')[1], w: sp.w, h: sp.h, type: 'Land', uri: shape.toDataURL('image/webp', 0.9), meta: meta, t: Date.now() };
    return registerCustom(rec).then(function () {
      renderTabs(); renderPalette(); fireSprites();
      return dbPut([rec]).then(function () { return true; }, function () { return false; });
    }).then(function (saved) { toast('Remix saved to My Sprites: ' + rec.name + (saved ? '' : ' (not persisted)')); pickBrush(key, true); return key; });
  });
}

// ---- UI: plug & play card section + selection rows
function renderPlugCard() {
  var b = $('plugBody'); if (!b) return; b.innerHTML = '';
  var p = map.plug || (map.plug = defaultPlug()), after = function () { PG.sig = ''; invalidate(); };
  b.appendChild(el('button', { class: 'finish autofill', id: 'btnAutoFill2', text: '✦ Auto-fill / Connect ' + (sel.length ? 'selected' : 'all'), title: 'Merge stickers into one landmass, bridge the gaps and connect the islands (selection, or everything)', onclick: autoFill }));
  b.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap;margin-top:6px' }, [
    check('Plug & play', function () { return p.on; }, function (v) { p.on = v; clearFxCache(); after(); }, 'Key out ocean water in stickers and merge their land into one coastline'),
    check('Snap-fit', function () { return p.snap; }, function (v) { p.snap = v; }, 'While dragging a land/coast sticker, snap it to where its coastline lines up with its neighbours (Alt = no snap)')]));
  b.appendChild(slider('Bridge gap (u)', 0, 3, 0.05, function () { return p.gap; }, function (v) { p.gap = v; }, { lazy: true, after: after, title: 'Gaps between pieces narrower than this become land' }));
  b.appendChild(slider('Warp to fit', 0, 1, 0.05, function () { return p.warp; }, function (v) { p.warp = v; }, { lazy: true, after: after, title: 'Stretch cut-off edges of the art toward neighbouring land (mesh warp)' }));
  b.appendChild(slider('Soft edges', 0, 1, 0.05, function () { return p.soft; }, function (v) { p.soft = v; }, { lazy: true, after: after, title: 'How strongly merged sticker art fades into the land below' }));
  b.appendChild(slider('Variation', 0, 1, 0.05, function () { return p.variation; }, function (v) { p.variation = v; }, { lazy: true, after: after, title: 'Per-placement hue / saturation / brightness / warp (and random flip + scale on new placements)' }));
  b.appendChild(el('div', { class: 'btnrow' }, [
    el('button', { class: 'mini', text: '🎲 Re-roll variation', title: 'New random variation for the selected stamps', onclick: rerollVariation }),
    el('button', { class: 'mini', text: '⟲ Fit (T)', title: 'Rotate / flip / nudge the selected stickers so their coastline matches the neighbours', onclick: fitSelected })]));
  b.appendChild(el('div', { class: 'hint', html: 'Ocean inside coast stickers becomes see-through, their land joins the land grid (one coastline, one foam line). Painted squares are kept separately — move or delete a sticker and its land follows.' }));
}
function plugSelRows(b, list, s, multi) {
  if (!plugOn(map)) return;
  var info = plugInfo(s.spriteKey);
  b.appendChild(row('Merge land', seg([[0, 'Auto', 'On for Ground / Land / Coast stickers'], [1, 'On'], [2, 'Off']], function () { return s.merge | 0; }, function (v) { checkpoint(); list.forEach(function (t) { t.merge = v; }); PG.sig = ''; changed(); }),
    el('span', { class: 'muted', text: isMerged(map, s) ? '✓' : '' })));
  if (info && info.ocean > 0.02) b.appendChild(el('div', { class: 'hint', text: 'Ocean keyed out: ' + Math.round(info.ocean * 100) + '% of the art' }));
  var texSel = el('select', {}, PLUG_LAND.map(function (id) { return el('option', { value: id, text: id }); }).concat(multi ? [el('option', { value: '__2', text: '2nd selected sticker' })] : []));
  texSel.value = multi ? '__2' : 'grass';
  b.appendChild(row('Remix', el('div', { class: 'btnrow', style: 'margin:0' }, [texSel, el('button', { class: 'mini', id: 'btnRemix', text: '✦ Remix', title: 'Shape of this sticker × texture → new sprite in My Sprites', onclick: function () {
    remixSprite(s, texSel.value === '__2' ? list[1] : texSel.value).catch(function (e) { toast('Remix failed: ' + e.message); });
  } })])));
}

// testing / scripting hook
window.MapMaker = { get map() { return map; }, set map(m) { map = normalizeMap(m); afterMapChange(false); }, sprites: SPR, categories: CATS, loadCategory: loadCategory, renderExport: renderExport,
  pickBrush: pickBrush, setTool: setTool, toPx: function (p) { return toPx(map, p); }, toScreen: toScreen, view: view, openExport: openExport,
  gen: gen, setSel: setSel, get sel() { return sel; }, undo: undo, redo: redo, applyGen: applyGen, cancelGen: cancelGen, regenerate: regenerate, clearGenerated: clearGenerated, refreshPreview: refreshPreview,
  setGenMode: function (m) { gen.mode = m; gen.preview = null; renderBrushCard(); refreshPreview(); }, setGenOpts: function (o) { Object.assign(gen.o, o); renderBrushCard(); refreshPreview(); },
  setRegion: function (pts) { gen.region = pts; renderBrushCard(); refreshPreview(); }, importFiles: importFiles, confirmImport: confirmImport, imp: imp, customKeys: customKeys,
  analyseSprite: analyseSprite, cutSheet: cutSheet, metaOf: metaOf, land: land, rv: rv, smartLand: smartLand, decorateLand: decorateLand, carveRivers: carveRivers, finishRiver: finishRiver, savePreset: savePreset, allPresets: allPresets,
  ensureTerrain: function () { checkpoint(); ensureTerrain(); changed(); renderMapCard(); return map.terrain; }, setCellSize: function (v) { setCellSize(map, v); changed(); renderMapCard(); },
  renderExportFull: renderExportFull, autoFill: autoFill, fitSelected: fitSelected, rerollVariation: rerollVariation, remixSprite: function (id, src) { return remixSprite(byId(id), typeof src === 'number' ? byId(src) : src); }, plugInfo: plugInfo, plugKeysReady: plugKeysReady, derivedCells: function () { return derivedCells(map, true); }, isMerged: function (id) { return isMerged(map, byId(id)); }, renderFxCard: renderFxCard, renderSel: renderSel, hasTerrain: function () { return hasTerrain(map); }, terrainPending: function () { var n = 0; Object.keys(TL.levels).forEach(function (P) { var L = TL.levels[P]; for (var k in L.chunks) if (L.chunks[k].sig !== L.chunks[k].want) n++; }); return n + (TL.tiles ? 0 : 1); }, fit: fit, renderBrushCard: renderBrushCard, saveJsonText: function () { var emb = prefs.embedCustom ? embedList(map) : []; return JSON.stringify(emb.length ? Object.assign({}, map, { customSprites: emb }) : map, jsonReplacer); }, prefs: prefs };
init();
})();
