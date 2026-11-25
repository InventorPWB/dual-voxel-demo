/**
 * The water surface of SpanSim's water (a layered heightfield): one smooth
 * sheet over each body of water, its corners shared between columns.
 *
 * Each wet span draws its column's square at its water level. A corner's
 * height is the average level of the water around it (the up to four
 * columns that meet there), grouped by level: levels within JOIN of each
 * other are one sheet (a stream down a slope, a lake); a bigger step splits
 * them (a waterfall's top and bottom). Every column works a corner out from
 * the same water, so neighbouring squares meet exactly. Where water spills
 * onto dry ground lower down, the dry floor joins in, so the sheet runs down
 * to it.
 *
 * Shores: the sheet carries on flat over the dry columns next to it (a
 * skirt), so the ground cuts it off exactly where it rises out of the water,
 * not at the edge of a column. Moving or sloping water is drawn at least MINVIS deep,
 * so a thin stream still reads as one sheet over the smooth ground.
 *
 * Waterfalls (water pouring over a drop) are a falling sheet from the lip
 * down to the water below, and water against a building piece (an
 * aquarium, a flooded room seen through glass) a pane on its side.
 *
 * Attributes: position, normal, flow (x, z in m/s; then 1 falling, 2 pane),
 * depth (metres, which fades the surface in at the very edge).
 */

/** Shallower than this (voxels) a span counts as dry. */
export const DRY = 0.004;
/**
 * Levels this close (voxels: 1.25 m) are one sheet; bigger drops are
 * waterfalls. (Generous: water running down a steep slope drops more than a
 * voxel from column to column, and should still be one sheet, not a
 * staircase of little falls.)
 */
