import { describe, it, expect } from 'vitest';
import { flatWorld, slopedWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { PLANT } from '../src/world/plants.js';
import { FluidSim } from '../src/world/FluidSim.js';
import { FluxSim } from '../src/world/FluxSim.js';
import { FULL, FLUID, packFluid, fluidVolumeOf } from '../src/world/fluids.js';

const water = (v = FULL) => packFluid(FLUID.WATER, v);

/** Solid stone in a box (inclusive). */
function wall(world, x0, y0, z0, x1, y1, z1) {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.setMat(x, y, z, MAT.STONE);
}

/** A walled basin on flat ground: inside x, z in [a, b], walls up to `top`. */
function basin(world, a, b, top) {
  wall(world, a - 1, GROUND, a - 1, b + 1, top, a - 1);
  wall(world, a - 1, GROUND, b + 1, b + 1, top, b + 1);
  wall(world, a - 1, GROUND, a - 1, a - 1, top, b + 1);
  wall(world, b + 1, GROUND, a - 1, b + 1, top, b + 1);
}

function pour(sim, x0, y0, z0, x1, y1, z1, v = FULL) {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    sim.world.setFluid(x, y, z, water(v));
    sim.enqueue(x, y, z);
  }
}

/** Height of the water surface in a column (voxels), or -1 if dry. */
function surface(sim, x, z) {
  for (let y = sim.world.sy - 1; y >= 0; y--) {
    const v = sim.vol(x, y, z);
    if (v) return y + sim.world.floorOffset(x, y, z) + Math.min(v, FULL) / FULL;
  }
  return -1;
}

