/**
 * Hybrid mesher over one voxel grid (material + occupancy per voxel).
 *
 * Every voxel's occupancy byte is the *terrain field*. A voxel whose material
 * is "hard" additionally holds a block: a full unit cube, whatever its
 * occupancy says. So one grid carries both, and they are meshed separately:
 *
 *  1. Blocks: exact cube faces (with Minecraft-style corner AO). A face is
 *     skipped when the neighbour is another block or fully buried terrain.
 *     Block geometry never deforms.
 *  2. Terrain: naive surface nets over the occupancy field, ignoring blocks.
 *     The field continues smoothly through block voxels, so terrain runs
 *     into a block and is hidden by its faces: a clean, hard intersection
 *     line instead of skinned or warped geometry. Terrain quads that lie
 *     entirely inside blocks are dropped.
 *
 * Terrain normals come from the gradient of the trilinearly interpolated
 * field and AO from sampling that field along the normal. Neither depends on
 * where a vertex sits in the voxel grid, so slopes shade without banding, and
 * both read shared voxel data, so chunk seams match.
 */

/** Voxels of border each side of a chunk needed to mesh it. */
export const PAD = 4;

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const BLOCK_AO = [0.5, 0.66, 0.83, 1];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Corner k of a cell is offset (k & 1, (k >> 1) & 1, (k >> 2) & 1).
const CELL_EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) CELL_EDGES.push(a, a | bit);

/**
 * @param {Uint8Array} occ   padded occupancy (terrain field), (size + 2·PAD)³
 * @param {Uint8Array} mat   padded material ids
 * @param {number} size      chunk size (voxels per side)
 * @param {number[]} origin  world coordinate of the chunk's voxel (0,0,0)
 * @param {Uint8Array} hard  HARD[materialId] === 1 for block materials
 * @param {number} fallbackMat  terrain material used under blocks when none is nearby
 */
