/**
 * Foliage mesher: the plant layer (see world/plants.js) of one padded chunk.
 *
 * Cross plants (grass, flowers) stand on the ground under their voxel. On
 * smooth terrain the exact ground height and slope come from the hermite
 * crossing on the vertical edge below (the same data the terrain is meshed
 * from), so tufts sit on the surface you see, not on the voxel grid. On a
 * building piece they stand on its flat top. Each voxel gets a few clumps of
 * two crossed cards, jittered by a hash of the world position, so re-meshing
 * after an edit nearby puts every tuft back exactly where it was.
 *
 * Leaves are drawn as a whole canopy: a smooth hull around the leaf voxels
 * (surface nets over a softened occupancy field), with leaf cards scattered
 * over it for a ragged outline. Hull normals are the field's gradient, so the
 * canopy shades like one soft volume.
 *
 * Output per vertex: position (metres), normal, uvl (u, v, texture layer),
 * wind (how far it sways: 0 at a plant's root, 1 at the tip) and ao. Groups:
 * { start, count, materialIndex } with 0 = grass/flowers, 1 = leaves.
 */

import { unpackNormal } from '../world/normals.js';
import { faceKey } from '../world/shapes.js';
import { PLANTS, PLANT_KIND } from '../world/plants.js';
import { TEXTURE_NAMES } from '../render/textures.js';
import { PAD } from './dualContour.js';

const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const LAYER = PLANTS.map((p) => (p.texture ? TEXTURE_NAMES.indexOf(p.texture) : 0));
const HULL_LAYER = TEXTURE_NAMES.indexOf('leaves_hull');
const CARD_LAYER = TEXTURE_NAMES.indexOf('leaves');

// Corner k of a cell is offset (k & 1, (k >> 1) & 1, (k >> 2) & 1).
const CELL_EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) CELL_EDGES.push(a, a | bit);

/** Hash of integer world coordinates and a salt, in [0, 1). */
export function hash4(x, y, z, k) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440670441) ^ Math.imul(k | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2654435761);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

class Stream {
  constructor() { this.pos = []; this.nrm = []; this.uvl = []; this.wind = []; this.ao = []; }
  vertex(x, y, z, n, u, v, layer, wind, ao) {
    this.pos.push(x, y, z);
    this.nrm.push(n[0], n[1], n[2]);
    this.uvl.push(u, v, layer);
    this.wind.push(wind);
    this.ao.push(ao);
  }
  /** Quad a-b-c-d (each [x, y, z, u, v, wind, ao]) as two triangles. */
  quad(a, b, c, d, n, layer) {
    for (const p of [a, b, c, a, c, d]) this.vertex(p[0], p[1], p[2], n, p[3], p[4], layer, p[5], p[6]);
  }
}

/**
 * @param {object} p      padded chunk from World.buildPadded (needs `plant`)
 * @param {number} scale  metres per voxel
 */
export function meshFoliage(p, scale = 1) {
  const cross = new Stream(), leaves = new Stream();
  if (p.plant) {
    crossPlants(p, scale, cross);
    canopy(p, scale, leaves);
  }
  const total = cross.ao.length + leaves.ao.length;
  const out = {
    position: new Float32Array(total * 3), normal: new Float32Array(total * 3),
    uvl: new Float32Array(total * 3), wind: new Float32Array(total), ao: new Float32Array(total),
    groups: [], triangles: total / 3,
  };
  let at = 0;
  [cross, leaves].forEach((s, materialIndex) => {
    const n = s.ao.length;
    if (!n) return;
    out.position.set(s.pos, at * 3);
    out.normal.set(s.nrm, at * 3);
    out.uvl.set(s.uvl, at * 3);
    out.wind.set(s.wind, at);
    out.ao.set(s.ao, at);
    out.groups.push({ start: at, count: n, materialIndex });
    at += n;
  });
  return out;
}

// ------------------------------------------------------------- cross plants

