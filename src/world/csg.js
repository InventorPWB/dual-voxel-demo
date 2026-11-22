/**
 * Exact CSG on hermite data (Ju et al., "Dual Contouring of Hermite Data").
 *
 * A solid is given by a signed distance function `sdf(x, y, z)` in voxel
 * units (positive inside; voxel centres sit at integer + 0.5). Each edit:
 *  - sets voxel solidity from the result of the boolean at voxel centres;
 *  - on every edge whose ends now differ, stores the exact surface point and
 *    normal: the world's existing crossing or the shape's own, whichever is
 *    the actual boundary of the result along that edge.
 * This is for smooth terrain. Building pieces (voxels with a shape state)
 * are off-limits: terrain never grows into them and edits never remove them;
 * where terrain meets one, the surface sits exactly on the piece's face (the
 * mesher puts it there), so no crossing is stored on those edges.
 */

import { CUT_OF } from './materials.js';

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const scratch = [0, 0, 0];

/**
 * Terrain that an edit cuts into shows its inside. For each removed voxel
 * ([x, y, z, ...] flat), the edges to its neighbours that are terrain of a
 * material with a `cut` form (Log) are marked cut, so the surface across
 * them is drawn as that form (end grain), whatever way it faces, while the
 * outside of the same wood stays bark. Doesn't mark meshes dirty.
 */
export function exposeCuts(world, removed) {
  for (let i = 0; i < removed.length; i += 3) {
    const x = removed[i], y = removed[i + 1], z = removed[i + 2];
    for (let a = 0; a < 3; a++) {
      const [dx, dy, dz] = AXES[a];
      // Neighbour on the + side: the edge is this voxel's; on the - side, the neighbour's.
      if (world.isTerrain(x + dx, y + dy, z + dz) && CUT_OF[world.getMat(x + dx, y + dy, z + dz)]) world.setCut(x, y, z, a);
      if (world.isTerrain(x - dx, y - dy, z - dz) && CUT_OF[world.getMat(x - dx, y - dy, z - dz)]) world.setCut(x - dx, y - dy, z - dz, a);
    }
  }
}
const nrm = [0, 0, 0];

/** Outward unit normal of an SDF at p (negative gradient), by central differences. */
export function sdfNormal(sdf, x, y, z, out = [0, 0, 0]) {
  const h = 0.01;
  const gx = sdf(x + h, y, z) - sdf(x - h, y, z);
  const gy = sdf(x, y + h, z) - sdf(x, y - h, z);
  const gz = sdf(x, y, z + h) - sdf(x, y, z - h);
  const l = Math.hypot(gx, gy, gz) || 1;
  out[0] = -gx / l; out[1] = -gy / l; out[2] = -gz / l;
  return out;
}

/**
 * Where along the edge from p (value a) toward +axis (value b) the SDF
 * crosses zero. Bisection to well below the 1/255 storage precision; falls
 * back to linear interpolation if the function itself doesn't change sign
 * (an endpoint value was overridden, e.g. by player protection).
 */
