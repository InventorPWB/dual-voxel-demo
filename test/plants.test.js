import { describe, it, expect } from 'vitest';
import { World, VOXEL } from '../src/world/World.js';
import { MAT, CRISP, PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT } from '../src/world/materials.js';
import { PLANT } from '../src/world/plants.js';
import { placeShape, sculptSphere, removeShape } from '../src/world/edits.js';
import { SHAPE, placement } from '../src/world/shapes.js';
import { growGrass, growTree } from '../src/world/trees.js';
import { meshChunk } from '../src/mesh/dualContour.js';
import { meshFoliage } from '../src/mesh/foliage.js';
import { flatWorld, sdfWorld, GROUND } from './helpers.js';

const meshFoliageAt = (w, cx, cy, cz) => meshFoliage(w.buildPadded(cx, cy, cz), VOXEL);

describe('plant layer', () => {
  it('grows grass on grass ground, in the empty voxel above it', () => {
    const w = flatWorld();
    growGrass(w);
    let n = 0;
    for (let z = 0; z < w.sz; z++) for (let x = 0; x < w.sx; x++) if (w.getPlant(x, GROUND, z)) n++;
    expect(n).toBeGreaterThan(w.sx * w.sz * 0.5);
    for (let y = 0; y < w.sy; y++) if (y !== GROUND) expect(w.getPlant(5, y, 5)).toBe(0);
  });

  it('grows no grass on stone', () => {
    const w = sdfWorld(2, 16, (x, y) => GROUND - y, MAT.STONE);
    expect(growGrass(w)).toBe(0);
  });

  it('a piece placed over grass replaces it; grass on a piece with a rounded top goes', () => {
    const w = flatWorld();
    growGrass(w);
    for (let z = 9; z <= 12; z++) for (let x = 9; x <= 12; x++) w.setPlant(x, GROUND, z, PLANT.GRASS);
    placeShape(w, placement(SHAPE.block, [10, GROUND, 10]), MAT.BRICK);
    expect(w.getPlant(10, GROUND, 10)).toBe(0);
    expect(w.getPlant(9, GROUND, 9)).toBe(PLANT.GRASS);
    // Grass on top of a flat block stays; on top of a sphere it can't stand.
    w.setPlant(10, GROUND + 2, 10, PLANT.GRASS);
    placeShape(w, placement(SHAPE.block, [10, GROUND + 2, 12]), MAT.BRICK);
    expect(w.getPlant(10, GROUND + 2, 10)).toBe(PLANT.GRASS);
    removeShape(w, placement(SHAPE.block, [10, GROUND, 10]));
    placeShape(w, placement(SHAPE.sphere, [10, GROUND, 10]), MAT.BRICK);
    expect(w.getPlant(10, GROUND + 2, 10)).toBe(0);
  });

  it('digging out the ground under grass removes it', () => {
    const w = flatWorld();
    w.setPlant(10, GROUND, 10, PLANT.GRASS);
    w.setPlant(20, GROUND, 20, PLANT.GRASS);
    sculptSphere(w, { x: 10.5, y: GROUND - 1, z: 10.5 }, 3, 'sub');
    expect(w.getPlant(10, GROUND, 10)).toBe(0);
    expect(w.getPlant(20, GROUND, 20)).toBe(PLANT.GRASS);
  });

  it('raising ground over grass clears it', () => {
    const w = flatWorld();
    w.setPlant(10, GROUND, 10, PLANT.GRASS);
    sculptSphere(w, { x: 10.5, y: GROUND, z: 10.5 }, 3, 'add', MAT.DIRT);
    expect(w.isSolid(10, GROUND, 10)).toBe(true);
    expect(w.getPlant(10, GROUND, 10)).toBe(0);
  });

  it('plants are never solid and never stored in solid voxels', () => {
    const w = flatWorld();
    w.setPlant(5, GROUND - 1, 5, PLANT.GRASS);
    expect(w.getPlant(5, GROUND - 1, 5)).toBe(0);
    w.setPlant(5, GROUND, 5, PLANT.LEAVES);
    expect(w.isSolid(5, GROUND, 5)).toBe(false);
  });

  it('stands grass on the smooth surface, at the exact ground height', () => {
    // Ground at a fractional height: surface at voxel y = GROUND + 0.3.
    const w = sdfWorld(2, 16, (x, y) => GROUND + 0.3 - y);
    w.setPlant(10, GROUND, 10, PLANT.GRASS);
    const f = meshFoliageAt(w, 0, 0, 0);
    expect(f.triangles).toBeGreaterThan(0);
    let minY = Infinity;
    for (let i = 1; i < f.position.length; i += 3) minY = Math.min(minY, f.position[i]);
    expect(minY).toBeCloseTo((GROUND + 0.3) * VOXEL - 0.04, 1);
  });

  it('meshes foliage the same after an unrelated edit nearby', () => {
    const w = flatWorld();
    growGrass(w);
    const before = meshFoliageAt(w, 0, 0, 0);
    placeShape(w, placement(SHAPE.block, [2, GROUND, 2]), MAT.PLANKS);
    w.setPlant(2, GROUND + 2, 2, 0);
    const after = meshFoliageAt(w, 0, 0, 0);
    // Same tufts everywhere except the four columns under the block.
    const key = (f) => {
      const out = new Set();
      for (let i = 0; i < f.position.length; i += 3) {
        const x = f.position[i] / VOXEL, z = f.position[i + 2] / VOXEL;
        if (x >= 1.5 && x <= 4.5 && z >= 1.5 && z <= 4.5) continue;
        out.add(`${f.position[i].toFixed(4)},${f.position[i + 1].toFixed(4)},${f.position[i + 2].toFixed(4)}`);
      }
      return out;
    };
    expect([...key(after)].sort()).toEqual([...key(before)].sort());
  });

  it('keeps an all-air chunk with leaves for meshing', () => {
    const w = new World(1, 2, 1, 16);
    w.setPlant(8, 24, 8, PLANT.LEAVES);
    expect(w.buildPadded(0, 1, 0).uniform).toBe(false);
    expect(meshFoliageAt(w, 0, 1, 0).triangles).toBeGreaterThan(0);
  });
});

