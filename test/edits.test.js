import { describe, it, expect } from 'vitest';
import { World, OCC_SLOPE } from '../src/world/World.js';
import { MAT, HARD } from '../src/world/materials.js';
import { stampSphere, stepForSpeed, smoothBrush, flattenBrush, placeAt, removeAt, SPECK_MAX_VOXELS } from '../src/world/edits.js';
import { PAD } from '../src/mesh/surfaceNets.js';
import { meshChunk } from '../src/mesh/surfaceNets.js';

const GROUND = 12;
// The steepest a smooth field may change between neighbouring voxels (+ rounding).
const MAX_STEP = Math.ceil(OCC_SLOPE * 255) + 2;

/** 32 × 32 × 32 world with flat smooth ground at y = GROUND. */
function flatWorld() {
  const w = new World(2, 2, 2, 16);
  for (let z = 0; z < w.sz; z++)
    for (let y = 0; y < w.sy; y++)
      for (let x = 0; x < w.sx; x++) {
        const o = Math.round(Math.min(1, Math.max(0, 0.5 + (GROUND - (y + 0.5)) * OCC_SLOPE)) * 255);
        w.setRaw(x, y, z, o, o ? MAT.GRASS : 0);
      }
  return w;
}

/**
 * Largest occupancy jump between face-neighbouring terrain voxels (bedrock and
 * blocks excluded: a block's stored field is hidden inside the cube).
 */
function maxStep(w) {
  let max = 0;
  for (let z = 0; z < w.sz - 1; z++)
    for (let y = 1; y < w.sy - 1; y++)
      for (let x = 0; x < w.sx - 1; x++) {
        if (w.isBlock(x, y, z)) continue;
        const o = w.getOcc(x, y, z);
        for (const [a, b, c] of [[x + 1, y, z], [x, y + 1, z], [x, y, z + 1]]) {
          if (!w.isBlock(a, b, c)) max = Math.max(max, Math.abs(o - w.getOcc(a, b, c)));
        }
      }
  return max;
}

/** Floating terrain pieces of at most `limit` voxels (not touching bedrock or blocks). */
function countSpecks(w, limit = SPECK_MAX_VOXELS) {
  const seen = new Uint8Array(w.sx * w.sy * w.sz);
  const id = (x, y, z) => x + w.sx * (y + w.sy * z);
  const solid = (x, y, z) => w.inBounds(x, y, z) && w.getOcc(x, y, z) >= 128 && !w.isBlock(x, y, z);
  let specks = 0;
  for (let z = 0; z < w.sz; z++)
    for (let y = 1; y < w.sy; y++)
      for (let x = 0; x < w.sx; x++) {
        if (seen[id(x, y, z)] || !solid(x, y, z)) continue;
        let size = 0, anchored = false;
        const stack = [[x, y, z]];
        seen[id(x, y, z)] = 1;
        while (stack.length) {
          const [cx, cy, cz] = stack.pop();
          size++;
          for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy, nz = cz + dz;
                if (ny < 1 || w.isBlock(nx, ny, nz)) { anchored = true; continue; }
                if (!solid(nx, ny, nz) || seen[id(nx, ny, nz)]) continue;
                seen[id(nx, ny, nz)] = 1;
                stack.push([nx, ny, nz]);
              }
        }
        if (!anchored && size <= limit) specks++;
      }
  return specks;
}

/** Snapshot of the terrain field stored inside every block. */
function blockFields(w) {
  const out = [];
  for (let z = 0; z < w.sz; z++) for (let y = 0; y < w.sy; y++) for (let x = 0; x < w.sx; x++) if (w.isBlock(x, y, z)) out.push(w.getOcc(x, y, z));
  return out;
}

function blockCount(w) {
  let n = 0;
  for (let z = 0; z < w.sz; z++) for (let y = 0; y < w.sy; y++) for (let x = 0; x < w.sx; x++) if (w.isBlock(x, y, z)) n++;
  return n;
}

/** A planks floor on the ground with a wall along one edge, crossing chunk borders. */
function addStructure(w) {
  for (let z = 10; z < 20; z++) for (let x = 10; x < 22; x++) placeAt(w, x, GROUND, z, MAT.PLANKS);
  for (let y = GROUND + 1; y < GROUND + 4; y++) for (let x = 10; x < 22; x++) placeAt(w, x, y, 20, MAT.PLANKS);
}