function crossing(sdf, px, py, pz, ax, a, b) {
  const dx = AXES[ax][0], dy = AXES[ax][1], dz = AXES[ax][2];
  const fa = sdf(px, py, pz), fb = sdf(px + dx, py + dy, pz + dz);
  if ((fa > 0) === (fb > 0)) return Math.max(0, Math.min(1, a / (a - b)));
  // Start from the linear guess (exact for planes), then bisect.
  let lo = 0, hi = 1;
  let t = fa / (fa - fb);
  for (let k = 0; k < 12; k++) {
    const v = sdf(px + dx * t, py + dy * t, pz + dz * t);
    if (Math.abs(v) < 1e-6) return t;
    if ((v > 0) === (fa > 0)) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/**
 * Apply a boolean to the world inside a voxel box.
 *
 * @param op        'union' | 'subtract'
 * @param box       [x0, y0, z0, x1, y1, z1], inclusive, must contain the whole
 *                  part of the shape that matters (outside it nothing changes)
 * @param sdf       signed distance, voxel units, positive inside
 * @param options.material  material for voxels the shape fills (union)
 * @param options.keep      union: keep the material of voxels that were already solid
 * @param options.protect   (x, y, z) => true for voxels that must not become solid
 * @param options.normal    optional exact normal function (x, y, z, out) for the shape
 * @returns number of voxels whose solidity changed (and whether anything changed at all)
 */
export function applyCSG(world, op, box, sdf, options = {}) {
  const { material = 1, keep = false, protect = null, normal = null } = options;
  // Clip to the world; bedrock (y = 0) is never edited.
  const x0 = Math.max(0, box[0]), y0 = Math.max(1, box[1]), z0 = Math.max(0, box[2]);
  const x1 = Math.min(world.sx - 1, box[3]), y1 = Math.min(world.sy - 1, box[4]), z1 = Math.min(world.sz - 1, box[5]);
  if (x0 > x1 || y0 > y1 || z0 > z1) return { changed: 0, touched: false };

  // Sample the shape on the box plus a one-voxel margin below (edges reach +1).
  const ex0 = x0 - 1, ey0 = y0 - 1, ez0 = z0 - 1;
  const nx = x1 - ex0 + 2, ny = y1 - ey0 + 2, nz = z1 - ez0 + 2;
  const idx = (x, y, z) => (x - ex0) + nx * ((y - ey0) + ny * (z - ez0));
  const val = new Float32Array(nx * ny * nz);
  const oldSolid = new Uint8Array(nx * ny * nz);
  const blocked = new Uint8Array(nx * ny * nz);
  const inBox = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
  for (let z = ez0; z < ez0 + nz; z++)
    for (let y = ey0; y < ey0 + ny; y++)
      for (let x = ex0; x < ex0 + nx; x++) {
        const i = idx(x, y, z);
        oldSolid[i] = world.isTerrain(x, y, z) ? 1 : 0;
        blocked[i] = world.isPiece(x, y, z) ? 1 : 0;
        // Outside the box the shape doesn't apply.
        let v = inBox(x, y, z) ? sdf(x + 0.5, y + 0.5, z + 0.5) : -1;
        if (op === 'union' && v > 0 && (blocked[i] || (protect && protect(x, y, z)))) v = -1e-3;
        val[i] = v;
      }

  const newSolid = (i) => (op === 'union' ? oldSolid[i] || val[i] > 0 : oldSolid[i] && !(val[i] > 0)) ? 1 : 0;

  // 1. Solidity and material.
  let changed = 0, touched = false;
  const removed = [];
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y, z);
        if (blocked[i]) continue;
        const was = oldSolid[i], now = newSolid(i);
        if (op === 'union') {
          if (val[i] > 0) {
            const m = keep && was ? world.getMat(x, y, z) : material;
            if (!was || world.getMat(x, y, z) !== m) { world.setMat(x, y, z, m); touched = true; }
          }
        } else if (was && !now) {
          world.setMat(x, y, z, 0);
          removed.push(x, y, z);
          touched = true;
        }
        if (was !== now) changed++;
      }

  exposeCuts(world, removed);

  // 2. Edges with at least one end in the box.
  const s = scratch;
  for (let z = ez0; z <= z1; z++)
    for (let y = ey0; y <= y1; y++)
      for (let x = ex0; x <= x1; x++) {
        for (let a = 0; a < 3; a++) {
          const qx = x + AXES[a][0], qy = y + AXES[a][1], qz = z + AXES[a][2];
          if (!inBox(x, y, z) && !inBox(qx, qy, qz)) continue;
          if (!world.inBounds(x, y, z) || !world.inBounds(qx, qy, qz)) continue;
          const ip = idx(x, y, z), iq = idx(qx, qy, qz);
          if (blocked[ip] || blocked[iq]) continue; // terrain meets a piece on its face: nothing to store
          const Rp = newSolid(ip), Rq = newSolid(iq);
          if (Rp === Rq) continue;
          const Ap = oldSolid[ip], Aq = oldSolid[iq];
          const Bp = val[ip] > 0, Bq = val[iq] > 0;
          // Positions are measured from the end that's solid in the result (u).
          // Union: the boundary is the farthest-out of the surfaces leaving u.
          // Subtract: it's the first place we leave the old solid or enter the shape.
          const fromP = Rp === 1;
          const Au = fromP ? Ap : Aq, Av = fromP ? Aq : Ap;
          const Bu = fromP ? Bp : Bq, Bv = fromP ? Bq : Bp;
          let best = -1, fromShape = false;
          const consider = (dist, shape) => {
            if (best < 0 || (op === 'union' ? dist > best : dist < best)) { best = dist; fromShape = shape; }
          };
          let haveA = false;
          if (Ap !== Aq && (op === 'union' ? Au && !Av : !Av)) {
            haveA = world.getEdge(x, y, z, a, s);
            const tA = haveA ? s[0] : 0.5;
            consider(fromP ? tA : 1 - tA, false);
          }
          if (Bp !== Bq && (op === 'union' ? Bu && !Bv : Bv)) {
            const tB = crossing(sdf, x + 0.5, y + 0.5, z + 0.5, a, val[ip], val[iq]);
            consider(fromP ? tB : 1 - tB, true);
          }
          if (best < 0) continue;
          const t = fromP ? best : 1 - best;
          if (fromShape) {
            const px = x + 0.5 + AXES[a][0] * t, py = y + 0.5 + AXES[a][1] * t, pz = z + 0.5 + AXES[a][2] * t;
            if (normal) normal(px, py, pz, nrm);
            else sdfNormal(sdf, px, py, pz, nrm);
            // Subtracting: the result's outward normal points into the removed shape.
            const sg = op === 'union' ? 1 : -1;
            world.setEdge(x, y, z, a, t, nrm[0] * sg, nrm[1] * sg, nrm[2] * sg);
          } else if (haveA) {
            continue; // the existing crossing stands, already stored
          } else {
            const sg = Rp ? 1 : -1;
            world.setEdge(x, y, z, a, t, AXES[a][0] * sg, AXES[a][1] * sg, AXES[a][2] * sg);
          }
          touched = true;
        }
      }

  if (touched) world.markDirtyBox(ex0, ey0, ez0, x1 + 1, y1 + 1, z1 + 1);
  return { changed, touched };
}

