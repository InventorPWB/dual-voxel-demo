import { describe, it, expect } from 'vitest';
import { flatWorld, slopedWorld, GROUND } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { SpanSim } from '../src/world/SpanSim.js';
import { FluidCore } from '../src/world/fluidCore.js';
import { meshSpans } from '../src/mesh/spanMesh.js';
import { FULL, FLUID, packFluid } from '../src/world/fluids.js';

/** Fill voxels in a box with water (inclusive). */
function pour(w, x0, y0, z0, x1, y1, z1) {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) w.setFluid(x, y, z, packFluid(FLUID.WATER, FULL));
}

/** Stone walls round [x0, x1] × [z0, z1] on flat ground, `h` high. */
function walls(w, x0, z0, x1, z1, h) {
  for (let y = GROUND; y < GROUND + h; y++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) { w.setMat(x, y, z0 - 1, MAT.STONE); w.setMat(x, y, z1 + 1, MAT.STONE); }
    for (let z = z0 - 1; z <= z1 + 1; z++) { w.setMat(x0 - 1, y, z, MAT.STONE); w.setMat(x1 + 1, y, z, MAT.STONE); }
  }
}

const level = (sim, x, z) => {
  const c = sim.getColumn(x, z);
  const s = c.spans.find((s) => s.d > 0.004);
  return s ? s.surface : -1;
};

describe('span simulation', () => {
  it('a released block spreads over a basin, conserves water exactly, and goes to sleep level', () => {
    const w = flatWorld();
    walls(w, 4, 4, 20, 20, 6);
    pour(w, 4, GROUND, 4, 7, GROUND + 3, 7); // 64 voxels
    const sim = new SpanSim(w);
    sim.wakeAll();
    const total = sim.totalVolume();
    expect(total).toBeCloseTo(64 * FULL, 3);
    const n = sim.settle(20000);
    expect(n).toBeLessThan(20000);
    expect(sim.queue.length).toBe(0);
    expect(sim.totalVolume()).toBeCloseTo(total, 3);
    // 64 voxels over 17 × 17 columns: 0.22 voxels deep, the same everywhere
    // (within a few millimetres: differences under MIN_DIFF don't flow).
    for (const [x, z] of [[4, 4], [20, 20], [12, 5], [19, 13]]) expect(Math.abs(level(sim, x, z) - (GROUND + 64 / 289))).toBeLessThan(0.015);
    // And the mirror agrees.
    expect(w.waterSurface(12, GROUND, 12) / 0.5).toBeCloseTo(GROUND + 64 / 289, 2);
  });

  it('runs down a slope as one continuous sheet', () => {
    const w = slopedWorld(0.27);
    const sim = new SpanSim(w);
    // A steady trickle at the top of the slope (x = 28), for a while.
    const wet = [];
    for (let t = 0; t < 200; t++) {
      const y = Math.floor(GROUND + 0.3 + 0.27 * 18) + 1;
      sim.deposit(28, y, 16, 40);
      sim.tick();
      if (t > 150) {
        // Every column from the source down to x = 12 has water in it.
        let n = 0;
        for (let x = 12; x <= 27; x++) if (level(sim, x, 16) > 0) n++;
        wet.push(n);
      }
    }
    expect(Math.min(...wet)).toBe(16);
    // And it's running downhill.
    const s = sim.getColumn(20, 16).spans.find((s) => s.d > 0);
    expect(sim.flowOf(s, [0, 0])[0]).toBeLessThan(-0.1);
  });

  it('keeps a sealed room under water dry, and floods it when a wall is broken', () => {
    const w = flatWorld();
    walls(w, 2, 2, 28, 28, 14);
    // A room of building pieces (stone cubes) 6 × 6 × 4, inside 4 × 4 × 2 open.
    const piece = (x, y, z) => w.setVoxel(x, y, z, MAT.STONE, 1);
    for (let x = 10; x <= 15; x++)
      for (let z = 10; z <= 15; z++)
        for (let y = GROUND; y <= GROUND + 3; y++) {
          const shell = x === 10 || x === 15 || z === 10 || z === 15 || y === GROUND || y === GROUND + 3;
          if (shell) piece(x, y, z);
        }
    // Water outside, 8 deep.
    for (let z = 2; z <= 28; z++)
      for (let x = 2; x <= 28; x++)
        for (let y = GROUND; y < GROUND + 8; y++) {
          const inRoom = x > 10 && x < 15 && z > 10 && z < 15 && y < GROUND + 3;
          if (!inRoom && !w.isSolid(x, y, z)) w.setFluid(x, y, z, packFluid(FLUID.WATER, FULL));
        }
    const sim = new SpanSim(w);
    sim.wakeAll();
    const total = sim.totalVolume();
    sim.settle(4000);
    // The room's inside stays dry; there's water over its roof.
    const room = sim.getColumn(12, 12).spans;
    const inside = room.find((s) => s.ylo === GROUND + 1);
    expect(inside.d).toBe(0);
    expect(room.find((s) => s.ylo === GROUND + 4).d).toBeGreaterThan(3);
    expect(sim.totalVolume()).toBeCloseTo(total, 1);
    // Break the wall: water floods in.
    w.setVoxel(10, GROUND + 1, 12, 0, 0);
    w.markDirtyBox(10, GROUND + 1, 12, 10, GROUND + 1, 12);
    sim.settle(8000);
    expect(sim.getColumn(12, 12).spans.find((s) => s.ylo === GROUND + 1).d).toBeGreaterThan(1.5);
    expect(sim.totalVolume()).toBeCloseTo(total, 0);
  });

  it('holds a source level, and the river it feeds runs on', () => {
    const w = flatWorld(2, 32);
    // A big pool (a source), and a channel out of it down a step.
    walls(w, 2, 2, 40, 40, 8);
    pour(w, 2, GROUND, 2, 40, GROUND + 5, 40);
    const sim = new SpanSim(w);
    const core = new FluidCore(w, sim);
    core.rebuild(true);
    expect(core.coreCount).toBeGreaterThan(0);
    sim.wakeAll();
    sim.settle(200);
    expect(sim.queue.length).toBe(0); // still water sleeps
    // Open the wall (x = 41) into a dry, walled run.
    for (let z = 20; z <= 21; z++) for (let y = GROUND; y < GROUND + 8; y++) w.setMat(41, y, z, 0);
    for (let x = 42; x <= 60; x++) for (let y = GROUND; y < GROUND + 8; y++) { w.setMat(x, y, 19, MAT.STONE); w.setMat(x, y, 22, MAT.STONE); }
    w.markDirtyBox(41, GROUND, 19, 60, GROUND + 8, 22);
    for (let t = 0; t < 400; t++) sim.tick();
    expect(level(sim, 58, 20)).toBeGreaterThan(GROUND + 1);
    expect(level(sim, 20, 20)).toBeCloseTo(GROUND + 6, 1);
  });

  it('puts water back that a block displaces', () => {
    const w = flatWorld();
    walls(w, 4, 4, 12, 12, 6);
    pour(w, 4, GROUND, 4, 12, GROUND + 1, 12);
    const sim = new SpanSim(w);
    sim.wakeAll();
    sim.settle();
    const total = sim.totalVolume();
    w.setMat(8, GROUND, 8, MAT.STONE);
    w.markDirtyBox(8, GROUND, 8, 8, GROUND, 8);
    sim.settle();
    expect(Math.abs(sim.totalVolume() - total)).toBeLessThan(1);
    expect(level(sim, 4, 4)).toBeGreaterThan(GROUND + 2);
  });
});

