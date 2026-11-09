/* Map Maker HTML — square terrain grid, terrain Smart Fill and custom rivers.
   JS port of the engine-free C# core of the Unity package (MapTerrainCore / MapRiverCore / MapTerrainFill), so
   both tools mesh the same squares into the same organic coasts (sandy rim + white foam on blue water).
   No dependencies, no network, no AI: deterministic noise + distance fields. */
(function () {
'use strict';

// ====================================================================== rasteriser core (also runs inside Web Workers)
function MMTerrainCore() {
  function Hash(x, y, s) {
    var h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h & 0xffffff) / 16777215;
  }
  function Noise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = Hash(ix, iy, s), b = Hash(ix + 1, iy, s), c = Hash(ix, iy + 1, s), d = Hash(ix + 1, iy + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function Fbm(x, y, s, oct) {
    var sum = 0, amp = 0.5, norm = 0;
    for (var o = 0; o < oct; o++) { sum += Noise(x, y, s + o * 131) * amp; norm += amp; x = x * 2.03 + 17.1; y = y * 2.03 + 31.7; amp *= 0.5; }
    return sum / norm;
  }
  function Smooth(e0, e1, v) { var t = (v - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  function Clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function Kernel(t, w) {
    var t2 = t * t, t3 = t2 * t;
    var b0 = (1 - t) * (1 - t) * (1 - t) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6;
    var c0 = (-t3 + 2 * t2 - t) * 0.5, c1 = (3 * t3 - 5 * t2 + 2) * 0.5, c2 = (-3 * t3 + 4 * t2 + t) * 0.5, c3 = (t3 - t2) * 0.5;
    w[0] = (b0 + c0) * 0.5; w[1] = (b1 + c1) * 0.5; w[2] = (b2 + c2) * 0.5; w[3] = (b3 + c3) * 0.5;
  }
  function Edt1(f, n, d, v, z) {
    var k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k])); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (var q2 = 0; q2 < n; q2++) { while (z[k + 1] < q2) k++; var dq = q2 - v[k]; d[q2] = dq * dq + f[v[k]]; }
  }
  function Edt(feature, w, h, dist, cap) {
    var INF = 1e20, n = Math.max(w, h);
    var f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), tmp = new Float64Array(w * h);
    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
      Edt1(f, h, d, v, z);
      for (var y2 = 0; y2 < h; y2++) tmp[y2 * w + x] = d[y2];
    }
    var cap2 = cap * cap;
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) f[xx] = tmp[yy * w + xx];
      Edt1(f, w, d, v, z);
      for (var x3 = 0; x3 < w; x3++) { var q = d[x3]; dist[yy * w + x3] = q >= cap2 ? cap : Math.sqrt(q); }
    }
  }
  var OUT = [0, 0, 0];
  function Sample(t, x, y, o) {
    var ix = Math.floor(x) % t.w, iy = Math.floor(y) % t.h;
    if (ix < 0) ix += t.w; if (iy < 0) iy += t.h;
    var k = (iy * t.w + ix) * 3, p = t.rgb;
    o[0] = p[k] / 255; o[1] = p[k + 1] / 255; o[2] = p[k + 2] / 255;
  }
  var T2 = [0, 0, 0];
  /** texture colour of type t at px -> o[0..2] */
  function Tile(t, x, y, seed, varScale, o) {
    var ts = t.tiles;
    if (!ts || !ts.length) { o[0] = t.r; o[1] = t.g; o[2] = t.b; return; }
    var vi = 0, vj = 0, vf = 0, n = ts.length;
    if (n > 1) {
      var vn = Fbm(x / varScale, y / varScale, seed + 7, 2) * n * 1.6;
      vi = Math.floor(vn) % n; if (vi < 0) vi += n;
      vj = (vi + 1) % n; vf = Smooth(0.3, 0.7, vn - Math.floor(vn));
    }
    Sample(ts[vi], x + vi * 97, y + vi * 61, o);
    if (vf > 0.001) { Sample(ts[vj], x + vj * 97, y + vj * 61, T2); o[0] += (T2[0] - o[0]) * vf; o[1] += (T2[1] - o[1]) * vf; o[2] += (T2[2] - o[2]) * vf; }
    if (t.tint > 0) {
      var l = (o[0] + o[1] + o[2]) / 3 * 2;
      o[0] += (t.r * l - o[0]) * t.tint; o[1] += (t.g * l - o[1]) * t.tint; o[2] += (t.b * l - o[2]) * t.tint;
    }
  }

  /** job: {cells, cols, rows, types[{water,priority,rim,foam,tiles,r,g,b,tint}], baseType, s(settings), rivers[], ox, oy, w, h}
      -> Uint8ClampedArray rgba (w*h*4), pixel space y-down from the grid's top-left corner. */
  function Render(job) {
    var cells = job.cells, cols = job.cols, rows = job.rows, types = job.types, s = job.s, ox = job.ox, oy = job.oy, w = job.w, h = job.h;
    var rgba = new Uint8ClampedArray(w * h * 4);
    var nt = types.length;
    var deepT = job.baseType >= 0 && job.baseType < nt ? job.baseType : 0;
    var shallowT = -1;
    for (var i = 0; i < nt; i++) if (types[i].water && i !== deepT && (shallowT < 0 || types[i].priority > types[shallowT].priority)) shallowT = i;
    var rimW = Math.max(0.5, s.rimWidth), foamW = Math.max(0.5, s.foamWidth), shW = Math.max(1, s.shallowWidth);
    var M = s.riversOnly ? 0 : Math.ceil(Math.min(110, Math.max(shW, Math.max(foamW * 4, rimW * 2.5)) + 3));
    var EW = w + 2 * M, EH = h + 2 * M, EN = EW * EH;
    var landF = new Float32Array(EN), typeA = new Uint8Array(EN), typeB = new Uint8Array(EN), mixB = new Float32Array(EN), shallowF = new Float32Array(EN);
    var isLand = new Uint8Array(EN), isWater = new Uint8Array(EN);
    var weights = new Float32Array(nt), kx = [0, 0, 0, 0], ky = [0, 0, 0, 0];
    var cp = Math.max(2, s.cellPx), seed = s.seed | 0;
    var warpA = s.edgeNoise * 0.7, rough = s.edgeNoise * 0.12;
    var maxPri = 1; for (i = 0; i < nt; i++) maxPri = Math.max(maxPri, types[i].priority);
    var c16 = cp * 1.6, c45 = cp * 0.45, c32 = cp * 0.32, c5 = cp * 0.5, c22 = cp * 2.2;
    if (!s.riversOnly) {
      for (var ey = 0; ey < EH; ey++) {
        var py = oy - M + ey + 0.5;
        for (var ex = 0; ex < EW; ex++) {
          var px = ox - M + ex + 0.5;
          var wx = (Fbm(px / c16, py / c16, seed + 11, 3) - 0.5) * 2 * warpA;
          var wy = (Fbm(px / c16 + 40.3, py / c16 + 9.1, seed + 23, 3) - 0.5) * 2 * warpA;
          wx += (Fbm(px / c45, py / c45, seed + 13, 2) - 0.5) * 0.5 * warpA;
          wy += (Fbm(px / c45 + 7.7, py / c45 + 3.1, seed + 29, 2) - 0.5) * 0.5 * warpA;
          var u = px / cp - 0.5 + wx, v = py / cp - 0.5 + wy;
          var iu = Math.floor(u), iv = Math.floor(v);
          Kernel(u - iu, kx); Kernel(v - iv, ky);
          weights.fill(0);
          for (var j = 0; j < 4; j++) {
            var cy = iv - 1 + j; cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
            var rowo = cy * cols;
            for (var ii = 0; ii < 4; ii++) {
              var cx = iu - 1 + ii; cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
              var t = cells[rowo + cx]; if (t >= nt) t = deepT;
              weights[t] += kx[ii] * ky[j];
            }
          }
          var land = 0, a = -1, b2 = -1, sa = -1e9, sb = -1e9;
          for (t = 0; t < nt; t++) {
            var wt = weights[t]; if (wt <= 0.0001 || types[t].water) continue;
            land += wt;
            var sc = wt + 0.06 * types[t].priority / maxPri;
            if (sc > sa) { sb = sa; b2 = a; sa = sc; a = t; } else if (sc > sb) { sb = sc; b2 = t; }
          }
          var e = ey * EW + ex;
          var fine = (Fbm(px / c32, py / c32, seed + 37, 2) - 0.5) * rough;
          landF[e] = land + fine;
          typeA[e] = a < 0 ? deepT : a;
          if (b2 >= 0) {
            var tb = s.typeBlend, tn = (Fbm(px / c5, py / c5, seed + 51, 2) - 0.5) * 0.18 * s.edgeNoise + (Fbm(px / c22, py / c22, seed + 57, 3) - 0.5) * 0.9 * s.edgeNoise * tb;
            typeB[e] = b2; mixB[e] = Smooth(tb, -tb, sa - sb + tn);
          } else { typeB[e] = typeA[e]; mixB[e] = 0; }
          shallowF[e] = shallowT >= 0 ? weights[shallowT] : 0;
          isLand[e] = landF[e] > 0.5 ? 1 : 0; isWater[e] = 1 - isLand[e];
        }
      }
    }
    var dIn = new Float32Array(EN), dOut = new Float32Array(EN);
    if (!s.riversOnly) { Edt(isWater, EW, EH, dIn, M + 1); Edt(isLand, EW, EH, dOut, M + 1); }
    var rv = [];
    (job.rivers || []).forEach(function (r) { if (r && (r.count > 1 || r.lakes.length) && r.maxX >= ox && r.minX <= ox + w && r.maxY >= oy && r.minY <= oy + h) rv.push(r); });
    var fr = s.foamR, fg = s.foamG, fb = s.foamB;
    var C = [0, 0, 0], S = [0, 0, 0], L = [0, 0, 0], P = { R: 0, G: 0, B: 0, A: 1 };
    for (var y = 0; y < h; y++) {
      var ey2 = y + M, py2 = oy + y + 0.5;
      for (var x = 0; x < w; x++) {
        var ex2 = x + M, e2 = ey2 * EW + ex2, px2 = ox + x + 0.5;
        var R, G, B, A = 1, sdCoast;
        if (s.riversOnly) { R = G = B = 0; A = 0; sdCoast = 1e6; }
        else {
          var lf = landF[e2];
          var exl = ex2 > 0 ? e2 - 1 : e2, exr = ex2 < EW - 1 ? e2 + 1 : e2, eyu = ey2 > 0 ? e2 - EW : e2, eyd = ey2 < EH - 1 ? e2 + EW : e2;
          var gx = (landF[exr] - landF[exl]) * 0.5, gy = (landF[eyd] - landF[eyu]) * 0.5;
          var gl = Math.sqrt(gx * gx + gy * gy) + 1e-5, lin = (lf - 0.5) / gl;
          sdCoast = isLand[e2] ? Math.max(0, dIn[e2] - 0.5) : -Math.max(0, dOut[e2] - 0.5);
          if (Math.abs(lin) < 1.5) sdCoast = lin;
          var aLand = Clamp01(0.5 + sdCoast);
          // water
          Tile(types[deepT], px2, py2, seed, s.variantScale, C);
          var wr = C[0], wg = C[1], wb = C[2];
          if (shallowT >= 0) {
            var paint = Smooth(0.25, 0.65, shallowF[e2] + (Fbm(px2 / (cp * 0.6), py2 / (cp * 0.6), seed + 61, 2) - 0.5) * 0.3);
            var dOutF = isLand[e2] ? 0 : dOut[e2], coast = 0;
            if (dOutF < shW) { var qq = 1 - dOutF / shW; coast = qq * qq * s.shallowStrength; }
            coast *= 0.75 + 0.5 * Fbm(px2 / 60, py2 / 60, seed + 71, 2);
            var shMix = Math.min(1, paint + coast);
            if (shMix > 0.001) { Tile(types[shallowT], px2, py2, seed + 3, s.variantScale, S); wr += (S[0] - wr) * shMix; wg += (S[1] - wg) * shMix; wb += (S[2] - wb) * shMix; }
          }
          var wa = s.transparentWater ? 0 : 1;
          if (!isLand[e2] || aLand < 1) {
            var d = Math.max(0, -sdCoast), near = types[typeA[e2]];
            var fo = near.foam || isLand[e2] ? 1 : 0.5;
            var wob = 0.7 + 0.6 * Fbm(px2 / 14, py2 / 14, seed + 81, 2);
            var ring = Math.exp(-(d * d) / (foamW * foamW * 0.9)), halo = Math.exp(-d / (foamW * 2.6)) * 0.38, lines = 0, band = d / (foamW * 1.4);
            if (band > 1 && band < 3.4) lines = (0.5 + 0.5 * Math.cos(band * 6.2832 - Fbm(px2 / 30, py2 / 30, seed + 91, 2) * 9)) * 0.09 * (1 - (band - 1) / 2.4);
            var fa = Clamp01((ring * 0.95 + halo + lines) * wob * s.foamStrength * fo);
            if (dOut[e2] >= M && !isLand[e2]) fa = 0;
            wr += (fr - wr) * fa; wg += (fg - wg) * fa; wb += (fb - wb) * fa;
            if (s.transparentWater) wa = Math.max(wa, fa);
          }
          // land
          var lr = 0, lg = 0, lb = 0;
          if (aLand > 0) {
            var ta = types[typeA[e2]];
            Tile(ta, px2, py2, seed + typeA[e2] * 13, s.variantScale, L); lr = L[0]; lg = L[1]; lb = L[2];
            var mb = mixB[e2];
            if (mb > 0.002 && typeB[e2] !== typeA[e2]) { Tile(types[typeB[e2]], px2, py2, seed + typeB[e2] * 13, s.variantScale, C); lr += (C[0] - lr) * mb; lg += (C[1] - lg) * mb; lb += (C[2] - lb) * mb; }
            var din = Math.max(0, sdCoast);
            var shade = 1 - s.coastShade * Math.exp(-Math.max(0, din - rimW * 0.8) / (rimW * 1.3)) * Smooth(rimW * 0.2, rimW * 0.9, din);
            lr *= shade; lg *= shade; lb *= shade;
            var rimT = ta.rim;
            if (rimT >= 0 && rimT < nt && rimT !== typeA[e2]) {
              var jit = (Fbm(px2 / 22, py2 / 22, seed + 101, 3) - 0.5) * rimW * 0.9;
              var rm = 1 - Smooth(rimW * 0.35, rimW * 1.05, din + jit);
              if (mb > 0.5 && types[typeB[e2]].rim !== rimT) rm *= 1 - (mb - 0.5) * 2;
              if (rm > 0.001) {
                Tile(types[rimT], px2, py2, seed + rimT * 13, s.variantScale, C);
                var wet = 1 + 0.18 * (1 - Smooth(0, rimW * 0.45, din));
                var rr = Math.min(1, C[0] * wet), rg = Math.min(1, C[1] * wet), rb = Math.min(1, C[2] * wet);
                lr += (rr - lr) * rm; lg += (rg - lg) * rm; lb += (rb - lb) * rm;
              }
            }
            var big = 0.94 + 0.12 * Fbm(px2 / 220, py2 / 220, seed + 111, 3);
            lr *= big; lg *= big; lb *= big;
          }
          R = wr + (lr - wr) * aLand; G = wg + (lg - wg) * aLand; B = wb + (lb - wb) * aLand; A = wa + (1 - wa) * aLand;
        }
        if (rv.length) { P.R = R; P.G = G; P.B = B; P.A = A; RiverPixel(rv, types, s, px2, py2, sdCoast, P, deepT, shallowT); R = P.R; G = P.G; B = P.B; A = P.A; }
        var o = (y * w + x) * 4;
        rgba[o] = Clamp01(R) * 255 + 0.5; rgba[o + 1] = Clamp01(G) * 255 + 0.5; rgba[o + 2] = Clamp01(B) * 255 + 0.5; rgba[o + 3] = Clamp01(A) * 255 + 0.5;
      }
    }
    return rgba;
  }

  var RW = [0, 0, 0], RS = [0, 0, 0], RB = [0, 0, 0];
  function RiverPixel(rv, types, s, px, py, sdCoast, P, deepT, shallowT) {
    var best = 1e9, bestAlong = 0, bestHw = 1, br = null;
    for (var q = 0; q < rv.length; q++) {
      var r = rv[q];
      if (px < r.minX || px > r.maxX || py < r.minY || py > r.maxY) continue;
      var rb = 1e9, ra = 0, rh = 1, X = r.x, Y = r.y, HW = r.hw, padB = r.bankWidth + r.foamWidth * 3 + 2;
      for (var i = 0; i + 1 < r.count; i++) {
        var x0 = X[i], y0 = Y[i], x1 = X[i + 1], y1 = Y[i + 1];
        var pad = Math.max(HW[i], HW[i + 1]) + padB;
        if (px < Math.min(x0, x1) - pad || px > Math.max(x0, x1) + pad || py < Math.min(y0, y1) - pad || py > Math.max(y0, y1) + pad) continue;
        var dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
        var t = l2 > 1e-6 ? Clamp01(((px - x0) * dx + (py - y0) * dy) / l2) : 0;
        var qx = x0 + dx * t - px, qy = y0 + dy * t - py, hw = HW[i] + (HW[i + 1] - HW[i]) * t;
        var sd = Math.sqrt(qx * qx + qy * qy) - hw;
        if (sd < rb) { rb = sd; ra = r.along[i] + (r.along[i + 1] - r.along[i]) * t; rh = hw; }
      }
      for (var k = 0; k < r.lakes.length; k++) {
        var l = r.lakes[k], ddx = px - l[0], ddy = py - l[1];
        var ang = Math.atan2(ddy, ddx);
        var rad = l[2] * (0.82 + 0.36 * Fbm(Math.cos(ang) * 1.3 + l[0] * 0.01, Math.sin(ang) * 1.3 + l[1] * 0.01, r.seed + 5, 3));
        var sdl = Math.sqrt(ddx * ddx + ddy * ddy) - rad;
        if (rb < 1e8) { var kk = Math.max(4, rh * 1.2), hh = Clamp01(0.5 + 0.5 * (rb - sdl) / kk); sdl = sdl + (rb - sdl) * (1 - hh) - kk * hh * (1 - hh); }
        if (sdl < rb) { rb = sdl; rh = Math.max(rh, l[2] * 0.6); }
      }
      if (rb < best) { best = rb; bestAlong = ra; bestHw = rh; br = r; }
    }
    if (!br) return;
    var sdv = best, landK = s.riversOnly ? 1 : Smooth(-6, 10, sdCoast), seed = br.seed;
    if (br.bankType >= 0 && br.bankType < types.length && br.bankWidth > 0.5) {
      var jit = (Fbm(px / 18, py / 18, seed + 3, 3) - 0.5) * br.bankWidth * 0.8;
      var ab = (1 - Smooth(br.bankWidth * 0.55, br.bankWidth * 1.15, sdv + jit)) * landK;
      if (ab > 0.001) {
        Tile(types[br.bankType], px, py, s.seed + br.bankType * 13, s.variantScale, RB);
        var wet = 1 - 0.12 * (1 - Smooth(0, br.bankWidth * 0.6, sdv));
        P.R += (RB[0] * wet - P.R) * ab; P.G += (RB[1] * wet - P.G) * ab; P.B += (RB[2] * wet - P.B) * ab; P.A += (1 - P.A) * ab;
      }
    }
    if (br.foam && sdv > 0) {
      var fa = Math.exp(-(sdv * sdv) / (br.foamWidth * br.foamWidth)) * 0.55 * landK;
      P.R += (s.foamR - P.R) * fa; P.G += (s.foamG - P.G) * fa; P.B += (s.foamB - P.B) * fa; P.A += (1 - P.A) * fa;
    }
    var aw = Clamp01(0.5 - sdv) * landK;
    if (aw <= 0) return;
    Tile(types[deepT], px, py, s.seed, s.variantScale, RW);
    var wr = RW[0], wg = RW[1], wb = RW[2], sr = wr, sg = wg, sb = wb;
    if (shallowT >= 0) { Tile(types[shallowT], px, py, s.seed + 3, s.variantScale, RS); sr = RS[0]; sg = RS[1]; sb = RS[2]; }
    if (br.waterMode === 1) { wr += (sr - wr) * 0.55; wg += (sg - wg) * 0.55; wb += (sb - wb) * 0.55; }
    else if (br.waterMode === 2) { var lum = (wr + wg + wb) / 3 / 0.28; wr = br.wr * lum; wg = br.wg * lum; wb = br.wb * lum; }
    var edge = Math.exp(Math.min(0, sdv) / Math.max(2, bestHw * 0.45)) * 0.6;
    wr += (sr - wr) * edge; wg += (sg - wg) * edge; wb += (sb - wb) * edge;
    if (br.foam) { var fi = Math.exp(Math.min(0, sdv) / Math.max(0.8, br.foamWidth * 0.6)) * 0.75; wr += (s.foamR - wr) * fi; wg += (s.foamG - wg) * fi; wb += (s.foamB - wb) * fi; }
    if (br.ripples && bestHw > 2) {
      var across = Math.min(0, sdv) / bestHw, n = Noise(bestAlong / 9, across * 3.5, seed + 17);
      var rp = Smooth(0.72, 0.95, n) * 0.28 * (1 + across * 0.6);
      wr += (s.foamR - wr) * rp; wg += (s.foamG - wg) * rp; wb += (s.foamB - wb) * rp;
    }
    P.R += (wr - P.R) * aw; P.G += (wg - P.G) * aw; P.B += (wb - P.B) * aw; P.A += (1 - P.A) * aw;
  }

  // ---------------------------------------------------------------- rivers (MapRiverCore)
  function computeBounds(sh) {
    var pad = sh.bankWidth + sh.foamWidth * 3 + 4;
    sh.minX = sh.minY = Infinity; sh.maxX = sh.maxY = -Infinity;
    for (var i = 0; i < sh.count; i++) {
      sh.minX = Math.min(sh.minX, sh.x[i] - sh.hw[i] - pad); sh.maxX = Math.max(sh.maxX, sh.x[i] + sh.hw[i] + pad);
      sh.minY = Math.min(sh.minY, sh.y[i] - sh.hw[i] - pad); sh.maxY = Math.max(sh.maxY, sh.y[i] + sh.hw[i] + pad);
    }
    sh.lakes.forEach(function (l) { var r = l[2] * 1.3 + pad; sh.minX = Math.min(sh.minX, l[0] - r); sh.maxX = Math.max(sh.maxX, l[0] + r); sh.minY = Math.min(sh.minY, l[1] - r); sh.maxY = Math.max(sh.maxY, l[1] + r); });
  }
  function BuildRiver(cx, cy, cw, taperStart, taperEnd, meander, wavelength, seed, lakeStart, lakeEnd, step) {
    step = step || 3;
    var sh = { x: [], y: [], hw: [], along: [], count: 0, lakes: [], bankType: -1, bankWidth: 8, waterMode: 0, wr: 0.2, wg: 0.45, wb: 0.65, foam: true, foamWidth: 3, ripples: true, seed: seed | 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
    var n = cx.length; if (!n) return sh;
    var X = [], Y = [], W = [];
    if (n === 1) { X.push(cx[0]); Y.push(cy[0]); W.push(cw[0]); }
    for (var i = 0; i + 1 < n; i++) {
      var p0x = cx[Math.max(0, i - 1)], p0y = cy[Math.max(0, i - 1)], p1x = cx[i], p1y = cy[i], p2x = cx[i + 1], p2y = cy[i + 1];
      var p3x = cx[Math.min(n - 1, i + 2)], p3y = cy[Math.min(n - 1, i + 2)];
      var len = Math.hypot(p2x - p1x, p2y - p1y), segs = Math.max(2, Math.ceil(len / Math.max(0.5, step)));
      for (var k = 0; k < segs; k++) {
        var t = k / segs, t2 = t * t, t3 = t2 * t;
        X.push(0.5 * (2 * p1x + (-p0x + p2x) * t + (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 + (-p0x + 3 * p1x - 3 * p2x + p3x) * t3));
        Y.push(0.5 * (2 * p1y + (-p0y + p2y) * t + (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 + (-p0y + 3 * p1y - 3 * p2y + p3y) * t3));
        var sm = t * t * (3 - 2 * t); W.push(cw[i] + (cw[i + 1] - cw[i]) * sm);
      }
    }
    if (n > 1) { X.push(cx[n - 1]); Y.push(cy[n - 1]); W.push(cw[n - 1]); }
    var m = X.length, along = new Array(m); along[0] = 0;
    for (i = 1; i < m; i++) along[i] = along[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    var Lm = Math.max(1e-3, along[m - 1]), wave = Math.max(10, wavelength);
    sh.along = along; sh.count = m;
    for (i = 0; i < m; i++) {
      var tt = along[i] / Lm, taper = taperStart + (taperEnd - taperStart) * tt, hw = Math.max(0.5, W[i] * 0.5 * taper), ox = 0, oy = 0;
      if (meander > 0 && m > 2) {
        var a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1), tx = X[b] - X[a], ty = Y[b] - Y[a], tl = Math.hypot(tx, ty) + 1e-6;
        var nx = -ty / tl, ny = tx / tl;
        var env = Smooth(0, wave * 0.6, along[i]) * Smooth(0, wave * 0.6, Lm - along[i]);
        var kk = (Fbm(along[i] / wave, 0.37, (seed | 0) + 41, 3) - 0.5) * 2, amp = meander * Math.max(hw * 2.5, wave * 0.35);
        ox = nx * kk * amp * env; oy = ny * kk * amp * env;
      }
      sh.x.push(X[i] + ox); sh.y.push(Y[i] + oy); sh.hw.push(hw);
    }
    if (lakeStart > 0) sh.lakes.push([sh.x[0], sh.y[0], lakeStart]);
    if (lakeEnd > 0 && m > 1) sh.lakes.push([sh.x[m - 1], sh.y[m - 1], lakeEnd]);
    computeBounds(sh);
    return sh;
  }
  function SignedDistance(r, px, py) {
    var best = 1e9;
    for (var i = 0; i + 1 < r.count; i++) {
      var x0 = r.x[i], y0 = r.y[i], dx = r.x[i + 1] - x0, dy = r.y[i + 1] - y0, l2 = dx * dx + dy * dy;
      var t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
      var sd = Math.hypot(x0 + dx * t - px, y0 + dy * t - py) - (r.hw[i] + (r.hw[i + 1] - r.hw[i]) * t);
      if (sd < best) best = sd;
    }
    if (r.count === 1) best = Math.min(best, Math.hypot(px - r.x[0], py - r.y[0]) - r.hw[0]);
    r.lakes.forEach(function (l) { var sd = Math.hypot(px - l[0], py - l[1]) - l[2]; if (sd < best) best = sd; });
    return best;
  }
  return { Hash: Hash, Noise: Noise, Fbm: Fbm, Edt: Edt, Render: Render, BuildRiver: BuildRiver, computeBounds: computeBounds, SignedDistance: SignedDistance };
}
var CORE = MMTerrainCore();
var Fbm = CORE.Fbm;

// ====================================================================== Smart Fill ops on the grid (MapTerrainFill)
function Rng(seed) {
  var s = (Math.imul(seed | 0, 2654435761) + 1013904223) >>> 0;
  this.next = function () {
    s = (s + 0x6D2B79F5) >>> 0; var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (((t ^ (t >>> 14)) >>> 0) & 0xffffff) / 16777216;
  };
  this.range = function (a, b) { return a + (b - a) * this.next(); };
  this.int = function (n) { return Math.min(n - 1, Math.floor(this.next() * n)); };
}
function encodeRle(cells) {
  var out = [], i = 0;
  if (!cells) return '';
  while (i < cells.length) { var j = i; while (j < cells.length && cells[j] === cells[i]) j++; out.push((j - i) + '*' + cells[i]); i = j; }
  return out.join(',');
}
function decodeRle(rle, count, fill) {
  var o = new Uint8Array(Math.max(0, count)); o.fill(fill | 0);
  if (!rle || typeof rle !== 'string') return o;
  var p = 0;
  rle.split(',').forEach(function (part) {
    var st = part.indexOf('*'); if (st <= 0) return;
    var n = parseInt(part.slice(0, st), 10), t = parseInt(part.slice(st + 1), 10);
    if (!isFinite(n) || !isFinite(t)) return;
    t = Math.max(0, Math.min(255, t));
    for (var k = 0; k < n && p < o.length; k++) o[p++] = t;
  });
  return o;
}
function isLand(c, water) { return c < water.length ? !water[c] : false; }
function blobs(cells, cols, rows, water) {
  var lab = new Int32Array(cells.length).fill(-1), sizes = [], q = new Int32Array(cells.length);
  for (var i = 0; i < cells.length; i++) {
    if (lab[i] >= 0 || !isLand(cells[i], water)) continue;
    var id = sizes.length, n = 0, qh = 0, qt = 0; lab[i] = id; q[qt++] = i;
    while (qh < qt) {
      var c = q[qh++]; n++; var x = c % cols, y = (c / cols) | 0;
      if (x + 1 < cols && lab[c + 1] < 0 && isLand(cells[c + 1], water)) { lab[c + 1] = id; q[qt++] = c + 1; }
      if (x > 0 && lab[c - 1] < 0 && isLand(cells[c - 1], water)) { lab[c - 1] = id; q[qt++] = c - 1; }
      if (y + 1 < rows && lab[c + cols] < 0 && isLand(cells[c + cols], water)) { lab[c + cols] = id; q[qt++] = c + cols; }
      if (y > 0 && lab[c - cols] < 0 && isLand(cells[c - cols], water)) { lab[c - cols] = id; q[qt++] = c - cols; }
    }
    sizes.push(n);
  }
  return { lab: lab, sizes: sizes };
}
function disc(o, cols, rows, cx, cy, r, t, water, onlyWater) {
  var x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (var y = Math.max(0, y0); y <= Math.min(rows - 1, y1); y++)
    for (var x = Math.max(0, x0); x <= Math.min(cols - 1, x1); x++) {
      var dx = x + 0.5 - cx, dy = y + 0.5 - cy; if (dx * dx + dy * dy > r * r) continue;
      var i = y * cols + x; if (onlyWater && isLand(o[i], water)) continue; o[i] = t;
    }
}
/** Joins land blobs with organic land bridges (minimum spanning tree). type 255 = source cell's type. */
function connect(cells, cols, rows, water, minCells, width, curve, jitter, type, seed, extraLinks) {
  var o = cells.slice(), B = blobs(cells, cols, rows, water), lab = B.lab, sizes = B.sizes, ids = [];
  for (var b = 0; b < sizes.length; b++) if (sizes[b] >= minCells) ids.push(b);
  if (ids.length < 2) return { cells: o, links: 0, blobs: ids.length };
  var edge = sizes.map(function () { return []; });
  for (var i = 0; i < cells.length; i++) {
    var bb = lab[i]; if (bb < 0) continue;
    var x = i % cols, y = (i / cols) | 0, bd = x === 0 || x === cols - 1 || y === 0 || y === rows - 1 || lab[i - 1] !== bb || lab[i + 1] !== bb || lab[i - cols] !== bb || lab[i + cols] !== bb;
    if (bd) edge[bb].push(i);
  }
  ids.forEach(function (b) { var e = edge[b]; if (e.length > 400) { var s = [], st = ((e.length / 400) | 0) + 1; for (var k = 0; k < e.length; k += st) s.push(e[k]); edge[b] = s; } });
  var n = ids.length, dist = [], pa = [], pb = [];
  for (i = 0; i < n; i++) { dist.push(new Float64Array(n)); pa.push(new Int32Array(n)); pb.push(new Int32Array(n)); }
  for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
    var best = Infinity, ba = 0, bc = 0, ei = edge[ids[i]], ej = edge[ids[j]];
    for (var a = 0; a < ei.length; a++) { var A = ei[a], ax = A % cols, ay = (A / cols) | 0;
      for (var c = 0; c < ej.length; c++) { var Cc = ej[c], dx = ax - Cc % cols, dy = ay - ((Cc / cols) | 0), d = dx * dx + dy * dy; if (d < best) { best = d; ba = A; bc = Cc; } } }
    dist[i][j] = dist[j][i] = best; pa[i][j] = ba; pb[i][j] = bc; pa[j][i] = bc; pb[j][i] = ba;
  }
  var inTree = new Uint8Array(n), links = []; inTree[0] = 1;
  for (var it = 1; it < n; it++) {
    var bst = Infinity, bi = -1, bj = -1;
    for (i = 0; i < n; i++) if (inTree[i]) for (j = 0; j < n; j++) if (!inTree[j] && dist[i][j] < bst) { bst = dist[i][j]; bi = i; bj = j; }
    if (bj < 0) break; inTree[bj] = 1; links.push([bi, bj]);
  }
  if (extraLinks > 0) {
    var cand = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) if (!links.some(function (l) { return (l[0] === i && l[1] === j) || (l[0] === j && l[1] === i); })) cand.push([i, j]);
    cand.sort(function (p, q) { return dist[p[0]][p[1]] - dist[q[0]][q[1]]; });
    for (var k2 = 0; k2 < Math.min(extraLinks, cand.length); k2++) links.push(cand[k2]);
  }
  var rng = new Rng(seed);
  links.forEach(function (l) {
    var a = pa[l[0]][l[1]], c = pb[l[0]][l[1]];
    var ax = a % cols + 0.5, ay = ((a / cols) | 0) + 0.5, cx = c % cols + 0.5, cy = ((c / cols) | 0) + 0.5;
    var dx = cx - ax, dy = cy - ay, len = Math.hypot(dx, dy); if (len < 0.5) return;
    var t = type !== 255 ? type : (rng.next() < 0.5 ? cells[a] : cells[c]);
    var nx = -dy / len, ny = dx / len, bend = (rng.next() - 0.5) * 2 * curve * len * 0.35, ns = rng.int(1000), steps = Math.max(2, (len * 3) | 0);
    for (var k = 0; k <= steps; k++) {
      var t01 = k / steps, env = Math.sin(t01 * Math.PI);
      var wob = (Fbm(t01 * len / 3, 0.5, seed + ns, 2) - 0.5) * 2 * curve * 1.5;
      var px = ax + dx * t01 + nx * (bend * env + wob * env), py = ay + dy * t01 + ny * (bend * env + wob * env);
      var wj = 1 + (Fbm(t01 * len / 2.5, 3.3, seed + ns + 9, 2) - 0.5) * 2 * jitter * 0.8;
      disc(o, cols, rows, px, py, Math.max(0.5, width * 0.5 * wj * (0.75 + 0.25 * (1 - env))), t, water, true);
    }
  });
  return { cells: o, links: links.length, blobs: n };
}
/** Expands land outward by up to `amount` cells with a noisy coast; outer cells become coastType (255 = keep). */
function grow(cells, cols, rows, water, amount, roughness, coastType, seed, mask) {
  var o = cells.slice(), n = cells.length, dist = new Float32Array(n), src = new Int32Array(n), q = [], qh = 0;
  for (var i = 0; i < n; i++) { if (isLand(cells[i], water)) { dist[i] = 0; src[i] = i; q.push(i); } else { dist[i] = Infinity; src[i] = -1; } }
  var lim = Math.ceil(amount * 1.6) + 1;
  while (qh < q.length) {
    var c = q[qh++], x = c % cols, y = (c / cols) | 0; if (dist[c] >= lim) continue;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; var nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      var ni = ny * cols + nx, nd = dist[c] + (dx && dy ? 1.414 : 1);
      if (nd < dist[ni]) { dist[ni] = nd; src[ni] = src[c]; q.push(ni); }
    }
  }
  for (i = 0; i < n; i++) {
    if (src[i] < 0 || dist[i] <= 0 || (mask && !mask[i])) continue;
    var xx = i % cols, yy = (i / cols) | 0, nz = Fbm(xx / 4.5, yy / 4.5, seed + 3, 3), reach = amount * (1 - roughness + roughness * 2 * nz);
    if (dist[i] <= reach) { var t = cells[src[i]]; if (coastType !== 255 && dist[i] > reach - 1 && amount >= 2.5) t = coastType; o[i] = t; }
  }
  return o;
}
/** Noise-shaped islands inside a cell rectangle. 255 = none for coast/peak/forest. */
function island(cells, cols, rows, water, rx, ry, rw, rh, density, scale, landType, coastType, peakType, peaks, forestType, forest, seed) {
  var o = cells.slice(), thr = 1 - Math.max(0.02, Math.min(0.98, density)), sc = Math.max(2, scale);
  for (var y = Math.max(0, ry); y < Math.min(rows, ry + rh); y++) for (var x = Math.max(0, rx); x < Math.min(cols, rx + rw); x++) {
    var u = (x - rx + 0.5) / Math.max(1, rw) * 2 - 1, v = (y - ry + 0.5) / Math.max(1, rh) * 2 - 1;
    var fall = Math.max(Math.abs(u), Math.abs(v)); fall = fall * fall * 0.75 + (u * u + v * v) * 0.25;
    var hgt = Fbm(x / sc, y / sc, seed + 1, 4) * 1.25 - fall * 0.55, base = thr * 0.9 + 0.05;
    if (hgt <= base) continue;
    var hi = hgt - base, t = landType;
    if (coastType !== 255 && hi < 0.035) t = coastType;
    else if (peakType !== 255 && peaks > 0 && hi > 0.32 - peaks * 0.22) t = peakType;
    else if (forestType !== 255 && forest > 0 && Fbm(x / (sc * 0.6), y / (sc * 0.6), seed + 77, 3) > 1 - forest * 0.55) t = forestType;
    o[y * cols + x] = t;
  }
  return o;
}
/** Cellular clean-up: lone cells take their neighbours' majority type. */
function smooth(cells, cols, rows, iterations, mask) {
  var a = cells.slice(), b = new Uint8Array(a.length), cnt = new Int32Array(256);
  for (var it = 0; it < Math.max(1, iterations); it++) {
    for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
      var i = y * cols + x, self = a[i];
      if (mask && !mask[i]) { b[i] = self; continue; }
      var same = 0, best = -1, bestN = 0, dx, dy, nx, ny, t;
      for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        nx = Math.max(0, Math.min(cols - 1, x + dx)); ny = Math.max(0, Math.min(rows - 1, y + dy)); t = a[ny * cols + nx];
        if (t === self) same++; var c = ++cnt[t]; if (c > bestN) { bestN = c; best = t; }
      }
      for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { nx = Math.max(0, Math.min(cols - 1, x + dx)); ny = Math.max(0, Math.min(rows - 1, y + dy)); cnt[a[ny * cols + nx]] = 0; }
      b[i] = same <= 2 && bestN >= 5 ? best : self;
    }
    var tmp = a; a = b; b = tmp;
  }
  return a;
}
function floodFill(cells, cols, rows, x, y, type) {
  if (x < 0 || y < 0 || x >= cols || y >= rows) return 0;
  var from = cells[y * cols + x]; if (from === type) return 0;
  var q = [y * cols + x], qh = 0, n = 0; cells[q[0]] = type;
  while (qh < q.length) {
    var c = q[qh++], cx = c % cols, cy = (c / cols) | 0; n++;
    if (cx > 0 && cells[c - 1] === from) { cells[c - 1] = type; q.push(c - 1); }
    if (cx < cols - 1 && cells[c + 1] === from) { cells[c + 1] = type; q.push(c + 1); }
    if (cy > 0 && cells[c - cols] === from) { cells[c - cols] = type; q.push(c - cols); }
    if (cy < rows - 1 && cells[c + cols] === from) { cells[c + cols] = type; q.push(c + cols); }
  }
  return n;
}
/** Square or round brush of `size` cells centred on continuous cell coords (cx, cy). */
function brush(cells, cols, rows, cx, cy, size, round, type) {
  var ch = false, r = size * 0.5, x0 = Math.floor(cx - r + 0.5), y0 = Math.floor(cy - r + 0.5);
  for (var y = y0; y < y0 + size; y++) for (var x = x0; x < x0 + size; x++) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
    if (round && size > 2) { var dx = x + 0.5 - cx, dy = y + 0.5 - cy; if (dx * dx + dy * dy > r * r + 0.25) continue; }
    var i = y * cols + x; if (cells[i] !== type) { cells[i] = type; ch = true; }
  }
  return ch;
}
/** Writes a river's water into the grid (cells within ~0.6 cell of the channel, so thin rivers stay connected). */
function stampRiver(cells, cols, rows, cellPx, r, type, shrink) {
  var n = 0; shrink = shrink || 0;
  var x0 = Math.max(0, ((r.minX / cellPx) | 0) - 1), x1 = Math.min(cols - 1, ((r.maxX / cellPx) | 0) + 1);
  var y0 = Math.max(0, ((r.minY / cellPx) | 0) - 1), y1 = Math.min(rows - 1, ((r.maxY / cellPx) | 0) + 1);
  for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
    var sd = CORE.SignedDistance(r, (x + 0.5) * cellPx, (y + 0.5) * cellPx);
    if (sd < (0.6 - shrink) * cellPx) { var i = y * cols + x; if (cells[i] !== type) { cells[i] = type; n++; } }
  }
  return n;
}

