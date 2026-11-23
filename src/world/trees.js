import { createNoise3D } from './noise.js';
import { applyCSG } from './csg.js';
import { MAT } from './materials.js';
import { PLANT, PLANT_KIND, DIRS26, twigId, branchBase } from './plants.js';
import { VOXEL } from './World.js';
import { unpackNormal } from './normals.js';

/**
 * Test vegetation for generated worlds: trees and a grass cover.
 *
 * A tree is ordinary world data: smooth Log terrain for the wood, and leaf
 * voxels in the plant layer for the crown. Nothing else remembers it.
 */

const e = [0, 0, 0];
const n3 = [0, 0, 0];

/**
 * Surface of the column at voxel (x, z): the lowest empty voxel above the
 * topmost terrain, with the ground's height (voxels) and normal there, from
 * the hermite crossing on the vertical edge below. Null if the column is empty.
 */
export function groundAt(world, x, z) {
  for (let y = world.sy - 1; y >= 1; y--) {
    if (!world.isTerrain(x, y - 1, z) || world.isSolid(x, y, z)) continue;
    if (!world.getEdge(x, y - 1, z, 1, e)) return { y, height: y, normal: [0, 1, 0], mat: world.getMat(x, y - 1, z) };
    unpackNormal(e[1], e[2], n3);
    return { y, height: y - 0.5 + e[0], normal: [n3[0], n3[1], n3[2]], mat: world.getMat(x, y - 1, z) };
  }
  return null;
}

/** Small seeded generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth minimum of two distances: joins shapes with a rounded fillet of size k. */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Grow one tree with its foot at voxel column (x, z). Returns false if
 * there's no ground there.
 *
 * Like a broadleaf (oak, beech, ash), in one of three habits, each varied in
 * size (0.8-1.25×), lean and proportions:
 *   spreading – the trunk forks low (2-4.5 m) into two or three stems of
 *               about equal size rising at an angle, sometimes with a low
 *               limb below the fork, and those carry the crown: broad and
 *               rounded, like an open-grown oak;
 *   leader    – the trunk carries on up the middle to the top, tapering, with
 *               limbs coming off it one by one in a spiral from 2.5-4.5 m up,
 *               long and spreading low down, short and steep near the top: a
 *               taller, egg-shaped crown;
 *   leaning   – a spreading tree whose trunk leans and bends back up, its
 *               crown lopsided towards the lean.
 * Each stem puts out side branches in turn round it (by the golden angle, as
 * real shoots do), facing out from the crown, those do the same once more,
 * and the finest shoots carry the leaves. Every stem tapers from base to tip.
 *
 * Wood at least RT thick is smooth Log terrain (an exact CSG union of
 * tapered capsules with rounded fillets), so it can be dug or chopped like
 * ground; terrain can't be drawn well any thinner, so thinner wood is in the
 * plant layer: boughs, branches and twigs of five thicknesses, each voxel
 * recording the voxel it grows from, which the mesher draws as one smooth
 * tapering tube joined into the wood it grows out of.
 *
 * Leaves grow around the leafy shoots, so every leaf hangs off a twig: each
 * shoot and shoot tip spreads a leaf density around it, the crown as a whole
 * adds more towards its middle, and where the summed density is high enough
 * there are leaves. So the clumps merge into one canopy with a lumpy
 * outline, while the outer shoots still leave gaps where you see the
 * branches and sky. Lone spikes are trimmed, and any leaves cut off from the
 * twigs are dropped.
 *
 * `debug`, if given, gets the terrain wood's signed distance function (`sdf`,
 * in voxels, positive inside), for tests.
 */
