import { createNoise3D } from './noise.js';
import { applyCSG } from './csg.js';
import { MAT } from './materials.js';
import { PLANT } from './plants.js';
import { VOXEL } from './World.js';
import { unpackNormal } from './normals.js';

/**
 * Test vegetation for generated worlds: trees and a grass cover.
 *
 * A tree is ordinary world data: a smooth trunk of Log terrain (an exact
 * CSG union, so it can be dug and chopped like any ground), and a canopy of
 * leaf voxels in the plant layer around its top. Nothing else remembers it.
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

/**
 * Grow one tree with its foot at voxel column (x, z). Sizes are in metres.
 * Returns false if there's no ground there.
 */
export function growTree(world, x, z, random = Math.random) {
  const g = groundAt(world, x, z);
  if (!g) return false;
  const V = VOXEL;
  const height = (5 + 3 * random()) / V; // trunk, voxels above ground
  const r0 = 0.55 / V, flare = 0.3 / V;
  const leanX = (random() - 0.5) * 0.12, leanZ = (random() - 0.5) * 0.12;
  const cx = x + 0.5, cz = z + 0.5, y0 = g.height - 1 / V, y1 = g.height + height;

  // Trunk: a leaning, tapering capsule that flares into roots at the ground.
  const axisAt = (y) => [cx + leanX * (y - g.height), cz + leanZ * (y - g.height)];
  const sdf = (px, py, pz) => {
    const yy = Math.max(y0, Math.min(y1, py));
    const [ax, az] = axisAt(yy);
    const above = Math.max(0, yy - g.height);
    const r = r0 * (1 - 0.25 * above / height) + flare * Math.exp(-above / (0.6 / V));
    // Cut flat at both ends: the top is hidden in the canopy, the bottom underground.
    return -Math.max(Math.hypot(px - ax, pz - az) - r, py - y1, y0 - py);
  };
  const reach = Math.ceil(r0 + flare + 0.2 * height) + 2;
  applyCSG(world, 'union', [x - reach, Math.floor(y0) - 1, z - reach, x + reach, Math.ceil(y1) + 2, z + reach], sdf, { material: MAT.LOG, keep: true });

  // Canopy: a few overlapping noisy blobs around the top of the trunk.
  const [tx, tz] = axisAt(y1);
  const noise = createNoise3D(Math.floor(random() * 1e9));
  const blobs = [];
  const count = 2 + Math.floor(random() * 2);
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2, d = i === 0 ? 0 : (0.8 + random() * 0.9) / V;
    blobs.push({
      x: tx + Math.cos(a) * d, y: y1 + (i === 0 ? 0.4 / V : (random() - 0.6) * 1.6 / V), z: tz + Math.sin(a) * d,
      r: (i === 0 ? 3 : 2.2 + random() * 0.8) / V,
    });
  }
  let x0 = Infinity, x1 = -Infinity, cy0 = Infinity, cy1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of blobs) {
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
        for (const b of blobs) {
          // Squashed a little vertically: canopies are wider than tall.
          const d = Math.hypot((px - b.x) / b.r, (py - b.y) / (b.r * 0.8), (pz - b.z) / b.r);
          inside = Math.max(inside, 1 - d);
        }
        inside += 0.22 * noise(px * V / 1.6, py * V / 1.6, pz * V / 1.6);
        if (inside > 0) world.setPlant(vx, vy, vz, PLANT.LEAVES);
      }
  world.markDirtyBox(Math.floor(x0) - 1, Math.floor(Math.min(cy0, y0)) - 1, Math.floor(z0) - 1, Math.ceil(x1) + 1, Math.ceil(cy1) + 1, Math.ceil(z1) + 1);
  return true;
}

/**
 * Scatter trees on a jittered grid (`spacing` metres apart) wherever the
 * ground is grass and fairly flat, keeping clear of `avoid` ({ x, z, r } in metres).
 */
export function growTrees(world, seed = 7, { spacing = 11, avoid = [] } = {}) {
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
