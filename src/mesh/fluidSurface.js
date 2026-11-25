/**
 * Water surface mesher, contoured like the terrain (for FluxSim's water).
 *
 * The surface is the boundary between air and everything that isn't air:
 * ground and water together. It's traced the way the terrain is, on the
 * grid of voxel centres: every edge between a sample inside (solid, or water
 * filled past its centre) and one outside (air, or water filled less than
 * halfway) has a crossing point, every cell of eight samples gets one vertex
 * (the average of its crossings: surface nets), and each crossed edge gets a
 * quad joining the four cells round it. Only quads with water at either end
 * of their edge are kept: the rest is ground, which the terrain mesher draws.
 *
 * Crossings:
 *  - water and air in a column: exactly at the water's level;
 *  - water and air side by side: where the water's level, run linearly from
 *    one column to the next, passes the samples' height, so a sloping
 *    surface comes out as a slope, not as steps;
 *  - ground and air: the terrain's own crossing (its hermite data), pushed
 *    out along its normal by the depth of any water lying on it, so a thin
 *    sheet running down a slope drapes over the ground at its depth;
 *  - ground beneath water lying on it: at the water's level.
 * So one mesher gives lakes, rivers and seas (flat on top, meeting the ground
 * at the shore), sheets on slopes, waterfalls and the front of a flood (as
 * real 3D faces), and water in caves and against glass, with no special cases.
 *
 * Vertices carry `normal` (smoothed), `flow` (xz: velocity from FluxSim's
 * face flows, z: 2 for water in free fall) and `depth` (metres of water
 * there, for fading the thinnest water in).
 *
 * Input: World.buildFluidPadded (with `et`/`en` hermite data and `flux`).
 */

import { OPAQUE } from '../world/materials.js';
import { unpackNormal } from '../world/normals.js';

const FULL = 1024;
/**
 * Less water than this (volume units, about 2 mm) isn't drawn. (A stream
 * running down a slope spreads into a sheet a centimetre or two deep, with
 * thinner patches in it: drawn only from 1 cm, it showed as nothing at all.)
 */
const THIN = 4;
/**
 * Water lying on the ground is drawn at least this far (voxels: 4 cm) clear of
 * it: a sheet a centimetre deep, drawn where it is, would fight the ground in
 * the depth buffer at any distance and show only in blotches.
 */
const LIFT = 0.08;
/** Depth (voxels) a vertex reports inside a body of water, however thin: fully visible (see waterMaterial uFade). */
const SHOWN = 0.2;