describe('span mesh', () => {
  function pool() {
    const w = flatWorld();
    walls(w, 4, 4, 12, 12, 6);
    pour(w, 4, GROUND, 4, 12, GROUND + 1, 12);
    const sim = new SpanSim(w);
    return { w, sim };
  }

  it('draws a still pool as one flat sheet at its level, carried over the shore', () => {
    const { sim } = pool();
    const m = meshSpans(sim.snapshot(0, 0, 0), 0.5);
    expect(m.triangles).toBeGreaterThan(0);
    const ys = new Set();
    for (let i = 1; i < m.position.length; i += 3) ys.add(m.position[i].toFixed(4));
    expect(ys.size).toBe(1);
    expect(Number([...ys][0])).toBeCloseTo((GROUND + 2) * 0.5, 2);
    // Normals point up.
    for (let i = 1; i < m.normal.length; i += 3) expect(m.normal[i]).toBeGreaterThan(0.99);
    // The sheet covers the pool's columns (4..12), up to the walls (no skirt over solid wall).
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < m.position.length; i += 3) { minX = Math.min(minX, m.position[i]); maxX = Math.max(maxX, m.position[i]); }
    expect(minX).toBeCloseTo(4 * 0.5);
    expect(maxX).toBeCloseTo(13 * 0.5);
  });

  it('joins neighbouring columns at different levels without gaps', () => {
    const w = slopedWorld(0.27);
    const sim = new SpanSim(w);
    for (let t = 0; t < 120; t++) {
      sim.deposit(28, Math.floor(GROUND + 0.3 + 0.27 * 18) + 1, 16, 40);
      sim.tick();
    }
    const m = meshSpans(sim.snapshot(0, 0, 1), 0.5);
    // Corners shared by squares meet exactly: every position at a given (x, z) on the stream has one height.
    const at = new Map();
    for (let i = 0; i < m.position.length; i += 3) {
      if (m.flow[i + 2] !== 0 || m.depth[i / 3] < 0.004) continue;
      const k = `${m.position[i]},${m.position[i + 2]}`;
      const y = m.position[i + 1];
      if (!at.has(k)) at.set(k, new Set());
      at.get(k).add(y.toFixed(5));
    }
    expect(at.size).toBeGreaterThan(20);
    for (const ys of at.values()) expect(ys.size).toBe(1);
  });

  it('draws a waterfall where water pours over a drop', () => {
    const w = flatWorld(2, 16, 4);
    // A shelf 8 high, x <= 10, with water on it pouring off its edge.
    for (let x = 0; x <= 10; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 12; y++) w.setMat(x, y, z, MAT.STONE);
    const sim = new SpanSim(w);
    let falls = 0;
    for (let t = 0; t < 30; t++) {
      sim.deposit(9, 12, 16, 400);
      sim.tick();
      for (let cy = 0; cy < 2; cy++) {
        const snap = sim.snapshot(0, cy, 1);
        if (snap) falls += snap.falls.length / 6;
      }
    }
    expect(falls).toBeGreaterThan(0);
  });

  it('draws thin running water clear of the ground it runs over', () => {
    const w = slopedWorld(0.27);
    const sim = new SpanSim(w);
    for (let t = 0; t < 120; t++) {
      sim.deposit(28, Math.floor(GROUND + 0.3 + 0.27 * 18) + 1, 16, 40);
      sim.tick();
    }
    const m = meshSpans(sim.snapshot(0, 0, 1), 0.5);
    // Each stream corner at least ~MINVIS over the floors of the columns round it.
    let n = 0;
    for (let i = 0; i < m.position.length; i += 3) {
      if (m.flow[i + 2] !== 0 || m.depth[i / 3] < 0.004) continue;
      const x = m.position[i] / 0.5, z = m.position[i + 2] / 0.5, y = m.position[i + 1] / 0.5;
      if (x < 13 || x > 26 || z !== 16) continue;
      let floor = 0, k = 0;
      for (const [cx, cz] of [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]]) {
        const sp = sim.getColumn(cx, cz).spans.find((s) => s.d > 0.004);
        if (sp) { floor += sp.lo; k++; }
      }
      expect(y - floor / k).toBeGreaterThan(0.1);
      n++;
    }
    expect(n).toBeGreaterThan(5);
  });

  it('fades a lone waterfall out at its sides', () => {
    const w = flatWorld(2, 16, 4);
    for (let x = 0; x <= 10; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 12; y++) w.setMat(x, y, z, MAT.STONE);
    // A one-column trough to the edge, so a single column pours.
    for (let x = 0; x <= 10; x++) for (const z of [15, 17]) w.setMat(x, 12, z, MAT.STONE);
    const sim = new SpanSim(w);
    let m = null;
    for (let t = 0; t < 30; t++) {
      sim.deposit(9, 12, 16, 300);
      sim.tick();
      const snap = sim.snapshot(0, 0, 1);
      if (snap && snap.falls.length) m = meshSpans(snap, 0.5);
    }
    expect(m).not.toBeNull();
    const fall = [];
    for (let v = 0; v < m.depth.length; v++) if (m.flow[v * 3 + 2] === 1) fall.push(m.depth[v]);
    expect(fall.length).toBeGreaterThan(0);
    // Solid in the middle, fading to nothing at its sides (no fall beside it).
    expect(Math.max(...fall)).toBeGreaterThan(0.03);
    expect(Math.min(...fall)).toBe(0);
  });

  it('draws the side of the water against glass, not against an opaque block', () => {
    const make = (mat) => {
      const w = flatWorld();
      walls(w, 4, 4, 12, 12, 6);
      for (let y = GROUND; y < GROUND + 6; y++) for (let z = 4; z <= 12; z++) w.setVoxel(13, y, z, mat, 1);
      pour(w, 4, GROUND, 4, 12, GROUND + 1, 12);
      return new SpanSim(w).snapshot(0, 0, 0);
    };
    expect(make(MAT.GLASS).glass.length).toBeGreaterThan(0);
    expect(make(MAT.STONE).glass.length).toBe(0);
  });
});
