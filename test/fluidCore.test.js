import { describe, it, expect } from 'vitest';
import { flatWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { FluidSim } from '../src/world/FluidSim.js';
import { FluidCore, TILE } from '../src/world/fluidCore.js';
import { FULL, FLUID, packFluid } from '../src/world/fluids.js';

/**
 * Flat ground with a pit dug `deep` voxels into it over x in [x0, x1], z in
 * [z0, z1], filled with water to the brim. (World of 3 × 3 × 3 chunks of 16.)
 */
function pit(x0, x1, z0, z1, deep = 4) {
  const w = flatWorld(3, 16);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let y = GROUND - deep; y < GROUND; y++) w.setMat(x, y, z, 0);
  const sim = new FluidSim(w);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let y = GROUND - deep; y < GROUND; y++) w.setFluid(x, y, z, packFluid(FLUID.WATER, FULL));
  const core = new FluidCore(w, sim);
  core.rebuild(true);
  return { w, sim, core };
}

describe('derived sources', () => {
  it('makes the middle of a 12 m pool a source, but not a 4 m pool or a 1 m channel', () => {
    expect(pit(4, 27, 4, 27).core.coreCount).toBeGreaterThan(0);
    expect(pit(4, 11, 4, 11).core.coreCount).toBe(0);
    expect(pit(2, 40, 10, 11).core.coreCount).toBe(0);
  });

  it('feeds a channel cut from a source pool without running low', () => {
    const { w, sim, core } = pit(4, 27, 4, 27);
    const before = sim.totalVolume();
    // A long dry channel from the pool's side out to x = 44.
    for (let x = 28; x <= 44; x++) for (let y = GROUND - 2; y < GROUND; y++) w.setMat(x, y, 16, 0);
    w.markDirtyBox(28, GROUND - 2, 16, 44, GROUND - 1, 16);
    for (let i = 0; i < 3000; i++) {
      sim.tick();
      if (i % 10 === 0) core.update(true);
    }
    // The channel filled, and the pool stayed brim-full: water came from the source.
    expect(sim.vol(44, GROUND - 2, 16)).toBeGreaterThan(FULL / 2);
    expect(sim.totalVolume()).toBeGreaterThan(before);
    expect(core.surf[15 + w.sx * 15]).toBeGreaterThan(GROUND - 0.05);
  });

  it('a still source lake neither gains nor loses water', () => {
    const { sim, core } = pit(4, 27, 4, 27);
    sim.wakeAll();
    const before = sim.totalVolume();
    for (let i = 0; i < 2000; i++) {
      sim.tick();
      if (i % 10 === 0) core.update(true);
    }
    expect(sim.totalVolume()).toBe(before);
    expect(sim.queue.length).toBe(0);
  });

  it('absorbs water poured into it, so it stays level and goes back to sleep', () => {
    const { w, sim, core } = pit(4, 27, 4, 27);
    const level = core.surf[15 + w.sx * 15];
    // A bucketful or two dropped into the middle, from above the surface.
    sim.deposit(15, GROUND + 2, 15, 16 * FULL);
    const ticks = sim.settle(3000);
    expect(ticks).toBeLessThan(3000);
    core.update(true);
    expect(core.surf[15 + w.sx * 15]).toBeCloseTo(level, 2);
  });

  it('stops being a source when an edit leaves it too small, so it can be drained', () => {
    const { w, sim, core } = pit(4, 27, 4, 27);
    expect(core.coreCount).toBeGreaterThan(0);
    // Fill most of the pool with stone: what's left is a 2 m strip.
    for (let z = 4; z <= 27; z++) for (let x = 8; x <= 27; x++) for (let y = GROUND - 4; y < GROUND; y++) w.setMat(x, y, z, MAT.STONE);
    w.markDirtyBox(8, GROUND - 4, 4, 27, GROUND - 1, 27);
    for (let i = 0; i < 200; i++) {
      sim.tick();
      core.update(true);
    }
    expect(core.coreCount).toBe(0);
    // (Nothing above tests TILE; keep it in sync with the window maths.)
    expect(TILE).toBe(4);
  });
});