export function growTree(world, x, z, random = Math.random, debug = null) {
  const g = groundAt(world, x, z);
  if (!g) return false;
  const V = VOXEL;
  const m = (v) => v / V; // metres to voxels
  const s = 0.8 + 0.45 * random(); // overall size
  const pick = random();
  const habit = pick < 0.45 ? 'spreading' : pick < 0.8 ? 'leader' : 'leaning';
  const RT = m(0.3); // thinnest terrain wood
  const rBase = m(0.33 + 0.07 * (s - 0.8) / 0.45), flare = m(0.3);

  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const add = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];

  // ---- the tree's shape: stems, each a bending polyline with a radius
  // (voxels) at each point, side stems recording where on their parent
  // they grow from.
  const stems = [];
  let centre = [x + 0.5, z + 0.5]; // the crown's middle, which side stems face away from
  const stem = ({ from, dir, len, level, parent = null, at = 0, bend = 0.3, up = 0, out = 0, segLen = m(0.9) }) => {
    const n = Math.max(2, Math.ceil(len / segLen));
    const pts = [from], rad = [0], dirs = []; // radii: see thickness, below
    let d = norm(dir), p = from;
    for (let k = 1; k <= n; k++) {
      const o = norm([p[0] - centre[0], 0, p[2] - centre[1]]);
      d = norm([0, 1, 2].map((j) => d[j] + (random() - 0.5) * bend + (j === 1 ? up : o[j] * out)));
      p = add(p, d, len / n);
      dirs.push(d);
      pts.push(p);
      rad.push(0);
    }
    const st = { pts, rad, dirs, len, level, parent, at, leafy: [], tip: 0 };
    stems.push(st);
    return st;
  };
  // Point, direction and radius at fraction t of a stem's length.
  const sample = (st, t) => {
    const n = st.dirs.length, f = Math.min(n - 1e-6, Math.max(0, t * n)), k = Math.floor(f), u = f - k;
    const a = st.pts[k], b = st.pts[k + 1];
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u], d: st.dirs[k], r: st.rad[k] + (st.rad[k + 1] - st.rad[k]) * u };
  };
  // A direction `angle` off d, turned `spin` round it (from a fixed side).
  const offAxis = (d, angle, spin) => {
    const u = norm(Math.abs(d[1]) < 0.9 ? [d[2], 0, -d[0]] : [1, 0, 0]);
    const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const q = [0, 1, 2].map((j) => Math.cos(spin) * u[j] + Math.sin(spin) * w[j]);
    return { dir: norm([0, 1, 2].map((j) => Math.cos(angle) * d[j] + Math.sin(angle) * q[j])), q };
  };
  const golden = 2.39996; // radians between successive side shoots, as on a real stem
  /**
   * Side stems along `st` from fraction t0 to t1, `count` of them in a
   * spiral, each `angle(t)` off it and `len(t)` long, facing out of the crown.
   */
  const sides = (st, { t0, t1, count, angle, len, level, opts = {} }) => {
    let spin = random() * Math.PI * 2;
    const made = [];
    for (let k = 0; k < count; k++) {
      const t = t0 + (t1 - t0) * (k + 0.3 + 0.4 * random()) / count;
      const { p, d } = sample(st, t);
      spin += golden;
      let { dir } = offAxis(d, angle(t), spin);
      // Facing into the crown or down: send it round the other side.
      const o = norm([p[0] - centre[0], 0, p[2] - centre[1]]);
      if ((level > 1 && dir[0] * o[0] + dir[2] * o[2] < -0.25) || dir[1] < -0.35) dir = offAxis(d, angle(t), spin + Math.PI).dir;
      made.push(stem({ from: p, dir, len: len(t), level, parent: st, at: t, ...opts }));
    }
    return made;
  };

  // Trunk: from a metre underground, leaning, curving back up if it leans far.
  const foot = [x + 0.5, g.height - m(1), z + 0.5];
  const leanDir = random() * Math.PI * 2;
  const leanBy = habit === 'leaning' ? 0.25 + 0.2 * random() : 0.03 + 0.07 * random();
  const trunkDir = norm([Math.cos(leanDir) * leanBy, 1, Math.sin(leanDir) * leanBy]);
  const trunkUp = habit === 'leaning' ? 0.12 : 0;
  let trunk, crownBase;
  const limbs = []; // the stems the crown is built on (level 1)
  if (habit === 'leader') {
    const H = m((11 + 3 * random()) * s);
    trunk = stem({ from: foot, dir: trunkDir, len: H, level: 0, bend: 0.06, up: 0.04, segLen: m(1.2) });
    crownBase = m((2.5 + 2 * random()) * s);
    const t0 = (crownBase + m(1)) / H, count = 7 + Math.floor(random() * 4);
    limbs.push(...sides(trunk, {
      t0, t1: 0.9, count, level: 1,
      angle: (t) => 1.3 - 0.65 * (t - t0) / (0.9 - t0) + (random() - 0.5) * 0.2,
      len: (t) => m((2.2 + 3.6 * (1 - (t - t0) / (1 - t0)) ** 0.8) * s * (0.85 + 0.3 * random())),
      opts: { bend: 0.3, up: 0.05, out: 0.06 },
    }));
    trunk.tip = m(1.8 * s);
  } else {
    const forkH = m((2 + 2.5 * random()) * s);
    trunk = stem({ from: foot, dir: trunkDir, len: forkH + m(1), level: 0, bend: 0.05, up: trunkUp, segLen: m(1.2) });
    const top = trunk.pts[trunk.pts.length - 1];
    crownBase = top[1] - g.height;
    centre = [top[0], top[2]];
    // Codominant stems from the fork, spread round evenly, tipped to the lean.
    const n = random() < 0.55 ? 2 : 3, turn = random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * Math.PI * 2 + (random() - 0.5) * 0.7;
      const tilt = 0.3 + 0.35 * random();
      let dir = [Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)];
      if (habit === 'leaning') dir = norm(add(dir, [Math.cos(leanDir), 0, Math.sin(leanDir)], 0.35));
      const len = m((5.5 + 2.5 * random()) * s * (i === 0 ? 1 : 0.8 + 0.2 * random()));
      limbs.push(stem({ from: top, dir, len, level: 1, parent: trunk, at: 1, bend: 0.3, up: 0.04, out: 0.08 }));
    }
    // Sometimes a low limb or two below the fork.
    const low = random() < 0.45 ? 1 + (random() < 0.3 ? 1 : 0) : 0;
    if (low) {
      const made = sides(trunk, {
        t0: 0.55, t1: 0.92, count: low, level: 1,
        angle: () => 1.1 + 0.3 * random(),
        len: () => m((3.5 + 1.5 * random()) * s),
        opts: { bend: 0.3, up: 0.07, out: 0.05 },
      });
      limbs.push(...made);
      crownBase = Math.min(crownBase, ...made.map((st) => st.pts[0][1] - g.height));
    }
  }
  // Branches along each limb, and shoots along those.
  for (const limb of limbs) {
    limb.tip = m(1.8 * s);
    limb.leafy.push(0.75);
    const branches = sides(limb, {
      t0: 0.22, t1: 0.95, count: Math.max(2, Math.round(limb.len / m(1.25))), level: 2,
      angle: () => 0.75 + 0.35 * random(),
      len: (t) => limb.len * (0.42 + 0.15 * random()) * (1 - 0.35 * t),
      opts: { bend: 0.35, up: 0.08, out: 0.05 },
    });
    for (const br of branches) {
      br.tip = m(1.9 * s);
      br.leafy.push(0.35);
      const shoots = sides(br, {
        t0: 0.3, t1: 0.95, count: Math.max(1, Math.round(br.len / m(0.8))), level: 3,
        angle: () => 0.6 + 0.3 * random(),
        len: () => br.len * (0.45 + 0.2 * random()),
        opts: { bend: 0.4, up: 0.1 },
      });
      for (const sh of shoots) { sh.tip = m(2.0 * s); sh.leafy.push(0); }
    }
  }

  // ---- thickness. As in real wood, a stem anywhere is as thick as it
  // needs to be to carry everything growing beyond that point: its
  // cross-section (strictly radius^E with E = 3, Murray's law) is the sum of those of the side stems leaving it further
  // on, plus a fine shoot's for its own tip, plus a little for each metre of
  // itself still to come. So every stem tapers smoothly from base to tip,
  // narrowing a step at each side stem it gives off, and a side stem is
  // never thicker than where it leaves its parent.
  const E = 3, rShoot = m(0.035);
  const kidsOf = new Map(stems.map((st) => [st, []]));
  for (const st of stems) if (st.parent) kidsOf.get(st.parent).push(st);
  for (let q = stems.length - 1; q >= 0; q--) { // side stems come after their parents
    const st = stems[q], n = st.pts.length - 1;
    const kids = kidsOf.get(st).sort((a, b) => b.at - a.at);
    let next = 0, carried = 0;
    for (let k = n; k >= 0; k--) {
      while (next < kids.length && kids[next].at >= k / n) carried += kids[next++].rad[0] ** E;
      const own = rShoot ** E * (1 + (st.len * V * (1 - k / n)) / 1.2);
      // (The trunk tapers a little up its length too, as trunks do.)
      st.rad[k] = (own + carried) ** (1 / E) * (st === trunk ? 1.08 - 0.12 * k / n : 1);
    }
  }
  // Scale to this tree's girth, on a curve that keeps the big stems nearly
  // as thick as the trunk they come from and does most of the thinning
  // among the small branches, as on a real tree.
  const full = Math.log(trunk.rad[0] / rShoot), girth = Math.log(rBase / rShoot);
  for (const st of stems) st.rad = st.rad.map((r) => rShoot * Math.exp(girth * Math.max(0, Math.log(r / rShoot) / full) ** 0.6));
  // A trunk that forks stays terrain wood right up to the fork (where the
  // stems leaving it, nearly as thick, are tubes that form the fork).
  const forked = kidsOf.get(trunk).some((st) => st.at >= 1);
  if (forked) trunk.rad = trunk.rad.map((r) => Math.max(r, RT * 1.08));

  // The voxels a stem runs through, in order, with how far along it each is.
  const voxelPath = (st) => {
    const n = st.dirs.length, path = [];
    for (let k = 0; k < n; k++) {
      const a = st.pts[k], b = st.pts[k + 1];
      const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])));
      for (let i = k ? 1 : 0; i <= steps; i++) {
        const u = steps ? i / steps : 0;
        const v = [Math.floor(a[0] + (b[0] - a[0]) * u), Math.floor(a[1] + (b[1] - a[1]) * u), Math.floor(a[2] + (b[2] - a[2]) * u)];
        const last = path[path.length - 1];
        if (last && v[0] === last.v[0] && v[1] === last.v[1] && v[2] === last.v[2]) continue;
        path.push({ v, t: (k + u) / n });
      }
    }
    return path;
  };

  // ---- wood thick enough for terrain: the trunk (flaring into roots at the
  // ground, along its own axis so there's no seam) and the bases of stems.
  const capsule = ({ a, b, ra, rb }, px, py, pz) => {
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / (bx * bx + by * by + bz * bz)));
    return { d: Math.hypot(px - a[0] - bx * t, py - a[1] - by * t, pz - a[2] - bz * t), r: ra + (rb - ra) * t };
  };
  const trunkSegs = [], segments = [];
  const voxelCentre = (e) => [e.v[0] + 0.5, e.v[1] + 0.5, e.v[2] + 0.5];
  for (const st of stems) {
    const segs = st === trunk ? trunkSegs : segments;
    const n = st.pts.length - 1;
    // A side shoot of a stem that follows its tube's line starts on that line.
    if (st.parent && st.parent.line) {
      let best = st.parent.line[0];
      for (const e of st.parent.line) if (Math.abs(e.t - st.at) < Math.abs(best.t - st.at)) best = e;
      st.pts[0] = best.p;
    }
    if (st.rad[0] < RT) continue;
    if (st.rad[n] >= RT) {
      for (let k = 0; k < n; k++) segs.push({ a: st.pts[k], b: st.pts[k + 1], ra: st.rad[k], rb: st.rad[k + 1] });
      if (st === trunk && forked) {
        // Its rounded end stops just short of the fork, inside the stems
        // rising from there, so no dome of wood shows in the crotch.
        const last = segs[segs.length - 1];
        last.b = add(last.b, st.dirs[n - 1], -0.6 * last.rb);
      }
      continue;
    }
    // It gets too thin for terrain partway, and a tube carries it on from
    // there. The tube runs through its voxels' (smoothed) centres, which can
    // be a quarter metre off the stem's own line, so the wood follows the
    // tube's line instead, all the way from the stem's base, and ends in a
    // short cone that tapers away inside the tube: the two line up, the
    // tube's end sinks straight back into the wood, and side shoots set on
    // this line (below) start from the middle of the wood.
    let k = 0;
    while (st.rad[k + 1] >= RT) k++;
    const tCut = (k + (st.rad[k] - RT) / (st.rad[k] - st.rad[k + 1])) / n;
    st.tWood = tCut;
    const path = voxelPath(st);
    let line = path.map(voxelCentre);
    for (let round = 0; round < 2; round++)
      line = line.map((p, j) => (j && j < line.length - 1 ? [0, 1, 2].map((q) => 0.5 * p[q] + 0.25 * (line[j - 1][q] + line[j + 1][q])) : p));
    st.line = path.map((e, j) => ({ p: line[j], t: e.t }));
    let j1 = 0;
    for (let q = 1; q < path.length; q++) if (Math.abs(path[q].t - tCut) < Math.abs(path[j1].t - tCut)) j1 = q;
    const rAt = (q) => Math.max(RT, sample(st, path[q].t).r);
    segs.push({ a: st.pts[0], b: line[0], ra: st.rad[0], rb: rAt(0) });
    for (let q = 0; q < j1; q++) segs.push({ a: line[q], b: line[q + 1], ra: rAt(q), rb: rAt(q + 1) });
    const c0 = line[j1], c1 = line[Math.min(line.length - 1, j1 + 2)];
    const ahead = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) > 0.5 ? norm([c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]]) : st.dirs[k];
    segs.push({ a: c0, b: add(c0, ahead, m(0.6)), ra: RT, rb: m(0.1) });
  }
  const fillet = m(0.3);
  const sdf = (px, py, pz) => {
    let d = Infinity;
    for (const seg of trunkSegs) { const c = capsule(seg, px, py, pz); d = Math.min(d, c.d - c.r); }
    d -= flare * Math.exp(-Math.max(0, py - g.height) / m(0.7));
    for (const seg of segments) {
      const k = capsule(seg, px, py, pz);
      d = smin(d, k.d - k.r, fillet);
    }
    return -d;
  };
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (const { a, b } of [...trunkSegs, ...segments])
    for (const p of [a, b]) {
      bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bz0 = Math.min(bz0, p[2]);
      bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); bz1 = Math.max(bz1, p[2]);
    }
  const pad = Math.ceil(rBase + flare) + 2;
  if (debug) { debug.sdf = sdf; debug.stems = stems; }
  applyCSG(world, 'union', [Math.floor(bx0) - pad, Math.floor(by0) - 1, Math.floor(bz0) - pad, Math.ceil(bx1) + pad, Math.ceil(by1) + pad, Math.ceil(bz1) + pad],
    sdf, { material: MAT.LOG, keep: true });

  // ---- the thinner wood in the plant layer, thickest stems first, so a
  // stem is laid down before the ones that join it.
  const twigVoxels = [];
  const leafy = []; // { a, b, r } capsules (voxels) the leaves fill around
  const leafTips = []; // { p, r } balls at shoot ends
  const lines = new Map(); // stem -> [{ v, t }] its voxels, with where along it they are
  for (const st of stems) {
    const n = st.dirs.length;
    let prev = null;
    if (st.parent) {
      // Join the parent's voxel nearest where it branches off.
      const pl = lines.get(st.parent);
      let best = null;
      for (const e of pl || []) if (!best || Math.abs(e.t - st.at) < Math.abs(best.t - st.at)) best = e;
      prev = best ? best.v : null;
    }
    const line = [], placed = [];
    for (let k = 0; k < n; k++) {
      const a = st.pts[k], b = st.pts[k + 1];
      const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])));
      for (let i = k ? 1 : 0; i <= steps; i++) {
        const u = steps ? i / steps : 0;
        const v = [Math.floor(a[0] + (b[0] - a[0]) * u), Math.floor(a[1] + (b[1] - a[1]) * u), Math.floor(a[2] + (b[2] - a[2]) * u)];
        if (prev && v[0] === prev[0] && v[1] === prev[1] && v[2] === prev[2]) continue;
        if (!world.inBounds(v[0], v[1], v[2])) { prev = null; continue; }
        const t = (k + u) / n;
        line.push({ v, t });
        if (t < (st.tWood || 0)) {
          // Still terrain wood here: no tube, even where the stem's voxels
          // poke out of it (they're off its line), just carry on from the wood.
          prev = world.isSolid(v[0], v[1], v[2]) ? v : null;
          continue;
        }
        const here = world.getPlant(v[0], v[1], v[2]);
        if (world.isSolid(v[0], v[1], v[2]) || PLANT_KIND[here] === 3) {
          // Wood or another stem: carry on from it.
          prev = v;
          if (!world.isSolid(...v)) placed.push(v);
          continue;
        }
        let step = prev ? [prev[0] - v[0], prev[1] - v[1], prev[2] - v[2]] : null;
        const held = prev && (world.isSolid(prev[0], prev[1], prev[2]) || PLANT_KIND[world.getPlant(prev[0], prev[1], prev[2])] === 3);
        if (!step || !held || Math.max(Math.abs(step[0]), Math.abs(step[1]), Math.abs(step[2])) !== 1) {
          // Nothing to follow on from (the end of terrain wood that isn't
          // quite solid here): join the nearest wood or twig around it, else
          // leave it out.
          // Of those, the one most nearly back along the stem.
          step = null;
          let best = -Infinity;
          const back = st.dirs[k];
          for (const o of DIRS26) {
            const w = [v[0] + o[0], v[1] + o[1], v[2] + o[2]];
            if (!world.inBounds(...w)) continue;
            const wood = world.isSolid(...w);
            if (!wood && PLANT_KIND[world.getPlant(...w)] !== 3) continue;
            const score = (wood ? 2 : 0) - (o[0] * back[0] + o[1] * back[1] + o[2] * back[2]) / Math.hypot(o[0], o[1], o[2]);
            if (score > best) { best = score; step = o; }
          }
          if (!step) continue;
        }
        const r = st.rad[k] + (st.rad[k + 1] - st.rad[k]) * u;
        world.setPlant(v[0], v[1], v[2], twigId(branchBase(r * V), step));
        twigVoxels.push(v);
        placed.push(v);
        prev = v;
      }
    }
    lines.set(st, line);
    if (!placed.length) continue;
    // Leaves: around the shoot from fraction `leafy` of the way along it,
    // and round its tip. (Reach of each one's influence; see the leaf
    // density below.)
    for (const from of st.leafy) {
      const r = m([1.2, 1.2, 1.35, 1.5][st.level] * s);
      for (let k = Math.floor(from * n); k < n; k++) leafy.push({ a: st.pts[k], b: st.pts[k + 1], r: r * (0.8 + 0.2 * k / n) });
    }
    if (st.tip) leafTips.push({ p: st.pts[n], r: st.tip });
  }
  const forkY = g.height + crownBase;
  // ---- leaves around the shoots and twigs, in empty voxels.
  const noise = createNoise3D(Math.floor(random() * 1e9));
  let x0 = Infinity, x1 = -Infinity, cy0 = Infinity, cy1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (p, r) => {
    x0 = Math.min(x0, p[0] - r); x1 = Math.max(x1, p[0] + r);
    cy0 = Math.min(cy0, p[1] - r); cy1 = Math.max(cy1, p[1] + r);
    z0 = Math.min(z0, p[2] - r); z1 = Math.max(z1, p[2] + r);
  };
  for (const c of leafy) { grow(c.a, c.r); grow(c.b, c.r); }
  for (const t of leafTips) grow(t.p, t.r);
  // The crown as a whole: an ellipsoid round all the twig tips. Its core
  // adds leaf density everywhere inside it, so the clumps on different
  // shoots merge into one canopy; towards its edge it adds less and less,
  // so the outline is still the clumps' lumps.
  const ex = [Infinity, -Infinity], ey = [Infinity, -Infinity], ez = [Infinity, -Infinity];
  for (const t of leafTips) {
    ex[0] = Math.min(ex[0], t.p[0]); ex[1] = Math.max(ex[1], t.p[0]);
    ey[0] = Math.min(ey[0], t.p[1]); ey[1] = Math.max(ey[1], t.p[1]);
    ez[0] = Math.min(ez[0], t.p[2]); ez[1] = Math.max(ez[1], t.p[2]);
  }
  const env = {
    c: [(ex[0] + ex[1]) / 2, (Math.max(ey[0], forkY) + ey[1]) / 2, (ez[0] + ez[1]) / 2],
    r: [(ex[1] - ex[0]) / 2 + m(0.6), (ey[1] - Math.max(ey[0], forkY)) / 2 + m(0.8), (ez[1] - ez[0]) / 2 + m(0.6)],
  };
  const leaves = [];
  for (let vz = Math.floor(z0); vz <= Math.ceil(z1); vz++)
    for (let vy = Math.floor(cy0); vy <= Math.ceil(cy1); vy++)
      for (let vx = Math.floor(x0); vx <= Math.ceil(x1); vx++) {
        if (!world.inBounds(vx, vy, vz) || world.isSolid(vx, vy, vz) || world.getPlant(vx, vy, vz)) continue;
        const px = vx + 0.5, py = vy + 0.5, pz = vz + 0.5;
        // Leaf density: each shoot's and tip's influence, summed (so nearby
        // clumps flow together into one mass, filling the creases between
        // them), with broad lumps and a finer ragged edge from noise.
        let density = 0;
        const add = (q) => { if (q < 1) density += (1 - q) * (1 - q); };
        for (const c of leafy) add((capsule({ a: c.a, b: c.b, ra: 0, rb: 0 }, px, py, pz).d / c.r) ** 2);
        for (const t of leafTips) add(((px - t.p[0]) ** 2 + ((py - t.p[1]) / 0.8) ** 2 + (pz - t.p[2]) ** 2) / (t.r * t.r));
        const q = ((px - env.c[0]) / env.r[0]) ** 2 + ((py - env.c[1]) / env.r[1]) ** 2 + ((pz - env.c[2]) / env.r[2]) ** 2;
        if (q < 1) density += 0.65 * (1 - q);
        if (density <= 0) continue;
        // Thinning out below the fork, so the trunk and the underside of
        // the crown show, as on a real tree.
        const lift = Math.min(1, Math.max(0, (py - (forkY - m(0.3))) / m(1.8)));
        density *= lift * lift * (3 - 2 * lift);
        density += 0.22 * noise(px * V / 2.6, py * V / 2.6, pz * V / 2.6) + 0.12 * noise(px * V / 0.7 + 31, py * V / 0.7, pz * V / 0.7);
        if (density > 0.36) { world.setPlant(vx, vy, vz, PLANT.LEAVES); leaves.push([vx, vy, vz]); }
      }
  // Trim lone spikes (leaves with at most one leaf beside them).
  const FACE6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const leafAround = (v) => FACE6.reduce((n, d) => n + (world.getPlant(v[0] + d[0], v[1] + d[1], v[2] + d[2]) === PLANT.LEAVES ? 1 : 0), 0);
  for (const v of leaves) if (world.getPlant(...v) === PLANT.LEAVES && leafAround(v) <= 1) world.setPlant(v[0], v[1], v[2], 0);
  // Drop any leaves not joined (face to face, through leaves) to a twig.
  const key = (v) => v[0] + world.sx * (v[1] + world.sy * v[2]);
  const reached = new Set();
  const stack = twigVoxels.slice();
  for (const v of stack) reached.add(key(v));
  while (stack.length) {
    const [vx, vy, vz] = stack.pop();
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const v = [vx + dx, vy + dy, vz + dz];
      const k = key(v);
      if (reached.has(k) || !world.inBounds(...v) || world.getPlant(...v) !== PLANT.LEAVES) continue;
      reached.add(k);
      stack.push(v);
    }
  }
  for (const v of leaves) if (!reached.has(key(v))) world.setPlant(v[0], v[1], v[2], 0);

  for (const v of twigVoxels) { grow(v, 1); }
  world.markDirtyBox(Math.floor(Math.min(x0, bx0)) - pad, Math.floor(by0) - 1, Math.floor(Math.min(z0, bz0)) - pad,
    Math.ceil(Math.max(x1, bx1)) + pad, Math.ceil(Math.max(cy1, by1)) + pad, Math.ceil(Math.max(z1, bz1)) + pad);
  return true;
}

