import { describe, it, expect } from 'vitest';
import { World, VOXEL } from '../src/world/World.js';
import { MAT, CRISP, PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT } from '../src/world/materials.js';
import { PLANT, supportsPlant, settlePlants } from '../src/world/plants.js';
import { placeShape, sculptSphere, removeShape, removeSpecks, breakAt } from '../src/world/edits.js';
import { SHAPE, placement } from '../src/world/shapes.js';
import { growGrass, growTree, rng } from '../src/world/trees.js';
import { meshChunk } from '../src/mesh/dualContour.js';
import { meshFoliage } from '../src/mesh/foliage.js';
import { flatWorld, sdfWorld, interiorOpenEdges, meshAll, faceNormal, GROUND } from './helpers.js';

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
    placeShape(w, placement(SHAPE.block, [10, GROUND, 10]), MAT.DIRT);
    expect(w.getPlant(10, GROUND, 10)).toBe(0);
    expect(w.getPlant(9, GROUND, 9)).toBe(PLANT.GRASS);
    // Grass on top of a flat dirt block stays; on top of a sphere it can't stand.
    w.setPlant(10, GROUND + 2, 10, PLANT.GRASS);
    expect(settlePlants(w, [0, 0, 0, w.sx, w.sy, w.sz])).toBe(0);
    removeShape(w, placement(SHAPE.block, [10, GROUND, 10]));
    placeShape(w, placement(SHAPE.sphere, [10, GROUND, 10]), MAT.DIRT);
    expect(w.getPlant(10, GROUND + 2, 10)).toBe(0);
  });

  it('grows grass only on soil: grass and dirt, not stone, sand or brick', () => {
    const w = flatWorld();
    expect(supportsPlant(w, 5, GROUND, 5, PLANT.GRASS)).toBe(true);
    placeShape(w, placement(SHAPE.block, [10, GROUND, 10]), MAT.BRICK);
    expect(supportsPlant(w, 10, GROUND + 2, 10, PLANT.GRASS)).toBe(false);
    const stone = sdfWorld(1, 16, (x, y) => GROUND - y, MAT.STONE);
    expect(supportsPlant(stone, 5, GROUND, 5, PLANT.GRASS)).toBe(false);
    // Painting the ground to stone under grass removes it on the next settle.
    w.setPlant(5, GROUND, 5, PLANT.GRASS);
    w.setMat(5, GROUND - 1, 5, MAT.STONE);
    settlePlants(w, [5, GROUND, 5, 5, GROUND, 5]);
    expect(w.getPlant(5, GROUND, 5)).toBe(0);
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
    // Trunk: smooth Log terrain a couple of metres up the column.
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

  it('draws wood cut open by an edit as end grain, at any angle, and the outside as bark', () => {
    const w = flatWorld(3, 16);
    growTree(w, 24, 24, rng(3));
    const count = () => {
      let log = 0, cut = 0, sideways = 0;
      for (const m of meshAll(w))
        for (let i = 0; i < m.position.length; i += 9) {
          const mat = m.material[i / 3];
          if (mat === MAT.LOG) log++;
          if (mat !== MAT.CUT_LOG) continue;
          cut++;
          const n = faceNormal(Array.from(m.position.subarray(i, i + 9)));
          if (n && Math.abs(n[1]) < 0.5) sideways++;
        }
      return { log, cut, sideways };
    };
    expect(count().cut).toBe(0);
    // Break a metre out of the trunk: the edges it opened above and below are cut.
    breakAt(w, 24, GROUND + 2, 24);
    expect(w.getCut(24, GROUND + 1, 24, 1)).toBe(true);
    expect(w.getCut(24, GROUND + 3, 24, 1)).toBe(true);
    expect(w.getMat(24, GROUND + 1, 24)).toBe(MAT.LOG); // the wood itself is unchanged
    expect(count().cut).toBeGreaterThan(0);
    // Digging into the trunk's side from +x: that cut faces sideways, and is end grain too.
    sculptSphere(w, { x: 26.6, y: GROUND + 6.5, z: 24.5 }, 1.6, 'sub');
    const after = count();
    expect(after.sideways).toBeGreaterThan(0);
    // Most of the wood is untouched bark.
    expect(after.log).toBeGreaterThan(after.cut * 3);
  });

  it('meshes trunks and limbs closed, with no loose bits, at every size', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const w = flatWorld(3, 16);
      growTree(w, 24, 24, rng(seed));
      expect(interiorOpenEdges(w), `seed ${seed}`).toEqual([]);
      // Every log voxel connects to the ground through other log or ground voxels.
      expect(removeSpecks(w, { x0: 0, y0: 1, z0: 0, x1: w.sx - 1, y1: w.sy - 1, z1: w.sz - 1, nx: w.sx, ny: w.sy - 1, nz: w.sz, empty: false, size: w.sx * (w.sy - 1) * w.sz,
        contains: (x, y, z) => x >= 0 && y >= 1 && z >= 0 && x < w.sx && y < w.sy && z < w.sz, index: (x, y, z) => x + w.sx * ((y - 1) + (w.sy - 1) * z) }), `seed ${seed}`).toBe(0);
    }
  });
});

describe('cutout mipmaps', () => {
  it('keep cutout coverage and colour at every level', async () => {
    const { textureArray } = await import('../src/render/textureArray.js');
    const { TEXTURE_NAMES, TEX_SIZE } = await import('../src/render/textures.js');
    const { mips, texture } = textureArray();
    for (const name of ['grass_blades', 'leaves', 'flowers']) {
      const l = TEXTURE_NAMES.indexOf(name);
      const cover = (data, size) => {
        let c = 0, g = 0, rb = 0;
        for (let i = 0; i < size * size; i++) {
          const o = (l * size * size + i) * 4;
          if (data[o + 3] < 128) continue;
          c++; g += data[o + 1]; rb += Math.max(data[o], data[o + 2]);
        }
        return { c: c / (size * size), greener: g > rb };
      };
      const base = cover(texture.image.data, TEX_SIZE);
      for (const m of mips.filter((m) => m.size >= 4)) {
        const at = cover(m.data, m.size);
        expect(Math.abs(at.c - base.c), `${name} ${m.size}`).toBeLessThan(0.12);
        expect(at.greener, `${name} ${m.size}`).toBe(true);
      }
    }
  });
});

describe('piece texturing', () => {
  it('gives piece vertices their place in the whole piece, and the kind of shape', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.pillar, [4, GROUND, 4]), MAT.LOG);
    placeShape(w, placement(SHAPE.small, [8, GROUND, 4]), MAT.GLASS);
    const m = meshChunk(w.buildPadded(0, 0, 0), CRISP, VOXEL);
    const span = { 2: [Infinity, -Infinity], 1: [Infinity, -Infinity] };
    for (let v = 0; v < m.material.length; v++) {
      const kind = m.local[v * 4 + 3];
      if (!kind) continue;
      for (let a = 0; a < 3; a++) {
        span[kind][0] = Math.min(span[kind][0], m.local[v * 4 + a]);
        span[kind][1] = Math.max(span[kind][1], m.local[v * 4 + a]);
      }
    }
    // Both the 1 m pillar (four voxels across) and the small block span 0..1.
    expect(span[2][0]).toBeCloseTo(0, 5);
    expect(span[2][1]).toBeCloseTo(1, 5);
    expect(span[1][0]).toBeCloseTo(0, 5);
    expect(span[1][1]).toBeCloseTo(1, 5);
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
