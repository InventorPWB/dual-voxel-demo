import { describe, it, expect } from 'vitest';
import { World, VOXEL } from '../src/world/World.js';
import { MAT, CRISP, PASS_OPAQUE, PASS_CUTOUT, PASS_TRANSLUCENT } from '../src/world/materials.js';
import { PLANT, DIRS26, plantDef, isWood, isSolidWood, woodParent, woodRadius, woodCut, woodCutSide, supportsPlant, settlePlants } from '../src/world/plants.js';
import { chop, severed, remove } from '../src/world/chop.js';
import { TEXTURE_NAMES } from '../src/render/textures.js';
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

  it('scatters cards through the inside of a crown when asked, only well inside it', () => {
    const w = new World(1, 2, 1, 16);
    for (let z = 2; z < 14; z++) for (let y = 18; y < 30; y++) for (let x = 2; x < 14; x++) w.setPlant(x, y, z, PLANT.LEAVES);
    const cardsIn = (f, lo, hi) => {
      let n = 0;
      for (let v = 0; v < f.triangles * 3; v += 6) {
        if (!f.axis[v * 3] && !f.axis[v * 3 + 1] && !f.axis[v * 3 + 2]) continue;
        const c = [0, 1, 2].map((k) => f.center[v * 3 + k] / VOXEL);
        if (c.every((x, k) => x > lo[k] && x < hi[k])) n++;
      }
      return n;
    };
    const lo = [5, 21, 5], hi = [11, 27, 11]; // well inside the 12³ block
    const without = meshFoliage(w.buildPadded(0, 1, 0), VOXEL, {});
    const withIn = meshFoliage(w.buildPadded(0, 1, 0), VOXEL, { interiorCards: true });
    expect(cardsIn(without, lo, hi)).toBe(0);
    expect(cardsIn(withIn, lo, hi)).toBeGreaterThan(5);
  });

  // Leaf cards of a mesh: { c: centre, n: facing, u, v: half-axes } (metres), from each card's first triangle.
  const leafCards = (f) => {
    const out = [];
    const at = (v) => [0, 1, 2].map((k) => f.position[v * 3 + k]);
    for (let v = 0; v < f.triangles * 3; v += 6) {
      if (!f.axis[v * 3] && !f.axis[v * 3 + 1] && !f.axis[v * 3 + 2]) continue;
      const a = at(v), b = at(v + 1), d = at(v + 5);
      out.push({
        c: [0, 1, 2].map((k) => f.center[v * 3 + k]), n: [0, 1, 2].map((k) => f.axis[v * 3 + k]),
        u: b.map((x, k) => (x - a[k]) / 2), v: d.map((x, k) => (x - a[k]) / 2),
      });
    }
    return out;
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it('fills a placed 1 m block of leaves with angled cards, roughly within it', () => {
    const w = new World(1, 2, 1, 16);
    for (let z = 8; z < 10; z++) for (let y = 20; y < 22; y++) for (let x = 8; x < 10; x++) w.setPlant(x, y, z, PLANT.LEAVES);
    const cards = leafCards(meshFoliage(w.buildPadded(0, 1, 0), VOXEL));
    // 2×2×2 voxels, all open: two cards each.
    expect(cards.length).toBe(16);
    const facings = new Set();
    for (const { c, n } of cards) {
      // Centred within the block, give or take a third of a voxel.
      for (const [k, lo] of [[0, 8], [1, 20], [2, 8]]) {
        expect(c[k] / VOXEL).toBeGreaterThan(lo - 0.35);
        expect(c[k] / VOXEL).toBeLessThan(lo + 2.35);
      }
      facings.add(n.map((x) => Math.round(x * 2)).join());
    }
    // Turned all sorts of ways, not lined up with the grid.
    expect(facings.size).toBeGreaterThan(8);
  });

  it('covers a flat wall of leaves mostly, with a few chinks of light', () => {
    const w = new World(1, 2, 1, 16);
    // A 3 m × 2 m wall, 1 m thick.
    for (let z = 8; z < 10; z++) for (let y = 18; y < 22; y++) for (let x = 2; x < 8; x++) w.setPlant(x, y, z, PLANT.LEAVES);
    const cards = leafCards(meshFoliage(w.buildPadded(0, 1, 0), VOXEL));
    // Look straight through it along z, away from its rim: is the ray
    // stopped by the solid middle (the inner 80%) of some card?
    let hit = 0, all = 0;
    for (let y = 18.5; y < 21.6; y += 0.1)
      for (let x = 2.5; x < 7.6; x += 0.1) {
        all++;
        const p = [x * VOXEL, y * VOXEL, 0];
        if (cards.some(({ c, n, u, v }) => {
          if (Math.abs(n[2]) < 0.2) return false; // nearly edge-on: dropped
          const t = (dot(c, n) - dot(p, n)) / n[2];
          const d = [p[0] - c[0], p[1] - c[1], t - c[2]];
          return Math.abs(dot(d, u) / dot(u, u)) < 0.8 && Math.abs(dot(d, v) / dot(v, v)) < 0.8;
        })) hit++;
      }
    expect(hit / all).toBeGreaterThan(0.9);
    expect(hit / all).toBeLessThan(1);
  });

  it('keeps an all-air chunk with leaves for meshing', () => {
    const w = new World(1, 2, 1, 16);
    w.setPlant(8, 24, 8, PLANT.LEAVES);
    expect(w.buildPadded(0, 1, 0).uniform).toBe(false);
    expect(meshFoliageAt(w, 0, 1, 0).triangles).toBeGreaterThan(0);
  });
});

