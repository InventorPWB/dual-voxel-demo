import { World, VOXEL } from '../src/world/World.js';
import { MAT, CRISP } from '../src/world/materials.js';
import { fillFromSDF } from '../src/world/csg.js';
import { stateContains } from '../src/world/shapes.js';
import { meshChunk } from '../src/mesh/dualContour.js';

/** Voxel level of the flat test ground's surface. */
export const GROUND = 12;

/** World of `n`³ chunks of `size` voxels, with flat ground whose surface is at voxel y = `ground`. */
export function flatWorld(n = 2, size = 16, ground = GROUND) {
  return sdfWorld(n, size, (x, y) => ground - y);
}

/** Ground sloping along x: surface height (voxels) = base + rise·(x - 10). Off the grid planes on purpose. */
export function slopedWorld(rise = 0.27, base = GROUND + 0.3, n = 2, size = 16) {
  const k = Math.cos(Math.atan(rise));
  return sdfWorld(n, size, (x, y) => (base + rise * (x - 10) - y) * k);
}

export function sdfWorld(n, size, sdf, mat = MAT.GRASS) {
  const w = new World(n, n, n, size);
  fillFromSDF(w, sdf, () => mat);
  return w;
}

export function meshAll(world) {
  const out = [];
  for (let i = 0; i < world.chunks.length; i++) {
    const [cx, cy, cz] = world.chunkCoords(i);
    const p = world.buildPadded(cx, cy, cz);
    out.push(meshChunk(p, CRISP, VOXEL));
  }
  return out;
}

/** All triangles (9 numbers each, metres) of the world's meshes. */
export function triangles(world) {
  const tris = [];
  for (const m of meshAll(world)) for (let i = 0; i < m.position.length; i += 9) tris.push(Array.from(m.position.subarray(i, i + 9)));
  return tris;
}

export const centroid = (t) => [(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3];

export function faceNormal(t) {
  const ax = t[3] - t[0], ay = t[4] - t[1], az = t[5] - t[2];
  const bx = t[6] - t[0], by = t[7] - t[1], bz = t[8] - t[2];
  const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const l = Math.hypot(...n);
  return l < 1e-12 ? null : n.map((v) => v / l);
}

/**
 * Edges used by an odd number of triangles, as midpoints (metres). A closed
 * surface has none (except where it's cut open at the world's border).
 */
export function openEdges(meshes) {
  const key = (p, i) => `${p[i].toFixed(4)},${p[i + 1].toFixed(4)},${p[i + 2].toFixed(4)}`;
  const counts = new Map(), mids = new Map();
  for (const m of meshes) {
    const p = m.position;
    for (let t = 0; t < p.length; t += 9) {
      for (let e = 0; e < 3; e++) {
        const a = t + e * 3, b = t + ((e + 1) % 3) * 3;
        const ka = key(p, a), kb = key(p, b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        counts.set(k, (counts.get(k) || 0) + 1);
        mids.set(k, [(p[a] + p[b]) / 2, (p[a + 1] + p[b + 1]) / 2, (p[a + 2] + p[b + 2]) / 2]);
      }
    }
  }
  const open = [];
  for (const [k, c] of counts) if (c % 2) open.push(mids.get(k));
  return open;
}

/** Open edges away from the world's outer border (the bedrock layer and terrain are cut open there). */
export function interiorOpenEdges(world, meshes = meshAll(world)) {
  const X = world.sx * VOXEL, Y = world.sy * VOXEL, Z = world.sz * VOXEL;
  return openEdges(meshes).filter(([x, y, z]) => x > 0.6 && z > 0.6 && x < X - 0.6 && z < Z - 0.6 && y < Y - 0.6);
}

/** Split meshes into their terrain and building-piece parts (each should be a closed surface). */
export function parts(meshes) {
  const terrain = [], pieces = [];
  for (const m of meshes) {
    const k = m.terrainVertices * 3;
    terrain.push({ position: m.position.subarray(0, k), normal: m.normal.subarray(0, k), material: m.material.subarray(0, k / 3) });
    pieces.push({ position: m.position.subarray(k), normal: m.normal.subarray(k), material: m.material.subarray(k / 3) });
  }
  return { terrain, pieces };
}

/** Is the point (metres) inside something solid: a piece's exact shape, or terrain? */
export function solidAt(world, px, py, pz) {
  const x = px / VOXEL, y = py / VOXEL, z = pz / VOXEL;
  const vx = Math.floor(x), vy = Math.floor(y), vz = Math.floor(z);
  if (world.isPiece(vx, vy, vz)) return stateContains(world.getShape(vx, vy, vz), x - vx, y - vy, z - vz);
  return world.isTerrain(vx, vy, vz);
}

/**
 * Real holes in the pieces' surface: open edges where light could get past.
 * A face partly hidden behind its neighbour can leave edges open without a
 * gap (the edge runs inside solid material); a hole is an open edge whose
 * far side, just behind the face, is empty.
 */
export function holes(meshes, world) {
  const owner = new Map();
  const key = (p, i) => `${p[i].toFixed(4)},${p[i + 1].toFixed(4)},${p[i + 2].toFixed(4)}`;
  for (const m of meshes) {
    const p = m.position;
    for (let t = 0; t < p.length; t += 9)
      for (let e = 0; e < 3; e++) {
        const a = t + e * 3, b = t + ((e + 1) % 3) * 3, c = t + ((e + 2) % 3) * 3;
        const ka = key(p, a), kb = key(p, b);
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const list = owner.get(k) || [];
        list.push([[p[a], p[a + 1], p[a + 2]], [p[b], p[b + 1], p[b + 2]], [p[c], p[c + 1], p[c + 2]]]);
        owner.set(k, list);
      }
  }
  const out = [];
  const leaks = ([a, b, c]) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e[1] * u[2] - e[2] * u[1], e[2] * u[0] - e[0] * u[2], e[0] * u[1] - e[1] * u[0]];
    const nl = Math.hypot(...n);
    // In-plane direction away from the triangle, across the edge.
    let d = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]];
    const dl = Math.hypot(...d);
    d = d.map((v) => v / dl);
    if (d[0] * u[0] + d[1] * u[1] + d[2] * u[2] > 0) d = d.map((v) => -v);
    const eps = 0.01;
    const probe = [0, 1, 2].map((i) => mid[i] + d[i] * eps - (n[i] / nl) * eps);
    return solidAt(world, ...probe) ? null : mid.map((v) => +v.toFixed(3));
  };
  for (const list of owner.values()) {
    if (list.length % 2 === 0) continue;
    // A hole only if light gets past behind every face that ends on this edge.
    const found = list.map(leaks);
    if (found.every(Boolean)) out.push(found[0]);
  }
  return out;
}
