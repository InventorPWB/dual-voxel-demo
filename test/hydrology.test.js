import { describe, it, expect } from 'vitest';
import { sdfWorld } from './helpers.js';
import { World, VOXEL } from '../src/world/World.js';
import { generateWorld } from '../src/world/generate.js';
import { fillWater, SEA } from '../src/world/hydrology.js';
import { FluidSim } from '../src/world/FluidSim.js';
import { FluidCore, TILE } from '../src/world/fluidCore.js';

describe('water at generation', () => {
  it('floods the lowland but not a cave sealed off from it', () => {
    // Ground at 15 m (below sea level), with a sealed cave 3 m down.
    const ground = 15 / VOXEL;
    const cave = (x, y, z) => Math.hypot(x - 24, y - (ground - 6), z - 24) - 3;
    const w = sdfWorld(3, 16, (x, y, z) => Math.min(ground - y, cave(x, y, z)));
    fillWater(w, null);
    const sim = new FluidSim(w);
    expect(sim.vol(10, ground + 1, 10)).toBeGreaterThan(0);
    expect(sim.vol(24, ground - 6, 24)).toBe(0);
  });

  it('makes a lake and a river that falls all the way to the sea, and both lake and sea are sources', () => {
    const w = new World(8, 4, 8);
    const { water } = generateWorld(w, 1337);
    expect(water).toBeTruthy();
    const { bed, lake } = water;
    for (let i = 1; i < bed.length; i++) expect(bed[i]).toBeLessThanOrEqual(bed[i - 1] + 1e-6);
    expect(bed[bed.length - 1]).toBeLessThan(SEA);
    const sim = new FluidSim(w);
    const core = new FluidCore(w, sim);
    core.rebuild(true);
    const lt = Math.floor(lake.x / VOXEL / TILE) + core.tx * Math.floor(lake.z / VOXEL / TILE);
    expect(core.core[lt]).toBe(1);
    // Some core well away from the lake: the sea.
    let far = 0;
    for (let t = 0; t < core.tx * core.tz; t++) {
      if (!core.core[t]) continue;
      const tx = t % core.tx, tz = (t - tx) / core.tx;
      if (Math.hypot((tx + 0.5) * TILE * VOXEL - lake.x, (tz + 0.5) * TILE * VOXEL - lake.z) > 20) far++;
    }
    expect(far).toBeGreaterThan(0);
  }, 60000);
});
