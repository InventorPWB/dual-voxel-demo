import { MATERIALS, MAT } from './materials.js';
import { applyCSG } from './csg.js';
import { CUBE } from './shapes.js';
import { settlePlants } from './plants.js';

/**
 * World edit rules shared by every tool.
 *  - Building pieces are written voxel by voxel as shape states (see
 *    shapes.js); removing one clears its cells. Terrain never overlaps them.
 *  - Terrain edits are exact booleans on the smooth terrain (csg.js):
 *    digging and raising with spheres, levelling with a plane; smoothing
 *    re-fits the surface. They never touch building pieces.
 *  - Nothing ever becomes solid inside the player (pass `protect`).
 * After terrain edits, tiny disconnected bits left floating are dissolved.
 * Plants go with whatever they stood on (settlePlants).
 */

/** Disconnected pieces this many voxels or smaller are removed after brush edits. */
export const SPECK_MAX_VOXELS = 12;

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Most common natural material among solid neighbours. */
export function terrainMaterialNear(world, x, y, z, fallback = MAT.DIRT) {
  const counts = new Map();
  let best = fallback, bestN = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!world.isTerrain(x + dx, y + dy, z + dz)) continue;
        const m = world.getMat(x + dx, y + dy, z + dz);
        if (!m || !MATERIALS[m].natural) continue;
        const n = (counts.get(m) || 0) + 1;
        counts.set(m, n);
        if (n > bestN) { bestN = n; best = m; }
      }
  return best;
}

// ---------------------------------------------------------------- regions

/** An axis-aligned voxel box clipped to the editable world (y >= 1). */
function region(world, x0, y0, z0, x1, y1, z1) {
  x0 = Math.max(0, x0); y0 = Math.max(1, y0); z0 = Math.max(0, z0);
  x1 = Math.min(world.sx - 1, x1); y1 = Math.min(world.sy - 1, y1); z1 = Math.min(world.sz - 1, z1);
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1, nz = z1 - z0 + 1;
  const empty = nx <= 0 || ny <= 0 || nz <= 0;
  return {
    x0, y0, z0, x1, y1, z1, nx, ny, nz, empty,
    size: empty ? 0 : nx * ny * nz,
    contains: (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1,
    index: (x, y, z) => (x - x0) + nx * ((y - y0) + ny * (z - z0)),
  };
}

/**
 * Dissolve tiny disconnected bits of terrain inside `r`: terrain voxels
 * connected (26-way) to nothing but air, not touching bedrock, a building
 * piece or the region boundary (where they might continue outside).
 */
export function removeSpecks(world, r) {
  if (r.empty) return 0;
  const seen = new Uint8Array(r.size);
  let removed = 0;
  const comp = [];
  for (let z = r.z0; z <= r.z1; z++)
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const i0 = r.index(x, y, z);
        if (seen[i0] || !world.isTerrain(x, y, z)) continue;
        comp.length = 0;
        let anchored = false;
        const stack = [x, y, z];
        seen[i0] = 1;
        while (stack.length) {
          const cz = stack.pop(), cy = stack.pop(), cx = stack.pop();
          comp.push(cx, cy, cz);
          for (let dz = -1; dz <= 1; dz++)
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy && !dz) continue;
                const nx = cx + dx, ny = cy + dy, nz = cz + dz;
                if (ny < 1 || world.isPiece(nx, ny, nz)) { anchored = true; continue; }
                if (!world.isTerrain(nx, ny, nz)) continue;
                if (!r.contains(nx, ny, nz)) { anchored = true; continue; }
                const j = r.index(nx, ny, nz);
                if (seen[j]) continue;
                seen[j] = 1;
                stack.push(nx, ny, nz);
              }
        }
        if (anchored || comp.length / 3 > SPECK_MAX_VOXELS) continue;
        // 26-isolated, so every neighbour is empty: clearing leaves no surface behind.
        for (let k = 0; k < comp.length; k += 3) world.setMat(comp[k], comp[k + 1], comp[k + 2], 0);
        removed += comp.length / 3;
      }
  if (removed) world.markDirtyBox(r.x0, r.y0, r.z0, r.x1, r.y1, r.z1);
  return removed;
}

