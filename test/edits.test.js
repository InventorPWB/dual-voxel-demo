import { describe, it, expect } from 'vitest';
import { VOXEL } from '../src/world/World.js';
import { MAT } from '../src/world/materials.js';
import { sculptSphere, smoothBrush, flattenBrush, placeShape, removeShape, shapeSolidVoxels, breakCells, breakAt, SPECK_MAX_VOXELS } from '../src/world/edits.js';
import { SHAPE, SHAPES, placement } from '../src/world/shapes.js';
import { flatWorld, slopedWorld, meshAll, triangles, centroid, faceNormal, interiorOpenEdges, openEdges, holes, parts, GROUND } from './helpers.js';

/** Floating solid pieces of at most `limit` voxels (not touching bedrock). */
function countSpecks(w, limit = SPECK_MAX_VOXELS) {
  const seen = new Uint8Array(w.sx * w.sy * w.sz);
  const id = (x, y, z) => x + w.sx * (y + w.sy * z);
  const solid = (x, y, z) => w.inBounds(x, y, z) && w.isSolid(x, y, z);
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
                if (ny < 1) { anchored = true; continue; }
                if (!solid(nx, ny, nz) || seen[id(nx, ny, nz)]) continue;
                seen[id(nx, ny, nz)] = 1;
                stack.push([nx, ny, nz]);
              }
        }
        if (!anchored && size <= limit) specks++;
      }
  return specks;
}

const G = GROUND * VOXEL;

describe('shapes on natural (off-grid) ground', () => {
  // The case that broke the occupancy-field version: shapes placed on a 15°
  // slope whose surface doesn't sit on grid planes.
  const w = slopedWorld(0.27);
  const at = { block: [10, 12, 4], slab: [10, 12, 10], stairs: [10, 12, 16], pillar: [16, 13, 4], sphere: [16, 14, 10], slope: [16, 14, 16] };
  for (const [id, o] of Object.entries(at)) placeShape(w, placement(SHAPE[id], o, 0), MAT.PLANKS);
  const tris = triangles(w);
  // Material per triangle isn't in `triangles`; use the meshes directly.
  const planks = [];
  for (const m of meshAll(w)) for (let i = 0; i < m.position.length; i += 9) if (m.material[i / 3] === MAT.PLANKS) planks.push(Array.from(m.position.subarray(i, i + 9)));
  const groundY = (x) => (GROUND + 0.3 + 0.27 * (x / VOXEL - 10)) * VOXEL;
  const verticesOf = (o, size, clearance = 0.03) => {
    const out = [];
    for (const t of planks) for (let k = 0; k < 9; k += 3) {
      const [x, y, z] = [t[k] / VOXEL, t[k + 1] / VOXEL, t[k + 2] / VOXEL];
      if (x < o[0] - 0.4 || x > o[0] + size[0] + 0.4 || z < o[2] - 0.4 || z > o[2] + size[2] + 0.4) continue;
      if (t[k + 1] < groundY(t[k]) + clearance) continue; // where it meets the ground
      out.push([x, y, z]);
    }
    return out;
  };

  it('keeps boxy shapes exactly on their faces', () => {
    for (const [id, size] of [['block', [2, 2, 2]], ['slab', [2, 1, 2]], ['stairs', [2, 2, 2]]]) {
      const o = at[id];
      const vs = verticesOf(o, size);
      expect(vs.length, id).toBeGreaterThan(6);
      for (const [x, y, z] of vs) {
        // Inside the footprint box (with a hair of tolerance), and on one of its planes or a step plane.
        expect(x, id).toBeGreaterThan(o[0] - 0.02); expect(x, id).toBeLessThan(o[0] + size[0] + 0.02);
        expect(z, id).toBeGreaterThan(o[2] - 0.02); expect(z, id).toBeLessThan(o[2] + size[2] + 0.02);
        expect(y, id).toBeLessThan(o[1] + size[1] + 0.02);
        const onPlane = [x - o[0], x - o[0] - size[0], z - o[2], z - o[2] - size[2], y - o[1] - size[1], y - o[1] - 1, z - o[2] - 1]
          .some((d) => Math.abs(d) < 0.02);
        expect(onPlane, `${id} vertex ${[x, y, z].map((v) => v.toFixed(2))}`).toBe(true);
      }
    }
  });

  it('keeps a pillar round and a sphere spherical', () => {
    for (const [id, r] of [['pillar', 1], ['sphere', 1]]) {
      const o = at[id];
      // (Vertices on the line where a curved shape meets the ground belong to both.)
      for (const [x, y, z] of verticesOf(o, [2 * r, 2 * r, 2 * r], 0.15)) {
        const d = id === 'pillar' ? Math.hypot(x - o[0] - 1, z - o[2] - 1) : Math.hypot(x - o[0] - r, y - o[1] - r, z - o[2] - r);
        const onCap = id === 'pillar' && Math.abs(y - o[1] - 2) < 0.02;
        // Curved pieces are exact: every vertex sits on the cylinder or sphere.
        if (!onCap) expect(Math.abs(d - r), `${id} at ${[x, y, z].map((v) => v.toFixed(2))}`).toBeLessThan(1e-4);
      }
    }
  });

  it('draws each shape in its own material', () => {
    // The 45° slope's face is planks, not the ground's grass.
    let up = 0;
    for (const t of planks) {
      const [cx, , cz] = centroid(t).map((v) => v / VOXEL);
      const n = faceNormal(t);
      if (cx > 16.2 && cx < 17.8 && cz > 16.5 && cz < 17.8 && n && n[1] > 0.5 && n[2] < -0.5) up++;
    }
    expect(up).toBeGreaterThanOrEqual(2);
  });

  it('stays closed: terrain ends exactly on the pieces, pieces have no holes', () => {
    const { terrain, pieces } = parts(meshAll(w));
    const X = w.sx * VOXEL, Z = w.sz * VOXEL;
    expect(openEdges(terrain).filter(([x, , z]) => x > 0.6 && z > 0.6 && x < X - 0.6 && z < Z - 0.6)).toEqual([]);
    expect(holes(pieces, w)).toEqual([]);
    expect(tris.length).toBeGreaterThan(100);
  });

  it('fills nothing in under a piece on uneven ground', () => {
    const w2 = slopedWorld(0.27);
    // Bottom at voxel 14; the ground under it lies between about 12.3 and 12.9.
    placeShape(w2, placement(SHAPE.block, [10, 14, 22]), MAT.BRICK);
    for (const [x, z] of [[10, 22], [11, 23]]) expect(w2.isSolid(x, 13, z)).toBe(false);
  });
});

