import { createNoise3D } from './noise.js';
import { applyCSG } from './csg.js';
import { MAT } from './materials.js';
import { PLANT } from './plants.js';
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
 * Proportioned like a broad oak: the crown spreads 11-15 m, about as wide as
 * the tree is tall, and 13-15 times the trunk's width. The trunk flares at
 * the foot, tapers to a fork at 3-4.5 m and splits into 4-5 limbs that
 * spread out and up, each forking once more, plus a leader up the middle.
 * The crown is dense leaf clusters in two tiers (along and at the end of
 * every limb, then a ring above and inward of those, then the top), so it
 * builds up into a tall, lumpy dome and never reads as a hollow shell.
 *
 * The wood is smooth Log terrain (an exact CSG union of tapered capsules,
 * blended with rounded fillets), so each tree leans, forks and spreads
 * differently and can be dug or chopped like ground. Wood stays at least
 * about 1.5 voxels thick, the least the terrain mesher draws reliably.
 */
export function growTree(world, x, z, random = Math.random) {
  const g = groundAt(world, x, z);
  if (!g) return false;
  const V = VOXEL;
  const s = 0.85 + 0.35 * random(); // overall size
  const m = (v) => v / V; // metres to voxels

  // Trunk: from a metre underground up to the fork, leaning a little.
  const foot = [x + 0.5, g.height - m(1), z + 0.5];
  const lean = random() * Math.PI * 2, leanBy = 0.03 + 0.05 * random();
  const forkH = m((3 + 1.5 * random()) * s);
  const fork = [foot[0] + Math.cos(lean) * leanBy * forkH, g.height + forkH, foot[2] + Math.sin(lean) * leanBy * forkH];
  const rBase = m(0.45), rFork = m(0.41), rLimb = m(0.38), flare = m(0.4);
  const trunk = { a: foot, b: fork, ra: rBase, rb: rFork };
  const segments = [];

  // Limbs spreading out and up from the fork, each forking once more.
  const limbs = 4 + (random() < 0.5 ? 1 : 0);
  const turn = random() * Math.PI * 2;
  const clumps = [];
  const tips = [];
  const clump = (p, r, lift = 0.4) => clumps.push({ x: p[0], y: p[1] + m(lift), z: p[2], r: m(r * s) });
  const along = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let i = 0; i < limbs; i++) {
    const a = turn + (i / limbs) * Math.PI * 2 + (random() - 0.5) * 0.6;
    const len = m((3.8 + 1.4 * random()) * s), rise = 0.4 + 0.25 * random();
    const out = Math.sqrt(1 - rise * rise);
    const from = [fork[0], fork[1] - m(0.3 + 0.4 * random()), fork[2]];
    const tip = [from[0] + Math.cos(a) * out * len, from[1] + rise * len, from[2] + Math.sin(a) * out * len];
    segments.push({ a: from, b: tip, ra: rFork, rb: rLimb });
    tips.push(tip);
    clump(tip, 2.1 + 0.5 * random());
    clump(along(from, tip, 0.5), 1.7 + 0.4 * random(), 0.9);
    // A side branch from about halfway, turned off to one side and a little higher.
    const at = along(from, tip, 0.45 + 0.15 * random());
    const side = a + (random() < 0.5 ? -1 : 1) * (0.6 + 0.3 * random());
    const sLen = len * (0.45 + 0.15 * random()), sRise = Math.min(0.85, rise + 0.2);
    const sOut = Math.sqrt(1 - sRise * sRise);
    const sTip = [at[0] + Math.cos(side) * sOut * sLen, at[1] + sRise * sLen, at[2] + Math.sin(side) * sOut * sLen];
    segments.push({ a: at, b: sTip, ra: rLimb, rb: rLimb });
    clump(sTip, 1.8 + 0.4 * random());
  }
  // A leader up the middle, crowned by the top of the dome.
  const leader = [fork[0], fork[1] + m(3.6 * s), fork[2]];
  segments.push({ a: fork, b: leader, ra: rFork, rb: rLimb });
  clump(leader, 2.5 + 0.4 * random(), 1.0);
  clump([fork[0], fork[1] + m(1.4 * s), fork[2]], 2.4, 0.4);
  // An upper tier: a cluster above and inward of each limb's end, so the
  // crown builds up in layers into a tall dome instead of one flat spread.
  for (const tip of tips) {
    const p = along(tip, leader, 0.45 + 0.15 * random());
    clump(p, 1.9 + 0.5 * random(), (1.2 + 0.8 * random()) * s);
  }

  const capsule = ({ a, b, ra, rb }, px, py, pz) => {
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * bx + (py - a[1]) * by + (pz - a[2]) * bz) / (bx * bx + by * by + bz * bz)));
    return { d: Math.hypot(px - a[0] - bx * t, py - a[1] - by * t, pz - a[2] - bz * t), r: ra + (rb - ra) * t };
  };
  const fillet = m(0.35);
  const sdf = (px, py, pz) => {
    // The trunk, flaring into roots just at the ground (along its own axis, so no seam).
    const c = capsule(trunk, px, py, pz);
    let d = c.d - c.r - flare * Math.exp(-Math.max(0, py - g.height) / m(0.7));
    for (const seg of segments) {
      const k = capsule(seg, px, py, pz);
      d = smin(d, k.d - k.r, fillet);
    }
    return -d;
  };
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (const { a, b } of [trunk, ...segments])
    for (const p of [a, b]) {
      bx0 = Math.min(bx0, p[0]); by0 = Math.min(by0, p[1]); bz0 = Math.min(bz0, p[2]);
      bx1 = Math.max(bx1, p[0]); by1 = Math.max(by1, p[1]); bz1 = Math.max(bz1, p[2]);
    }
  const pad = Math.ceil(rBase + flare) + 2;
  applyCSG(world, 'union', [Math.floor(bx0) - pad, Math.floor(by0) - 1, Math.floor(bz0) - pad, Math.ceil(bx1) + pad, Math.ceil(by1) + pad, Math.ceil(bz1) + pad],
    sdf, { material: MAT.LOG, keep: true });

  // Crown: the clusters, squashed into a dome, with a noisy edge.
  const noise = createNoise3D(Math.floor(random() * 1e9));
  let x0 = Infinity, x1 = -Infinity, cy0 = Infinity, cy1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of clumps) {
    x0 = Math.min(x0, b.x - b.r); x1 = Math.max(x1, b.x + b.r);
    cy0 = Math.min(cy0, b.y - b.r); cy1 = Math.max(cy1, b.y + b.r);
    z0 = Math.min(z0, b.z - b.r); z1 = Math.max(z1, b.z + b.r);
  }
  for (let vz = Math.floor(z0); vz <= Math.ceil(z1); vz++)
    for (let vy = Math.floor(cy0); vy <= Math.ceil(cy1); vy++)
      for (let vx = Math.floor(x0); vx <= Math.ceil(x1); vx++) {
        if (!world.inBounds(vx, vy, vz) || world.isSolid(vx, vy, vz)) continue;
        const px = vx + 0.5, py = vy + 0.5, pz = vz + 0.5;
        let inside = -Infinity;
        for (const b of clumps) {
          const d = Math.hypot((px - b.x) / b.r, (py - b.y) / (b.r * 0.8), (pz - b.z) / b.r);
          inside = Math.max(inside, 1 - d);
        }
        inside += 0.22 * noise(px * V / 1.4, py * V / 1.4, pz * V / 1.4);
        if (inside > 0) world.setPlant(vx, vy, vz, PLANT.LEAVES);
      }
  world.markDirtyBox(Math.floor(Math.min(x0, bx0)) - pad, Math.floor(by0) - 1, Math.floor(Math.min(z0, bz0)) - pad,
    Math.ceil(Math.max(x1, bx1)) + pad, Math.ceil(cy1) + 1, Math.ceil(Math.max(z1, bz1)) + pad);
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
