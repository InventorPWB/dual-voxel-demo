import { createNoise3D } from './noise.js';
import { MAT } from './materials.js';
import { VOXEL } from './World.js';
import { fillFromSDF } from './csg.js';
import { growTrees, growGrass } from './trees.js';
import { planWater, fillWater } from './hydrology.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fill the world with rolling hills, a smooth mountain with a few overhangs,
 * a cliff terrace and a sandy lowland, then trees and a grass cover. Shapes
 * are defined in metres and sampled into the 0.5 m voxels the player edits.
 * `avoid` keeps trees clear of places ({ x, z, r } in metres), like the spawn.
 */
export function generateWorld(world, seed = 1337, { avoid = [], withWater = true } = {}) {
  const noise = createNoise3D(seed);
  const { sx, sy, sz } = world;
  const V = VOXEL;
  const W = sx * V, D = sz * V, TOP = sy * V; // world size in metres

  const fbm2 = (x, z, octaves) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, 11.7 * o, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };

  const mx = W * 0.66, mz = D * 0.6; // mountain centre (m)
  const heightAt = (x, z) => {
    let h = 20 + 8 * fbm2(x / 70, z / 70, 4);
    const dx = x - mx, dz = z - mz;
    const mountain = Math.exp(-(dx * dx + dz * dz) / (2 * 20 * 20));
    h += 28 * mountain * (0.85 + 0.15 * noise(x / 14, 5.3, z / 14));
    // A terrace with a steep cliff edge.
    h += 6 * smoothstep(-0.06, 0.06, noise(x / 55, 3.3, z / 55));
    return Math.min(TOP - 6, h);
  };

  // Height per voxel column (metres), interpolated between column centres.
  const H = new Float32Array(sx * sz);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) H[x + sx * z] = heightAt((x + 0.5) * V, (z + 0.5) * V);
  if (withWater) seaBasin(H, sx, sz, noise);
  const sandy = H.map((h) => (h < 17.5 ? 1 : 0)); // the lowland, before the river's dug
  // A lake on the mountain's flank and a river from it down to the sea (shapes H).
  const water = withWater ? planWater(H, sx, sz, noise, { mountain: { x: mx, z: mz }, avoid }) : null;
  const hAt = (x, z) => H[Math.min(sx - 1, Math.max(0, x)) + sx * Math.min(sz - 1, Math.max(0, z))];
  const wetAt = (x, z) => sandy[x + sx * z] || (water && water.wet[x + sx * z]);
  const height = (vx, vz) => {
    const fx = vx - 0.5, fz = vz - 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
    const a = hAt(x0, z0) + (hAt(x0 + 1, z0) - hAt(x0, z0)) * tx;
    const b = hAt(x0, z0 + 1) + (hAt(x0 + 1, z0 + 1) - hAt(x0, z0 + 1)) * tx;
    return a + (b - a) * tz;
  };

  // Signed distance (voxels, positive inside): height above the point, plus
  // 3D noise near the surface on high ground for a few overhangs.
  const sdf = (vx, vy, vz) => {
    const h = height(vx, vz);
    const wy = vy * V;
    let d = h - wy;
    const overhang = smoothstep(30, 40, h) * 4;
    if (overhang > 0 && Math.abs(d) < 8) d += overhang * noise(vx * V / 16, wy / 12, vz * V / 16);
    return d / V;
  };

  // Materials by depth below the surface and steepness. `d` is the SDF's value
  // (vertical distance to the surface, plus the overhang noise), which
  // overstates the depth wherever the ground is steep or the noise leans: so
  // depth is measured the way the SDF's gradient says, as distance
  // perpendicular to the surface, and steepness comes from the same gradient.
  // (Otherwise dirt and stone show through the grass on slopes and overhangs.)
  const G = 0.5; // gradient sample spacing, voxels
  const matAt = (x, y, z, d) => {
    if (d * V > 8) return MAT.STONE; // deep inside: no need to look at the gradient
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    const gx = (sdf(cx + G, cy, cz) - sdf(cx - G, cy, cz)) / (2 * G);
    const gy = (sdf(cx, cy + G, cz) - sdf(cx, cy - G, cz)) / (2 * G);
    const gz = (sdf(cx, cy, cz + G) - sdf(cx, cy, cz - G)) / (2 * G);
    // Steepness: how far the surface leans from level (rise over run is 1/slope).
    const slope = Math.hypot(gx, gz) / Math.max(Math.abs(gy), 1e-3);
    const dd = (d / Math.max(Math.hypot(gx, gy, gz), 0.25)) * V; // metres below the surface
    if (wetAt(Math.min(sx - 1, Math.max(0, x)), Math.min(sz - 1, Math.max(0, z))) && dd <= 1.5) return MAT.SAND;
    if (slope > 1.1) return dd <= 0.6 && slope < 1.6 ? MAT.GRASS : MAT.STONE;
    if (dd <= 0.6) return MAT.GRASS;
    if (dd <= 2.5) return MAT.DIRT;
    return MAT.STONE;
  };

  fillFromSDF(world, sdf, matAt);
  // Trees keep clear of the lake and the river.
  const clear = water ? [{ x: water.lake.x, z: water.lake.z, r: 14 }, ...water.course.filter((_, i) => i % 3 === 0).map(([x, z]) => ({ x, z, r: 4.5 }))] : [];
  growTrees(world, seed + 1, { avoid: [...avoid, ...clear] });
  growGrass(world, seed + 2);
  if (withWater) fillWater(world, water);
  return { water };
}

/**
 * Sink the ground along the world's lowest edge into a basin for the sea:
 * deepest at the edge (about 8 m down), rising to the original ground some
 * 30 m in, along a coast that wanders. Works on H (m per voxel column) in place.
 */
function seaBasin(H, sx, sz, noise) {
  const V = VOXEL, band = 20 / V;
  // Mean ground height in a band along each edge: x = 0, x = max, z = 0, z = max.
  const mean = [0, 0, 0, 0], n = [0, 0, 0, 0];
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const h = H[x + sx * z];
      if (x < band) { mean[0] += h; n[0]++; }
      if (x >= sx - band) { mean[1] += h; n[1]++; }
      if (z < band) { mean[2] += h; n[2]++; }
      if (z >= sz - band) { mean[3] += h; n[3]++; }
    }
  const edge = mean.map((m, k) => m / n[k]).reduce((b, m, k, a) => (m < a[b] ? k : b), 0);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const d = [x, sx - 1 - x, z, sz - 1 - z][edge] * V; // metres from that edge
      const along = (edge < 2 ? z : x) * V;
      const coast = 30 + 6 * noise(along / 25, 9.1, 0.5);
      const t = Math.min(1, Math.max(0, (coast - d) / coast));
      H[x + sx * z] -= 8.5 * t * t * (3 - 2 * t);
    }
}

/** Height in metres of the top of the highest solid voxel in the column containing metre point (x, z). */
export function surfaceHeight(world, x, z) {
  const vx = Math.floor(x / VOXEL), vz = Math.floor(z / VOXEL);
  for (let y = world.sy - 1; y >= 0; y--) if (world.isSolid(vx, y, vz)) return (y + 1) * VOXEL;
  return 0;
}
