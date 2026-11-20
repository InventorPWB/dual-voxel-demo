import { describe, it, expect } from 'vitest';
import { VOXEL } from '../src/world/World.js';
import { MAT } from '../src/world/materials.js';
import { placeShape } from '../src/world/edits.js';
import { SHAPE, placement } from '../src/world/shapes.js';
import { flatWorld, sdfWorld, meshAll, triangles, centroid, faceNormal, interiorOpenEdges, openEdges, holes, parts, GROUND } from './helpers.js';

const sphere = (cx, cy, cz, r) => (x, y, z) => r - Math.hypot(x - cx, y - cy, z - cz);

const G = GROUND * VOXEL; // ground height in metres

describe('mesher', () => {
  it('meshes a smooth sphere as a closed surface', () => {
    const w = sdfWorld(1, 32, sphere(16, 16, 16, 7.3), MAT.STONE);
    const meshes = meshAll(w);
    expect(meshes[0].triangles).toBeGreaterThan(500);
    expect(interiorOpenEdges(w, meshes)).toEqual([]);
  });

  it('produces matching seams across chunk borders', () => {
    const w = sdfWorld(2, 16, sphere(16, 16.3, 15.6, 9.2), MAT.DIRT);
    // Shapes straddling the x = 16 border too.
    placeShape(w, placement(SHAPE.block, [15, 22, 15]), MAT.BRICK);
    placeShape(w, placement(SHAPE.slope, [15, 8, 4], 1), MAT.PLANKS);
    expect(interiorOpenEdges(w)).toEqual([]);
  });

  it('meshes a 1 m block to its exact footprint, faces on the grid planes', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.block, [10, GROUND, 10]), MAT.BRICK);
    const above = triangles(w);
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const t of above) for (let k = 0; k < 9; k += 3) {
      if (t[k + 1] < G + 0.01) continue;
      for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], t[k + a]); mx[a] = Math.max(mx[a], t[k + a]); }
    }
    for (const a of [0, 2]) { expect(mn[a]).toBeCloseTo(5, 1.7); expect(mx[a]).toBeCloseTo(6, 1.7); }
    expect(mx[1]).toBeCloseTo(G + 1, 1.7);
  });

  it('joins neighbouring blocks into one flat top, and meets level ground in a crisp line', () => {
    const w = flatWorld();
    for (let x = 8; x <= 14; x += 2) placeShape(w, placement(SHAPE.block, [x, GROUND, 10]), MAT.STONE_BRICK);
    for (const t of triangles(w)) {
      const [cx, cy, cz] = centroid(t);
      // Top of the row (metres x 4..8, z 5..6): flat at G + 1, no seams between blocks.
      if (cx > 4.1 && cx < 7.9 && cz > 5.1 && cz < 5.9 && cy > G + 0.5) for (let k = 1; k < 9; k += 3) expect(t[k]).toBeCloseTo(G + 1, 2);
      // Ground right beside the row stays on the ground plane: no skirt or fillet.
      if (cx > 4.1 && cx < 7.9 && ((cz > 4.55 && cz < 4.95) || (cz > 6.05 && cz < 6.45))) for (let k = 1; k < 9; k += 3) expect(t[k]).toBeCloseTo(G, 2);
    }
  });

  it('meshes a slope as a 45° face', () => {
    const w = flatWorld();
    // A 3-wide run, measured on the middle one.
    for (let x = 8; x <= 12; x += 2) placeShape(w, placement(SHAPE.slope, [x, GROUND, 10]), MAT.PLANKS);
    let sum = [0, 0, 0], area = 0;
    for (const t of triangles(w)) {
      const [cx, cy, cz] = centroid(t);
      // The face itself (a lone slope's sharp top edge rounds off a little near z 5.75).
      if (cx < 5.05 || cx > 5.95 || cz < 5.1 || cz > 5.6 || cy < G + 0.05) continue;
      const n = faceNormal(t);
      if (!n || n[1] < 0.3) continue;
      sum = sum.map((v, i) => v + n[i]); area++;
    }
    expect(area).toBeGreaterThanOrEqual(4);
    const l = Math.hypot(...sum);
    const tilt = (Math.acos(sum[1] / l) * 180) / Math.PI;
    expect(Math.abs(tilt - 45)).toBeLessThan(1);
    expect(sum[2] / l).toBeLessThan(-0.6); // faces back toward the player (−z), rising away
  });

  it('meshes stairs with treads on the 0.5 m grid planes', () => {
    const w = flatWorld();
    for (let x = 8; x <= 12; x += 2) placeShape(w, placement(SHAPE.stairs, [x, GROUND, 10]), MAT.STONE_BRICK);
    const treads = new Set();
    for (const m of parts(meshAll(w)).pieces)
      for (let i = 0; i < m.position.length; i += 9) {
        const t = Array.from(m.position.subarray(i, i + 9));
        const [cx, cy, cz] = centroid(t);
        const n = faceNormal(t);
        if (!n || n[1] < 0.99 || cx < 5.05 || cx > 5.95 || cz < 5.05 || cz > 5.95) continue;
        treads.add(cy.toFixed(2));
      }
    expect([...treads].sort()).toEqual([(G + 0.5).toFixed(2), (G + 1).toFixed(2)]);
  });

  it('joins slopes stacked into a roof into one plane', () => {
    const w = sdfWorld(1, 32, () => -1);
    for (let k = 0; k < 3; k++) for (let x = 4; x <= 8; x += 2) placeShape(w, placement(SHAPE.slope, [x, 6 + 2 * k, 6 + 2 * k]), MAT.BRICK);
    let worst = 0, n = 0;
    for (const m of parts(meshAll(w)).pieces)
      for (let i = 0; i < m.position.length; i += 3) {
        const x = m.position[i], y = m.position[i + 1], z = m.position[i + 2];
        // Upward faces over the middle column: all on the plane y = z (metres).
        if (x > 2.6 && x < 4.4 && m.normal[i + 1] > 0.6 && m.normal[i + 2] < -0.6) { worst = Math.max(worst, Math.abs(y - z)); n++; }
      }
    expect(n).toBeGreaterThan(10);
    expect(worst).toBeLessThan(1e-4);
  });

  it('keeps pieces exact where they meet in any combination', () => {
    // Slopes at right angles (a hip), stairs against a slope, a slab on a wedge: the
    // cases a single smooth surface can't resolve. Every vertex of cube and wedge
    // pieces sits on a voxel grid point, and there are no holes.
    const w = sdfWorld(2, 16, () => -1);
    placeShape(w, placement(SHAPE.slope, [10, 10, 10], 0), MAT.BRICK);
    placeShape(w, placement(SHAPE.slope, [12, 10, 10], 1), MAT.BRICK);
    placeShape(w, placement(SHAPE.slope, [12, 10, 12], 2), MAT.BRICK);
    placeShape(w, placement(SHAPE.stairs, [10, 10, 12], 3), MAT.COBBLE);
    placeShape(w, placement(SHAPE.slab, [10, 12, 10]), MAT.PLANKS);
    placeShape(w, placement(SHAPE.slope, [16, 12, 16], 1, true), MAT.BRICK);
    const { pieces } = parts(meshAll(w));
    for (const m of pieces) for (let i = 0; i < m.position.length; i++) expect(Number.isInteger(Math.round(m.position[i] / VOXEL * 1e4) / 1e4)).toBe(true);
    expect(holes(pieces, w)).toEqual([]);
  });

  it('hides faces between neighbouring pieces', () => {
    const w = sdfWorld(1, 32, () => -1);
    placeShape(w, placement(SHAPE.block, [10, 10, 10]), MAT.BRICK);
    placeShape(w, placement(SHAPE.block, [12, 10, 10]), MAT.BRICK);
    const { pieces } = parts(meshAll(w));
    // Two 1 m blocks side by side: a 2 × 1 × 1 m box, 10 m² of surface; no faces inside.
    let area = 0;
    for (const m of pieces) for (let i = 0; i < m.position.length; i += 9) {
      const t = Array.from(m.position.subarray(i, i + 9));
      const u = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], v = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    expect(area).toBeCloseTo(10, 4);
  });

  it('gives crisp shapes outward normals', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.block, [10, GROUND + 4, 10]), MAT.PLANKS); // floating, so all six sides show
    const c = [5.5, G + 2.5, 5.5];
    let checked = 0;
    const meshes = meshAll(w);
    for (const m of meshes) {
      const P = m.position, Nm = m.normal;
      for (let i = 0; i < P.length; i += 3) {
        const d = [P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]];
        if (Math.max(...d.map(Math.abs)) > 0.6) continue;
        expect(d[0] * Nm[i] + d[1] * Nm[i + 1] + d[2] * Nm[i + 2]).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