describe('trees', () => {
  it('grows a log trunk out of the ground with leaves only in empty voxels', () => {
    const w = flatWorld(3, 16);
    expect(growTree(w, 24, 24, () => 0.5)).toBe(true);
    // Trunk: log terrain a few metres up the column.
    expect(w.getMat(24, GROUND + 4, 24)).toBe(MAT.LOG);
    expect(w.isTerrain(24, GROUND + 4, 24)).toBe(true);
    let leaves = 0;
    for (let z = 0; z < w.sz; z++)
      for (let y = 0; y < w.sy; y++)
        for (let x = 0; x < w.sx; x++)
          if (w.getPlant(x, y, z) === PLANT.LEAVES) {
            leaves++;
            expect(w.isSolid(x, y, z)).toBe(false);
          }
    expect(leaves).toBeGreaterThan(200);
  });
});

describe('glass', () => {
  const countFacesAt = (m, predicate) => {
    let n = 0;
    for (let i = 0; i < m.position.length; i += 9) {
      const cx = (m.position[i] + m.position[i + 3] + m.position[i + 6]) / 3;
      const cy = (m.position[i + 1] + m.position[i + 4] + m.position[i + 7]) / 3;
      const cz = (m.position[i + 2] + m.position[i + 5] + m.position[i + 8]) / 3;
      if (predicate(cx, cy, cz, m.material[i / 3])) n++;
    }
    return n;
  };

  it('keeps the brick face behind glass, merges glass with glass, and orders the passes', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.block, [2, GROUND, 10]), MAT.BRICK);
    placeShape(w, placement(SHAPE.block, [4, GROUND, 10]), MAT.GLASS);
    placeShape(w, placement(SHAPE.block, [6, GROUND, 10]), MAT.GLASS);
    placeShape(w, placement(SHAPE.block, [8, GROUND, 10]), MAT.STAINED_GLASS);
    const m = meshChunk(w.buildPadded(0, 0, 0), CRISP, VOXEL);
    // Brick's +x face at x = 2 m (against the glass) is drawn.
    expect(countFacesAt(m, (x, y, z, mat) => mat === MAT.BRICK && Math.abs(x - 2) < 1e-4)).toBeGreaterThan(0);
    // Between the two glass blocks (x = 3 m): no faces.
    expect(countFacesAt(m, (x, y, z, mat) => mat === MAT.GLASS && Math.abs(x - 3) < 1e-4)).toBe(0);
    // Passes in order, each holding only its own materials.
    expect(m.groups.map((g) => g.pass)).toEqual([PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT]);
    const g = m.groups;
    for (let v = g[1].start; v < g[1].start + g[1].count; v++) expect(m.material[v]).toBe(MAT.GLASS);
    for (let v = g[2].start; v < g[2].start + g[2].count; v++) expect(m.material[v]).toBe(MAT.STAINED_GLASS);
  });
});
