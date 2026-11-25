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
 * not at the edge of a column. Running water is drawn clear of the ground
 * under it by at least MINVIS (see corner), so a stream, however thin and
 * however steep its bed, reads as one sheet over the ground.
 *
 * Waterfalls (water pouring over a drop) are a falling sheet from the lip
 * down to the water below, and water against a building piece (an
 * aquarium, a flooded room seen through glass) a pane on its side.
 *
 * Attributes: position, normal, flow (x, z in m/s; then 0 on the surface,
 * 1..2 falling: 1 at the lip, 2 at the bottom; 3 a pane),
 * depth (metres: of the water there; for a falling sheet, how solid it is, 0..1).
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
/** Fields per span in a snapshot (SpanSim.snapshot): floor, roof, depth, flow x, flow z, first open voxel. */
export const REC = 6;
/** A span this close to full (voxels) is full to its roof: it has no surface to draw. */
export const FULL_TO = 0.002;
/** Running water is drawn at least this far clear of the ground (voxels). */
const MINVIS = 0.16;
/** How far below a column's floor its ground may fall, towards its corners (voxels). */
const TREAD = 0.25;
/** How far above its floor the ground may rise at a lip, over a drop (voxels). */
const LIP = 0.15;
/** A falling sheet clears the lip by this much before it falls away (voxels). */
const CLEAR = 0.5;
/** Fields per fall in a snapshot: x, z, side, top, bottom, flow (voxels³ a tick), speed (m/s). */
export const FALLREC = 7;
/** Heights this close (voxels: 1 mm) are level: a square that's level all round isn't split. */
const LEVEL = 2e-3;

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function meshSpans(p, scale = 1) {
  const { size: S, pad: P, origin, start, rec, falls, glass } = p;
  const [ox, oy, oz] = origin;
  const N = S + 2 * P;
  const pos = [], flow = [], dep = [], keys = [];

  /**
   * Does span record o have a water surface: wet, and not full to its roof?
   * (Water filling a cave under an overhang, or a flooded room, has none:
   * its top is the rock or the ceiling, and the water's surface is in the
   * span above.)
   */
  const open = (o) => rec[o + 2] > DRY && rec[o + 2] < rec[o + 1] - rec[o] - FULL_TO;

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
          if (!open(o)) continue;
          const lo = rec[o], hi = rec[o + 1];
          cand.push({ s: lo + Math.min(d, hi - lo), lo, hi, d: Math.min(d, hi - lo), vx: rec[o + 3], vz: rec[o + 4], c, y0: rec[o + 5] });
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
    // (Levels join only where the sheet between them is open: not across a
    // roof, as from water in a cave under an overhang up to the lake's
    // surface over it.)
    let a = m, b = m, roof = cand[m].hi;
    while (a > 0 && cand[a].s - cand[a - 1].s <= JOIN && cand[a - 1].hi >= cand[b].s) roof = Math.min(roof, cand[--a].hi);
    while (b < cand.length - 1 && cand[b + 1].s - cand[b].s <= JOIN && roof >= cand[b + 1].s) roof = Math.min(roof, cand[++b].hi);
    const lo = cand[a].s, hi = cand[b].s;
    let hs = 0, n = 0, ds = 0, vx = 0, vz = 0, fs = 0;
    const used = [];
    for (let q = a; q <= b; q++) {
      const c = cand[q];
      hs += c.s;
      ds += c.d;
      fs += c.lo;
      vx += c.vx;
      vz += c.vz;
      n++;
      used.push(c.c);
    }
    const members = n;
    // A drop beside this corner (water below that isn't part of this sheet,
    // or open air down past JOIN): the ground here is a lip.
    let lip = a > 0;
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
          const f = rec[o];
          if (f <= lo - JOIN && rec[o + 1] > lo) lip = true;
          if (rec[o + 2] > DRY) continue;
          if (f < hi && f > lo - JOIN && rec[o + 1] > f && f > floor) floor = f;
        }
        if (floor > -Infinity) {
          hs += floor;
          fs += floor;
          n++;
        }
      }
    vx /= members;
    vz /= members;
    let h = hs / n;
    // Running water stays clear of the ground under it. The ground's
    // surface over a column lies within that column's own layer of cells
    // (from half a voxel under its first open voxel to half a voxel over),
    // so down a steep slope it's terraced, a step per column, while the
    // sheet's corners, averaged, make a smooth ramp: that would dip into
    // the top of every step. So a corner rises to clear the ground of each
    // column round it (the floor here, held to that column's layer and not
    // far below its own floor) by
    // MINVIS, or half the water's depth if more. Thin water on gentler
    // ground is lifted the same way: drawn a few millimetres over the
    // faceted ground, the ground would poke through along every contour,
    // in bands that crawl as it moves. Still, level water isn't lifted, so
    // a lake's shore stays exactly where the ground meets its level.
    const floorHere = fs / n;
    let ground = -Infinity;
    for (let q = a; q <= b; q++) {
      const { y0, lo: f } = cand[q];
      // (Within a step the ground is nearly level, falling away only at its
      // edge: so not much below the column's own floor either. At a lip it
      // ends in an edge, a little above the floor.)
      ground = Math.max(ground, Math.min(y0 + 0.5, Math.max(y0 - 0.5, floorHere, lip ? f + LIP : f - TREAD)));
    }
    const speed = Math.hypot(vx, vz);
    const moving = Math.max(Math.min(1, speed / 0.05), Math.min(1, (hi - lo) / 0.05));
    h += Math.max(0, ground + Math.max(MINVIS, (ds / members) * 0.5) - h) * moving;
    out = { h, depth: (ds / members) * scale, vx, vz };
    cache.set(key, out);
    return out;
  }

  // ---- output --------------------------------------------------------------------

  function vert(x, y, z, fx, fz, kind, d) {
    pos.push(x * scale, y * scale, z * scale);
    flow.push(fx, fz, kind);
    dep.push(d);
    // (Vertices of the sheet, and of the falls, share normals with the others at the same point.)
    keys.push(kind < 3 ? `${kind ? 'f' : ''}${x.toFixed(4)},${z.toFixed(4)},${y.toFixed(4)}` : null);
  }

  /**
   * Height halfway from p1 to p2 on a monotone cubic through p0..p3
   * (Fritsch–Carlson; p0 or p3 null where there's nothing): a smooth curve
   * that never goes past p1 or p2, so a fold rounds off without bulging
   * into the ground or up over a lip. Level stays exactly level.
   */
  function mid(p0, p1, p2, p3) {
    const d1 = p2 - p1;
    if (Math.abs(d1) < LEVEL) return (p1 + p2) / 2;
    const d0 = p0 === null ? d1 : p1 - p0, d2 = p3 === null ? d1 : p3 - p2;
    let m1 = d0 * d1 <= 0 ? 0 : (d0 + d1) / 2;
    let m2 = d1 * d2 <= 0 ? 0 : (d1 + d2) / 2;
    const a = m1 / d1, b = m2 / d1, r = a * a + b * b;
    if (r > 9) {
      const k = 3 / Math.sqrt(r);
      m1 = k * a * d1;
      m2 = k * b * d1;
    }
    return (p1 + p2) / 2 + (m1 - m2) / 8;
  }

  /** Two triangles over a quad (a: lowest x and z, b: +x, c: +z, d: both), split a–d or b–c, facing up. */
  function quad(a, b, c, d, ad) {
    if (ad) for (const q of [a, c, d, a, d, b]) vert(q.x, q.h, q.z, q.vx, q.vz, 0, q.depth);
    else for (const q of [a, c, b, b, c, d]) vert(q.x, q.h, q.z, q.vx, q.vz, 0, q.depth);
  }

  const g16 = new Array(16);
  /**
   * Column (i, j)'s square (x0, z0: its corner of lowest x and z), from the
   * sheet's corners round it: own(di, dj) gives its own four (di, dj 0..1),
   * and the sheet beyond them is looked up from those (null where there's
   * none: the ground's). Level (its own four corners), it's two triangles. Otherwise it's split in four, the new points on
   * smooth curves through the corners either side, so the sheet bends
   * smoothly instead of folding along the squares' edges. (Both squares
   * either side of an edge work out the point on it from the same four
   * corners along it, so they meet exactly; and an edge that's level stays
   * straight, so a square that isn't split meets one that is.)
   */
  function square(x0, z0, i, j, own) {
    const c4 = [own(0, 0), own(1, 0), own(0, 1), own(1, 1)];
    const P = (x, z, c) => ({ x, z, h: c.h, vx: c.vx, vz: c.vz, depth: c.depth });
    const c00 = P(x0, z0, c4[0]), c10 = P(x0 + 1, z0, c4[1]), c01 = P(x0, z0 + 1, c4[2]), c11 = P(x0 + 1, z0 + 1, c4[3]);
    const lo = Math.min(c00.h, c10.h, c01.h, c11.h), hi = Math.max(c00.h, c10.h, c01.h, c11.h);
    if (hi - lo < LEVEL) {
      quad(c00, c10, c01, c11, true);
      return;
    }
    for (let dj = -1, n = 0; dj <= 2; dj++)
      for (let di = -1; di <= 2; di++, n++) {
        const ci = di < 0 ? 0 : di > 1 ? 1 : di, cj = dj < 0 ? 0 : dj > 1 ? 1 : dj;
        let c = c4[ci + 2 * cj];
        // Beyond its own corners: the sheet through the nearest of them (so
        // the squares either side of an edge find the same).
        if (ci !== di || cj !== dj) c = corner(i + di, j + dj, c.h, false) || outer(i + di, j + dj, c.h);
        g16[n] = c;
      }
    const C = (di, dj) => g16[di + 1 + 4 * (dj + 1)];
    const H = (di, dj) => {
      const c = C(di, dj);
      return c ? c.h : null;
    };
    const row = (dj) => (H(0, dj) === null || H(1, dj) === null ? null : mid(H(-1, dj), H(0, dj), H(1, dj), H(2, dj)));
    const col = (di) => (H(di, 0) === null || H(di, 1) === null ? null : mid(H(di, -1), H(di, 0), H(di, 1), H(di, 2)));
    const eb = row(0), et = row(1), el = col(0), er = col(1);
    const hc = (mid(row(-1), eb, et, row(2)) + mid(col(-1), el, er, col(2))) / 2;
    const blend = (x, z, h, ...cs) => {
      const q = { x, z, h, vx: 0, vz: 0, depth: 0 };
      for (const c of cs) {
        q.vx += c.vx / cs.length;
        q.vz += c.vz / cs.length;
        q.depth += c.depth / cs.length;
      }
      return q;
    };
    const xm = x0 + 0.5, zm = z0 + 0.5;
    const pb = blend(xm, z0, eb, c00, c10), pt = blend(xm, z0 + 1, et, c01, c11);
    const pl = blend(x0, zm, el, c00, c01), pr = blend(x0 + 1, zm, er, c10, c11);
    const pc = blend(xm, zm, hc, c00, c10, c01, c11);
    // Each quarter split through the middle (the diagonal from its outer corner).
    quad(c00, pb, pl, pc, true);
    quad(pb, c10, pc, pr, false);
    quad(pl, pc, c01, pt, false);
    quad(pc, pr, pt, c11, true);
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
        if (!open(o)) continue;
        const lo = rec[o], hi = rec[o + 1];
        const s = lo + Math.min(d, hi - lo);
        mine.push(s);
        if (!inChunk(s)) continue;
        square(x0, z0, i, j, (di, dj) => corner(i + di, j + dj, s));
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
            if (!open(o)) continue;
            const L = rec[o] + Math.min(d, rec[o + 1] - rec[o]);
            if (!inChunk(L)) continue;
            if (levels.some((l) => Math.abs(l - L) <= JOIN)) continue;
            if (mine.some((l) => Math.abs(l - L) <= JOIN)) continue;
            levels.push(L);
            if (!isBank(c, L)) continue;
            square(x0, z0, i, j, (di, dj) => corner(i + di, j + dj, L, false) || outer(i + di, j + dj, L));
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

  // Which sides of which columns pour (the chunk's, and the columns just
  // round it), how solid each fall is and where it lands. Where the next
  // column along the lip pours too, the two falls meet halfway between
  // their own: as solid and landing as low as each other, so a wide fall is
  // one sheet. Where it doesn't, the fall fades out at that end.
  const solidOf = (f) => 0.3 + 0.7 * Math.min(1, f * 8);
  const pours = new Map();
  for (let n = 0; n < falls.length; n += FALLREC) pours.set(`${falls[n]},${falls[n + 1]},${falls[n + 2]}`, [solidOf(falls[n + 5]), falls[n + 4]]);
  /** Neighbours along the lip at face end a and b (see faceEnds). */
  const ALONG = [[[0, -1], [0, 1]], [[0, 1], [0, -1]], [[1, 0], [-1, 0]], [[-1, 0], [1, 0]]];
  // The fall's profile: [how far down (0..1), how solid]. It leaves the lip
  // as fast as the water ran over it and falls away under gravity (out ∝
  // √down), after first clearing the lip's edge (the smooth ground can
  // reach half a voxel past the column's side), thinning into spray at the
  // bottom rather than ending in a hard line.
  const PROFILE = [[0, 1], [0.04, 1], [0.2, 0.95], [0.5, 0.8], [0.8, 0.45], [1, 0.1]];

  for (let n = 0; n < falls.length; n += FALLREC) {
    const x = falls[n], z = falls[n + 1], k = falls[n + 2], top = falls[n + 3], bottom = falls[n + 4], f = falls[n + 5], u = falls[n + 6];
    // How far out it lands (voxels): speed × time to fall.
    const reach = Math.min(2, (u * Math.sqrt((2 * (top - bottom) * scale) / 9.81)) / scale);
    const out = (row) => (row[0] > 0 ? CLEAR + reach * Math.sqrt(row[0]) : 0);
    if (!inChunk(top) || x < ox || z < oz || x >= ox + S || z >= oz + S) continue;
    const i = x - ox + P, j = z - oz + P;
    const [dx, dz] = SIDES[k];
    const [a, b] = faceEnds(k, i, j);
    // The lip: the sheet's own corners there.
    const ta = (corner(a[0], a[1], top) || flat(top)).h, tb = (corner(b[0], b[1], top) || flat(top)).h;
    const d = solidOf(f);
    const na = pours.get(`${x + ALONG[k][0][0]},${z + ALONG[k][0][1]},${k}`), nb = pours.get(`${x + ALONG[k][1][0]},${z + ALONG[k][1][1]},${k}`);
    const sa = na ? (d + na[0]) / 2 : 0, sb = nb ? (d + nb[0]) / 2 : 0;
    const ba = na ? (bottom + na[1]) / 2 : bottom, bb = nb ? (bottom + nb[1]) / 2 : bottom;
    // Ends with no fall beside them are pulled in a little, so the sheet narrows.
    const ia = na ? 0 : 0.15, ib = nb ? 0 : 0.15;
    const ea = [a[0] + (b[0] - a[0]) * ia, a[1] + (b[1] - a[1]) * ia], eb = [b[0] + (a[0] - b[0]) * ib, b[1] + (a[1] - b[1]) * ib];
    const p = (c, row, hTop, hBot) => [ox + c[0] - P + dx * out(row), hTop + (hBot - hTop) * row[0], oz + c[1] - P + dz * out(row)];
    // Across the lip: its two ends and the middle. (The middle of the lip
    // on the sheet's own curve along it: see square.)
    const along = (c, e, ref) => {
      const q = [c[0] + (b[0] - a[0]) * e, c[1] + (b[1] - a[1]) * e];
      return (corner(q[0], q[1], ref, false) || outer(q[0], q[1], ref)).h;
    };
    const em = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2], tm = mid(along(a, -1, ta), ta, tb, along(b, 1, tb));
    const across = [[ea, ta, sa, ba], [em, tm, d, bottom], [eb, tb, sb, bb]];
    for (let r = 0; r < PROFILE.length - 1; r++) {
      const r0 = PROFILE[r], r1 = PROFILE[r + 1];
      for (let c = 0; c < 2; c++) {
        const [ca, ha, wa, la] = across[c], [cb, hb, wb, lb] = across[c + 1];
        const a0 = [p(ca, r0, ha, la), wa * r0[1]], b0 = [p(cb, r0, hb, lb), wb * r0[1]];
        const a1 = [p(ca, r1, ha, la), wa * r1[1]], b1 = [p(cb, r1, hb, lb), wb * r1[1]];
        for (const [v, dv, down] of [[...a0, r0[0]], [...b0, r0[0]], [...b1, r1[0]], [...a0, r0[0]], [...b1, r1[0]], [...a1, r1[0]]]) vert(v[0], v[1], v[2], dx * 0.5, dz * 0.5, 1 + down, dv);
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
    for (const q of [a1, b1, b0, a1, b0, a0]) vert(q[0], q[1], q[2], 0, 0, 3, 1);
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
