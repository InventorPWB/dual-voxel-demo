import { describe, it, expect } from 'vitest';
import { flatWorld, slopedWorld, GROUND, triangles } from './helpers.js';
import { MAT } from '../src/world/materials.js';
import { SpanSim } from '../src/world/SpanSim.js';
import { FluidCore } from '../src/world/fluidCore.js';
import { meshSpans, FALLREC } from '../src/mesh/spanMesh.js';
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

  it('runs steadily down a channel, at a realistic pace, without surging', () => {
    const w = slopedWorld(0.1);
    // A channel 4 wide down the slope, draining into a pit at the bottom.
    for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (const z of [13, 18]) if (!w.isSolid(x, y, z)) w.setMat(x, y, z, MAT.STONE);
    for (let x = 0; x <= 5; x++) for (let z = 14; z <= 17; z++) for (let y = 1; y < 28; y++) w.setMat(x, y, z, 0);
    const sim = new SpanSim(w);
    const yTop = Math.floor(GROUND + 0.3 + 0.1 * 18) + 1;
    const depth = [];
    for (let t = 0; t < 700; t++) {
      for (let z = 14; z <= 17; z++) sim.deposit(29, yTop, z, 10);
      sim.tick();
      if (t >= 500) depth.push(sim.getColumn(16, 15).spans.find((s) => s.d > 0).d);
    }
    // Steady: the depth mid-channel holds to a fraction of a millimetre.
    expect(Math.max(...depth) - Math.min(...depth)).toBeLessThan(0.002);
    // A few centimetres deep, running at about a metre a second.
    const s = sim.getColumn(16, 15).spans.find((s) => s.d > 0);
    expect(s.d).toBeGreaterThan(0.06);
    const speed = Math.hypot(...sim.flowOf(s, [0, 0]));
    expect(speed).toBeGreaterThan(0.3);
    expect(speed).toBeLessThan(3);
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
    for (let t = 0; t < 240; t++) {
      sim.deposit(28, Math.floor(GROUND + 0.3 + 0.27 * 18) + 1, 16, 40);
      sim.tick();
    }
    const m = meshSpans(sim.snapshot(0, 0, 1), 0.5);
    // Squares meet exactly: every position at a given (x, z) on the stream has
    // one height (corners, and the points the squares are split at).
    const at = new Map();
    for (let i = 0; i < m.position.length; i += 3) {
      if (m.flow[i + 2] !== 0 || m.depth[i / 3] < 0.01) continue;
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
        if (snap) falls += snap.falls.length / FALLREC;
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
      if (x < 13 || x > 26 || z !== 16 || x % 1) continue;
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

  it('keeps a stream down a steep slope clear of the ground under it', () => {
    const w = slopedWorld(0.8);
    const sim = new SpanSim(w);
    for (let t = 0; t < 300; t++) {
      sim.deposit(26, Math.floor(GROUND + 0.3 + 0.8 * 16) + 1, 16, 30);
      sim.tick();
    }
    // The ground's triangles facing up, by column.
    const bins = new Map();
    for (const t of triangles(w)) {
      const ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
      if (ny <= 0) continue;
      const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / 0.5), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / 0.5);
      const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / 0.5), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / 0.5);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) bins.set(`${x},${z}`, [...(bins.get(`${x},${z}`) || []), t]);
    }
    const groundAt = (x, z, y) => {
      let best = -Infinity;
      for (const t of bins.get(`${Math.floor(x / 0.5)},${Math.floor(z / 0.5)}`) || []) {
        const d = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
        const l0 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d;
        const l1 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d;
        if (l0 < -1e-6 || l1 < -1e-6 || 1 - l0 - l1 < -1e-6) continue;
        const ty = l0 * t[1] + l1 * t[4] + (1 - l0 - l1) * t[7];
        if (ty < y + 0.5 && ty > best) best = ty;
      }
      return best;
    };
    // Points across the stream's sheet, where it runs over wet columns well inside the stream.
    let n = 0;
    for (const [cx, cy, cz] of [[0, 0, 1], [0, 1, 1]]) {
      const snap = sim.snapshot(cx, cy, cz);
      if (!snap) continue;
      const m = meshSpans(snap, 0.5);
      const p = m.position;
      for (let v = 0; v < p.length / 3; v += 3) {
        if (m.flow[v * 3 + 2] !== 0) continue;
        for (const [a, b] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2]]) {
          const c = 1 - a - b;
          const x = a * p[v * 3] + b * p[v * 3 + 3] + c * p[v * 3 + 6];
          const y = a * p[v * 3 + 1] + b * p[v * 3 + 4] + c * p[v * 3 + 7];
          const z = a * p[v * 3 + 2] + b * p[v * 3 + 5] + c * p[v * 3 + 8];
          const vx = Math.floor(x / 0.5), vz = Math.floor(z / 0.5);
          let inside = true;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!sim.getColumn(vx + dx, vz + dz)?.spans.some((s) => s.d > 0.004)) inside = false;
          if (!inside) continue;
          const g = groundAt(x, z, y);
          if (g === -Infinity) continue;
          expect(y - g).toBeGreaterThan(0.005);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('bends sloping water smoothly, never past its corners, and leaves level water in whole squares', () => {
    const w = slopedWorld(0.27);
    const sim = new SpanSim(w);
    for (let t = 0; t < 240; t++) {
      sim.deposit(28, Math.floor(GROUND + 0.3 + 0.27 * 18) + 1, 16, 40);
      sim.tick();
    }
    const m = meshSpans(sim.snapshot(0, 0, 1), 0.5);
    const at = new Map();
    for (let i = 0; i < m.position.length; i += 3) if (m.flow[i + 2] === 0) at.set(`${(m.position[i] / 0.5).toFixed(2)},${(m.position[i + 2] / 0.5).toFixed(2)}`, m.position[i + 1]);
    // Points halfway along a square's edge lie between the corners at its ends.
    let split = 0;
    for (const [k, y] of at) {
      const [x, z] = k.split(',').map(Number);
      if (x % 1 && z % 1) continue;
      const ends = x % 1 ? [[x - 0.5, z], [x + 0.5, z]] : z % 1 ? [[x, z - 0.5], [x, z + 0.5]] : null;
      if (!ends || ends.some(([ex, ez]) => !at.has(`${ex.toFixed(2)},${ez.toFixed(2)}`))) continue;
      const [ya, yb] = ends.map(([ex, ez]) => at.get(`${ex.toFixed(2)},${ez.toFixed(2)}`));
      expect(y).toBeGreaterThanOrEqual(Math.min(ya, yb) - 1e-4);
      expect(y).toBeLessThanOrEqual(Math.max(ya, yb) + 1e-4);
      split++;
    }
    expect(split).toBeGreaterThan(10);
    // A still pool: whole squares only.
    const pw = flatWorld();
    walls(pw, 4, 4, 12, 12, 6);
    pour(pw, 4, GROUND, 4, 12, GROUND + 1, 12);
    const pm = meshSpans(new SpanSim(pw).snapshot(0, 0, 0), 0.5);
    for (let i = 0; i < pm.position.length; i += 3) {
      expect((pm.position[i] / 0.5) % 1).toBe(0);
      expect((pm.position[i + 2] / 0.5) % 1).toBe(0);
    }
  });

  it('joins neighbouring waterfalls into one sheet, thrown clear of the lip', () => {
    const w = flatWorld(2, 16, 4);
    // A shelf 8 high, x <= 10, with water across it pouring off its edge.
    for (let x = 0; x <= 10; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 12; y++) w.setMat(x, y, z, MAT.STONE);
    const sim = new SpanSim(w);
    let m = null;
    for (let t = 0; t < 40; t++) {
      for (let z = 12; z <= 20; z++) sim.deposit(8, 12, z, 60);
      sim.tick();
      const snap = sim.snapshot(0, 0, 1);
      if (snap && snap.falls.length / FALLREC >= 3) m = meshSpans(snap, 0.5);
    }
    expect(m).not.toBeNull();
    // Every point of the falls has one solidity (where two falls meet, they agree).
    const at = new Map();
    let below = 0;
    for (let v = 0; v < m.depth.length; v++) {
      const k3 = m.flow[v * 3 + 2];
      if (k3 < 1 || k3 > 2) continue;
      const k = `${m.position[v * 3].toFixed(4)},${m.position[v * 3 + 2].toFixed(4)},${m.position[v * 3 + 1].toFixed(4)}`;
      if (!at.has(k)) at.set(k, new Set());
      at.get(k).add(m.depth[v].toFixed(4));
      // Once it's falling, it's out past the lip's edge (x = 11) by half a voxel or more.
      if (k3 > 1.1) {
        expect(m.position[v * 3] / 0.5).toBeGreaterThanOrEqual(11.5 - 1e-4);
        below++;
      }
    }
    expect(below).toBeGreaterThan(0);
    for (const ds of at.values()) expect(ds.size).toBe(1);
  });
});