function cleanup(world, box) {
  removeSpecks(world, region(world, box[0] - 2, box[1] - 2, box[2] - 2, box[3] + 2, box[4] + 2, box[5] + 2));
  settlePlants(world, [box[0] - 3, box[1] - 3, box[2] - 3, box[3] + 3, box[4] + 3, box[5] + 3]);
}

// ----------------------------------------------------------------- brushes

const sphereBox = (c, r) => [
  Math.floor(c.x - r) - 1, Math.floor(c.y - r) - 1, Math.floor(c.z - r) - 1,
  Math.floor(c.x + r) + 1, Math.floor(c.y + r) + 1, Math.floor(c.z + r) + 1,
];

/**
 * Add ('add') or remove ('sub') a sphere (centre c and radius r in voxels).
 * New ground takes `material`; ground that was already there keeps its own.
 */
export function sculptSphere(world, c, r, mode, material = MAT.DIRT, opts = {}) {
  const box = sphereBox(c, r);
  const sdf = (x, y, z) => r - Math.hypot(x - c.x, y - c.y, z - c.z);
  const normal = (x, y, z, out) => {
    const dx = x - c.x, dy = y - c.y, dz = z - c.z, l = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
    return out;
  };
  const res = applyCSG(world, mode === 'add' ? 'union' : 'subtract', box, sdf, { material, keep: true, protect: opts.protect, normal });
  if (res.touched) cleanup(world, box);
  return res.changed;
}

/**
 * Smooth the surface inside a sphere. Builds a signed-distance estimate from
 * the stored crossings, blurs it, and re-extracts solidity and crossings from
 * the result, so edges round off and dents fill over time.
 */
export function smoothBrush(world, c, r, dt, opts = {}) {
  const rg = region(world, Math.floor(c.x - r) - 2, Math.floor(c.y - r) - 2, Math.floor(c.z - r) - 2,
    Math.floor(c.x + r) + 2, Math.floor(c.y + r) + 2, Math.floor(c.z + r) + 2);
  if (rg.empty) return 0;
  const s = new Float32Array(rg.size);
  const e = [0, 0, 0];
  // 1. Signed distance estimate: distance to the nearest crossing on the
  //    voxel's own six edges (about a voxel if none), signed by solidity.
  for (let z = rg.z0; z <= rg.z1; z++)
    for (let y = rg.y0; y <= rg.y1; y++)
      for (let x = rg.x0; x <= rg.x1; x++) {
        const solid = world.isTerrain(x, y, z);
        let d = 1.2;
        for (let a = 0; a < 3; a++) {
          const [dx, dy, dz] = AXES[a];
          if (world.isTerrain(x + dx, y + dy, z + dz) !== solid && world.getEdge(x, y, z, a, e)) d = Math.min(d, e[0]);
          if (world.isTerrain(x - dx, y - dy, z - dz) !== solid && world.getEdge(x - dx, y - dy, z - dz, a, e)) d = Math.min(d, 1 - e[0]);
        }
        s[rg.index(x, y, z)] = solid ? d : -d;
      }
  // 2. Blur toward the 3×3×3 average, strongest at the centre.
  const out = new Float32Array(s);
  const weight = new Float32Array(rg.size);
  for (let z = rg.z0 + 1; z < rg.z1; z++)
    for (let y = rg.y0 + 1; y < rg.y1; y++)
      for (let x = rg.x0 + 1; x < rg.x1; x++) {
        const dist = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z);
        if (dist > r || world.isPiece(x, y, z)) continue;
        const k = Math.min(1, 6 * dt * falloff(dist / r));
        if (k <= 0) continue;
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += s[rg.index(x + dx, y + dy, z + dz)];
        const i = rg.index(x, y, z);
        let v = s[i] + (sum / 27 - s[i]) * k;
        // Never make the player's space solid.
        if (v > 0 && s[i] <= 0 && opts.protect && opts.protect(x, y, z)) v = s[i];
        out[i] = v;
        weight[i] = k;
      }
  // 3. Re-extract where the blur acted.
  let changed = 0;
  for (let z = rg.z0 + 1; z < rg.z1; z++)
    for (let y = rg.y0 + 1; y < rg.y1; y++)
      for (let x = rg.x0 + 1; x < rg.x1; x++) {
        const i = rg.index(x, y, z);
        if (!weight[i] || (s[i] > 0) === (out[i] > 0)) continue;
        world.setMat(x, y, z, out[i] > 0 ? terrainMaterialNear(world, x, y, z) : 0);
        changed++;
      }
  const at = (x, y, z) => (rg.contains(x, y, z) ? out[rg.index(x, y, z)] : 0);
  const grad = (x, y, z, a) => at(x + AXES[a][0], y + AXES[a][1], z + AXES[a][2]) - at(x - AXES[a][0], y - AXES[a][1], z - AXES[a][2]);
  for (let z = rg.z0; z < rg.z1; z++)
    for (let y = rg.y0; y < rg.y1; y++)
      for (let x = rg.x0; x < rg.x1; x++) {
        const i = rg.index(x, y, z);
        for (let a = 0; a < 3; a++) {
          const qx = x + AXES[a][0], qy = y + AXES[a][1], qz = z + AXES[a][2];
          const j = rg.index(qx, qy, qz);
          if (!weight[i] && !weight[j]) continue;
          if (world.isPiece(x, y, z) || world.isPiece(qx, qy, qz)) continue;
          const vp = out[i], vq = out[j];
          if ((vp > 0) === (vq > 0)) continue;
          const t = vp / (vp - vq);
          let gx = 0, gy = 0, gz = 0;
          for (const [px, py, pz, w] of [[x, y, z, 1 - t], [qx, qy, qz, t]]) {
            gx += grad(px, py, pz, 0) * w; gy += grad(px, py, pz, 1) * w; gz += grad(px, py, pz, 2) * w;
          }
          world.setEdge(x, y, z, a, t, -gx, -gy, -gz);
        }
      }
  world.markDirtyBox(rg.x0, rg.y0, rg.z0, rg.x1, rg.y1, rg.z1);
  if (changed) cleanup(world, [rg.x0, rg.y0, rg.z0, rg.x1, rg.y1, rg.z1]);
  return changed;
}