function crossPlants(p, scale, out) {
  const { mat, shape, et, en, plant, size, origin } = p;
  const N = size + 2 * PAD, NN = N * N;
  const [ox, oy, oz] = origin;
  const n = [0, 1, 0];
  const up = [0, 1, 0];
  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const i = lx + PAD + N * (ly + PAD) + NN * (lz + PAD);
        const id = plant[i];
        if (PLANT_KIND[id] !== 1 || mat[i]) continue;
        const below = i - N;
        const gx = ox + lx, gy = oy + ly, gz = oz + lz;
        // Ground height (voxels) under the voxel's centre, and its normal.
        let h0;
        if (mat[below] && !shape[below]) {
          const k = below * 3 + 1;
          unpackNormal(en[k * 2], en[k * 2 + 1], n);
          if (n[1] < 0.5) continue; // too steep to stand on
          h0 = gy - 0.5 + et[k] / 255;
        } else if (shape[below] && faceKey(shape[below], 2) === 'full') {
          n[0] = 0; n[1] = 1; n[2] = 0;
          h0 = gy;
        } else continue;

        const def = PLANTS[id];
        const layer = LAYER[id];
        for (let c = 0; c < def.clumps; c++) {
          const r = (s) => hash4(gx, gy, gz, c * 8 + s);
          const px = gx + 0.12 + 0.76 * r(0), pz = gz + 0.12 + 0.76 * r(1);
          // On the tangent plane through the crossing, kept within the voxel's reach.
          let h = h0 - (n[0] * (px - gx - 0.5) + n[2] * (pz - gz - 0.5)) / n[1];
          h = Math.max(h0 - 0.6, Math.min(h0 + 0.6, h)) - 0.04;
          const H = (def.height[0] + (def.height[1] - def.height[0]) * r(2)) / scale;
          const W = def.width * (0.8 + 0.4 * r(3)) / scale;
          const a = r(4) * Math.PI;
          const lean = [(r(5) - 0.5) * 0.25 * H, (r(6) - 0.5) * 0.25 * H];
          const flip = r(7) < 0.5;
          for (let q = 0; q < 2; q++) {
            const ang = a + q * Math.PI / 2;
            const dx = Math.cos(ang) * W / 2, dz = Math.sin(ang) * W / 2;
            const u0 = flip ? 1 : 0, u1 = 1 - u0;
            const v = (x, y, z, u, vv, w, ao) => [x * scale, y * scale, z * scale, u, vv, w, ao];
            out.quad(
              v(px - dx, h, pz - dz, u0, 0, 0, 0.55),
              v(px + dx, h, pz + dz, u1, 0, 0, 0.55),
              v(px + dx + lean[0], h + H, pz + dz + lean[1], u1, 1, 1, 1),
              v(px - dx + lean[0], h + H, pz - dz + lean[1], u0, 1, 1, 1),
              // Ground normal: tufts shade like the ground they grow from.
              n[1] > 0.999 ? up : n, layer,
            );
          }
        }
      }
}

// -------------------------------------------------------------------- canopy

/** Iso level of the softened leaf field the hull follows. */
const ISO = 0.35;