/**
 * Scatter trees on a jittered grid (`spacing` metres apart) wherever the
 * ground is grass and fairly flat, keeping clear of `avoid` ({ x, z, r } in metres).
 */
export function growTrees(world, seed = 7, { spacing = 19, avoid = [] } = {}) {
  const random = rng(seed);
  const V = VOXEL;
  const W = world.sx * V, D = world.sz * V;
  let n = 0;
  for (let gz = spacing / 2; gz < D - 2; gz += spacing)
    for (let gx = spacing / 2; gx < W - 2; gx += spacing) {
      const mx = gx + (random() - 0.5) * spacing * 0.8, mz = gz + (random() - 0.5) * spacing * 0.8;
      const skip = random() < 0.25;
      if (skip || mx < 4 || mz < 4 || mx > W - 4 || mz > D - 4) continue;
      if (avoid.some((a) => Math.hypot(mx - a.x, mz - a.z) < a.r)) continue;
      const x = Math.floor(mx / V), z = Math.floor(mz / V);
      const g = groundAt(world, x, z);
      if (!g || g.mat !== MAT.GRASS || g.normal[1] < 0.85) continue;
      if (growTree(world, x, z, random)) n++;
    }
  return n;
}

/**
 * Cover grass ground with grass, thinned in patches, with flower patches
 * here and there. Only on the topmost surface of each column, and only where
 * it isn't too steep.
 */
export function growGrass(world, seed = 11) {
  const noise = createNoise3D(seed);
  const V = VOXEL;
  let n = 0;
  for (let z = 0; z < world.sz; z++)
    for (let x = 0; x < world.sx; x++) {
      const g = groundAt(world, x, z);
      if (!g || g.mat !== MAT.GRASS || g.normal[1] < 0.6 || g.y >= world.sy) continue;
      if (world.getPlant(x, g.y, z)) continue; // under a canopy that reaches the ground
      const px = (x + 0.5) * V, pz = (z + 0.5) * V;
      const density = 0.85 + 0.3 * noise(px / 9, 1.7, pz / 9);
      if (hash2(x, z, 1) > density) continue;
      const flowers = noise(px / 6, 4.2, pz / 6) > 0.55 && hash2(x, z, 2) < 0.6;
      world.setPlant(x, g.y, z, flowers ? PLANT.FLOWERS : PLANT.GRASS);
      n++;
    }
  world.markAllDirty();
  return n;
}

function hash2(x, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