describe('shapes', () => {
  it('removing a placed shape leaves the ground as it was', () => {
    const w = flatWorld();
    const p = placement(SHAPE.block, [10, GROUND, 10]);
    placeShape(w, p, MAT.BRICK);
    removeShape(w, p);
    for (const t of triangles(w)) {
      const [cx, , cz] = centroid(t);
      if (cx > 4 && cx < 7 && cz > 4 && cz < 7) for (let k = 1; k < 9; k += 3) expect(t[k]).toBeCloseTo(G, 2);
    }
  });

  it('carving a shape into the ground leaves a hole of that shape', () => {
    const w = flatWorld();
    removeShape(w, placement(SHAPE.block, [10, GROUND - 2, 10]));
    expect(w.isSolid(10, GROUND - 1, 10)).toBe(false);
    expect(w.isSolid(11, GROUND - 2, 11)).toBe(false);
    expect(w.isSolid(12, GROUND - 1, 10)).toBe(true);
    expect(w.isSolid(10, GROUND - 3, 10)).toBe(true);
    // Hole walls on the grid planes (natural materials soften the corners by a few cm).
    for (const t of triangles(w)) {
      const n = faceNormal(t);
      const [cx, cy, cz] = centroid(t);
      if (!n || cy > G - 0.05 || cy < G - 0.95 || Math.abs(n[0]) < 0.99) continue;
      if (cz > 5.05 && cz < 5.95 && cx < 10) expect([5, 6].some((v) => Math.abs(cx - v) < 0.05)).toBe(true);
    }
  });

  it('breaks a whole 1 m piece, whichever of its voxels you aim at', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.slope, [10, GROUND, 10], 1), MAT.BRICK);
    const filled = placement(SHAPE.slope, [10, GROUND, 10], 1).voxels.length;
    expect(breakCells(w, 11, GROUND + 1, 11)).toHaveLength(filled);
    breakAt(w, 10, GROUND, 10);
    for (let z = 10; z < 12; z++) for (let y = GROUND; y < GROUND + 2; y++) for (let x = 10; x < 12; x++) expect(w.isSolid(x, y, z)).toBe(false);
  });

  it('breaks one of two slabs sharing a metre, and one small block at a time', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.slab, [10, GROUND, 10]), MAT.BRICK);
    placeShape(w, placement(SHAPE.slab, [10, GROUND + 1, 10]), MAT.BRICK);
    breakAt(w, 11, GROUND + 1, 11);
    expect(w.isSolid(10, GROUND + 1, 10)).toBe(false);
    expect(w.isSolid(11, GROUND, 11)).toBe(true);
    placeShape(w, placement(SHAPE.small, [14, GROUND, 10]), MAT.BRICK);
    placeShape(w, placement(SHAPE.small, [15, GROUND, 10]), MAT.BRICK);
    breakAt(w, 15, GROUND, 10);
    expect(w.isSolid(14, GROUND, 10)).toBe(true);
    expect(w.isSolid(15, GROUND, 10)).toBe(false);
  });

  it('breaks a metre of ground at a time, leaving pieces in it alone', () => {
    const w = flatWorld();
    placeShape(w, placement(SHAPE.small, [10, GROUND - 1, 10]), MAT.BRICK);
    breakAt(w, 11, GROUND - 1, 11);
    expect(w.isSolid(11, GROUND - 2, 11)).toBe(false);
    expect(w.isSolid(10, GROUND - 1, 10)).toBe(true);
    expect(w.isSolid(12, GROUND - 1, 10)).toBe(true);
    expect(interiorOpenEdges(w)).toEqual([]);
  });

  it('a slope turns to rise away from the player', () => {
    const facing = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (let rot = 0; rot < 4; rot++) {
      const p = placement(SHAPE.slope, [0, 0, 0], rot);
      const [fx, fz] = facing[rot];
      // Its upper voxels are on the far side along the facing direction.
      for (const [x, y, z] of p.voxels) if (y === 1) expect((x + 0.5 - 1) * fx + (z + 0.5 - 1) * fz, `rot ${rot}`).toBeGreaterThan(0);
    }
  });

  it('knows which voxels a shape fills (used to keep placements out of the player)', () => {
    const w = flatWorld();
    expect(shapeSolidVoxels(w, placement(SHAPE.block, [3, GROUND, 3])).length).toBe(8);
    expect(shapeSolidVoxels(w, placement(SHAPE.slab, [3, GROUND, 3])).length).toBe(4);
  });

  it('stays one closed surface after many random placements and removals', () => {
    const w = slopedWorld(0.2);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 500; i++) {
      const s = SHAPES[Math.floor(rnd() * SHAPES.length)];
      const p = placement(s, [2 + Math.floor(rnd() * 26), GROUND - 2 + Math.floor(rnd() * 8), 2 + Math.floor(rnd() * 26)], Math.floor(rnd() * 4), rnd() < 0.15);
      if (rnd() < 0.3) removeShape(w, p);
      else placeShape(w, p, 1 + Math.floor(rnd() * 8));
      if (rnd() < 0.2) breakAt(w, 2 + Math.floor(rnd() * 26), GROUND - 2 + Math.floor(rnd() * 8), 2 + Math.floor(rnd() * 26));
    }
    // Terrain is one closed surface (ending exactly on piece faces); pieces have no holes.
    const { terrain, pieces } = parts(meshAll(w));
    const X = w.sx * VOXEL, Z = w.sz * VOXEL;
    expect(openEdges(terrain).filter(([x, , z]) => x > 0.6 && z > 0.6 && x < X - 0.6 && z < Z - 0.6)).toEqual([]);
    expect(holes(pieces, w)).toEqual([]);
  });
});

