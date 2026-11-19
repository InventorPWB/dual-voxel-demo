import { createNoise3D } from './noise.js';
import { MAT } from './materials.js';
import { OCC_SLOPE } from './World.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Fill the world with rolling hills, a smooth mountain with a few overhangs,
 * a cliff terrace and a sandy lowland. Writes occupancy + material directly
 * into the same voxels the player edits.
 */
export function generateWorld(world, seed = 1337) {
  const noise = createNoise3D(seed);
  const { sx, sy, sz } = world;

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

  const mx = sx * 0.66, mz = sz * 0.6; // mountain centre
  const heightAt = (x, z) => {
    let h = 24 + 9 * fbm2(x / 70, z / 70, 4);
    const dx = x - mx, dz = z - mz;
    const mountain = Math.exp(-(dx * dx + dz * dz) / (2 * 21 * 21));
    h += 40 * mountain * (0.85 + 0.15 * noise(x / 14, 5.3, z / 14));
    // A terrace with a steep cliff edge.
    h += 7 * smoothstep(-0.06, 0.06, noise(x / 55, 3.3, z / 55));
    return Math.min(sy - 8, h);
  };

  const H = new Float32Array(sx * sz);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) H[x + sx * z] = heightAt(x + 0.5, z + 0.5);

  const hAt = (x, z) => H[Math.min(sx - 1, Math.max(0, x)) + sx * Math.min(sz - 1, Math.max(0, z))];

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const h = H[x + sx * z];
      const slope = Math.hypot(hAt(x + 1, z) - hAt(x - 1, z), hAt(x, z + 1) - hAt(x, z - 1)) * 0.5;
      // 3D noise only near the surface on high ground: gives overhangs on the mountain.
      const overhang = smoothstep(34, 46, h) * 4.5;

      let depth = 0; // solid voxels since the last air voxel, counted from the top
      for (let y = sy - 1; y >= 0; y--) {
        let d = h - (y + 0.5);
        if (overhang > 0 && Math.abs(d) < 8) d += overhang * noise(x / 16, y / 12, z / 16);
        let occ = y === 0 ? 255 : Math.round(Math.min(1, Math.max(0, 0.5 + d * OCC_SLOPE)) * 255);

        if (occ >= 128) depth++;
        else depth = 0;
        if (occ === 0) {
          world.setRaw(x, y, z, 0, 0);
          continue;
        }

        const dd = Math.max(1, depth);
        let mat;
        if (h < 21.5 && dd <= 3) mat = MAT.SAND;
        else if (slope > 1.1 || h > 64) mat = dd <= 1 && slope < 1.6 && h <= 64 ? MAT.GRASS : MAT.STONE;
        else if (dd === 1) mat = MAT.GRASS;
        else if (dd <= 4) mat = MAT.DIRT;
        else mat = MAT.STONE;
        world.setRaw(x, y, z, occ, mat);
      }
    }
  }
  world.markAllDirty();
}

/** Highest solid voxel y in a column, or 0. */
export function surfaceHeight(world, x, z) {
  for (let y = world.sy - 1; y >= 0; y--) if (world.isSolid(x, y, z)) return y + 1;
  return 0;
}