// Both simulations: the cellular one, and the flux one (with momentum).
for (const Sim of [FluidSim, FluxSim]) describe(`fluid simulation (${Sim.name})`, () => {
  it('conserves volume and levels out in a closed basin, then sleeps', () => {
    const w = flatWorld();
    basin(w, 6, 20, GROUND + 8);
    const sim = new Sim(w);
    pour(sim, 12, GROUND + 4, 12, 14, GROUND + 6, 14);
    const total = sim.totalVolume();
    const ticks = sim.settle(5000);
    expect(ticks).toBeLessThan(5000); // went to sleep
    expect(sim.totalVolume()).toBe(total);
    // 27 voxels over a 15 × 15 floor: an even sheet.
    const levels = [];
    for (let z = 6; z <= 20; z++) for (let x = 6; x <= 20; x++) levels.push(surface(sim, x, z));
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(0.05);
    expect(levels[0]).toBeCloseTo(GROUND + 27 / 225, 1);
  });

  it('finds the same level on both sides of a wall it passes under (U-tube)', () => {
    const w = flatWorld();
    // Two basins, x 4..10 and 14..20, joined by a tunnel at floor level under the wall between them.
    wall(w, 3, GROUND, 3, 21, GROUND + 14, 3);
    wall(w, 3, GROUND, 11, 21, GROUND + 14, 11);
    wall(w, 3, GROUND, 3, 3, GROUND + 14, 11);
    wall(w, 21, GROUND, 3, 21, GROUND + 14, 11);
    wall(w, 11, GROUND + 1, 4, 13, GROUND + 14, 10);
    const sim = new Sim(w);
    pour(sim, 4, GROUND, 4, 10, GROUND + 7, 10);
    const total = sim.totalVolume();
    sim.settle(20000);
    expect(sim.totalVolume()).toBe(total);
    const a = surface(sim, 7, 7), b = surface(sim, 17, 7);
    expect(b).toBeGreaterThan(GROUND + 2);
    expect(Math.abs(a - b)).toBeLessThan(0.35);
  });

  it('spills off a ledge and ends up at the bottom', () => {
    const w = flatWorld();
    wall(w, 8, GROUND, 8, 12, GROUND + 3, 12);
    const sim = new Sim(w);
    pour(sim, 10, GROUND + 4, 10, 10, GROUND + 4, 10);
    const total = sim.totalVolume();
    sim.settle(5000);
    expect(sim.totalVolume()).toBe(total);
    let onTop = 0;
    for (let z = 8; z <= 12; z++) for (let x = 8; x <= 12; x++) onTop += sim.vol(x, GROUND + 4, z);
    expect(onTop).toBeLessThan(total * 0.05);
  });

  it('runs downhill on smooth sloping ground', () => {
    const w = slopedWorld(0.15);
    const sim = new Sim(w);
    // Above the ground near the high end.
    const x = 26, z = 16;
    let y = w.sy - 1;
    while (!w.isSolid(x, y - 1, z)) y--;
    pour(sim, x, y, z, x, y, z);
    // It comes to rest, rather than trickling for ever.
    expect(sim.settle(8000)).toBeLessThan(8000);
    let sum = 0, sumX = 0;
    for (let zz = 0; zz < w.sz; zz++) for (let yy = 0; yy < w.sy; yy++) for (let xx = 0; xx < w.sx; xx++) {
      const v = sim.vol(xx, yy, zz);
      sum += v; sumX += v * xx;
    }
    // (Poured at x = 26; most of it ends near the low end.)
    expect(sumX / sum).toBeLessThan(12);
  });

  it('puts water back nearby when a voxel it was in becomes solid', () => {
    const w = flatWorld();
    basin(w, 8, 16, GROUND + 8);
    const sim = new Sim(w);
    pour(sim, 8, GROUND, 8, 16, GROUND + 1, 16);
    sim.settle();
    const total = sim.totalVolume();
    w.setMat(12, GROUND, 12, MAT.STONE);
    w.setVoxel(10, GROUND + 1, 10, MAT.BRICK, 1);
    expect(w.getFluid(12, GROUND, 12)).toBe(0);
    sim.settle();
    expect(sim.totalVolume()).toBe(total);
  });

  it('washes away grass it covers', () => {
    const w = flatWorld();
    basin(w, 8, 12, GROUND + 6);
    w.setPlant(10, GROUND, 10, PLANT.GRASS);
    const sim = new Sim(w);
    pour(sim, 8, GROUND + 2, 8, 12, GROUND + 2, 12);
    sim.settle();
    expect(w.getPlant(10, GROUND, 10)).toBe(0);
  });

  it('stores a chunk full of still water as one value, and expands it again when needed', () => {
    const w = flatWorld(2, 16, 4); // ground surface at y = 4: chunks above it are all open
    const sim = new Sim(w);
    // Fill the lower-left chunk above the ground, and the one above it all but its top layers, with water.
    for (let z = 0; z < 16; z++) for (let y = 4; y < 29; y++) for (let x = 0; x < 16; x++) w.setFluid(x, y, z, water());
    sim.compact(w.chunks.length);
    const top = w.chunks[w.chunkIndex(0, 0, 0)];
    expect(w.chunks[w.chunkIndex(0, 1, 0)].fluid).not.toBe(null); // (part air: kept as an array)
    expect(top.fluid).toBe(null);
    expect(top.fluidUniform).toBe(water());
    const total = sim.totalVolume();
    // Building into it, and digging a hole in what was built, keep the volume exact.
    w.setMat(5, 10, 5, MAT.STONE);
    sim.settle();
    w.setMat(5, 10, 5, 0);
    expect(sim.vol(5, 10, 5)).toBe(0);
    sim.wake([5, 10, 5, 5, 10, 5]);
    sim.settle();
    expect(sim.totalVolume()).toBe(total);
  }, 20000); // (a big block of water spreading out takes a while)

  it('wakes when an edit opens a way out', () => {
    const w = flatWorld();
    basin(w, 8, 12, GROUND + 4);
    const sim = new Sim(w);
    pour(sim, 8, GROUND, 8, 12, GROUND + 2, 12);
    sim.settle();
    expect(sim.queue.length).toBe(0);
    // Knock a hole in the wall: markDirtyBox wakes the water beside it.
    for (const y of [GROUND, GROUND + 1]) w.setMat(13, y, 10, 0);
    w.markDirtyBox(13, GROUND, 10, 13, GROUND + 1, 10);
    expect(sim.queue.length).toBeGreaterThan(0);
    sim.settle();
    expect(fluidVolumeOf(w.getFluid(16, GROUND, 10))).toBeGreaterThan(0);
  });
});