function blockVertsAreIntegers(w) {
  for (let i = 0; i < w.chunks.length; i++) {
    const [cx, cy, cz] = w.chunkCoords(i);
    const p = w.buildPadded(cx, cy, cz);
    const m = meshChunk(p.occ, p.mat, p.size, p.origin, HARD);
    for (let j = 0; j < m.blockVertices * 3; j++) if (!Number.isInteger(m.position[j])) return false;
  }
  return true;
}

describe('edits keep the terrain field smooth', () => {
  it('generated ground starts smooth', () => {
    expect(maxStep(flatWorld())).toBeLessThanOrEqual(MAX_STEP);
  });

  it('raising terrain over and around blocks (held brush) stays smooth; blocks stay cubes', () => {
    const w = flatWorld();
    addStructure(w);
    const blocks = blockCount(w);
    // Hold a raise brush that sweeps across the floor and over the wall.
    for (let i = 0; i < 120; i++) stampSphere(w, 10 + (i % 12), GROUND + 1 + (i / 40), 18 + (i % 5), 3, 'add', stepForSpeed(3, 0.025), MAT.STONE);
    expect(maxStep(w)).toBeLessThanOrEqual(MAX_STEP);
    expect(blockCount(w)).toBe(blocks);
    expect(blockVertsAreIntegers(w)).toBe(true);
  });

  it('digging through blocks stays smooth and never removes a block', () => {
    const w = flatWorld();
    addStructure(w);
    const blocks = blockCount(w);
    for (let i = 0; i < 80; i++) stampSphere(w, 8 + (i % 16), GROUND, 15 + (i % 7), 2.5, 'sub', stepForSpeed(3, 0.025));
    expect(maxStep(w)).toBeLessThanOrEqual(MAX_STEP);
    expect(blockCount(w)).toBe(blocks);
  });

  it('building and removing with terrain materials stays smooth', () => {
    const w = flatWorld();
    for (let x = 4; x < 12; x++) placeAt(w, x, GROUND, 6, MAT.DIRT);
    for (let x = 4; x < 12; x++) removeAt(w, x, GROUND - 1, 26);
    expect(maxStep(w)).toBeLessThanOrEqual(MAX_STEP);
    expect(w.isSolid(8, GROUND, 6)).toBe(true);
    expect(w.isSolid(8, GROUND - 1, 26)).toBe(false);
  });

  it('removing a block restores the terrain that was in its cell', () => {
    const w = flatWorld();
    const y = GROUND - 4; // deep underground: field is 255 here
    placeAt(w, 16, y, 16, MAT.BRICK);
    removeAt(w, 16, y, 16);
    expect(w.isBlock(16, y, 16)).toBe(false);
    expect(w.getOcc(16, y, 16)).toBe(255);

    // Ground surface 0.3 above the cell centre, as on a slope: no pit, and grass stays grass.
    const w2 = flatWorld();
    const lift = Math.round((0.5 + 0.3 * OCC_SLOPE) * 255);
    for (let z = 0; z < w2.sz; z++) for (let x = 0; x < w2.sx; x++) w2.setRaw(x, GROUND, z, lift, MAT.GRASS);
    for (let z = 0; z < w2.sz; z++) for (let x = 0; x < w2.sx; x++) w2.setRaw(x, GROUND - 1, z, 255, MAT.DIRT);
    placeAt(w2, 16, GROUND, 16, MAT.PLANKS);
    removeAt(w2, 16, GROUND, 16);
    expect(w2.getOcc(16, GROUND, 16)).toBe(lift);
    expect(w2.getMat(16, GROUND, 16)).toBe(MAT.GRASS);
  });

  it('brushes never change the terrain stored inside blocks', () => {
    const w = flatWorld();
    addStructure(w);
    const before = blockFields(w);
    const step = stepForSpeed(3, 0.025);
    for (let i = 0; i < 60; i++) {
      stampSphere(w, 10 + (i % 12), GROUND + 1, 15 + (i % 6), 3, 'add', step, MAT.STONE);
      stampSphere(w, 10 + (i % 12), GROUND - 1, 21, 3, 'sub', step);
      smoothBrush(w, { x: 15, y: GROUND, z: 15 }, 4, 0.025);
      flattenBrush(w, { x: 15, y: GROUND, z: 21 }, 4, GROUND + 2, 0.025);
    }
    expect(blockFields(w)).toEqual(before);
  });

  it('a wall of blocks shields the far side from brushes', () => {
    const w = flatWorld();
    // A solid partition at x = 16 across the whole world.
    for (let z = 0; z < w.sz; z++) for (let y = 1; y < w.sy; y++) w.setRaw(16, y, z, w.getOcc(16, y, z), MAT.STONE_BRICK);
    const farSide = () => {
      const s = [];
      for (let z = 0; z < w.sz; z++) for (let y = 1; y < w.sy; y++) for (let x = 17; x < w.sx; x++) s.push(w.getOcc(x, y, z));
      return s;
    };
    const before = farSide();
    for (let i = 0; i < 40; i++) {
      stampSphere(w, 14.5, GROUND, 16, 5, 'add', 255, MAT.STONE);
      stampSphere(w, 15.5, GROUND - 1, 10, 5, 'sub');
    }
    expect(farSide()).toEqual(before);
  });

  it('never grows terrain into the player', () => {
    const w = flatWorld();
    // Player standing on the ground at (16, GROUND, 16): box 0.6 wide, 1.8 tall.
    const protect = (x, y, z) => x + 1 > 15.6 && x < 16.4 && z + 1 > 15.6 && z < 16.4 && y + 1 > GROUND && y < GROUND + 1.8;
    for (let i = 0; i < 50; i++) stampSphere(w, 16, GROUND, 16, 4, 'add', 40, MAT.STONE, { protect });
    for (let y = GROUND; y < GROUND + 2; y++) expect(w.getOcc(16, y, 16)).toBeLessThan(128);
    expect(w.isSolid(19, GROUND + 1, 16)).toBe(true); // but terrain did grow around them
  });

  it('dissolves tiny floating pieces left by digging', () => {
    const w = flatWorld();
    // Dig a pit, leaving a sliver, then keep digging around it.
    const step = stepForSpeed(3, 0.025);
    for (let i = 0; i < 300; i++) {
      const a = i * 0.7;
      stampSphere(w, 16 + Math.cos(a) * 3, GROUND - 2 + Math.sin(a * 0.3), 16 + Math.sin(a) * 3, 2.5, 'sub', step);
    }
    // And a hand-made speck hanging in the air next to an edit.
    w.setRaw(20, GROUND + 4, 20, 200, MAT.DIRT);
    stampSphere(w, 21, GROUND, 21, 1.5, 'sub');
    expect(countSpecks(w)).toBe(0);
  });

  it('removing a block resting on the ground leaves the ground untouched', () => {
    const w = flatWorld();
    const before = [w.getOcc(16, GROUND - 1, 16), w.getOcc(16, GROUND - 2, 16)];
    placeAt(w, 16, GROUND, 16, MAT.PLANKS);
    removeAt(w, 16, GROUND, 16);
    expect(w.isSolid(16, GROUND, 16)).toBe(false);
    expect([w.getOcc(16, GROUND - 1, 16), w.getOcc(16, GROUND - 2, 16)]).toEqual(before);
  });

  it('building with terrain fills exact grid cells', () => {
    const w = flatWorld();
    for (let x = 8; x < 14; x++) placeAt(w, x, GROUND, 8, MAT.DIRT);
    for (let x = 8; x < 14; x++) expect(w.isSolid(x, GROUND, 8)).toBe(true);
    expect(w.isSolid(14, GROUND, 8)).toBe(false);
    expect(w.isSolid(10, GROUND + 1, 8)).toBe(false);
    expect(w.isSolid(10, GROUND, 9)).toBe(false);
    removeAt(w, 10, GROUND - 1, 20);
    expect(w.isSolid(10, GROUND - 1, 20)).toBe(false);
    expect(w.isSolid(11, GROUND - 1, 20)).toBe(true);
    expect(w.isSolid(10, GROUND - 2, 20)).toBe(true);
    expect(maxStep(w)).toBeLessThanOrEqual(MAX_STEP);
  });
});