/**
 * Level the ground to a horizontal plane at height `planeY` (voxels) within a
 * cylinder of radius r around c: fills below the plane and cuts away above it.
 */
export function flattenBrush(world, c, r, planeY, material = MAT.DIRT, opts = {}) {
  const depth = Math.ceil(r) + 2, height = Math.ceil(r) + 4;
  const radial = (x, z) => r - Math.hypot(x - c.x, z - c.z);
  const box = [Math.floor(c.x - r) - 1, Math.floor(planeY - depth) - 1, Math.floor(c.z - r) - 1,
    Math.floor(c.x + r) + 1, Math.floor(planeY + height) + 1, Math.floor(c.z + r) + 1];
  const below = (x, y, z) => Math.min(planeY - y, radial(x, z), y - (planeY - depth));
  const above = (x, y, z) => Math.min(y - planeY, radial(x, z), planeY + height - y);
  const a = applyCSG(world, 'union', box, below, { material, keep: true, protect: opts.protect });
  const b = applyCSG(world, 'subtract', box, above);
  if (a.touched || b.touched) cleanup(world, box);
  return a.changed + b.changed;
}

/** Paint: recolour solid voxels inside the sphere. */
export function paintBrush(world, c, r, material) {
  const rg = region(world, Math.floor(c.x - r), Math.floor(c.y - r), Math.floor(c.z - r), Math.floor(c.x + r), Math.floor(c.y + r), Math.floor(c.z + r));
  let n = 0;
  for (let z = rg.z0; z <= rg.z1; z++)
    for (let y = rg.y0; y <= rg.y1; y++)
      for (let x = rg.x0; x <= rg.x1; x++) {
        const m = world.getMat(x, y, z);
        if (!m || m === material || Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z) > r) continue;
        world.setMat(x, y, z, material);
        n++;
      }
  if (n) world.markDirtyBox(rg.x0, rg.y0, rg.z0, rg.x1, rg.y1, rg.z1);
  return n;
}

function falloff(t) {
  const u = Math.max(0, 1 - t * t);
  return u * u;
}

// ------------------------------------------------------------------ shapes