/**
 * Fill the whole world from a signed distance function (terrain generation):
 * materials from `matAt(x, y, z, d)` where solid, and exact crossings with
 * normals from the function's gradient on every surface edge.
 */
export function fillFromSDF(world, sdf, matAt) {
  const { sx, sy, sz } = world;
  const val = new Float32Array(sx * sy * sz);
  const idx = (x, y, z) => x + sx * (y + sy * z);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++)
      for (let y = sy - 1; y >= 0; y--) {
        const d = y === 0 ? 1 : sdf(x + 0.5, y + 0.5, z + 0.5);
        val[idx(x, y, z)] = d;
      }
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++)
      for (let y = 0; y < sy; y++) {
        const d = val[idx(x, y, z)];
        world.setMat(x, y, z, d > 0 ? matAt(x, y, z, d) : 0);
      }
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const a0 = val[idx(x, y, z)];
        for (let a = 0; a < 3; a++) {
          const qx = x + AXES[a][0], qy = y + AXES[a][1], qz = z + AXES[a][2];
          if (qx >= sx || qy >= sy || qz >= sz) continue;
          const b0 = val[idx(qx, qy, qz)];
          if ((a0 > 0) === (b0 > 0)) continue;
          const t = crossing(sdf, x + 0.5, y + 0.5, z + 0.5, a, a0, b0);
          sdfNormal(sdf, x + 0.5 + AXES[a][0] * t, y + 0.5 + AXES[a][1] * t, z + 0.5 + AXES[a][2] * t, nrm);
          world.setEdge(x, y, z, a, t, nrm[0], nrm[1], nrm[2]);
        }
      }
  world.markAllDirty();
}
