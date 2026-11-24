import { describe, it, expect } from 'vitest';
import { flatWorld, slopedWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { VOXEL } from '../src/world/World.js';
import { FULL, FLUID, packFluid } from '../src/world/fluids.js';
import { meshFluidSurface } from '../src/mesh/fluidSurface.js';

const water = (v = FULL) => packFluid(FLUID.WATER, v);

function mesh(world) {
  const tris = [];
  for (let i = 0; i < world.chunks.length; i++) {
    const p = world.buildFluidPadded(...world.chunkCoords(i), true);
    if (!p) continue;
    const m = meshFluidSurface(p, VOXEL);
    for (let k = 0; k < m.position.length; k += 9) {
      const t = Array.from(m.position.subarray(k, k + 9));
      const ax = t[3] - t[0], ay = t[4] - t[1], az = t[5] - t[2], bx = t[6] - t[0], by = t[7] - t[1], bz = t[8] - t[2];
      const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      const l = Math.hypot(...n) || 1;
      tris.push({ p: t, n: n.map((v) => v / l), chunk: i });
    }
  }
  return tris;
}

/** A pool on flat ground, x and z in [a, b], `depth` voxels of water (a fraction is fine), walled in stone. */
function pool(a, b, depth) {
  const w = flatWorld();
  for (let z = a - 1; z <= b + 1; z++) for (let x = a - 1; x <= b + 1; x++) {
    if (x >= a && x <= b && z >= a && z <= b) continue;
    for (let y = GROUND; y < GROUND + 4; y++) w.setMat(x, y, z, MAT.STONE);
  }
  for (let z = a; z <= b; z++) for (let x = a; x <= b; x++) {
    let left = depth;
    for (let y = GROUND; left > 0; y++, left--) w.setFluid(x, y, z, water(Math.round(Math.min(1, left) * FULL)));
  }
  return w;
}

describe('contoured water surface', () => {
  it('lies flat at the water level, facing up', () => {
    const w = pool(10, 20, 1.6);
    const tops = mesh(w).filter((t) => t.n[1] > 0.9);
    expect(tops.length).toBeGreaterThan(50);
    // Away from the walls, every vertex is at the level.
    for (const t of tops)
      for (let k = 0; k < 9; k += 3) {
        const x = t.p[k] / VOXEL, z = t.p[k + 2] / VOXEL;
        if (x < 12 || x > 19 || z < 12 || z > 19) continue;
        expect(t.p[k + 1]).toBeCloseTo((GROUND + 1.6) * VOXEL, 2);
      }
  });

  it('matches across chunk seams', () => {
    const w = pool(10, 22, 1.6); // spans the border at x = 16
    const at = new Map();
    for (const t of mesh(w))
      for (let k = 0; k < 9; k += 3) {
        if (Math.abs(t.p[k] / VOXEL - 16.5) > 1.01) continue;
        const key = `${t.p[k].toFixed(4)},${t.p[k + 1].toFixed(4)},${t.p[k + 2].toFixed(4)}`;
        at.set(key, (at.get(key) || new Set()).add(t.chunk));
      }
    // Vertices near the seam are shared exactly by both chunks' meshes somewhere.
    expect([...at.values()].some((s) => s.size === 2)).toBe(true);
  });

  it('drapes a thin sheet over sloping ground, above it', () => {
    const w = slopedWorld(0.4);
    // 1/5 of a voxel (10 cm) of water on every column of a strip down the slope.
    for (let x = 4; x < 28; x++) for (let z = 8; z < 12; z++) {
      let y = w.sy - 1;
      while (!w.isSolid(x, y - 1, z)) y--;
      w.setFluid(x, y, z, water(FULL / 5));
    }
    const tris = mesh(w).filter((t) => t.n[1] > 0.5);
    expect(tris.length).toBeGreaterThan(40);
    // Following the slope: the sheet's own triangles tilt like the ground (rise 0.4 per voxel).
    const tilted = tris.filter((t) => Math.abs(t.n[0]) > 0.2);
    expect(tilted.length).toBeGreaterThan(tris.length / 2);
  });

  it('draws water in free fall as upright faces, not just flat tops', () => {
    const w = flatWorld();
    // A column of water hanging off the side of a ledge (as it falls).
    for (let y = GROUND; y < GROUND + 6; y++) w.setMat(10, y, 10, MAT.STONE);
    for (let y = GROUND; y < GROUND + 6; y++) w.setFluid(11, y, 10, water());
    const sides = mesh(w).filter((t) => Math.abs(t.n[1]) < 0.5);
    expect(sides.length).toBeGreaterThan(10);
  });
});