export function meshFluidSurface(p, scale = 1) {
  const { mat, shape, floor, et, en, flux, size, pad: P, origin } = p;
  const N = size + 2 * P, NN = N * N;
  const I = (x, y, z) => x + N * (y + N * z);
  // Water running down a slope leaves the odd voxel dry in the middle of it
  // (a rivulet goes round a bump). Drawn as it is, each shows as a hole in
  // the sheet; so for drawing, a dry voxel with water on at least three sides
  // takes their average.
  const fluid = p.fluid.slice();
  for (let z = 1; z < N - 1; z++)
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = I(x, y, z);
        if (p.mat[i] || (p.fluid[i] & 4095) >= THIN || !p.mat[i - N]) continue;
        let n = 0, sum = 0;
        for (const j of [i - 1, i + 1, i - NN, i + NN]) {
          const v = p.fluid[j] & 4095;
          if (!p.mat[j] && v >= THIN) { n++; sum += v; }
        }
        // (Or two, if it holds a trace of water itself: part of the same thin sheet.)
        if (n >= 3 || (n >= 2 && (p.fluid[i] & 4095) > 0)) fluid[i] = (1 << 12) | Math.round(sum / n);
      }
  const vol = (i) => fluid[i] & 4095;
  const solid = (i) => mat[i] !== 0 && (mat[i] === 255 || OPAQUE[mat[i]] === 1);
  const terrain = (i) => mat[i] !== 0 && mat[i] !== 255 && !shape[i];
  const wet = (i) => !mat[i] && vol(i) >= THIN;
  const cap = (i) => FULL - floor[i];
  /** Water level (voxels, absolute in the padded grid) of water cell i in layer y. */
  const level = (i, y) => y + (floor[i] + Math.min(vol(i), cap(i))) / FULL;
  const wetAbove = (i, y) => y + 1 < N && wet(i + N);

  // ---- samples: signed "how far inside" (voxels) at each voxel centre
  const s = new Float32Array(N * NN);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = I(x, y, z);
        if (solid(i)) s[i] = 1;
        else if (wet(i)) s[i] = wetAbove(i, y) ? 1 : Math.max(-0.5, Math.min(1, level(i, y) - (y + 0.5)));
        else s[i] = -0.5;
      }
  const inside = (i) => s[i] > 0;

  // ---- crossings on edges: point (voxels, padded grid) and normal
  const n3 = [0, 0, 0];
  /**
   * Crossing on the edge from sample (x, y, z) to its +axis neighbour, or
   * null if there's none. Returns [px, py, pz, nx, ny, nz, water] (water: 1
   * if it's water's surface, so its quad is drawn).
   */
  const crossings = new Map();
  function crossing(x, y, z, a) {
    const key = I(x, y, z) * 3 + a;
    let c = crossings.get(key);
    if (c === undefined) {
      c = crossingOf(x, y, z, a);
      crossings.set(key, c);
    }
    return c;
  }
  function crossingOf(x, y, z, a) {
    const i = I(x, y, z), j = a === 0 ? i + 1 : a === 1 ? i + N : i + NN;
    const ip = inside(i), iq = inside(j);
    if (ip === iq) return null;
    const lo = ip ? i : j, hi = ip ? j : i; // lo: the inside sample, hi: the outside one
    const water = wet(i) || wet(j) ? 1 : 0;
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    const out = [cx, cy, cz, 0, 0, 0, water];
    const dir = ip ? 1 : -1; // outward, along the axis
    if (a === 1) {
      // In a column.
      if (dir > 0) {
        // Up from inside (lo, below) to outside (hi, above): the top of whatever's below.
        let top;
        if (wet(hi)) {
          top = level(hi, y + 1);
          if (terrain(lo) && et) top = Math.max(top, y + 0.5 + et[lo * 3 + 1] / 255 + LIFT);
        }
        else if (wet(lo)) top = level(lo, y);
        else if (terrain(lo) && et) top = y + 0.5 + et[lo * 3 + 1] / 255;
        else top = y + 1;
        out[1] = Math.max(y + 0.51, Math.min(y + 1.49, top));
        // A sheet lying on ground follows the ground's slope; deeper water is level.
        if (terrain(lo) && wet(hi) && level(hi, y + 1) - (y + 1) < 0.5 && en) {
          unpackNormal(en[(lo * 3 + 1) * 2], en[(lo * 3 + 1) * 2 + 1], n3);
          out[3] = n3[0]; out[4] = n3[1]; out[5] = n3[2];
        } else if (!wet(hi) && !wet(lo) && terrain(lo) && en) {
          unpackNormal(en[(lo * 3 + 1) * 2], en[(lo * 3 + 1) * 2 + 1], n3);
          out[3] = n3[0]; out[4] = n3[1]; out[5] = n3[2];
        } else out[4] = 1;
      } else {
        // Down from inside (above) to outside (below): an underside.
        out[1] = y + 1;
        out[4] = -1;
      }
      return out;
    }
    // Side by side.
    let t; // along the edge from sample i, 0..1
    if (wet(lo) && (wet(hi) || !mat[hi])) {
      // Water beside water or air: where the level, run linearly between the
      // columns, passes the samples' height.
      const sl = s[lo], sh = wet(hi) ? s[hi] : Math.min(-0.05, s[lo] - 1);
      const f = sl / (sl - sh); // from lo
      t = ip ? f : 1 - f;
      // Normal from the level's slope across the face.
      const hl = s[lo], hh = sh;
      const nx = a === 0 ? (hl - hh) * dir : 0, nz = a === 2 ? (hl - hh) * dir : 0;
      const l = Math.hypot(nx, 1, nz);
      out[3] = nx / l; out[4] = 1 / l; out[5] = nz / l;
      // (Against air with no water beside it, it's the water's side: more upright.)
      if (!wet(hi)) {
        out[3] = a === 0 ? dir : 0; out[4] = 0; out[5] = a === 2 ? dir : 0;
      }
    } else if (terrain(lo) && et) {
      // The ground's own crossing, pushed out by the depth of water lying on it.
      // (Edges are stored on their lower voxel, i.)
      const te = et[i * 3 + a] / 255;
      unpackNormal(en[(i * 3 + a) * 2], en[(i * 3 + a) * 2 + 1], n3);
      let px = cx + (a === 0 ? te : 0), py = cy, pz = cz + (a === 2 ? te : 0);
      const dq = wet(hi) ? Math.max(LIFT, level(hi, y) - (y + floor[hi] / FULL)) : 0;
      px += n3[0] * dq; py += n3[1] * dq; pz += n3[2] * dq;
      out[0] = px; out[1] = py; out[2] = pz;
      out[3] = n3[0]; out[4] = n3[1]; out[5] = n3[2];
      return out;
    } else {
      t = 0.5;
      out[3] = a === 0 ? dir : 0; out[5] = a === 2 ? dir : 0;
    }
    t = Math.max(0.01, Math.min(0.99, t));
    if (a === 0) out[0] = cx + t;
    else out[2] = cz + t;
    return out;
  }

  // ---- cells: one vertex each, where any of its 12 edges is crossed
  // Cell (x, y, z) has corners at samples x..x+1, y..y+1, z..z+1.
  const cellKey = (x, y, z) => x + N * (y + N * z);
  const cells = new Map();
  function cell(x, y, z) {
    const k = cellKey(x, y, z);
    let c = cells.get(k);
    if (c !== undefined) return c;
    c = null;
    if (x >= 0 && y >= 0 && z >= 0 && x < N - 1 && y < N - 1 && z < N - 1) {
      let sx = 0, sy = 0, sz = 0, nx = 0, ny = 0, nz = 0, n = 0;
      for (let a = 0; a < 3; a++)
        for (let u = 0; u < 2; u++)
          for (let v = 0; v < 2; v++) {
            // The 4 edges of the cell along axis a.
            const ex = a === 0 ? x : x + u, ey = a === 1 ? y : a === 0 ? y + u : y + v, ez = a === 2 ? z : z + v;
            const cr = crossing(ex, ey, ez, a);
            if (!cr) continue;
            sx += cr[0]; sy += cr[1]; sz += cr[2];
            nx += cr[3]; ny += cr[4]; nz += cr[5];
            n++;
          }
      if (n) {
        const l = Math.hypot(nx, ny, nz) || 1;
        // Water about it: is it at the water's edge (a dry column beside), how
        // deep, how fast, falling? At the edge it reports no depth, so the
        // surface fades out there over a cell rather than ending in a stepped
        // outline; inside a body of water, however thin (a sheet running down a
        // slope), at least SHOWN, so it's fully drawn.
        let depth = Infinity, edge = false, fx = 0, fz = 0, fw = 0, falling = 0;
        for (let k8 = 0; k8 < 8; k8++) {
          const i = I(x + (k8 & 1), y + ((k8 >> 1) & 1), z + ((k8 >> 2) & 1));
          if (solid(i)) continue;
          if (!wet(i)) {
            // (Air over water, or over water a layer or two down a slope, isn't the edge: a dry column is.
            // Nor is a voxel holding a trace of water too thin to draw: the sheet carries on over it.)
            const yy = y + ((k8 >> 1) & 1);
            const damp = (j) => !mat[j] && vol(j) > 0;
            const near = damp(i) || (yy > 0 && damp(i - N)) || (yy > 1 && damp(i - 2 * N)) || (yy + 1 < N && damp(i + N));
            if (!near) edge = true;
            continue;
          }
          const yy = y + ((k8 >> 1) & 1);
          if (wetAbove(i, yy)) { depth = Math.min(depth, 1); continue; }
          // The whole column of water under this surface, not just this voxel's share.
          let b = i, by = yy;
          while (by > 0 && wet(b - N) && level(i, yy) - by < 1) { b -= N; by--; }
          depth = Math.min(depth, level(i, yy) - (by + floor[b] / FULL));
          if (flux) {
            // Velocity: the flow through its faces (both sides) over the water it holds.
            // (Floored low: a thin sheet's water moves fast, and that's what shows.)
            const v = Math.max(vol(i), 16);
            const fxi = (flux[i * 2] + flux[(i - 1) * 2]) / 2, fzi = (flux[i * 2 + 1] + flux[(i - NN) * 2 + 1]) / 2;
            fx += fxi / v; fz += fzi / v; fw++;
          }
          if (yy > 0 && !mat[i - N] && vol(i - N) < THIN) falling = 2; // (broken up: see waterMaterial)
        }
        c = {
          p: [sx / n, sy / n, sz / n],
          n: [nx / l, ny / l, nz / l],
          f: [fw ? fx / fw : 0, fw ? fz / fw : 0, falling],
          d: edge ? 0 : depth === Infinity ? 1 : Math.max(SHOWN, depth),
        };
      }
    }
    cells.set(k, c);
    return c;
  }

  const pos = [], nrm = [], flw = [], dep = [];
  const ox = origin[0] - P, oy = origin[1] - P, oz = origin[2] - P;
  function vert(c) {
    pos.push((ox + c.p[0]) * scale, (oy + c.p[1]) * scale, (oz + c.p[2]) * scale);
    nrm.push(c.n[0], c.n[1], c.n[2]);
    flw.push(c.f[0], c.f[1], c.f[2]);
    dep.push(c.d * scale);
  }

  // ---- quads: each crossed edge in the chunk with water at an end
  for (let z = P; z < P + size; z++)
    for (let y = P; y < P + size; y++)
      for (let x = P; x < P + size; x++)
        for (let a = 0; a < 3; a++) {
          const i = I(x, y, z), j = a === 0 ? i + 1 : a === 1 ? i + N : i + NN;
          if (inside(i) === inside(j)) continue;
          if (!wet(i) && !wet(j)) continue;
          // The four cells round the edge.
          let q;
          if (a === 0) q = [[x, y - 1, z - 1], [x, y, z - 1], [x, y, z], [x, y - 1, z]];
          else if (a === 1) q = [[x - 1, y, z - 1], [x, y, z - 1], [x, y, z], [x - 1, y, z]];
          else q = [[x - 1, y - 1, z], [x, y - 1, z], [x, y, z], [x - 1, y, z]];
          const cs = q.map(([cx, cy, cz]) => cell(cx, cy, cz));
          if (cs.some((c) => !c)) continue;
          // Facing out of the inside sample, along the axis.
          const out = inside(i) ? 1 : -1;
          const want = [a === 0 ? out : 0, a === 1 ? out : 0, a === 2 ? out : 0];
          const [c0, c1, c2, c3] = cs;
          // (Which way the quad winds, from its two diagonals: sound even when it's bent.)
          const ux = c2.p[0] - c0.p[0], uy = c2.p[1] - c0.p[1], uz = c2.p[2] - c0.p[2];
          const vx = c3.p[0] - c1.p[0], vy = c3.p[1] - c1.p[1], vz = c3.p[2] - c1.p[2];
          const crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
          const flip = crx * want[0] + cry * want[1] + crz * want[2] < 0;
          // Split along the shorter diagonal.
          const d02 = dist2(c0.p, c2.p), d13 = dist2(c1.p, c3.p);
          const tri = (a1, b1, c1x) => (flip ? (vert(a1), vert(c1x), vert(b1)) : (vert(a1), vert(b1), vert(c1x)));
          if (d02 <= d13) { tri(c0, c1, c2); tri(c0, c2, c3); } else { tri(c0, c1, c3); tri(c1, c2, c3); }
        }

  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nrm),
    flow: new Float32Array(flw),
    depth: new Float32Array(dep),
    triangles: pos.length / 9,
  };
}

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