/** Terrain triangles of the whole world, as [ax, ay, az, bx, ...] per triangle. */
function terrainTris(w) {
  const out = [];
  for (let i = 0; i < w.chunks.length; i++) {
    const [cx, cy, cz] = w.chunkCoords(i);
    const p = w.buildPadded(cx, cy, cz);
    const m = meshChunk(p.occ, p.mat, p.size, p.origin, HARD);
    for (let j = m.blockVertices * 3; j < m.position.length; j += 9) out.push(Array.from(m.position.subarray(j, j + 9)));
  }
  return out;
}
const centroid = (t) => [(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3];

describe('terrain meets blocks cleanly', () => {
  it('meshes ground in a one-voxel gap between blocks', () => {
    const w = flatWorld();
    for (let z = 9; z <= 14; z++) for (let x = 9; x <= 11; x++) if (!(x === 10 && z >= 10)) placeAt(w, x, GROUND, z, MAT.PLANKS);
    let area = 0;
    for (const t of terrainTris(w)) {
      const [cx, , cz] = centroid(t);
      if (cx > 10 && cx < 11 && cz > 10 && cz < 14) {
        const e1 = [t[3] - t[0], t[5] - t[2]], e2 = [t[6] - t[0], t[8] - t[2]];
        area += Math.abs(e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      }
    }
    expect(area).toBeGreaterThan(3.99);
  });

  it('level ground meets a block at its base, without a skirt', () => {
    const w = flatWorld();
    for (let z = 10; z < 20; z++) placeAt(w, 16, GROUND, z, MAT.BRICK);
    for (const t of terrainTris(w)) {
      for (let k = 0; k < 9; k += 3) {
        const x = t[k], y = t[k + 1], z = t[k + 2];
        // Every visible terrain vertex near the wall lies on the ground plane.
        if (z > 11 && z < 18 && (x < 16 || x > 17) && Math.abs(x - 16.5) < 2) expect(y).toBeCloseTo(GROUND, 1.9); // ground rounds 76.5 → 77: 5 mm
      }
    }
  });

  it('a terrain cell built beside a block is flush with its top', () => {
    const w = flatWorld();
    const y = GROUND + 2; // in the air, on top of a pillar
    for (let z = 10; z < 20; z++) {
      for (let h = GROUND; h <= y; h++) placeAt(w, 17, h, z, MAT.BRICK);
      placeAt(w, 16, y, z, MAT.PLANKS);
      for (let h = GROUND; h <= y; h++) placeAt(w, 15, h, z, MAT.DIRT);
    }
    // The dirt column's top runs level (y + 1) right up to the planks: no groove at the joint.
    let seen = 0;
    for (const t of terrainTris(w)) {
      for (let k = 0; k < 9; k += 3) {
        const x = t[k], vy = t[k + 1], z = t[k + 2];
        if (z > 11 && z < 18 && x > 15.5 && x < 16.01 && vy > y + 0.5) {
          expect(vy).toBeCloseTo(y + 1, 3);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('terrain never hangs off blocks that overhang the ground', () => {
    // Ground sloping down along x: level with the beam's base at x = 12, 2 m below it at x = 22.
    const w = new World(2, 2, 2, 16);
    const h = (x) => GROUND + 1 - 0.2 * Math.max(0, x - 12);
    for (let z = 0; z < w.sz; z++) for (let y = 0; y < w.sy; y++) for (let x = 0; x < w.sx; x++) {
      const o = Math.round(Math.min(1, Math.max(0, 0.5 + (h(x + 0.5) - (y + 0.5)) * OCC_SLOPE)) * 255);
      w.setRaw(x, y, z, o, o ? MAT.GRASS : 0);
    }
    for (let x = 10; x <= 22; x++) placeAt(w, x, GROUND + 1, 16, MAT.PLANKS);
    const onBlock = (x, y, z) => {
      const e = 1e-3;
      for (const dx of [-e, e]) for (const dy of [-e, e]) for (const dz of [-e, e])
        if (w.isBlock(Math.floor(x + dx), Math.floor(y + dy), Math.floor(z + dz))) return true;
      return false;
    };
    let curtain = 0;
    for (const t of terrainTris(w)) {
      const [cx, cy, cz] = centroid(t);
      // Terrain may close a gap of under half a voxel up to a block's face, but
      // anything higher above the ground must lie on a block (hidden by it).
      if (cy > h(cx) + 0.5 && !onBlock(cx, cy, cz)) curtain++;
    }
    expect(curtain).toBe(0);
  });
});
