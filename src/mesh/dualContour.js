/**
 * Chunk mesher. Two kinds of voxel, two exact methods:
 *
 * Building pieces (voxels with a shape state) are drawn as their exact
 * polygons (see shapes.js), skipping faces a neighbouring piece covers.
 *
 * Smooth terrain is dual contoured from its hermite data. Every voxel edge
 * where terrain ends stores the exact crossing point and normal (see
 * World/csg.js); where terrain meets a building piece the surface is the
 * piece's face, halfway along the edge. Each cell (the cube between eight
 * voxel centres) gets one vertex: the point that best fits the tangent
 * planes of its crossings (a small least-squares solve). Each crossed edge
 * gets a quad joining the four cells around it. Natural materials are
 * softened a little: vertices move partway toward the crossings' average.
 *
 * Terrain quads take the material of their solid voxel, or its cut form
 * (Cut Log) where an edit opened that edge (World/Chunk `cut`).
 *
 * Shading: terrain uses the average of a cell's crossing normals; pieces
 * their own face normals. AO samples how much opaque material is just outside.
 *
 * Texture blending: each cell's vertex has a material, voted by its crossings
 * (most wins; a tie goes to the higher one). A natural terrain triangle's
 * `blend` packs its three vertices' materials (m0 | m1 << 8 | m2 << 16); the
 * shader fades between them across the triangle, so borders between
 * materials are soft. 0 means no blending (pieces, crafted or glass terrain).
 * (`material` stays the quad's own solid voxel's material, which picks its pass.)
 *
 * Texturing: piece vertices also carry `local`: where they sit within the
 * whole piece they belong to (0..1 per axis; xyz) and its kind of shape (w:
 * 1 box or wedge, 2 round, 3 sphere; 0 for terrain). Materials mapped per
 * piece (logs, glass) use it, so rings centre on a log and a glass frame
 * follows the piece's outline.
 *
 * Render passes: every triangle goes to its material's pass (opaque, cutout,
 * translucent; see materials.js), output in that order as `groups`. A piece
 * face is only hidden by a neighbour that's opaque or of the same material,
 * so stone behind glass is still drawn, and glass-to-glass faces merge.
 *
 * Chunks are meshed from a copy padded by PAD voxels, so seams match.
 */

import { unpackNormal } from '../world/normals.js';
import { stateGeometry, faceHidden, DIRS, shapeKind } from '../world/shapes.js';
import { PASS, OPAQUE } from '../world/materials.js';

/** Voxels of border each side of a chunk needed to mesh it. */
export const PAD = 3;

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Corner k of a cell is offset (k & 1, (k >> 1) & 1, (k >> 2) & 1).
const CELL_EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) CELL_EDGES.push(a, a | bit);
const BIT_AXIS = { 1: 0, 2: 1, 4: 2 };

/**
 * @param {object} p        padded chunk: { mat, et, en, size, origin } (see World.buildPadded)
 * @param {Float32Array} crisp  crispness 0..1 per material id
 * @param {number} scale    metres per voxel (output positions are in metres)
 */
