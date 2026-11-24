import { describe, it, expect } from 'vitest';
import { flatWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { FluxSim } from '../src/world/FluxSim.js';
import { FluidSim } from '../src/world/FluidSim.js';
import { FULL, FLUID, packFluid } from '../src/world/fluids.js';

/** A walled channel on flat ground, x in [2, 29], z in [10, 11], walls 6 high, with a block of water at the near end. */
function channel(Sim = FluxSim) {
  const w = flatWorld();
  for (let x = 1; x <= 30; x++)
    for (let y = GROUND; y < GROUND + 6; y++) {
      w.setMat(x, y, 9, MAT.STONE);
      w.setMat(x, y, 12, MAT.STONE);
    }
  for (let z = 9; z <= 12; z++) for (let y = GROUND; y < GROUND + 6; y++) { w.setMat(1, y, z, MAT.STONE); w.setMat(30, y, z, MAT.STONE); }
  const sim = new Sim(w);
  for (let x = 2; x <= 7; x++) for (let z = 10; z <= 11; z++) for (let y = GROUND; y < GROUND + 4; y++) {
    w.setFluid(x, y, z, packFluid(FLUID.WATER, FULL));
    sim.enqueue(x, y, z);
  }
  return { w, sim };
}

const surface = (sim, x, z) => {
  for (let y = sim.world.sy - 1; y >= 0; y--) if (sim.vol(x, y, z)) return y + Math.min(sim.vol(x, y, z), FULL) / FULL;
  return 0;
};

describe('flux simulation', () => {
  it('has momentum: a released block runs down a channel faster than the cellular model, and settles sooner', () => {
    const ticks = (Sim) => {
      const { sim } = channel(Sim);
      const total = sim.totalVolume();
      let reach = -1, t = 0;
      for (; t < 4000 && sim.queue.length; t++) {
        sim.tick();
        if (reach < 0 && sim.vol(29, GROUND, 10) > 50) reach = t;
      }
      expect(sim.queue.length).toBe(0); // went to sleep
      expect(sim.totalVolume()).toBe(total);
      return { reach, rest: t, surface: surface(sim, 29, 10) };
    };
    const flux = ticks(FluxSim), cell = ticks(FluidSim);
    expect(flux.reach).toBeLessThan(cell.reach * 0.8);
    expect(flux.rest).toBeLessThan(cell.rest);
    // 48 voxels of water over a 28 × 2 channel: about 0.86 voxels deep at rest.
    expect(flux.surface).toBeCloseTo(GROUND + 48 / 56, 1);
  });

  it('has a velocity where water is moving, and none where it rests', () => {
    const { sim } = channel();
    for (let t = 0; t < 15; t++) sim.tick();
    expect(sim.velocity(10, GROUND, 10)[0]).toBeGreaterThan(0.1);
    sim.settle(6000);
    expect(Math.abs(sim.velocity(10, GROUND, 10)[0])).toBeLessThan(0.01);
  });
});