function canopy(p, scale, out) {
  const { plant, size, origin } = p;
  const N = size + 2 * PAD, NN = N * N;
  const [ox, oy, oz] = origin;
  const LEAF = new Uint8Array(N * N * N);
  let any = false;
  for (let i = 0; i < LEAF.length; i++) if (PLANT_KIND[plant[i]] === 2) { LEAF[i] = 1; any = true; }
  if (!any) return;

  // Softened field: part the voxel itself, part its 3×3×3 neighbourhood.
  const F = new Float32Array(N * N * N);
  for (let z = 1; z < N - 1; z++)
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = x + N * y + NN * z;
        let s = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += LEAF[i + dx + N * dy + NN * dz];
        F[i] = 0.4 * LEAF[i] + 0.6 * s / 27;
      }
  const field = (qx, qy, qz) => {
    const m = N - 1.0001;
    qx = Math.max(0, Math.min(m, qx)); qy = Math.max(0, Math.min(m, qy)); qz = Math.max(0, Math.min(m, qz));
    const x0 = qx | 0, y0 = qy | 0, z0 = qz | 0, fx = qx - x0, fy = qy - y0, fz = qz - z0;
    const i = x0 + N * y0 + NN * z0;
    const c00 = F[i] + (F[i + 1] - F[i]) * fx, c10 = F[i + N] + (F[i + N + 1] - F[i + N]) * fx;
    const c01 = F[i + NN] + (F[i + NN + 1] - F[i + NN]) * fx, c11 = F[i + NN + N] + (F[i + NN + N + 1] - F[i + NN + N]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  };

  // One vertex per cell the hull passes through (cells span 8 voxel centres).
  const C = size + 1, base = PAD - 1;
  const slot = new Int32Array(C * C * C).fill(-1);
  const vPos = [], vNrm = [], vAo = [], vCell = [];
  const cell = (px, py, pz) => {
    const key = (px - base) + C * ((py - base) + C * (pz - base));
    if (slot[key] >= 0) return slot[key];
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (let e = 0; e < CELL_EDGES.length; e += 2) {
      const a = CELL_EDGES[e], b = CELL_EDGES[e + 1];
      const ia = (px + (a & 1)) + N * (py + ((a >> 1) & 1)) + NN * (pz + ((a >> 2) & 1));
      const ib = (px + (b & 1)) + N * (py + ((b >> 1) & 1)) + NN * (pz + ((b >> 2) & 1));
      if (LEAF[ia] === LEAF[ib]) continue;
      const fa = F[ia], fb = F[ib];
      const t = Math.max(0.15, Math.min(0.85, Math.abs(fa - fb) > 1e-6 ? (fa - ISO) / (fa - fb) : 0.5));
      const d = b - a;
      sx += (a & 1) + (d === 1 ? t : 0);
      sy += ((a >> 1) & 1) + (d === 2 ? t : 0);
      sz += ((a >> 2) & 1) + (d === 4 ? t : 0);
      cnt++;
    }
    const qx = px + sx / cnt, qy = py + sy / cnt, qz = pz + sz / cnt;
    // Outward normal: down the field's gradient.
    let nx = field(qx - 1, qy, qz) - field(qx + 1, qy, qz);
    let ny = field(qx, qy - 1, qz) - field(qx, qy + 1, qz);
    let nz = field(qx, qy, qz - 1) - field(qx, qy, qz + 1);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    // Darker where there's more canopy just outside, and underneath.
    const outside = field(qx + nx * 1.5, qy + ny * 1.5, qz + nz * 1.5);
    const ao = (1 - Math.min(0.5, outside * 1.2)) * (0.72 + 0.28 * (ny * 0.5 + 0.5));
    // Pull the shell in a little: the cards make the outline.
    const inset = 0.25;
    const s = vAo.length;
    vPos.push(qx - nx * inset, qy - ny * inset, qz - nz * inset);
    vNrm.push(nx, ny, nz);
    vAo.push(ao);
    vCell.push(px, py, pz);
    slot[key] = s;
    return s;
  };
  const world = (q, k) => (q + [ox, oy, oz][k] - PAD + 0.5) * scale;

  const quad = [0, 0, 0, 0];
  const nv = [0, 0, 0];
  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const px = lx + PAD, py = ly + PAD, pz = lz + PAD;
        const ia = px + N * py + NN * pz;
        for (let axis = 0; axis < 3; axis++) {
          const d = AX[axis];
          const ib = ia + d[0] + N * d[1] + NN * d[2];
          if (LEAF[ia] === LEAF[ib]) continue;
          const u = AX[(axis + 1) % 3], v = AX[(axis + 2) % 3];
          quad[0] = cell(px - u[0] - v[0], py - u[1] - v[1], pz - u[2] - v[2]);
          quad[1] = cell(px - v[0], py - v[1], pz - v[2]);
          quad[2] = cell(px, py, pz);
          quad[3] = cell(px - u[0], py - u[1], pz - u[2]);
          for (const j of [0, 1, 2, 0, 2, 3]) {
            const s = quad[j] * 3;
            const x = world(vPos[s], 0), y = world(vPos[s + 1], 1), z = world(vPos[s + 2], 2);
            nv[0] = vNrm[s]; nv[1] = vNrm[s + 1]; nv[2] = vNrm[s + 2];
            // Planar UVs along the normal's main axis, one tile per metre.
            const ax = Math.abs(nv[0]), ay = Math.abs(nv[1]), az = Math.abs(nv[2]);
            const [uu, vv] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
            out.vertex(x, y, z, nv, uu, vv, HULL_LAYER, 0.12, vAo[quad[j]]);
          }
        }
      }

  // Leaf cards over the hull: one or two per hull vertex, owned by the chunk
  // that owns the cell's minimum corner (so neighbours don't double up).
  const CARD = 0.95 / scale; // card size, voxels
  for (let s = 0; s < vAo.length; s++) {
    const cx = vCell[s * 3], cy = vCell[s * 3 + 1], cz = vCell[s * 3 + 2];
    if (cx < PAD || cy < PAD || cz < PAD || cx >= PAD + size || cy >= PAD + size || cz >= PAD + size) continue;
    const gx = ox + cx - PAD, gy = oy + cy - PAD, gz = oz + cz - PAD;
    const n = [vNrm[s * 3], vNrm[s * 3 + 1], vNrm[s * 3 + 2]];
    const count = hash4(gx, gy, gz, 90) < 0.5 ? 2 : 1;
    for (let c = 0; c < count; c++) {
      const r = (k) => hash4(gx, gy, gz, 100 + c * 16 + k);
      // Card facing: the hull normal, tipped a random amount.
      let ax = n[0] + (r(0) - 0.5) * 1.6, ay = n[1] + (r(1) - 0.5) * 1.6 + 0.2, az = n[2] + (r(2) - 0.5) * 1.6;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      // Tangent frame around it, spun randomly.
      const ref = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let tx = ref[1] * az - ref[2] * ay, ty = ref[2] * ax - ref[0] * az, tz = ref[0] * ay - ref[1] * ax;
      const tl = Math.hypot(tx, ty, tz);
      tx /= tl; ty /= tl; tz /= tl;
      let bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;
      const spin = r(3) * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
      [tx, ty, tz, bx, by, bz] = [tx * cs + bx * sn, ty * cs + by * sn, tz * cs + bz * sn, bx * cs - tx * sn, by * cs - ty * sn, bz * cs - tz * sn];
      const size2 = CARD * (0.8 + 0.45 * r(4)) / 2;
      const push = 0.15 + 0.35 * r(5);
      const jx = (r(6) - 0.5) * 0.6, jy = (r(7) - 0.5) * 0.6, jz = (r(8) - 0.5) * 0.6;
      const px = vPos[s * 3] + n[0] * push + jx, py = vPos[s * 3 + 1] + n[1] * push + jy, pz = vPos[s * 3 + 2] + n[2] * push + jz;
      const corner = (su, sv, u, v) => [
        world(px + (tx * su + bx * sv) * size2, 0), world(py + (ty * su + by * sv) * size2, 1), world(pz + (tz * su + bz * sv) * size2, 2),
        u, v, 1, vAo[s] * (0.9 + 0.2 * r(9)),
      ];
      out.quad(corner(-1, -1, 0, 0), corner(1, -1, 1, 0), corner(1, 1, 1, 1), corner(-1, 1, 0, 1), n, CARD_LAYER);
    }
  }
}
