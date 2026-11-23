import { describe, it, expect } from 'vitest';
import { World, VOXEL } from '../src/world/World.js';
import { MAT, CRISP } from '../src/world/materials.js';
import { generateWorld } from '../src/world/generate.js';
import { fillFromSDF } from '../src/world/csg.js';
import { placeShape } from '../src/world/edits.js';
import { SHAPE, placement } from '../src/world/shapes.js';
import { meshChunk } from '../src/mesh/dualContour.js';
import { meshAll } from './helpers.js';

const unpack = (b) => [b & 255, (b >> 8) & 255, (b >> 16) & 255];

describe('generated terrain', () => {
  it('keeps the grass skin over slopes and overhangs: no dirt showing through it', () => {
    // Tall enough for the mountain's overhangs (they start at 30 m).
    const w = new World(4, 7, 4, 16);
    generateWorld(w, 1337);
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]];
    let exposed = 0, dirt = 0;
    for (let z = 1; z < w.sz - 1; z++)
      for (let y = 1; y < w.sy - 1; y++)
        for (let x = 1; x < w.sx - 1; x++) {
          const m = w.getMat(x, y, z);
          if (!m || !dirs.some(([a, b, c]) => !w.isSolid(x + a, y + b, z + c))) continue;
          exposed++;
          if (m === MAT.DIRT) dirt++;
        }
    expect(exposed).toBeGreaterThan(2000);
    // (A stray voxel on an overhang's edge may show its dirt layer; it was hundreds.)
    expect(dirt).toBeLessThanOrEqual(5);
  });
});

describe('texture blending', () => {
  // Ground at voxel y = 12: grass skin over dirt, with a patch of stone on top.
  function layered() {
    const w = new World(2, 2, 2, 16);
    fillFromSDF(w, (x, y) => 12 - y, (x, y, z, d) => (d < 1.2 ? (x > 20 ? MAT.STONE : MAT.GRASS) : MAT.DIRT));
    return w;
  }

  it('gives natural terrain triangles three vertex materials, and none to pieces', () => {
    const w = layered();
    placeShape(w, placement(SHAPE.block, [10, 12, 10]), MAT.BRICK);
    let blended = 0, mixed = 0, pieceBlend = 0;
    for (const m of meshAll(w))
      for (const g of m.groups) {
        for (let i = g.start; i < g.start + g.terrain; i++) {
          const b = m.blend[i];
          expect(b).toBeGreaterThan(0);
          const [a, c, d] = unpack(b);
          for (const id of [a, c, d]) expect([MAT.GRASS, MAT.DIRT, MAT.STONE]).toContain(id);
          // All three corners of a triangle carry the same triple.
          if (i % 3 === 0) { expect(m.blend[i + 1]).toBe(b); expect(m.blend[i + 2]).toBe(b); blended++; if (a !== c || c !== d) mixed++; }
        }
        for (let i = g.start + g.terrain; i < g.start + g.count; i++) if (m.blend[i] !== 0) pieceBlend++;
      }
    expect(blended).toBeGreaterThan(100);
    expect(mixed).toBeGreaterThan(0); // the grass/stone border blends
    expect(pieceBlend).toBe(0);
  });

  it('votes a cell\'s material from its crossings: one odd voxel in the grass does not show through', () => {
    const w = layered();
    // A single dirt voxel in the grass skin, sides exposed on a rise.
    w.setMat(8, 11, 8, MAT.DIRT);
    for (const m of meshAll(w))
      for (const g of m.groups)
        for (let i = g.start; i < g.start + g.terrain; i += 3) {
          const [a, b, c] = unpack(m.blend[i]);
          const x = m.position[i * 3], z = m.position[i * 3 + 2];
          if (x > 3.5 && x < 4.5 && z > 3.5 && z < 4.5 && m.position[i * 3 + 1] > 5.5) expect([a, b, c]).toEqual([MAT.GRASS, MAT.GRASS, MAT.GRASS]);
        }
  });

  it('does not blend crafted terrain', () => {
    const w = new World(1, 1, 1, 16);
    fillFromSDF(w, (x, y) => 8 - y, () => MAT.PLANKS);
    const m = meshChunk(w.buildPadded(0, 0, 0), CRISP, VOXEL);
    expect(m.triangles).toBeGreaterThan(0);
    expect(Array.from(m.blend).every((b) => b === 0)).toBe(true);
  });
});
