import { describe, it, expect } from 'vitest';
import { flatWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { VOXEL } from '../src/world/World.js';
import { FluidSim } from '../src/world/FluidSim.js';
import { FULL, FLUID, packFluid } from '../src/world/fluids.js';
import { meshFluid } from '../src/mesh/fluidMesh.js';

function meshWater(world) {
  const tris = [];
  for (let i = 0; i < world.chunks.length; i++) {
    const p = world.buildFluidPadded(...world.chunkCoords(i));
    if (!p) continue;
    const m = meshFluid(p, VOXEL);
    for (let k = 0; k < m.position.length; k += 9) tris.push({ p: Array.from(m.position.subarray(k, k + 9)), n: Array.from(m.normal.subarray(k, k + 3)), chunk: i });
  }
  return tris;
}

/** A settled pool `depth` voxels (fraction) deep on flat ground, x and z in [a, b], walled in stone. */
function pool(a, b, depth) {
  const w = flatWorld();
  for (let z = a - 1; z <= b + 1; z++) for (let x = a - 1; x <= b + 1; x++) {
    if (x >= a && x <= b && z >= a && z <= b) continue;
    for (let y = GROUND; y < GROUND + 4; y++) w.setMat(x, y, z, MAT.STONE);
  }
  for (let z = a; z <= b; z++) for (let x = a; x <= b; x++) w.setFluid(x, GROUND, z, packFluid(FLUID.WATER, Math.round(depth * FULL)));
  return w;
}

describe('water mesh', () => {
  it('draws the top at the water level', () => {
    const w = pool(10, 20, 0.5);
    const tops = meshWater(w).filter((t) => t.n[1] > 0.9);
    expect(tops.length).toBeGreaterThan(0);
    // A level pool merges into a few big quads, not one per column (11 × 11 here).
    expect(tops.length).toBeLessThan(40);
    for (const t of tops) for (let k = 1; k < 9; k += 3) expect(t.p[k]).toBeCloseTo((GROUND + 0.5) * VOXEL, 2);
  });

  it('matches across chunk seams', () => {
    // The pool spans the chunk border at x = 16 (chunks of 16 voxels); the surface slopes so heights vary.
    const w = pool(10, 22, 0.5);
    const sim = new FluidSim(w);
    w.setFluid(21, GROUND + 1, 15, packFluid(FLUID.WATER, FULL));
    sim.enqueue(21, GROUND + 1, 15);
    for (let i = 0; i < 6; i++) sim.tick();
    const tops = meshWater(w).filter((t) => t.n[1] > 0.5);
    const at = new Map();
    for (const t of tops)
      for (let k = 0; k < 9; k += 3) {
        if (Math.abs(t.p[k] - 16 * VOXEL) > 1e-6) continue;
        const key = t.p[k + 2].toFixed(3);
        const ys = at.get(key) || new Map();
        ys.set(t.chunk, t.p[k + 1]);
        at.set(key, ys);
      }
    let pairs = 0;
    for (const ys of at.values()) {
      const v = [...ys.values()];
      if (v.length < 2) continue;
      pairs++;
      // (Level stretches are merged at heights rounded to 1/128 voxel: 4 mm.)
      expect(Math.abs(v[0] - v[1])).toBeLessThan(0.004);
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('runs the surface over ground beside it, but never into building pieces', () => {
    const w = flatWorld();
    // A shallow trench in the ground, with a brick block at one end.
    for (let x = 8; x <= 20; x++) w.setMat(x, GROUND - 1, 12, 0);
    w.setVoxel(21, GROUND - 1, 12, MAT.BRICK, 1);
    for (let x = 8; x <= 20; x++) w.setFluid(x, GROUND - 1, 12, packFluid(FLUID.WATER, FULL / 2));
    const tops = meshWater(w).filter((t) => t.n[1] > 0.5);
    // Is the middle of voxel column (x, z) under any top triangle?
    const covered = (x, z) => {
      const px = (x + 0.5) * VOXEL, pz = (z + 0.5) * VOXEL;
      return tops.some(({ p }) => {
        const s = (ax, az, bx, bz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);
        const d1 = s(p[0], p[2], p[3], p[5]), d2 = s(p[3], p[5], p[6], p[8]), d3 = s(p[6], p[8], p[0], p[2]);
        return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
      });
    };
    expect(covered(12, 11)).toBe(true); // ground beside the trench
    expect(covered(21, 12)).toBe(false); // the brick
  });
});