// ====================================================================== data defaults (same as the Unity package)
function C(r, g, b) { return { r: r, g: g, b: b, a: 1 }; }
function T(id, name, kind, pri, c, rim) { return { id: id, name: name, kind: kind, priority: pri, color: c, rimId: rim, foam: true, tileKeys: [0, 1, 2, 3].map(function (i) { return 'Terrain/Tiles/' + id + '_' + i; }), tileGuids: [], tintAmount: 0 }; }
function defaultTypes() {
  return [
    T('deep', 'Deep Water', 'Water', 0, C(0.10, 0.27, 0.44), ''),
    T('shallow', 'Shallow Water', 'Water', 1, C(0.20, 0.45, 0.58), ''),
    T('sand', 'Sand', 'Land', 2, C(0.80, 0.70, 0.50), ''),
    T('grass', 'Grass', 'Land', 3, C(0.47, 0.55, 0.22), 'sand'),
    T('dirt', 'Dirt', 'Land', 3, C(0.42, 0.31, 0.20), 'sand'),
    T('forest', 'Forest', 'Land', 4, C(0.20, 0.33, 0.16), 'grass'),
    T('swamp', 'Swamp', 'Land', 3, C(0.30, 0.36, 0.22), ''),
    T('ice', 'Ice / Snow', 'Land', 5, C(0.86, 0.90, 0.95), ''),
    T('rock', 'Rock', 'Land', 5, C(0.45, 0.43, 0.40), ''),
    T('lava', 'Lava', 'Land', 5, C(0.70, 0.25, 0.08), 'rock')
  ];
}
function defaultLook() { return { edgeNoise: 0.55, rimWidth: 0.08, foamWidth: 0.07, foamStrength: 0.9, foamColor: { r: 0.94, g: 0.98, b: 1, a: 1 }, shallowWidth: 0.4, shallowStrength: 0.55, coastShade: 0.12, variantScale: 3.6, typeBlend: 0.45, seed: 1 }; }
function defaultRiverStyle() { return { taperStart: 0.5, taperEnd: 1.2, meander: 0.5, meanderWave: 1.2, bankId: 'sand', bankWidth: 0.07, waterMode: 0, customColor: { r: 0.22, g: 0.55, b: 0.62, a: 1 }, foam: true, foamWidth: 0.03, ripples: true, lakeStart: 0, lakeEnd: 0, seed: 7 }; }
function S(o) { return Object.assign(defaultRiverStyle(), o); }
var BUILTIN_PRESETS = [
  { name: 'Lowland river', style: S({}) },
  { name: 'Mountain stream', style: S({ taperStart: 0.2, taperEnd: 1.5, meander: 0.9, meanderWave: 0.6, bankId: 'rock', bankWidth: 0.05, waterMode: 1, foam: true, foamWidth: 0.025, ripples: true, seed: 11 }) },
  { name: 'Jungle river', style: S({ taperStart: 0.6, taperEnd: 1.1, meander: 0.8, meanderWave: 1.8, bankId: 'grass', bankWidth: 0.09, waterMode: 2, customColor: C(0.27, 0.45, 0.36), foam: false, ripples: true, seed: 5 }) },
  { name: 'Desert wadi', style: S({ taperStart: 0.4, taperEnd: 1.4, meander: 0.35, meanderWave: 2.2, bankId: 'sand', bankWidth: 0.12, waterMode: 1, foam: true, ripples: false, seed: 3 }) },
  { name: 'Lake chain', style: S({ meander: 0.4, bankId: 'sand', lakeStart: 0.9, lakeEnd: 1.3, seed: 9 }) },
  { name: 'Lava flow', style: S({ taperStart: 0.3, taperEnd: 1, meander: 0.6, meanderWave: 1, bankId: 'rock', bankWidth: 0.08, waterMode: 2, customColor: C(0.95, 0.42, 0.1), foam: false, ripples: true, seed: 13 }) },
  { name: 'Canal (straight)', style: S({ taperStart: 0, taperEnd: 0, meander: 0, bankId: 'rock', bankWidth: 0.04, foam: false, ripples: false }) }
];
// Canal: taper 0 would give zero width; Unity clamps hw to 0.5 px. Use 1 = constant width (the HTML UI shows it as "no taper").
BUILTIN_PRESETS[6].style.taperStart = 1; BUILTIN_PRESETS[6].style.taperEnd = 1;