export const JOIN = 2.5;
/** Fields per span in a snapshot (SpanSim.snapshot): floor, roof, depth, flow x, flow z. */
export const REC = 5;
/** Running water is drawn at least this deep (voxels). */
const MINVIS = 0.16;

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function meshSpans(p, scale = 1) {
  const { size: S, pad: P, origin, start, rec, falls, glass } = p;
  const [ox, oy, oz] = origin;
  const N = S + 2 * P;
  const pos = [], flow = [], dep = [], keys = [];

  // ---- corners --------------------------------------------------------------------

  const cand = [];
  /** Water round corner (i, j) (between local columns i - 1, i and j - 1, j), sorted by level. */
  function gather(i, j) {
    cand.length = 0;
    for (let dj = -1; dj <= 0; dj++)
      for (let di = -1; di <= 0; di++) {
        const ci = i + di, cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
        const c = ci + N * cj;
        for (let r = start[c]; r < start[c + 1]; r++) {
          const o = r * REC, d = rec[o + 2];
          if (d <= DRY) continue;
          const lo = rec[o], hi = rec[o + 1];
          cand.push({ s: lo + Math.min(d, hi - lo), lo, d, vx: rec[o + 3], vz: rec[o + 4], c });
        }
      }
    cand.sort((a, b) => a.s - b.s);
  }

  const cache = new Map();
  /**
   * The sheet at corner (i, j) through the water at level s (or, unless
   * `exact`, the nearest within JOIN): { h, depth, vx, vz }; null if none.
   */
  function corner(i, j, s, exact = true) {
    const key = `${i},${j},${s},${exact}`;
    let out = cache.get(key);
    if (out !== undefined) return out;
    gather(i, j);
    let m = -1, best = Infinity;
    for (let n = 0; n < cand.length; n++) {
      const e = Math.abs(cand[n].s - s);
      if (e < best) { best = e; m = n; }
    }
    if (m < 0 || best > (exact ? 1e-6 : JOIN)) {
      cache.set(key, null);
      return null;
    }
    let a = m, b = m;
    while (a > 0 && cand[a].s - cand[a - 1].s <= JOIN) a--;
    while (b < cand.length - 1 && cand[b + 1].s - cand[b].s <= JOIN) b++;
    const lo = cand[a].s, hi = cand[b].s;
    let hs = 0, n = 0, ds = 0, vx = 0, vz = 0;
    const used = [];
    for (let q = a; q <= b; q++) {
      const c = cand[q];
      hs += c.s;
      ds += c.d;
      vx += c.vx;
      vz += c.vz;
      n++;
      used.push(c.c);
    }
    const members = n;
    // Dry ground lower than the water, beside it: the sheet runs down onto it.
    for (let dj = -1; dj <= 0; dj++)
      for (let di = -1; di <= 0; di++) {
        const ci = i + di, cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
        const c = ci + N * cj;
        if (used.includes(c)) continue;
        let floor = -Infinity;
        for (let r = start[c]; r < start[c + 1]; r++) {
          const o = r * REC;
          if (rec[o + 2] > DRY) continue;
          const f = rec[o];
          if (f < hi && f > lo - JOIN && rec[o + 1] > f && f > floor) floor = f;
        }
        if (floor > -Infinity) {
          hs += floor;
          n++;
        }
      }
    vx /= members;
    vz /= members;
    let h = hs / n;
    // Thin water that's moving, or on a slope: at least MINVIS deep, so it
    // covers the ground it runs over. (Drawn a few millimetres over the ground,
    // the faceted ground would poke through it along every contour, in bands
    // that crawl as the water moves.) Still, level water isn't lifted, so a
    // lake's shore stays exactly where the ground meets its level.
    const speed = Math.hypot(vx, vz);
    const moving = Math.max(Math.min(1, speed / 0.05), Math.min(1, (hi - lo) / 0.05));
    h += Math.max(0, MINVIS - ds / n) * moving;
    out = { h, depth: (ds / 4) * scale + 0.05 * Math.min(1, speed / 0.3), vx, vz };
    cache.set(key, out);
    return out;
  }

  // ---- output --------------------------------------------------------------------

  function vert(x, y, z, fx, fz, kind, d) {
    pos.push(x * scale, y * scale, z * scale);
    flow.push(fx, fz, kind);
    dep.push(d);
    keys.push(kind === 0 ? `${x},${z},${y.toFixed(4)}` : null);
  }

  /** A column's square from its four corners (x0, z0 the corner of the lowest x and z). */
  function square(x0, z0, c00, c10, c01, c11) {
    const v = (x, z, c) => vert(x, c.h, z, c.vx, c.vz, 0, c.depth);
    // (Split along the diagonal whose ends are closer in height: the flatter way.)
    if (Math.abs(c00.h - c11.h) <= Math.abs(c10.h - c01.h)) {
      v(x0, z0, c00); v(x0, z0 + 1, c01); v(x0 + 1, z0 + 1, c11);
      v(x0, z0, c00); v(x0 + 1, z0 + 1, c11); v(x0 + 1, z0, c10);
    } else {
      v(x0, z0, c00); v(x0, z0 + 1, c01); v(x0 + 1, z0, c10);
      v(x0 + 1, z0, c10); v(x0, z0 + 1, c01); v(x0 + 1, z0 + 1, c11);
    }
  }

  const inChunk = (s) => {
    const y = Math.floor(s);
    return y >= oy && y < oy + S;
  };
  const flat = (s) => ({ h: s, depth: 0, vx: 0, vz: 0 });
  /**
   * A skirt's corner away from any water: at the water's level where the
   * ground there is higher (it's hidden in the bank), else down on the ground
   * (the floors of the dry columns round it), so it never hangs in the air.
   */
  function outer(i, j, L) {
    let sum = 0, n = 0;
    for (let dj = -1; dj <= 0; dj++)
      for (let di = -1; di <= 0; di++) {
        const ci = i + di, cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= N || cj >= N) continue;
        const c = ci + N * cj;
        for (let r = start[c]; r < start[c + 1]; r++) {
          const o = r * REC;
          if (rec[o + 1] >= L && rec[o] <= L + 1) { sum += rec[o]; n++; break; }
        }
      }
    return flat(n ? Math.min(L, sum / n) : L);
  }

  // ---- the sheet over wet columns, and skirts over their dry shores ----------------

  for (let j = P; j < P + S; j++)
    for (let i = P; i < P + S; i++) {
      const c = i + N * j;
      const x0 = ox + i - P, z0 = oz + j - P;
      const mine = [];
      for (let r = start[c]; r < start[c + 1]; r++) {
        const o = r * REC, d = rec[o + 2];
        if (d <= DRY) continue;
        const lo = rec[o], hi = rec[o + 1];
        const s = lo + Math.min(d, hi - lo);
        mine.push(s);
        if (!inChunk(s)) continue;
        square(x0, z0, corner(i, j, s), corner(i + 1, j, s), corner(i, j + 1, s), corner(i + 1, j + 1, s));
      }

      // Skirt: water beside this column (any of the eight round it) at a
      // level where this column's ground is just above it.
      const levels = [];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const n = i + di + N * (j + dj);
          for (let r = start[n]; r < start[n + 1]; r++) {
            const o = r * REC, d = rec[o + 2];
            if (d <= DRY) continue;
            const L = rec[o] + Math.min(d, rec[o + 1] - rec[o]);
            if (!inChunk(L)) continue;
            if (levels.some((l) => Math.abs(l - L) <= JOIN)) continue;
            if (mine.some((l) => Math.abs(l - L) <= JOIN)) continue;
            levels.push(L);
            if (!isBank(c, L)) continue;
            const k = (ci, cj) => corner(ci, cj, L, false) || outer(ci, cj, L);
            square(x0, z0, k(i, j), k(i + 1, j), k(i, j + 1), k(i + 1, j + 1));
          }
        }
    }

  /** Is column c's ground just above level L here (so a sheet at L over it is cut off by the ground)? */
  function isBank(c, L) {
    let bank = false;
    for (let r = start[c]; r < start[c + 1]; r++) {
      const o = r * REC, lo = rec[o], hi = rec[o + 1];
      if (lo <= L && hi >= L) return lo >= L - 0.02; // open here: only if its floor is (about) at the water
      if (lo > L && lo < L + 1) bank = true;
    }
    return bank;
  }

  // ---- waterfalls -----------------------------------------------------------------

  /** Ends of side k of local column (i, j), as corners: seen from outside, left to right. */
  function faceEnds(k, i, j) {
    if (k === 0) return [[i + 1, j], [i + 1, j + 1]];
    if (k === 1) return [[i, j + 1], [i, j]];
    if (k === 2) return [[i + 1, j + 1], [i, j + 1]];
    return [[i, j], [i + 1, j]];
  }

  // Which sides of which columns pour, and how much: a fall's ends fade out
  // where the next column along the lip doesn't pour, so a falling sheet has
  // soft sides rather than square ones.
  const pours = new Map();
  for (let n = 0; n < falls.length; n += 6) pours.set(`${falls[n]},${falls[n + 1]},${falls[n + 2]}`, falls[n + 5]);
  /** Neighbours along the lip at face end a and b (see faceEnds). */
  const ALONG = [[[0, -1], [0, 1]], [[0, 1], [0, -1]], [[1, 0], [-1, 0]], [[-1, 0], [1, 0]]];
  // The fall's profile: [out from the lip, how far down (0..1), how solid].
  // A parabola (it leaves the lip moving and speeds up), thinning out into
  // spray at the bottom rather than ending in a hard line.
  const PROFILE = [[0, 0, 1], [0.12, 0.08, 1], [0.24, 0.3, 0.95], [0.34, 0.62, 0.8], [0.42, 1, 0.35]];

  for (let n = 0; n < falls.length; n += 6) {
    const x = falls[n], z = falls[n + 1], k = falls[n + 2], top = falls[n + 3], bottom = falls[n + 4], f = falls[n + 5];
    if (!inChunk(top)) continue;
    const i = x - ox + P, j = z - oz + P;
    const [dx, dz] = SIDES[k];
    const [a, b] = faceEnds(k, i, j);
    // The lip: the sheet's own corners there.
    const ta = (corner(a[0], a[1], top) || flat(top)).h, tb = (corner(b[0], b[1], top) || flat(top)).h;
    const d = Math.min(1, f * 3) * 0.6 + 0.03;
    const side = (e) => {
      const nf = pours.get(`${x + ALONG[k][e][0]},${z + ALONG[k][e][1]},${k}`);
      return nf === undefined ? 0 : Math.min(1, 0.5 + nf / Math.max(f, 1e-6) / 2);
    };
    const sa = side(0), sb = side(1);
    // Ends with no fall beside them are pulled in a little, so the sheet narrows.
    const ia = sa ? 0 : 0.15, ib = sb ? 0 : 0.15;
    const ea = [a[0] + (b[0] - a[0]) * ia, a[1] + (b[1] - a[1]) * ia], eb = [b[0] + (a[0] - b[0]) * ib, b[1] + (a[1] - b[1]) * ib];
    const p = (c, row, hTop) => [ox + c[0] - P + dx * row[0], hTop + (bottom - hTop) * row[1], oz + c[1] - P + dz * row[0]];
    // Across the lip: its two ends and the middle (full strength there; an
    // end fades to nothing unless the next column along pours too).
    const em = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2], tm = (ta + tb) / 2;
    const across = [[ea, ta, sa], [em, tm, 1], [eb, tb, sb]];
    for (let r = 0; r < PROFILE.length - 1; r++) {
      const r0 = PROFILE[r], r1 = PROFILE[r + 1];
      for (let c = 0; c < 2; c++) {
        const [ca, ha, wa] = across[c], [cb, hb, wb] = across[c + 1];
        const a0 = [p(ca, r0, ha), d * r0[2] * wa], b0 = [p(cb, r0, hb), d * r0[2] * wb];
        const a1 = [p(ca, r1, ha), d * r1[2] * wa], b1 = [p(cb, r1, hb), d * r1[2] * wb];
        for (const [v, dv] of [a0, b0, b1, a0, b1, a1]) vert(v[0], v[1], v[2], dx * 0.5, dz * 0.5, 1, dv);
      }
    }
  }

  // ---- panes against building pieces ----------------------------------------------

  for (let n = 0; n < glass.length; n += 5) {
    const x = glass[n], z = glass[n + 1], k = glass[n + 2], y0 = glass[n + 3], y1 = glass[n + 4];
    if (y1 <= y0 || !inChunk(y1 - 1e-4)) continue;
    const [a, b] = faceEnds(k, x - ox + P, z - oz + P);
    // (Just outside the water, in front of the glass: on its face, the two
    // would fight over which shows, in bands.)
    const [dx, dz] = SIDES[k];
    const at = (c, y) => [ox + c[0] - P + dx * 0.01, y, oz + c[1] - P + dz * 0.01];
    const a1 = at(a, y1), b1 = at(b, y1), a0 = at(a, y0), b0 = at(b, y0);
    for (const q of [a1, b1, b0, a1, b0, a0]) vert(q[0], q[1], q[2], 0, 0, 2, 1);
  }

  // ---- normals: the sheet's averaged over the squares meeting at each corner --------

  const count = pos.length / 3;
  const normal = new Float32Array(count * 3);
  const acc = new Map();
  const face = [0, 0, 0];
  for (let t = 0; t < count; t += 3) {
    const o = t * 3;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    face[0] = ay * bz - az * by;
    face[1] = az * bx - ax * bz;
    face[2] = ax * by - ay * bx;
    const l = Math.hypot(face[0], face[1], face[2]) || 1;
    for (let v = 0; v < 3; v++) {
      const key = keys[t + v];
      if (key === null) {
        normal.set([face[0] / l, face[1] / l, face[2] / l], (t + v) * 3);
        continue;
      }
      let a = acc.get(key);
      if (!a) acc.set(key, (a = [0, 0, 0]));
      a[0] += face[0] / l;
      a[1] += face[1] / l;
      a[2] += face[2] / l;
    }
  }
  for (let v = 0; v < count; v++) {
    const key = keys[v];
    if (key === null) continue;
    const a = acc.get(key);
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    normal[v * 3] = a[0] / l;
    normal[v * 3 + 1] = a[1] / l;
    normal[v * 3 + 2] = a[2] / l;
  }

  return {
    position: new Float32Array(pos),
    normal,
    flow: new Float32Array(flow),
    depth: new Float32Array(dep),
    triangles: count / 3,
  };
}