/** Voxels a placed shape fills, as [x, y, z]. */
export function shapeSolidVoxels(world, p) {
  return p.voxels.filter(([x, y, z]) => world.inBounds(x, y, z)).map(([x, y, z]) => [x, y, z]);
}

/** How far a foundation may reach down to the ground under a piece, in voxels. */
const FOUNDATION = 2;

/**
 * Place a building piece (see shapes.js `placement`) in `material`. Its
 * voxels replace whatever was there; terrain around it now ends on its faces.
 * With `foundation`, gaps of up to a metre between its bottom and the ground
 * are filled with cubes of the same material, so it never floats above
 * uneven ground.
 */
export function placeShape(world, p, material, { foundation = false } = {}) {
  const inPiece = new Set(p.voxels.map(([x, y, z]) => `${x},${y},${z}`));
  let n = 0;
  const [ox, oy, oz] = p.origin;
  for (const [x, y, z, state] of p.voxels) {
    if (!world.inBounds(x, y, z) || y < 1) continue;
    world.setVoxel(x, y, z, material, state, [x - ox, y - oy, z - oz]);
    n++;
  }
  if (foundation) {
    for (const [x, y, z] of p.voxels) {
      if (inPiece.has(`${x},${y - 1},${z}`)) continue; // not a bottom voxel
      let depth = 0;
      while (depth < FOUNDATION && y - 1 - depth >= 1 && !world.isSolid(x, y - 1 - depth, z)) depth++;
      if (depth === 0 || depth >= FOUNDATION && !world.isSolid(x, y - 1 - depth, z)) continue; // resting, or nothing below
      for (let k = 1; k <= depth; k++) world.setVoxel(x, y - k, z, material, CUBE);
    }
  }
  world.markDirtyBox(ox - 1, oy - FOUNDATION - 1, oz - 1, ox + p.size[0], oy + p.size[1], oz + p.size[2]);
  // A piece with a rounded or sloped top can't carry the plants above it.
  settlePlants(world, [ox, oy, oz, ox + p.size[0] - 1, oy + p.size[1], oz + p.size[2] - 1]);
  return n;
}

/**
 * Clear a box of voxels (a piece's cell, or a cell of ground), pieces and
 * terrain alike. Terrain left around it gets flat faces on the box's sides.
 */
export function clearBox(world, x0, y0, z0, x1, y1, z1) {
  let n = 0;
  for (let z = z0; z <= z1; z++)
    for (let y = Math.max(1, y0); y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!world.isSolid(x, y, z)) continue;
        world.setVoxel(x, y, z, 0, 0);
        n++;
      }
  if (!n) return 0;
  const inBox = (x, y, z) => x >= x0 && x <= x1 && y >= Math.max(1, y0) && y <= y1 && z >= z0 && z <= z1;
  // Terrain that now borders the hole: a flat face on the cell boundary.
  for (let z = z0 - 1; z <= z1 + 1; z++)
    for (let y = Math.max(1, y0 - 1); y <= y1 + 1; y++)
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (!world.isTerrain(x, y, z)) continue;
        for (let a = 0; a < 3; a++) {
          const [dx, dy, dz] = AXES[a];
          if (inBox(x + dx, y + dy, z + dz)) world.setEdge(x, y, z, a, 0.5, dx, dy, dz);
          if (inBox(x - dx, y - dy, z - dz)) world.setEdge(x - dx, y - dy, z - dz, a, 0.5, -dx, -dy, -dz);
        }
      }
  world.markDirtyBox(x0 - 1, y0 - 1, z0 - 1, x1 + 1, y1 + 1, z1 + 1);
  removeSpecks(world, region(world, x0 - 3, y0 - 3, z0 - 3, x1 + 3, y1 + 3, z1 + 3));
  settlePlants(world, [x0 - 3, y0 - 3, z0 - 3, x1 + 3, y1 + 4, z1 + 3]);
  return n;
}

/** Remove what's in a placed shape's footprint (its whole cell). */
export function removeShape(world, p) {
  const [ox, oy, oz] = p.origin;
  return clearBox(world, ox, oy, oz, ox + p.size[0] - 1, oy + p.size[1] - 1, oz + p.size[2] - 1);
}