export function meshChunk(occ, mat, size, origin, hard, fallbackMat = 2) {
  const N = size + 2 * PAD;
  const NN = N * N;
  const [ox, oy, oz] = origin;
  const off = (d) => d[0] + N * d[1] + NN * d[2];

  const isHard = (i) => hard[mat[i]] === 1;
  const isSolid = (i) => hard[mat[i]] === 1 || occ[i] >= 128;

  // Occluder field for AO: blocks count as fully solid.
  const occA = new Uint8Array(occ.length);
  for (let i = 0; i < occ.length; i++) occA[i] = hard[mat[i]] ? 255 : occ[i];

  /** Trilinear sample of a padded field; q is in padded sample coordinates. */
  function field(arr, qx, qy, qz) {
    const m = N - 1.0001;
    qx = qx < 0 ? 0 : qx > m ? m : qx;
    qy = qy < 0 ? 0 : qy > m ? m : qy;
    qz = qz < 0 ? 0 : qz > m ? m : qz;
    const x0 = qx | 0, y0 = qy | 0, z0 = qz | 0;
    const fx = qx - x0, fy = qy - y0, fz = qz - z0;
    const i = x0 + N * y0 + NN * z0;
    const c00 = arr[i] + (arr[i + 1] - arr[i]) * fx;
    const c10 = arr[i + N] + (arr[i + N + 1] - arr[i + N]) * fx;
    const c01 = arr[i + NN] + (arr[i + NN + 1] - arr[i + NN]) * fx;
    const c11 = arr[i + NN + N] + (arr[i + NN + N + 1] - arr[i + NN + N]) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return (c0 + (c1 - c0) * fz) / 255;
  }

  // ---------------------------------------------------------------- blocks
  const bPos = [], bNrm = [], bMat = [], bAo = [];
  const cornerPos = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const cornerAo = [0, 0, 0, 0];

  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const i = (lx + PAD) + N * (ly + PAD) + NN * (lz + PAD);
        if (!isHard(i)) continue;
        const m = mat[i];
        for (let axis = 0; axis < 3; axis++) {
          const d = AX[axis], u = AX[(axis + 1) % 3], v = AX[(axis + 2) % 3];
          const dOff = off(d), uOff = off(u), vOff = off(v);
          for (const s of [1, -1]) {
            const front = i + s * dOff;
            if (isHard(front) || occ[front] === 255) continue;

            const bx = ox + lx + (s > 0 ? d[0] : 0);
            const by = oy + ly + (s > 0 ? d[1] : 0);
            const bz = oz + lz + (s > 0 ? d[2] : 0);
            for (let k = 0; k < 4; k++) {
              const [cu, cv] = CORNERS[k];
              cornerPos[k][0] = bx + cu * u[0] + cv * v[0];
              cornerPos[k][1] = by + cu * u[1] + cv * v[1];
              cornerPos[k][2] = bz + cu * u[2] + cv * v[2];
              const du = cu ? uOff : -uOff, dv = cv ? vOff : -vOff;
              const s1 = isSolid(front + du), s2 = isSolid(front + dv), c = isSolid(front + du + dv);
              cornerAo[k] = BLOCK_AO[s1 && s2 ? 0 : 3 - (s1 + s2 + c)];
            }
            // Counter-clockwise seen from outside; flip the diagonal to keep AO gradients even.
            const o = s > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
            const tri = cornerAo[o[0]] + cornerAo[o[2]] >= cornerAo[o[1]] + cornerAo[o[3]]
              ? [o[0], o[1], o[2], o[0], o[2], o[3]]
              : [o[1], o[2], o[3], o[1], o[3], o[0]];
            for (const k of tri) {
              bPos.push(cornerPos[k][0], cornerPos[k][1], cornerPos[k][2]);
              bNrm.push(d[0] * s, d[1] * s, d[2] * s);
              bMat.push(m);
              bAo.push(cornerAo[k]);
            }
          }
        }
      }

  // --------------------------------------------------------------- terrain
  const C = size + 1;
  const cellBase = PAD - 1;
  const cellSlot = new Int32Array(C * C * C).fill(-1);
  const cPos = [];
  const cNrm = [];
  const cAo = [];
  const cInBlock = [];
  const corO = new Float32Array(8);

  /** Is padded-voxel-space point r inside (or on the surface of) a block? */
  function inBlock(rx, ry, rz) {
    const e = 1e-3;
    for (const dx of [-e, e])
      for (const dy of [-e, e])
        for (const dz of [-e, e]) {
          const X = Math.floor(rx + dx), Y = Math.floor(ry + dy), Z = Math.floor(rz + dz);
          if (X < 0 || Y < 0 || Z < 0 || X >= N || Y >= N || Z >= N) continue;
          if (isHard(X + N * Y + NN * Z)) return true;
        }
    return false;
  }

  function cell(px, py, pz) {
    const key = (px - cellBase) + C * ((py - cellBase) + C * (pz - cellBase));
    const existing = cellSlot[key];
    if (existing >= 0) return existing;

    for (let k = 0; k < 8; k++) {
      corO[k] = occ[(px + (k & 1)) + N * (py + ((k >> 1) & 1)) + NN * (pz + ((k >> 2) & 1))] / 255;
    }
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let e = 0; e < CELL_EDGES.length; e += 2) {
      const a = CELL_EDGES[e], b = CELL_EDGES[e + 1];
      const oa = corO[a], ob = corO[b];
      if ((oa >= 0.5) === (ob >= 0.5)) continue;
      const t = (0.5 - oa) / (ob - oa);
      sx += (a & 1) + (((b & 1) - (a & 1)) * t);
      sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
      sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
      n++;
    }
    // q: vertex position in padded sample coordinates (sample P sits at q = P).
    const qx = px + sx / n, qy = py + sy / n, qz = pz + sz / n;

    // Normal: central-difference gradient of the smooth field (solid → empty).
    let gx = field(occ, qx + 1, qy, qz) - field(occ, qx - 1, qy, qz);
    let gy = field(occ, qx, qy + 1, qz) - field(occ, qx, qy - 1, qz);
    let gz = field(occ, qx, qy, qz + 1) - field(occ, qx, qy, qz - 1);
    let len = Math.hypot(gx, gy, gz);
    if (len < 1e-5) { gx = 0; gy = -1; gz = 0; len = 1; }
    const nx = -gx / len, ny = -gy / len, nz = -gz / len;

    // AO: how much solid stuff (terrain or blocks) lies just outside the surface.
    const occl =
      (field(occA, qx + nx * 1.0, qy + ny * 1.0, qz + nz * 1.0) +
        field(occA, qx + nx * 2.0, qy + ny * 2.0, qz + nz * 2.0) +
        field(occA, qx + nx * 3.0, qy + ny * 3.0, qz + nz * 3.0)) / 3;
    const ao = 1 - Math.min(0.55, occl * 1.5);

    const slot = cAo.length;
    // World position: sample P sits at origin + (P - PAD) + 0.5.
    cPos.push(ox + qx - PAD + 0.5, oy + qy - PAD + 0.5, oz + qz - PAD + 0.5);
    cNrm.push(nx, ny, nz);
    cAo.push(ao);
    cInBlock.push(inBlock(qx + 0.5, qy + 0.5, qz + 0.5));
    cellSlot[key] = slot;
    return slot;
  }

  /** Terrain material for a block voxel's field: borrow a nearby terrain material. */
  function terrainMat(i) {
    for (const o of [-N, 1, -1, NN, -NN, N]) {
      const j = i + o;
      if (j >= 0 && j < occ.length && !isHard(j) && occ[j] > 0 && mat[j]) return mat[j];
    }
    return fallbackMat;
  }

  const tPos = [], tNrm = [], tMat = [], tAo = [];
  const quad = [0, 0, 0, 0];

  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const px = lx + PAD, py = ly + PAD, pz = lz + PAD;
        const ia = px + N * py + NN * pz;
        const sa = occ[ia] >= 128;
        for (let axis = 0; axis < 3; axis++) {
          const d = AX[axis];
          const ib = ia + off(d);
          const sb = occ[ib] >= 128;
          if (sa === sb) continue;

          const u = AX[(axis + 1) % 3], v = AX[(axis + 2) % 3];
          quad[0] = cell(px - u[0] - v[0], py - u[1] - v[1], pz - u[2] - v[2]);
          quad[1] = cell(px - v[0], py - v[1], pz - v[2]);
          quad[2] = cell(px, py, pz);
          quad[3] = cell(px - u[0], py - u[1], pz - u[2]);
          if (cInBlock[quad[0]] && cInBlock[quad[1]] && cInBlock[quad[2]] && cInBlock[quad[3]]) continue;

          const solid = sa ? ia : ib;
          const m = isHard(solid) ? terrainMat(solid) : mat[solid];
          const dir = sa ? 1 : -1;

          const p0 = quad[0] * 3, p1 = quad[1] * 3, p2 = quad[2] * 3, p3 = quad[3] * 3;
          const d1x = cPos[p2] - cPos[p0], d1y = cPos[p2 + 1] - cPos[p0 + 1], d1z = cPos[p2 + 2] - cPos[p0 + 2];
          const d2x = cPos[p3] - cPos[p1], d2y = cPos[p3 + 1] - cPos[p1 + 1], d2z = cPos[p3 + 2] - cPos[p1 + 2];
          const facing = ((d1y * d2z - d1z * d2y) * d[0] + (d1z * d2x - d1x * d2z) * d[1] + (d1x * d2y - d1y * d2x) * d[2]) * dir;
          const order = facing >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
          for (const k of order) {
            const s = quad[k];
            tPos.push(cPos[s * 3], cPos[s * 3 + 1], cPos[s * 3 + 2]);
            tNrm.push(cNrm[s * 3], cNrm[s * 3 + 1], cNrm[s * 3 + 2]);
            tMat.push(m);
            tAo.push(cAo[s]);
          }
        }
      }

  const join = (a, b) => {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  return {
    position: join(bPos, tPos),
    normal: join(bNrm, tNrm),
    material: join(bMat, tMat),
    ao: join(bAo, tAo),
    blockVertices: bPos.length / 3,
    triangles: (bPos.length + tPos.length) / 9,
  };
}