export function meshChunk(p, crisp, scale = 1) {
  const { mat, shape, et, en, size, origin } = p;
  const offs = p.off || new Uint8Array(mat.length);
  const N = size + 2 * PAD;
  const NN = N * N;
  const [ox, oy, oz] = origin;
  const off = (d) => d[0] + N * d[1] + NN * d[2];

  // Opaque solidity as 0/255, for AO; and which voxels are smooth terrain.
  const occ = new Uint8Array(mat.length);
  const ter = new Uint8Array(mat.length);
  for (let i = 0; i < mat.length; i++) {
    occ[i] = OPAQUE[mat[i]] ? 255 : 0;
    ter[i] = mat[i] && !shape[i] ? 1 : 0;
  }

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

  // ---- least squares over tangent planes
  const qef = new Float64Array(9);
  const qOut = new Float64Array(3);
  const n3 = [0, 0, 0];
  // Natural materials: pull toward the crossings' average (stability on thin
  // features, softer edges); crafted ones: exact.
  const SOFT_BIAS = 0.05, SOFT_SHARPNESS = 0.75;
  /** Crafted materials: vertex normals more than ~25° off their face use the face normal. */
  const CREASE_COS = Math.cos((25 * Math.PI) / 180);

  function addPlane(px, py, pz, nx, ny, nz) {
    const d = nx * px + ny * py + nz * pz;
    qef[0] += nx * nx; qef[1] += nx * ny; qef[2] += nx * nz;
    qef[3] += ny * ny; qef[4] += ny * nz; qef[5] += nz * nz;
    qef[6] += nx * d; qef[7] += ny * d; qef[8] += nz * d;
  }

  /** Solve (AᵀA + λI) x = Aᵀb + λm into qOut, clamped to the cell. */
  function solveQEF(L, mx, my, mz) {
    const a00 = qef[0] + L, a01 = qef[1], a02 = qef[2], a11 = qef[3] + L, a12 = qef[4], a22 = qef[5] + L;
    const b0 = qef[6] + L * mx, b1 = qef[7] + L * my, b2 = qef[8] + L * mz;
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    let x = mx, y = my, z = mz;
    if (Math.abs(det) > 1e-12) {
      const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
      x = (c00 * b0 + c01 * b1 + c02 * b2) / det;
      y = (c01 * b0 + c11 * b1 + c12 * b2) / det;
      z = (c02 * b0 + c12 * b1 + c22 * b2) / det;
    }
    qOut[0] = x < 0 ? 0 : x > 1 ? 1 : x;
    qOut[1] = y < 0 ? 0 : y > 1 ? 1 : y;
    qOut[2] = z < 0 ? 0 : z > 1 ? 1 : z;
  }

  const C = size + 1;
  const cellBase = PAD - 1;
  const cellSlot = new Int32Array(C * C * C).fill(-1);
  const cPos = [], cNrm = [], cAo = [], cMat = [];
  const corI = new Int32Array(8);
  // Scratch for a cell's material vote (a cell has at most 12 crossings).
  const voteMat = new Uint8Array(12), voteCount = new Uint8Array(12), voteTop = new Uint8Array(12);

  function cell(px, py, pz) {
    const key = (px - cellBase) + C * ((py - cellBase) + C * (pz - cellBase));
    const existing = cellSlot[key];
    if (existing >= 0) return existing;

    let crispness = 0;
    for (let k = 0; k < 8; k++) {
      const ci = (px + (k & 1)) + N * (py + ((k >> 1) & 1)) + NN * (pz + ((k >> 2) & 1));
      corI[k] = ci;
      if (ter[ci] && crisp[mat[ci]] > crispness) crispness = crisp[mat[ci]];
    }

    qef.fill(0);
    let sx = 0, sy = 0, sz = 0, n = 0, snx = 0, sny = 0, snz = 0;
    let kinds = 0; // materials tallied in vote*
    for (let e = 0; e < CELL_EDGES.length; e += 2) {
      const a = CELL_EDGES[e], b = CELL_EDGES[e + 1];
      const ia = corI[a], ib = corI[b];
      if (ter[ia] === ter[ib]) continue;
      const axis = BIT_AXIS[b - a];
      // Vote for the cell's material: that of the solid end of each crossing.
      {
        const solid = ter[ia] ? a : b;
        const m = mat[corI[solid]], h = (solid >> 1) & 1;
        let k = 0;
        while (k < kinds && voteMat[k] !== m) k++;
        if (k === kinds) { voteMat[k] = m; voteCount[k] = 0; voteTop[k] = 0; kinds++; }
        voteCount[k]++;
        if (h > voteTop[k]) voteTop[k] = h;
      }
      let t;
      if (shape[ia] || shape[ib]) {
        // Terrain meets a building piece: on the piece's face, normal out of the terrain.
        t = 0.5;
        const sg = ter[ia] ? 1 : -1;
        n3[0] = axis === 0 ? sg : 0; n3[1] = axis === 1 ? sg : 0; n3[2] = axis === 2 ? sg : 0;
      } else {
        const k = ia * 3 + axis;
        t = et[k] / 255;
        unpackNormal(en[k * 2], en[k * 2 + 1], n3);
      }
      const cx = (a & 1) + (axis === 0 ? t : 0);
      const cy = ((a >> 1) & 1) + (axis === 1 ? t : 0);
      const cz = ((a >> 2) & 1) + (axis === 2 ? t : 0);
      addPlane(cx, cy, cz, n3[0], n3[1], n3[2]);
      sx += cx; sy += cy; sz += cz; n++;
      snx += n3[0]; sny += n3[1]; snz += n3[2];
    }
    // Most crossings win; a tie goes to the material that reaches higher
    // (the surface layer over what's under it).
    let best = 0;
    for (let k = 1; k < kinds; k++)
      if (voteCount[k] > voteCount[best] || (voteCount[k] === voteCount[best] && voteTop[k] > voteTop[best])) best = k;
    sx /= n; sy /= n; sz /= n;
    solveQEF(SOFT_BIAS * (1 - crispness) + 1e-4, sx, sy, sz);
    const kk = SOFT_SHARPNESS + (1 - SOFT_SHARPNESS) * crispness;
    // q: vertex in padded sample coordinates (sample P sits at q = P).
    const qx = px + sx + (qOut[0] - sx) * kk;
    const qy = py + sy + (qOut[1] - sy) * kk;
    const qz = pz + sz + (qOut[2] - sz) * kk;

    let nl = Math.hypot(snx, sny, snz);
    if (nl < 1e-6) { snx = 0; sny = 1; snz = 0; nl = 1; }
    const nx = snx / nl, ny = sny / nl, nz = snz / nl;

    // AO: how much solid lies just outside the surface.
    const occl = (field(occ, qx + nx, qy + ny, qz + nz) + field(occ, qx + nx * 2, qy + ny * 2, qz + nz * 2)) / 2;
    const ao = 1 - Math.min(0.5, occl * 1.2);

    const slot = cAo.length;
    // World position (metres): sample P sits at voxel origin + (P - PAD) + 0.5.
    cPos.push((ox + qx - PAD + 0.5) * scale, (oy + qy - PAD + 0.5) * scale, (oz + qz - PAD + 0.5) * scale);
    cNrm.push(nx, ny, nz);
    cAo.push(ao);
    cMat.push(voteMat[best]);
    cellSlot[key] = slot;
    return slot;
  }

  // One output stream per render pass; terrain first, then pieces.
  const streams = [0, 1, 2].map(() => ({ pos: [], nrm: [], mat: [], blend: [], ao: [], local: [], terrain: 0 }));
  const quad = [0, 0, 0, 0];
  /** Only natural, opaque terrain blends into its neighbours; crafted and glass stay as they are. */
  const blendable = (m) => m !== 0 && OPAQUE[m] === 1 && crisp[m] < 0.5;

  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const px = lx + PAD, py = ly + PAD, pz = lz + PAD;
        const ia = px + N * py + NN * pz;
        const sa = ter[ia] === 1;
        for (let axis = 0; axis < 3; axis++) {
          const d = AX[axis];
          const ib = ia + off(d);
          const sb = ter[ib] === 1;
          if (sa === sb) continue;

          const u = AX[(axis + 1) % 3], v = AX[(axis + 2) % 3];
          quad[0] = cell(px - u[0] - v[0], py - u[1] - v[1], pz - u[2] - v[2]);
          quad[1] = cell(px - v[0], py - v[1], pz - v[2]);
          quad[2] = cell(px, py, pz);
          quad[3] = cell(px - u[0], py - u[1], pz - u[2]);

          // Each quad is one crossed edge.
          const m = mat[sa ? ia : ib];
          const o = streams[PASS[m]];
          const dir = sa ? 1 : -1;
          const p0 = quad[0] * 3, p1 = quad[1] * 3, p2 = quad[2] * 3, p3 = quad[3] * 3;
          const d1x = cPos[p2] - cPos[p0], d1y = cPos[p2 + 1] - cPos[p0 + 1], d1z = cPos[p2 + 2] - cPos[p0 + 2];
          const d2x = cPos[p3] - cPos[p1], d2y = cPos[p3 + 1] - cPos[p1 + 1], d2z = cPos[p3 + 2] - cPos[p1 + 2];
          const facing = ((d1y * d2z - d1z * d2y) * d[0] + (d1z * d2x - d1x * d2z) * d[1] + (d1x * d2y - d1y * d2x) * d[2]) * dir;
          const order = facing >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];

          // Crafted materials: where a vertex's smooth normal leans well away
          // from this face (an edge or corner), use the face's own normal.
          const crease = crisp[m] >= 0.5;
          for (let t = 0; t < 6; t += 3) {
            let gx = 0, gy = 0, gz = 0;
            if (crease) {
              const a = quad[order[t]] * 3, b = quad[order[t + 1]] * 3, c = quad[order[t + 2]] * 3;
              const ux = cPos[b] - cPos[a], uy = cPos[b + 1] - cPos[a + 1], uz = cPos[b + 2] - cPos[a + 2];
              const vx = cPos[c] - cPos[a], vy = cPos[c + 1] - cPos[a + 1], vz = cPos[c + 2] - cPos[a + 2];
              gx = uy * vz - uz * vy; gy = uz * vx - ux * vz; gz = ux * vy - uy * vx;
              const gl = Math.hypot(gx, gy, gz);
              if (gl > 1e-12) { gx /= gl; gy /= gl; gz /= gl; } else { gx = gy = gz = 0; }
            }
            // Natural terrain blends its textures: the triangle carries its three
            // cells' materials, and each vertex stands for its own (see terrainMaterial.js).
            let blend = 0;
            if (blendable(m)) {
              const c0 = cMat[quad[order[t]]], c1 = cMat[quad[order[t + 1]]], c2 = cMat[quad[order[t + 2]]];
              if (blendable(c0) && blendable(c1) && blendable(c2)) blend = c0 | (c1 << 8) | (c2 << 16);
            }
            for (let j = t; j < t + 3; j++) {
              const s = quad[order[j]];
              o.pos.push(cPos[s * 3], cPos[s * 3 + 1], cPos[s * 3 + 2]);
              const nx = cNrm[s * 3], ny = cNrm[s * 3 + 1], nz = cNrm[s * 3 + 2];
              if (crease && (gx || gy || gz) && nx * gx + ny * gy + nz * gz < CREASE_COS) o.nrm.push(gx, gy, gz);
              else o.nrm.push(nx, ny, nz);
              o.mat.push(m);
              o.blend.push(blend);
              o.ao.push(cAo[s]);
              o.local.push(0, 0, 0, 0);
            }
          }
        }
      }

  // ---- building pieces: exact geometry per shape state
  for (const o of streams) o.terrain = o.ao.length;
  const dirOff = DIRS.map(off);
  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const px = lx + PAD, py = ly + PAD, pz = lz + PAD;
        const i = px + N * py + NN * pz;
        const st = shape[i];
        if (!st) continue;
        const m = mat[i];
        const o = streams[PASS[m]];
        const g = stateGeometry(st);
        // The piece this voxel belongs to: its corner (padded coords) and size per axis.
        const ob = offs[i];
        const corner = [px - (ob & 1), py - ((ob >> 1) & 1), pz - ((ob >> 2) & 1)];
        const extent = [1, 1, 1];
        for (let a = 0; a < 3; a++) {
          if ((ob >> a) & 1) { extent[a] = 2; continue; }
          // Does any voxel of the same piece sit one step further along this axis?
          for (let k = 0; k < 8 && extent[a] === 1; k++) {
            if (!((k >> a) & 1)) continue;
            const j = corner[0] + (k & 1) + N * (corner[1] + ((k >> 1) & 1)) + NN * (corner[2] + ((k >> 2) & 1));
            if (!shape[j] || mat[j] !== m) continue;
            const q = offs[j];
            if ((q & 7) === (k & 7)) extent[a] = 2;
          }
        }
        const kind = shapeKind(st);
        const bx = px - corner[0], by = py - corner[1], bz = pz - corner[2];
        for (const f of g.faces) {
          if (f.dir >= 0) {
            const j = i + dirOff[f.dir];
            if (faceHidden(st, f.dir, shape[j]) && (OPAQUE[mat[j]] || mat[j] === m)) continue;
          }
          for (let k = 0; k < f.pos.length; k += 3) {
            const vx = f.pos[k], vy = f.pos[k + 1], vz = f.pos[k + 2];
            const nx = f.nrm[k], ny = f.nrm[k + 1], nz = f.nrm[k + 2];
            o.pos.push((ox + lx + vx) * scale, (oy + ly + vy) * scale, (oz + lz + vz) * scale);
            o.nrm.push(nx, ny, nz);
            o.mat.push(m);
            o.blend.push(0);
            o.local.push((bx + vx) / extent[0], (by + vy) / extent[1], (bz + vz) / extent[2], kind);
            // Padded sample coordinates of the vertex (sample P sits at the voxel's centre).
            const qx = px + vx - 0.5, qy = py + vy - 0.5, qz = pz + vz - 0.5;
            const occl = (field(occ, qx + nx * 0.6, qy + ny * 0.6, qz + nz * 0.6) + field(occ, qx + nx * 1.5, qy + ny * 1.5, qz + nz * 1.5)) / 2;
            o.ao.push(1 - Math.min(0.5, occl * 1.0));
          }
        }
      }

  // Concatenate the passes: groups are vertex ranges (start, count) per pass.
  const total = streams.reduce((n, o) => n + o.ao.length, 0);
  const position = new Float32Array(total * 3), normal = new Float32Array(total * 3);
  const material = new Float32Array(total), ao = new Float32Array(total), local = new Float32Array(total * 4);
  const blend = new Float32Array(total);
  const groups = [];
  let at = 0;
  streams.forEach((o, pass) => {
    const n = o.ao.length;
    if (!n) return;
    position.set(o.pos, at * 3);
    normal.set(o.nrm, at * 3);
    material.set(o.mat, at);
    blend.set(o.blend, at);
    ao.set(o.ao, at);
    local.set(o.local, at * 4);
    groups.push({ start: at, count: n, pass, terrain: o.terrain });
    at += n;
  });
  return {
    position, normal, material, blend, ao, local, groups,
    /** Terrain vertices at the start of the opaque pass. */
    terrainVertices: streams[0].terrain,
    triangles: total / 3,
  };
}