// ====================================================================== tiles (seamless textures, shared with Unity)
var TILE_URI = window.MM_TILES || {};
var tileImg = {}, tileReady = null;
function loadTiles() {
  if (tileReady) return tileReady;
  tileReady = Promise.all(Object.keys(TILE_URI).map(function (k) {
    return new Promise(function (res) { var im = new Image(); im.onload = function () { tileImg[k] = im; res(); }; im.onerror = function () { res(); }; im.src = TILE_URI[k]; });
  }));
  return tileReady;
}
var scaledCache = {};
/** RGB bytes of a tile key ('Terrain/Tiles/grass_0' or 'grass_0') resampled to `scale` (render ppu / 100). */
function tileRgb(key, scale) {
  var k = String(key || '').replace(/^.*\//, ''), im = tileImg[k]; if (!im) return null;
  var ck = k + '@' + scale.toFixed(3); if (scaledCache[ck]) return scaledCache[ck];
  var w = Math.max(4, Math.round(im.naturalWidth * scale)), h = Math.max(4, Math.round(im.naturalHeight * scale));
  var c = document.createElement('canvas'); c.width = w; c.height = h;
  var x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  // draw 3x3 so the resampled edges stay seamless
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) x.drawImage(im, dx * w, dy * h, w, h);
  var d = x.getImageData(0, 0, w, h).data, rgb = new Uint8Array(w * h * 3);
  for (var i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
  return (scaledCache[ck] = { w: w, h: h, rgb: rgb });
}
/** HTML-only extra variants: 'grass_0..3' also pulls in the generated 'grass_4..7' (saved JSON keeps the Unity keys) */
function expandKeys(keys) {
  var out = keys.slice();
  keys.forEach(function (k) { var m = /^(.*_)(\d+)$/.exec(String(k)); if (m && +m[2] < 4) { var e = m[1] + (+m[2] + 4), b = e.replace(/^.*\//, ''); if (TILE_URI[b] && out.indexOf(e) < 0) out.push(e); } });
  return out;
}
function tileThumb(key) { var k = String(key || '').replace(/^.*\//, ''); return TILE_URI[k] || ''; }
function tileNames() { return Object.keys(TILE_URI).sort(); }

// ====================================================================== worker pool
var CORE_SRC = '(' + MMTerrainCore.toString() + ')()';
var WORKER_SRC = 'var CORE=' + CORE_SRC + ';var TILES={};' +
  'onmessage=function(e){var m=e.data;if(m.cmd==="tiles"){TILES[m.key]=m.tiles;return;}' +
  'var ts=TILES[m.tileKey]||[];var types=m.types.map(function(t,i){var o={};for(var k in t)o[k]=t[k];o.tiles=ts[i]||[];return o;});' +
  'try{var px=CORE.Render({cells:m.cells,cols:m.cols,rows:m.rows,types:types,baseType:m.baseType,s:m.s,rivers:m.rivers,ox:m.ox,oy:m.oy,w:m.w,h:m.h});' +
  'postMessage({id:m.id,rgba:px.buffer},[px.buffer]);}catch(err){postMessage({id:m.id,error:String(err)});}};';
var pool = null;
function makePool() {
  if (pool) return pool;
  pool = { workers: [], queue: [], busy: [], jobs: {}, nextId: 1, tileSets: {}, ok: false };
  var n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  try {
    var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    for (var i = 0; i < n; i++) {
      var w = new Worker(url); w._i = i; w._sets = {};
      w.onmessage = onWorkerMsg.bind(null, i);
      w.onerror = function (ev) {
        ev.preventDefault && ev.preventDefault(); pool.ok = false;   // fall back to the main thread, re-queue everything in flight
        for (var b = 0; b < pool.busy.length; b++) if (pool.busy[b]) { mainQueue.push(pool.busy[b]); pool.busy[b] = null; }
        while (pool.queue.length) mainQueue.push(pool.queue.shift());
        runMain();
      };
      pool.workers.push(w); pool.busy.push(null);
    }
    pool.ok = true;
  } catch (e) { pool.ok = false; pool.workers = []; }
  return pool;
}
function onWorkerMsg(i, e) {
  var m = e.data, job = pool.busy[i]; pool.busy[i] = null;
  if (job) { if (m.error) job.reject(new Error(m.error)); else job.resolve(new Uint8ClampedArray(m.rgba)); }
  pump();
}
function pump() {
  for (var i = 0; i < pool.workers.length && pool.queue.length; i++) {
    if (pool.busy[i]) continue;
    var job = pool.queue.shift(), w = pool.workers[i];
    if (job.cancelled && job.cancelled()) { job.reject(new Error('cancelled')); i--; continue; }
    pool.busy[i] = job;
    if (!w._sets[job.tileKey]) { w.postMessage({ cmd: 'tiles', key: job.tileKey, tiles: pool.tileSets[job.tileKey] }); w._sets[job.tileKey] = 1; }
    w.postMessage(job.msg);
  }
}
var mainQueue = [], mainBusy = false;
function runMain() {
  if (mainBusy || !mainQueue.length) return;
  mainBusy = true;
  setTimeout(function () {
    var job = mainQueue.shift(); mainBusy = false;
    if (job) {
      if (job.cancelled && job.cancelled()) job.reject(new Error('cancelled'));
      else try { var m = job.msg, ts = pool.tileSets[job.tileKey] || [];
        var types = m.types.map(function (t, i) { return Object.assign({}, t, { tiles: ts[i] || [] }); });
        job.resolve(CORE.Render({ cells: m.cells, cols: m.cols, rows: m.rows, types: types, baseType: m.baseType, s: m.s, rivers: m.rivers, ox: m.ox, oy: m.oy, w: m.w, h: m.h }));
      } catch (e) { job.reject(e); }
    }
    runMain();
  }, 0);
}
/** ctx from prepare(); rect in render px. Returns Promise<Uint8ClampedArray>. */
function renderRect(ctx, ox, oy, w, h, cancelled, priority) {
  makePool();
  return new Promise(function (resolve, reject) {
    var rivers = ctx.rivers.filter(function (r) { return r.maxX >= ox && r.minX <= ox + w && r.maxY >= oy && r.minY <= oy + h; });
    var msg = { cmd: 'render', cells: ctx.cells, cols: ctx.cols, rows: ctx.rows, types: ctx.types, baseType: ctx.baseType, s: ctx.s, rivers: rivers, ox: ox, oy: oy, w: w, h: h, tileKey: ctx.tileKey };
    var job = { msg: msg, tileKey: ctx.tileKey, resolve: resolve, reject: reject, cancelled: cancelled };
    if (pool.ok) { if (priority) pool.queue.unshift(job); else pool.queue.push(job); pump(); }
    else { if (priority) mainQueue.unshift(job); else mainQueue.push(job); runMain(); }
  });
}
function workerCount() { makePool(); return pool.ok ? pool.workers.length : 0; }

/** Builds a render context for a terrain + rivers description at `ppu` render px per map unit.
    t = map.terrain, rivers = [{points:[{px:{x,y} (map px), width (units)}], style}], opts {transparentWater, riversOnly, mapPPU} */
function prepare(t, rivers, ppu, opts) {
  opts = opts || {};
  var mppu = opts.mapPPU || 100, scale = ppu / 100;
  var list = t.types && t.types.length ? t.types : defaultTypes();
  var idx = function (id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; };
  var types = list.map(function (s) {
    var c = s.color || C(0.5, 0.5, 0.5);
    return { id: s.id, water: s.kind === 'Water', priority: s.priority | 0, rim: idx(s.rimId), foam: s.foam !== false, r: c.r, g: c.g, b: c.b, tint: +s.tintAmount || 0 };
  });
  var tileKey = Math.round(ppu * 1000) + '|' + list.map(function (s) { return (s.tileKeys || []).join('+'); }).join(';');
  makePool();
  if (!pool.tileSets[tileKey]) {
    pool.tileSets[tileKey] = list.map(function (s) { return expandKeys(s.tileKeys || []).map(function (k) { return tileRgb(k, scale); }).filter(Boolean); });
  }
  var l = Object.assign(defaultLook(), t.look || {}), fc = l.foamColor || { r: 0.94, g: 0.98, b: 1 };
  var s = { cellPx: Math.max(2, t.cellSize * ppu), edgeNoise: +l.edgeNoise, rimWidth: Math.max(0.5, l.rimWidth * ppu), foamWidth: Math.max(0.5, l.foamWidth * ppu), foamStrength: +l.foamStrength,
    foamR: fc.r, foamG: fc.g, foamB: fc.b, shallowWidth: Math.max(1, l.shallowWidth * ppu), shallowStrength: +l.shallowStrength, coastShade: +l.coastShade,
    variantScale: Math.max(8, l.variantScale * ppu), typeBlend: Math.max(0.05, Math.min(0.9, l.typeBlend == null ? 0.45 : +l.typeBlend)), seed: l.seed | 0, transparentWater: !!opts.transparentWater, riversOnly: !!opts.riversOnly };
  var k = ppu / mppu;
  var shapes = (rivers || []).map(function (r) { return buildShape(r, idx, ppu, k); }).filter(Boolean);
  var base = idx(t.baseId); if (base < 0) base = 0;
  return { cells: t.cells, cols: t.cols, rows: t.rows, types: types, baseType: base, s: s, rivers: shapes, tileKey: tileKey, ppu: ppu, k: k };
}
/** r.points[i].px = map px; widths in units; ppu = render px per unit; k = render px per map px */
function buildShape(r, idx, ppu, k) {
  if (!r || !r.points || !r.points.length || r.visible === false) return null;
  var st = Object.assign(defaultRiverStyle(), r.style || {});
  var xs = r.points.map(function (p) { return p.px.x * k; }), ys = r.points.map(function (p) { return p.px.y * k; }), ws = r.points.map(function (p) { return Math.max(0.01, +p.width || 0.2) * ppu; });
  var sh = CORE.BuildRiver(xs, ys, ws, +st.taperStart, +st.taperEnd, +st.meander, st.meanderWave * ppu, st.seed | 0, st.lakeStart * ppu, st.lakeEnd * ppu, Math.max(1.5, ppu * 0.03));
  sh.bankType = st.bankId ? idx(st.bankId) : -1; sh.bankWidth = st.bankWidth * ppu;
  sh.waterMode = st.waterMode | 0; var cc = st.customColor || C(0.22, 0.55, 0.62); sh.wr = cc.r; sh.wg = cc.g; sh.wb = cc.b;
  sh.foam = !!st.foam; sh.foamWidth = Math.max(0.5, st.foamWidth * ppu); sh.ripples = !!st.ripples; sh.seed = (st.seed | 0) + (r.id | 0) * 31;
  CORE.computeBounds(sh);
  return sh;
}

window.MMTerrain = {
  core: CORE, Rng: Rng, encodeRle: encodeRle, decodeRle: decodeRle, blobs: blobs, connect: connect, grow: grow, island: island, smooth: smooth,
  floodFill: floodFill, brush: brush, stampRiver: stampRiver, defaultTypes: defaultTypes, defaultLook: defaultLook, defaultRiverStyle: defaultRiverStyle,
  BUILTIN_PRESETS: BUILTIN_PRESETS, loadTiles: loadTiles, tileThumb: tileThumb, tileNames: tileNames, tileRgb: tileRgb, prepare: prepare, buildShape: buildShape,
  renderRect: renderRect, workerCount: workerCount
};
})();
