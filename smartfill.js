/* Map Maker 2D — Smart Fill (offline, deterministic, sprite-only terrain generation).
 * Pure functions, no DOM.  The Unity port (Editor/MapSmartFill.cs) follows this file line by line, so the same
 * seed + options + anchors give the same layout in both editors.
 *
 * All geometry is in "map pixels" (100 px = 1 Unity unit, y DOWN).  Rotations returned are Unity degrees (CCW).
 * Catalog entries: {key, biome, type, m: {angle, major, minor, coverage, size, tags[]}} (see tools/sprite_meta.py).
 * Placement output: {key, x, y, rot, scale, flipX, z: 'base'|'over'} — base pieces go under the anchors, 'over'
 * pieces (ridges, rivers, features) on top. */
(function (root) {
'use strict';

// ---------------------------------------------------------------- deterministic helpers
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function hash1(i, seed) { var h = Math.imul((i | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x9E3779B1); h ^= h >>> 15; h = Math.imul(h, 0x85EBCA77); h ^= h >>> 13; return (h >>> 0) / 4294967296; }
/** smooth 1-D value noise in [-1, 1] */
function noise1(x, seed) { var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return (hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u) * 2 - 1; }
function hyp(x, y) { return Math.sqrt(x * x + y * y); }   // not Math.hypot: sqrt is correctly rounded everywhere (bit-identical C# port)
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function normDeg(d) { d = d % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function has(e, t) { return e.m.tags.indexOf(t) >= 0; }

// ---------------------------------------------------------------- sprite pools (data-driven: tags + type + biome)
var ROLES = {
  land: function (e) { return has(e, 'land') && !has(e, 'water') && (e.type === 'Land' || e.type === 'Ground'); },
  landLong: function (e) { return ROLES.land(e) && e.m.major / Math.max(1, e.m.minor) >= 1.5; },
  ridge: function (e) { return (has(e, 'ridge') || has(e, 'peak')) && !has(e, 'water'); },
  river: function (e) { return has(e, 'river') || (has(e, 'water') && e.m.major / Math.max(1, e.m.minor) >= 1.6); },
  coast: function (e) { return has(e, 'coast') && !(has(e, 'water') && !has(e, 'land') && e.type === 'Water' && !has(e, 'sand')); },
  feature: function (e) { return e.type === 'Features' || (e.type === 'Peaks' && e.m.size === 'small'); },
  pond: function (e) { return has(e, 'water') && e.m.size !== 'large'; }
};
var FALLBACK = { landLong: 'land', ridge: 'land', coast: 'land', river: 'pond', pond: 'river', feature: 'ridge' };

function Pools(catalog, strict) {
  var list = catalog.slice().sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  var cache = {};
  function get(role, biome) {
    var ck = role + '|' + (biome || '*');
    if (cache[ck]) return cache[ck];
    var f = ROLES[role], r = list.filter(function (e) { return (!biome || e.biome === biome) && f(e); });
    return (cache[ck] = r);
  }
  /** biome first, then the role's fallback in the same biome, then the role across all biomes */
  this.pick = function (rng, role, biome) {
    var r = get(role, biome);
    if (!r.length && FALLBACK[role]) r = get(FALLBACK[role], biome);
    if (!r.length && FALLBACK[FALLBACK[role]]) r = get(FALLBACK[FALLBACK[role]], biome);
    if (strict && biome) {   // picked biome: never leave it (e.g. a set of your own imported sprites)
      if (!r.length) r = list.filter(function (e) { return e.biome === biome; });
      return r.length ? pick(rng, r) : null;
    }
    if (!r.length) r = get(role, null);
    if (!r.length && FALLBACK[role]) r = get(FALLBACK[role], null);
    if (!r.length) r = list;
    return r.length ? pick(rng, r) : null;
  };
  this.biomes = function () { var b = {}; list.forEach(function (e) { b[e.biome] = 1; }); return Object.keys(b).sort(); };
}

// ---------------------------------------------------------------- graph: MST (Prim) + extra links
function links(anchors, extra) {
  var n = anchors.length, edges = [];
  if (n < 2) return edges;
  var inT = [true], best = [], from = [];
  for (var i = 1; i < n; i++) { inT[i] = false; best[i] = dist(anchors[0], anchors[i]); from[i] = 0; }
  for (var k = 1; k < n; k++) {
    var bi = -1;
    for (var j = 1; j < n; j++) if (!inT[j] && (bi < 0 || best[j] < best[bi])) bi = j;
    inT[bi] = true; edges.push([from[bi], bi]);
    for (j = 1; j < n; j++) if (!inT[j]) { var d = dist(anchors[bi], anchors[j]); if (d < best[j]) { best[j] = d; from[j] = bi; } }
  }
  var nExtra = Math.round(clamp(extra, 0, 1) * (n - 1));
  if (nExtra > 0) {
    var used = {}; edges.forEach(function (e) { used[Math.min(e[0], e[1]) + ',' + Math.max(e[0], e[1])] = 1; });
    var cand = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) if (!used[i + ',' + j]) cand.push([i, j, dist(anchors[i], anchors[j])]);
    cand.sort(function (a, b) { return a[2] - b[2] || a[0] - b[0] || a[1] - b[1]; });
    for (i = 0; i < Math.min(nExtra, cand.length); i++) edges.push([cand[i][0], cand[i][1]]);
  }
  return edges;
}
function dist(a, b) { return hyp(a.x - b.x, a.y - b.y); }

// ---------------------------------------------------------------- path: bezier + perpendicular noise, arc-length table
function buildPath(a, b, o, rng, seed) {
  var dx = b.x - a.x, dy = b.y - a.y, D = hyp(dx, dy) || 1, ux = dx / D, uy = dy / D, nx = -uy, ny = ux;
  var ia = Math.min(a.r * 0.55, D * 0.3), ib = Math.min(b.r * 0.55, D * 0.3);
  var p0 = { x: a.x + ux * ia, y: a.y + uy * ia }, p3 = { x: b.x - ux * ib, y: b.y - uy * ib };
  var L = hyp(p3.x - p0.x, p3.y - p0.y);
  var b1 = (rng() * 2 - 1) * o.curve * L * 0.35, b2 = (rng() * 2 - 1) * o.curve * L * 0.35;
  var p1 = { x: p0.x + ux * L / 3 + nx * b1, y: p0.y + uy * L / 3 + ny * b1 }, p2 = { x: p0.x + ux * 2 * L / 3 + nx * b2, y: p0.y + uy * 2 * L / 3 + ny * b2 };
  var N = Math.max(8, Math.ceil(L / 6)), pts = [];
  for (var i = 0; i <= N; i++) {
    var t = i / N, m = 1 - t;
    pts.push({ x: m * m * m * p0.x + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * p3.x, y: m * m * m * p0.y + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * p3.y });
  }
  // perpendicular wobble, fading out at both ends so the path still meets the anchors
  var amp = o.jitter * o.width * 0.6, freq = 1 / Math.max(40, o.width * 2.5), s = 0;
  var out = [];
  for (i = 0; i <= N; i++) {
    var q = pts[Math.max(0, i - 1)], r = pts[Math.min(N, i + 1)], tx = r.x - q.x, ty = r.y - q.y, tl = hyp(tx, ty) || 1;
    if (i) s += hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    var w = noise1(s * freq, seed) * amp * Math.sin(Math.PI * i / N);
    out.push({ x: pts[i].x - ty / tl * w, y: pts[i].y + tx / tl * w });
  }
  var len = [0];
  for (i = 1; i < out.length; i++) len.push(len[i - 1] + hyp(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
  return { pts: out, len: len, total: len[len.length - 1] };
}
/** point + unit tangent at arc length s */
function at(path, s) {
  var L = path.len, P = path.pts, lo = 0, hi = L.length - 1;
  s = clamp(s, 0, path.total);
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (L[mid] <= s) lo = mid; else hi = mid; }
  var seg = L[hi] - L[lo] || 1, f = (s - L[lo]) / seg;
  var tx = P[hi].x - P[lo].x, ty = P[hi].y - P[lo].y, tl = hyp(tx, ty) || 1;
  return { x: lerp(P[lo].x, P[hi].x, f), y: lerp(P[lo].y, P[hi].y, f), tx: tx / tl, ty: ty / tl };
}

// ---------------------------------------------------------------- stamping
/** align the sprite's principal axis with tangent (tx, ty) (map px, y down); returns {rot, flipX} */
function alignRot(e, tx, ty, rng, jitterDeg) {
  var tdeg = -Math.atan2(ty, tx) * 180 / Math.PI, flip = rng() < 0.5;
  // flipX mirrors the sprite's axis angle a -> -a, so world axis = rot - a
  var rot = flip ? tdeg + e.m.angle : tdeg - e.m.angle;
  if (rng() < 0.5) rot += 180;
  return { rot: normDeg(rot + (rng() * 2 - 1) * jitterDeg), flipX: flip };
}
function put(out, e, x, y, rot, scale, flip, z) { if (e) out.push({ key: e.key, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, rot: Math.round(rot * 100) / 100, scale: Math.round(scale * 1000) / 1000, flipX: !!flip, z: z }); }

/** pieces along one path. role: pool role, width: thickness px, side: perpendicular offset (×width), z */
function strip(out, path, o, rng, pools, biomeAt, role, width, side, z, overlap, maxScale) {
  var s = 0, guard = 0;
  while (s <= path.total && guard++ < 4000) {
    var t = path.total ? s / path.total : 0, p = at(path, s), biome = biomeAt(t, rng);
    var e = pools.pick(rng, role, biome); if (!e) return;
    var w = width * (0.8 + 0.4 * rng());
    var sc = clamp(w / Math.max(4, e.m.minor), 0.08, maxScale || 3);
    if (e.m.major * sc > width * 5) sc = width * 5 / e.m.major;
    var a = alignRot(e, p.tx, p.ty, rng, 10 * o.jitter);
    var off = side * width + (rng() * 2 - 1) * width * 0.25 * o.jitter;
    put(out, e, p.x - p.ty * off, p.y + p.tx * off, a.rot, sc, a.flipX, z);
    s += Math.max(width * 0.2, e.m.major * sc * (1 - overlap));
  }
}

function features(out, pathsOrPts, o, rng, pools, biomeAt, width) {
  if (!(o.features > 0)) return;
  pathsOrPts.forEach(function (path) {
    var step = Math.max(20, width * 1.3 / o.features), s = rng() * step;
    while (s < path.total) {
      var t = s / path.total, p = at(path, s), biome = biomeAt(t, rng);
      var role = rng() < 0.12 ? 'pond' : 'feature';
      var e = pools.pick(rng, role, biome);
      if (e) {
        var target = width * (0.25 + 0.3 * rng()), sc = clamp(target / Math.max(4, e.m.major), 0.08, 1.5);
        var off = (rng() * 2 - 1) * width * 0.3;
        put(out, e, p.x - p.ty * off, p.y + p.tx * off, normDeg((rng() * 2 - 1) * 12), sc, rng() < 0.5, 'over');
      }
      s += step * (0.6 + 0.8 * rng());
    }
  });
}

function biomeFn(o, a, b) {
  if (o.biomeMode === 'pick' && o.biome) return function () { return o.biome; };
  return function (t, rng) { return rng() < smooth(0.15, 0.85, t) ? b.biome : a.biome; };
}

// ---------------------------------------------------------------- Connect
function connect(anchors, o, catalog) {
  o = defaults(o);
  var pools = new Pools(catalog, o.biomeMode === 'pick'), rng = mulberry32(o.seed ^ hashStr('connect:' + o.style)), out = [];
  var edges = links(anchors, o.extra);
  edges.forEach(function (ed, ei) {
    var a = anchors[ed[0]], b = anchors[ed[1]], path = buildPath(a, b, o, rng, (o.seed + ei * 7919) | 0), bf = biomeFn(o, a, b);
    if (path.total < 8) return;
    var W = o.width, ov = 0.25 + 0.5 * o.density;
    if (o.style === 'ridge') {
      strip(out, path, o, rng, pools, bf, 'land', W * 0.9, 0, 'base', ov);
      strip(out, path, o, rng, pools, bf, 'ridge', W * 0.55, 0, 'over', ov * 0.8, 1.6);
    } else if (o.style === 'river') {
      strip(out, path, o, rng, pools, bf, 'river', W * 0.45, 0, 'over', ov, 2.5);
    } else if (o.style === 'coast') {
      strip(out, path, o, rng, pools, bf, 'land', W * 0.8, -0.35, 'base', ov);
      strip(out, path, o, rng, pools, bf, 'coast', W * 0.6, 0.3, 'base', ov);
    } else {
      strip(out, path, o, rng, pools, bf, 'landLong', W, 0, 'base', ov);
    }
    if (o.style !== 'river') features(out, [path], o, rng, pools, bf, W);
  });
  return { placements: out, edges: edges };
}

// ---------------------------------------------------------------- Poisson disc (variable radius, dart throwing on a hash grid)
function poisson(rng, inside, bbox, rAt, maxPts) {
  var rMin = Infinity, pts = [], cell, grid = {};
  // sample rMin from a coarse scan
  for (var gy = 0; gy <= 8; gy++) for (var gx = 0; gx <= 8; gx++) { var x = lerp(bbox.x0, bbox.x1, gx / 8), y = lerp(bbox.y0, bbox.y1, gy / 8); if (inside(x, y)) rMin = Math.min(rMin, rAt(x, y)); }
  if (!isFinite(rMin)) rMin = rAt((bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2);
  rMin = Math.max(6, rMin * 0.5); cell = rMin;
  var area = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0), tries = Math.min(60000, Math.ceil(area / (rMin * rMin) * 3) + 200), rMax = 0;
  for (var k = 0; k < tries && pts.length < maxPts; k++) {
    var px = lerp(bbox.x0, bbox.x1, rng()), py = lerp(bbox.y0, bbox.y1, rng());
    if (!inside(px, py)) continue;
    var r = rAt(px, py), ok = true, R = Math.max(r, rMax), cx = Math.floor(px / cell), cy = Math.floor(py / cell), cr = Math.ceil(R / cell);
    for (var yy = cy - cr; yy <= cy + cr && ok; yy++) for (var xx = cx - cr; xx <= cx + cr && ok; xx++) {
      var c = grid[xx + ',' + yy]; if (!c) continue;
      for (var i = 0; i < c.length; i++) { var q = c[i]; if (hyp(q.x - px, q.y - py) < Math.min(r, q.r) * 1.0 + Math.abs(r - q.r) * 0.5) { ok = false; break; } }
    }
    if (!ok) continue;
    var p = { x: px, y: py, r: r }; pts.push(p); rMax = Math.max(rMax, r);
    var key = cx + ',' + cy; (grid[key] || (grid[key] = [])).push(p);
  }
  return pts;
}
function pointInPoly(poly, x, y) {
  var c = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function distToPoly(poly, x, y) {
  var best = Infinity;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var a = poly[j], b = poly[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1, t = clamp(((x - a.x) * vx + (y - a.y) * vy) / l2, 0, 1);
    best = Math.min(best, hyp(a.x + vx * t - x, a.y + vy * t - y));
  }
  return best;
}
/** a land piece sized to `target` px (its major axis) at random orientation */
function blob(out, rng, pools, role, biome, x, y, target, rotRand, z) {
  var e = pools.pick(rng, role, biome); if (!e) return;
  var sc = clamp(target / Math.max(4, e.m.major), 0.06, 3);
  put(out, e, x, y, normDeg((rng() * 2 - 1) * rotRand), sc, rng() < 0.5, z);
}

// ---------------------------------------------------------------- Grow / fill around
function grow(anchors, o, catalog) {
  o = defaults(o);
  var pools = new Pools(catalog, o.biomeMode === 'pick'), rng = mulberry32(o.seed ^ hashStr('grow')), out = [];
  anchors.forEach(function (a, ai) {
    var R = o.radius, inner = a.r * 0.5, outer = a.r + R, ns = (o.seed + ai * 104729) | 0;
    var edgeR = function (x, y) { var th = Math.atan2(y - a.y, x - a.x); return outer * (0.72 + 0.28 * noise1((th + Math.PI) * 2.2, ns)) ; };
    var inside = function (x, y) { var d = hyp(x - a.x, y - a.y); return d >= inner && d <= edgeR(x, y); };
    var uAt = function (x, y) { return clamp((hyp(x - a.x, y - a.y) - a.r * 0.6) / Math.max(1, edgeR(x, y) - a.r * 0.6), 0, 1); };
    var big = o.width * 1.1, small = o.width * 0.3;
    var rAt = function (x, y) { return lerp(big, small, uAt(x, y)) * (1.15 - 0.6 * o.density); };
    var pts = poisson(rng, inside, { x0: a.x - outer, y0: a.y - outer, x1: a.x + outer, y1: a.y + outer }, rAt, 900);
    var bf = biomeFn(o, a, a);
    pts.forEach(function (p) {
      var u = uAt(p.x, p.y), b = bf(0, rng);
      if (u > 0.82) { if (rng() < 0.55) blob(out, rng, pools, rng() < 0.5 ? 'feature' : 'land', b, p.x, p.y, p.r * 1.3, 180, rng() < 0.5 ? 'base' : 'over'); return; }
      blob(out, rng, pools, 'land', b, p.x, p.y, p.r * 2.4, o.rotRand, 'base');
    });
    featuresIn(out, pts.filter(function (p) { return uAt(p.x, p.y) < 0.75; }), o, rng, pools, bf);
  });
  return { placements: out };
}
function featuresIn(out, pts, o, rng, pools, bf) {
  if (!(o.features > 0)) return;
  pts.forEach(function (p) {
    if (rng() > 0.35 * o.features) return;
    blob(out, rng, pools, rng() < 0.12 ? 'pond' : 'feature', bf(rng(), rng), p.x + (rng() - 0.5) * p.r, p.y + (rng() - 0.5) * p.r, p.r * (0.6 + 0.5 * rng()), 12, 'over');
  });
}

// ---------------------------------------------------------------- Fill region (lasso polygon)
function fillRegion(poly, o, catalog) {
  o = defaults(o);
  var pools = new Pools(catalog, o.biomeMode === 'pick'), rng = mulberry32(o.seed ^ hashStr('fill')), out = [];
  if (!poly || poly.length < 3) return { placements: out };
  var bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  poly.forEach(function (p) { bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y); bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y); });
  var D = o.width * 1.5, big = o.width * 1.1, small = o.width * 0.3;
  var uAt = function (x, y) { return 1 - smooth(0, D, distToPoly(poly, x, y)); };      // 0 deep inside .. 1 at the edge
  var rAt = function (x, y) { return lerp(big, small, uAt(x, y)) * (1.15 - 0.6 * o.density); };
  var pts = poisson(rng, function (x, y) { return pointInPoly(poly, x, y); }, bb, rAt, 1500);
  var biome = o.biome || 'Temperate', bf = function () { return biome; };
  pts.forEach(function (p) {
    var u = uAt(p.x, p.y);
    if (u > 0.85 && rng() < 0.4) { blob(out, rng, pools, 'feature', biome, p.x, p.y, p.r * 1.4, 180, 'over'); return; }
    blob(out, rng, pools, 'land', biome, p.x, p.y, p.r * 2.4, o.rotRand, 'base');
  });
  featuresIn(out, pts.filter(function (p) { return uAt(p.x, p.y) < 0.7; }), o, rng, pools, bf);
  return { placements: out };
}

function defaults(o) {
  var d = { style: 'land', width: 160, density: 0.5, jitter: 0.5, curve: 0.4, extra: 0, seed: 1, biomeMode: 'match', biome: '', features: 0.5, radius: 350, rotRand: 30 };
  o = Object.assign(d, o || {}); o.seed = o.seed | 0; return o;
}

root.MMSmartFill = { connect: connect, grow: grow, fillRegion: fillRegion, links: links, mulberry32: mulberry32, noise1: noise1, pointInPoly: pointInPoly, defaults: defaults, Pools: Pools, ROLES: ROLES };
})(typeof window !== 'undefined' ? window : globalThis);