describe('trees', () => {
  /** Every plant in the world: { wood: [[x, y, z, id]], leaves: [[x, y, z]] }. */
  const plants = (w) => {
    const wood = [], leaves = [];
    for (let z = 0; z < w.sz; z++)
      for (let y = 0; y < w.sy; y++)
        for (let x = 0; x < w.sx; x++) {
          const p = w.getPlant(x, y, z);
          if (isWood(p)) wood.push([x, y, z, p]);
          if (p === PLANT.LEAVES) leaves.push([x, y, z]);
        }
    return { wood, leaves };
  };
  /** Follow wood voxel v's parents down: true if they end in solid ground. */
  const grounded = (w, v) => {
    for (let steps = 0; steps < 300; steps++) {
      if (w.isSolid(...v)) return true;
      const o = DIRS26[woodParent(w.getPlant(...v))];
      if (!o || !isWood(w.getPlant(...v))) return false;
      v = [v[0] + o[0], v[1] + o[1], v[2] + o[2]];
    }
    return false;
  };
  const meshTrees = (w) => {
    const out = [];
    for (let cz = 0; cz < w.nz; cz++)
      for (let cy = 0; cy < w.ny; cy++)
        for (let cx = 0; cx < w.nx; cx++) {
          const p = w.buildPadded(cx, cy, cz);
          if (!p.uniform) out.push(meshFoliage(p, VOXEL));
        }
    return out;
  };
  /** Trunk foot of the tree grown at column (x, z): the wood growing out of the ground nearest it. */
  const foot = (w, x, z) => {
    let best = null;
    for (let vz = z - 3; vz <= z + 3; vz++)
      for (let vx = x - 3; vx <= x + 3; vx++)
        for (let y = 1; y < w.sy; y++) {
          const o = DIRS26[woodParent(w.getPlant(vx, y, vz))];
          if (!isWood(w.getPlant(vx, y, vz)) || !o || !w.isSolid(vx + o[0], y + o[1], vz + o[2])) continue;
          if (!best || Math.hypot(vx - x, vz - z) < Math.hypot(best[0] - x, best[2] - z)) best = [vx, y, vz];
        }
    return best;
  };

  it('grows a tree of wood out of the ground, trunk to twig, with leaves only in empty voxels', () => {
    const w = flatWorld(4, 16);
    expect(growTree(w, 32, 32, rng(2))).toBe(true);
    const { wood, leaves } = plants(w);
    // All of it is plants: no terrain wood.
    for (let y = GROUND; y < w.sy; y++) expect(w.isSolid(32, y, 32)).toBe(false);
    // The trunk's foot grows from the ground under it, thick.
    const f = foot(w, 32, 32);
    expect(f[1]).toBe(GROUND);
    expect(DIRS26[woodParent(w.getPlant(...f))][1]).toBe(-1);
    expect(woodRadius(w.getPlant(...f))).toBeGreaterThan(0.2);
    // Wood of every size, from trunk to twig.
    const names = new Set(wood.map(([, , , id]) => plantDef(id).name));
    expect([...names].sort()).toEqual(['Bough', 'Branch', 'Trunk', 'Twig']);
    expect(leaves.length).toBeGreaterThan(1000);
    for (const v of [...wood, ...leaves]) expect(w.isSolid(v[0], v[1], v[2])).toBe(false);
  });

  it('links every piece of wood back to the ground, and every leaf to wood', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const w = flatWorld(4, 16);
      growTree(w, 32, 32, rng(seed));
      const { wood, leaves } = plants(w);
      for (const v of wood) expect(grounded(w, v.slice(0, 3)), `seed ${seed}: wood at ${v}`).toBe(true);
      const set = severed(w, []);
      expect(set.wood).toEqual([]);
      // Every leaf reaches wood through leaves, face to face.
      const key = (v) => v.join();
      const seen = new Set(wood.map((v) => key(v.slice(0, 3))));
      const stack = wood.map((v) => v.slice(0, 3));
      while (stack.length) {
        const v = stack.pop();
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const u = v.map((c, k) => c + d[k]);
          if (seen.has(key(u)) || w.getPlant(...u) !== PLANT.LEAVES) continue;
          seen.add(key(u));
          stack.push(u);
        }
      }
      expect(leaves.filter((v) => !seen.has(key(v))), `seed ${seed}`).toEqual([]);
    }
  });

  it('grows trees of different habits, sizes and girths', () => {
    const heights = [], girths = [];
    for (let seed = 1; seed <= 12; seed++) {
      const w = flatWorld(4, 16);
      growTree(w, 32, 32, rng(seed));
      const { wood } = plants(w);
      heights.push(Math.max(...wood.map((v) => v[1])) - GROUND);
      girths.push(woodRadius(w.getPlant(...foot(w, 32, 32))));
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(6); // voxels: 3 m
    expect(Math.max(...girths) / Math.min(...girths)).toBeGreaterThan(1.4);
  });

  it('draws wood as bark tubes, and makes the thick wood solid to bump into and aim at', () => {
    const w = flatWorld(4, 16);
    growTree(w, 32, 32, rng(5));
    let bark = 0, cards = 0, solid = 0;
    for (const f of meshTrees(w)) {
      for (const g of f.groups) {
        if (g.materialIndex !== 1) continue;
        for (let v = g.start; v < g.start + g.count; v += 3) (f.axis[v * 3] || f.axis[v * 3 + 1] || f.axis[v * 3 + 2]) ? cards++ : bark++;
      }
      // Each solid triangle belongs to a voxel of solid wood.
      for (let t = 0; t < f.wood.triangles; t++) {
        const id = w.getPlant(f.wood.cell[t * 3], f.wood.cell[t * 3 + 1], f.wood.cell[t * 3 + 2]);
        expect(isSolidWood(id)).toBe(true);
        solid++;
      }
    }
    expect(bark).toBeGreaterThan(1000);
    expect(cards).toBeGreaterThan(500);
    expect(solid).toBeGreaterThan(300);
  });

  it('chops wood an eighth at a time, drawing the notch as end grain, and fells all it carried', () => {
    const w = flatWorld(4, 16);
    growTree(w, 32, 32, rng(2));
    const f = foot(w, 32, 32);
    const cutLayer = TEXTURE_NAMES.indexOf('log_end');
    const endGrain = () => meshTrees(w).reduce((n, m) => {
      for (let v = 0; v < m.uvl.length / 3; v++) if (m.uvl[v * 3 + 2] === cutLayer) n++;
      return n;
    }, 0);
    expect(endGrain()).toBe(0);
    for (let k = 1; k < 8; k++) {
      expect(chop(w, ...f, 2)).toBe(null);
      expect(woodCut(w.getPlant(...f))).toBe(k);
      expect(woodCutSide(w.getPlant(...f))).toBe(2);
    }
    expect(endGrain()).toBeGreaterThan(0);
    // The eighth stroke goes through: the whole tree and its leaves are freed.
    const before = plants(w);
    const set = chop(w, ...f, 6);
    // (The foot is all the tree grows from: roots and all grow from it.)
    expect(set.wood.length).toBe(before.wood.length);
    expect(set.leaves.length).toBe(before.leaves.length);
    remove(w, set);
    const after = plants(w);
    expect(after.leaves.length).toBe(0);
    for (const v of after.wood) expect(grounded(w, v.slice(0, 3))).toBe(true);
  });

  it('cutting off a branch takes what grows from it and its leaves, and leaves the rest of the tree whole', () => {
    const w = flatWorld(4, 16);
    growTree(w, 32, 32, rng(3));
    const before = plants(w);
    // A branch up in the crown, a few voxels above the fork.
    const branch = before.wood.find(([, , , id]) => plantDef(id).name === 'Branch' && woodRadius(id) > 0.06);
    const set = severed(w, [branch.slice(0, 3)]);
    expect(set.wood.length).toBeGreaterThan(1);
    expect(set.wood.length).toBeLessThan(before.wood.length / 2);
    remove(w, set);
    const after = plants(w);
    expect(after.wood.length).toBe(before.wood.length - set.wood.length);
    expect(after.leaves.length).toBe(before.leaves.length - set.leaves.length);
    for (const v of after.wood) expect(grounded(w, v.slice(0, 3))).toBe(true);
  });

  it('a tree goes when the ground under its trunk is dug away', () => {
    const w = flatWorld(4, 16);
    growTree(w, 32, 32, rng(4));
    expect(plants(w).wood.length).toBeGreaterThan(50);
    sculptSphere(w, { x: 32.5, y: GROUND - 0.5, z: 32.5 }, 3, 'sub');
    const { wood, leaves } = plants(w);
    for (const v of wood) expect(grounded(w, v.slice(0, 3))).toBe(true);
    expect(wood.filter((v) => Math.hypot(v[0] - 32, v[2] - 32) < 3 && v[1] > GROUND + 4)).toEqual([]);
    expect(leaves.length).toBe(0);
  });

  it('draws terrain wood cut open by an edit as end grain, at any angle, and the outside as bark', () => {
    const w = flatWorld(3, 16);
    sculptSphere(w, { x: 24.5, y: GROUND + 5, z: 24.5 }, 4, 'add', MAT.LOG);
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
    // Break a metre out of it: the edges it opened above and below are cut.
    breakAt(w, 24, GROUND + 2, 24);
    expect(w.getCut(24, GROUND + 1, 24, 1)).toBe(true);
    expect(w.getCut(24, GROUND + 3, 24, 1)).toBe(true);
    expect(w.getMat(24, GROUND + 1, 24)).toBe(MAT.LOG); // the wood itself is unchanged
    expect(count().cut).toBeGreaterThan(0);
    // Digging into its side from +x: that cut faces sideways, and is end grain too.
    sculptSphere(w, { x: 28.1, y: GROUND + 6.5, z: 24.5 }, 1.6, 'sub');
    const after = count();
    expect(after.sideways).toBeGreaterThan(0);
    // Most of the wood is untouched bark.
    expect(after.log).toBeGreaterThan(after.cut * 3);
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