describe('terrain brushes', () => {
  it('dig, raise, smooth and level keep one closed surface', () => {
    const w = slopedWorld(0.2);
    for (let i = 0; i < 40; i++) sculptSphere(w, { x: 10 + (i % 8), y: GROUND + 1 + i / 20, z: 16 }, 2.5, 'add', MAT.DIRT);
    for (let i = 0; i < 40; i++) sculptSphere(w, { x: 8 + (i % 12), y: GROUND, z: 8 + (i % 5) }, 2, 'sub');
    for (let i = 0; i < 10; i++) smoothBrush(w, { x: 14, y: GROUND + 1, z: 16 }, 4, 0.1);
    flattenBrush(w, { x: 22, y: 0, z: 22 }, 4, GROUND + 1);
    expect(interiorOpenEdges(w)).toEqual([]);
  });

  it('levels ground exactly to the chosen height', () => {
    const w = slopedWorld(0.27);
    flattenBrush(w, { x: 16, y: 0, z: 16 }, 5, GROUND + 1);
    for (const t of triangles(w)) {
      const [cx, , cz] = centroid(t).map((v) => v / VOXEL);
      if (Math.hypot(cx - 16, cz - 16) < 3.5) for (let k = 1; k < 9; k += 3) expect(t[k] / VOXEL).toBeCloseTo(GROUND + 1, 2);
    }
  });

  it('never grows terrain into the player', () => {
    const w = flatWorld();
    const protect = (x, y, z) => x + 1 > 15.4 && x < 16.6 && z + 1 > 15.4 && z < 16.6 && y + 1 > GROUND && y < GROUND + 3.6;
    for (let i = 0; i < 10; i++) sculptSphere(w, { x: 16, y: GROUND, z: 16 }, 3 + i * 0.3, 'add', MAT.STONE, { protect });
    for (let i = 0; i < 5; i++) smoothBrush(w, { x: 16, y: GROUND + 1, z: 16 }, 4, 0.2, { protect });
    for (let y = GROUND; y < GROUND + 3; y++) expect(w.isSolid(16, y, 16)).toBe(false);
    expect(w.isSolid(19, GROUND + 1, 16)).toBe(true); // but it grew around them
  });

  it('dissolves tiny floating pieces left by digging', () => {
    const w = flatWorld();
    for (let i = 0; i < 200; i++) {
      const a = i * 0.7;
      sculptSphere(w, { x: 16 + Math.cos(a) * 3, y: GROUND - 2 + Math.sin(a * 0.3), z: 16 + Math.sin(a) * 3 }, 2.5, 'sub');
    }
    expect(countSpecks(w)).toBe(0);
  });
});
