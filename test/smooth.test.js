import { describe, it, expect } from 'vitest';
import { World } from '../src/world/World.js';
import { MAT } from '../src/world/materials.js';
import { fillFromSDF } from '../src/world/csg.js';
import { sculptSphere, smoothBrush } from '../src/world/edits.js';

/** Surface height (voxels) of each column in a box: the top solid voxel plus its top crossing. */
function heights(w, x0, x1, z0, z1) {
  const e = [0, 0, 0], out = [];
  for (let z = z0; z <= z1; z++) {
    const row = [];
    for (let x = x0; x <= x1; x++) {
      let y = w.sy - 2;
      while (y > 1 && !w.isTerrain(x, y, z)) y--;
      row.push(w.getEdge(x, y, z, 1, e) ? y + e[0] : y + 0.5);
    }
    out.push(row);
  }
  return out;
}

/** Largest second difference of the surface height: how sharp its worst bump or dent is. */
function sharpest(h) {
  let m = 0;
  for (let j = 1; j < h.length - 1; j++)
    for (let i = 1; i < h[0].length - 1; i++) m = Math.max(m, Math.abs(h[j][i - 1] + h[j][i + 1] + h[j - 1][i] + h[j + 1][i] - 4 * h[j][i]));
  return m;
}

describe('smooth brush', () => {
  it('keeps rounding off jagged ground instead of leaving spikes it can no longer move', () => {
    const w = new World(2, 2, 2, 16);
    fillFromSDF(w, (x, y) => 12.3 - y, () => MAT.GRASS);
    // Roughen it with random bumps and dents.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 25; i++)
      sculptSphere(w, { x: 8 + rnd() * 16, y: 12 + (rnd() - 0.5) * 3, z: 8 + rnd() * 16 }, 1.5 + rnd() * 2, rnd() < 0.5 ? 'add' : 'sub', MAT.DIRT);
    const before = sharpest(heights(w, 11, 21, 11, 21));
    // Hold the brush for a few seconds at 60 frames a second.
    for (let it = 0; it < 400; it++) smoothBrush(w, { x: 16, y: 12, z: 16 }, 9, 1 / 60);
    const after = sharpest(heights(w, 11, 21, 11, 21));
    expect(before).toBeGreaterThan(5);
    // (Before the fix, single-voxel tips whose surface sat at their centre never went: this stayed above 1.3.)
    expect(after).toBeLessThan(0.8);
  }, 60000);
});
