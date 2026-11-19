import { describe, it, expect } from 'vitest';
import { meshChunk } from '../src/mesh/surfaceNets.js';
import { World } from '../src/world/World.js';
import { HARD, MAT } from '../src/world/materials.js';

function meshAll(world) {
  const meshes = [];
  for (let i = 0; i < world.chunks.length; i++) {
    const [cx, cy, cz] = world.chunkCoords(i);
    const p = world.buildPadded(cx, cy, cz);
    meshes.push(meshChunk(p.occ, p.mat, p.size, p.origin, HARD));
  }
  return meshes;
}

/** Split a mesh into its block part and terrain part (position + normal arrays). */
function parts(m) {
  const b = m.blockVertices * 3;
  return {
    blocks: { position: m.position.subarray(0, b), normal: m.normal.subarray(0, b) },
    terrain: { position: m.position.subarray(b), normal: m.normal.subarray(b) },
  };
}

/** Every undirected edge of a closed triangle mesh is used by an even number of triangles. */
function openEdges(meshes) {
  const key = (p, i) => `${p[i].toFixed(4)},${p[i + 1].toFixed(4)},${p[i + 2].toFixed(4)}`;
  const counts = new Map();
  for (const m of meshes) {
    const p = m.position;
    for (let t = 0; t < p.length; t += 9) {
      const v = [key(p, t), key(p, t + 3), key(p, t + 6)];
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        if (a === b) continue;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  let open = 0;
  for (const c of counts.values()) if (c % 2 !== 0) open++;
  return open;
}

function fillSphere(world, cx, cy, cz, r, mat) {
  for (let z = 0; z < world.sz; z++)
    for (let y = 0; y < world.sy; y++)
      for (let x = 0; x < world.sx; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
        const o = Math.round(Math.min(1, Math.max(0, 0.5 + (r - d) * 0.4)) * 255);
        if (o) world.setRaw(x, y, z, o, mat);
      }
}

describe('hybrid mesher', () => {
  it('meshes a block as an exact unit cube, whatever its terrain field', () => {
    for (const field of [0, 143, 255]) {
      const world = new World(1, 1, 1, 16);
      world.setRaw(5, 6, 7, field, MAT.PLANKS);
      const [m] = meshAll(world);
      const { blocks, terrain } = parts(m);
      expect(blocks.position.length / 9).toBe(12);
      for (let i = 0; i < blocks.position.length; i += 3) {
        expect([5, 6]).toContain(blocks.position[i]);
        expect([6, 7]).toContain(blocks.position[i + 1]);
        expect([7, 8]).toContain(blocks.position[i + 2]);
      }
      // Flat, outward normals, and counter-clockwise winding seen from outside.
      const p = blocks.position, n = blocks.normal;
      for (let t = 0; t < p.length; t += 9) {
        const nn = [n[t], n[t + 1], n[t + 2]];
        expect(Math.abs(nn[0]) + Math.abs(nn[1]) + Math.abs(nn[2])).toBeCloseTo(1);
        const c = [(p[t] + p[t + 3] + p[t + 6]) / 3 - 5.5, (p[t + 1] + p[t + 4] + p[t + 7]) / 3 - 6.5, (p[t + 2] + p[t + 5] + p[t + 8]) / 3 - 7.5];
        expect(c[0] * nn[0] + c[1] * nn[1] + c[2] * nn[2]).toBeGreaterThan(0);
        const e1 = [p[t + 3] - p[t], p[t + 4] - p[t + 1], p[t + 5] - p[t + 2]];
        const e2 = [p[t + 6] - p[t], p[t + 7] - p[t + 1], p[t + 8] - p[t + 2]];
        const x = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        expect(x[0] * nn[0] + x[1] * nn[1] + x[2] * nn[2]).toBeGreaterThan(0);
      }
      expect(openEdges([blocks])).toBe(0);
      // Any terrain the field makes lies inside the block and is dropped.
      expect(terrain.position.length).toBe(0);
    }
  });

  it('meshes smooth terrain as a closed surface', () => {
    const world = new World(1, 1, 1, 32);
    fillSphere(world, 16, 16, 16, 7.3, MAT.STONE);
    const [m] = meshAll(world);
    expect(m.blockVertices).toBe(0);
    expect(m.triangles).toBeGreaterThan(500);
    expect(openEdges([m])).toBe(0);
  });

  it('produces matching terrain seams across chunk boundaries', () => {
    const world = new World(2, 2, 2, 16);
    fillSphere(world, 16, 16.3, 15.6, 9.2, MAT.DIRT);
    expect(openEdges(meshAll(world))).toBe(0);
  });

  it('keeps blocks watertight across chunk boundaries', () => {
    const world = new World(2, 2, 2, 16);
    for (let y = 12; y < 24; y++) for (let x = 10; x < 22; x++) world.setRaw(x, y, 23, 0, MAT.BRICK);
    const meshes = meshAll(world);
    expect(openEdges(meshes.map((m) => parts(m).blocks))).toBe(0);
  });

  it('keeps blocks cubic where they sit in terrain, and terrain smooth around them', () => {
    const world = new World(2, 2, 2, 16);
    fillSphere(world, 16, 8, 16, 12, MAT.GRASS);
    // A wall pushed into the hill, crossing the x = 16 chunk border.
    for (let y = 16; y < 24; y++) for (let x = 10; x < 22; x++) world.setRaw(x, y, 17, world.getOcc(x, y, 17), MAT.PLANKS);
    let terrainTris = 0;
    for (const m of meshAll(world)) {
      const { blocks, terrain } = parts(m);
      for (const v of blocks.position) expect(Number.isInteger(v)).toBe(true);
      terrainTris += terrain.position.length / 9;
    }
    expect(terrainTris).toBeGreaterThan(200);
  });
});
