/**
 * Water mesher. Water is drawn as its surface, never as cubes:
 *
 *  - The top: one quad per column where the water ends, at the water's level.
 *    Each corner's height is the average level of the wet cells around it,
 *    so the surface is continuous, with no steps between fill levels, and
 *    slopes gently where water runs downhill or spills off an edge.
 *  - Shoreline: the surface carries on over the smooth ground beside it (a
 *    skirt, each ground cell once, at the same corner heights), and the depth
 *    test clips it against the ground actually drawn there. So the shoreline
 *    follows the smooth terrain exactly, wherever it crosses the water's level,
 *    rather than the voxel grid. Never over building pieces: they end on
 *    exact faces anyway, and a skirt would show through glass.
 *  - Walls: where water meets air at a lower level (the edge of a falling
 *    sheet, an overhang's underside) or glass, a vertical or downward face.
 *
 * Vertices carry `flow` (xz: which way and how fast the surface runs
 * downhill, from the difference in level around it; z of the attribute: 1 on
 * falling water) for the shader's moving ripples.
 *
 * Input: World.buildFluidPadded. Output positions are in metres.
 */

import { OPAQUE } from '../world/materials.js';

const FULL = 1024;
/** Surfaces in neighbouring columns within this many voxels of each other join up. */
const JOIN = 1.25;
/**
 * ... or this many, where either is a sheet lying on the ground: water
 * cascading down a slope or over a ledge, whose surface should run on down
 * as one smooth slope, not as flat steps with walls between.
 */
const JOIN_SHEET = 3.25;
/** Water thinner than this (volume units: about 2 mm) isn't drawn. (Thin water fades in: see `depth`.) */
const THIN = 4;
/**
 * A thin sheet running over the ground is drawn at least this thick (voxels:
 * 5 cm) above it, so the smooth ground, which bulges about between the
 * sheet's corners, doesn't poke through.
 */
const SKIN = 0.1;
/**
 * Water running downhill over the ground, less deep than this (volume units:
 * about 15 cm), isn't drawn as a surface: the ground's shader draws it as a
 * wet, streaming film instead (see waterFilm in src/render/waterHeight.js).
 */
const FILM_VOL = 300;
/**
 * A skirt goes over ground whose surface is at most this far (voxels) below
 * the water's level beside it: a bank. Ground lower than that is a slope
 * the water runs down, where a skirt would hang in the air.
 */
const SKIRT_BELOW = 0.9;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function meshFluid(p, scale = 1) {
  const { mat, shape, fluid, floor, size, pad: P, origin } = p;
  const N = size + 2 * P, NN = N * N;
  const I = (x, y, z) => x + N * (y + N * z);
  const vol = (i) => fluid[i] & 4095;
  const isTerrain = (i) => mat[i] !== 0 && mat[i] !== 255 && !shape[i];
  const seeThrough = (i) => mat[i] !== 0 && mat[i] !== 255 && !OPAQUE[mat[i]];
  const wetAbove = (i, y) => y + 1 < N && !mat[i + N] && vol(i + N) >= THIN;
  /** Level of the water in cell i (layer y), voxels: its surface, or the top if water's above. */
  const level = (i, y) => (wetAbove(i, y) ? y + 1 : y + (floor[i] + Math.min(vol(i), FULL - floor[i])) / FULL);

  const pos = [], nrm = [], flw = [], dep = [];
  const ox = origin[0] - P, oy = origin[1] - P, oz = origin[2] - P;

  /** A vertex at (x, y, z) voxels, normal n, flow f, over water d voxels deep (for fading thin water in). */
  function vert(x, y, z, n, f, d = 1) {
    pos.push((ox + x) * scale, (oy + y) * scale, (oz + z) * scale);
    nrm.push(n[0], n[1], n[2]);
    flw.push(f[0], f[1], f[2]);
    dep.push(d * scale);
  }

  /** Quad a b c d (each [x, y, z], voxels) facing n, whatever order they come in round the edge. */
  function quad(a, b, c, d, n, f) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) [b, d] = [d, b];
    vert(...a, n, f); vert(...b, n, f); vert(...c, n, f);
    vert(...a, n, f); vert(...c, n, f); vert(...d, n, f);
  }

  /**
   * A piece of the top surface over column (x, z): corner heights h (00, 10,
   * 11, 01), each corner with its own normal and flow (from the slope of the
   * surface round it), so the surface shades smoothly across quads instead
   * of in facets. Split along whichever diagonal bends it least.
   */
  function topQuad(x, z, h, n, f, d = [1, 1, 1, 1]) {
    // Level and still (open water, ponds): kept to merge into bigger quads.
    // (Settled water is level to within a few millimetres: close enough.)
    const lo = Math.min(...h), hi = Math.max(...h);
    // (Deep enough not to be fading: merged quads are drawn as fully there.)
    // (0.4 voxels: 20 cm, past where the surface fades in, see waterMaterial.js.)
    if (hi - lo < 0.006 && d.every((v) => v >= 0.4) && n.every((v) => v[1] > 0.99998) && f.every((v) => Math.abs(v[0]) < 0.004 && Math.abs(v[1]) < 0.004 && !v[2])) {
      flat.push(x, z, Math.round(((lo + hi) / 2) * 128) / 128);
      return;
    }
    const c = [[x, h[0], z], [x + 1, h[1], z], [x + 1, h[2], z + 1], [x, h[3], z + 1]];
    const tri = (a, b, e) => {
      vert(...c[a], n[a], f[a], d[a]); vert(...c[b], n[b], f[b], d[b]); vert(...c[e], n[e], f[e], d[e]);
    };
    // (Corners in this order wind upward-facing: 0 → 3 → 2 is counter-clockwise seen from above.)
    if (Math.abs(h[0] - h[2]) <= Math.abs(h[1] - h[3])) {
      tri(0, 3, 2); tri(0, 2, 1);
    } else {
      tri(0, 3, 1); tri(1, 3, 2);
    }
  }

  /**
   * Level, still pieces of surface (x, z, height; see topQuad), merged into
   * rectangles: first runs along x, then runs of identical runs along z. So a
   * calm lake or the open sea is a handful of quads per chunk, not one per
   * column.
   */
  const flat = [];
  function mergeFlat() {
    const n = flat.length / 3;
    if (!n) return;
    const order = Array.from({ length: n }, (_, k) => k);
    order.sort((a, b) => flat[a * 3 + 2] - flat[b * 3 + 2] || flat[a * 3 + 1] - flat[b * 3 + 1] || flat[a * 3] - flat[b * 3]);
    // Runs along x: [x0, x1, z, h].
    const runs = [];
    for (const k of order) {
      const x = flat[k * 3], z = flat[k * 3 + 1], h = flat[k * 3 + 2];
      const r = runs[runs.length - 1];
      if (r && r[3] === h && r[2] === z && r[1] === x) r[1] = x + 1;
      else runs.push([x, x + 1, z, h]);
    }
    // Stack identical runs in consecutive rows: [x0, x1, z0, z1, h].
    const open = new Map();
    const rects = [];
    for (const [x0, x1, z, h] of runs) {
      const key = `${x0},${x1},${h}`;
      const r = open.get(key);
      if (r && r[3] === z) r[3] = z + 1;
      else {
        const nr = [x0, x1, z, z + 1, h];
        open.set(key, nr);
        rects.push(nr);
      }
    }
    const up = [0, 1, 0], still = [0, 0, 0];
    for (const [x0, x1, z0, z1, h] of rects) {
      vert(x0, h, z0, up, still); vert(x0, h, z1, up, still); vert(x1, h, z1, up, still);
      vert(x0, h, z0, up, still); vert(x1, h, z1, up, still); vert(x1, h, z0, up, still);
    }
  }

  // Which cells hold the top of the water in their column (with a surface to draw).
  const top = new Uint8Array(N * NN);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = I(x, y, z);
        // (A film thinner than THIN isn't drawn: it would only flicker in and
        // out of the ground under it.)
        if (mat[i] || vol(i) < THIN || wetAbove(i, y)) continue;
        // Full under a roof: nothing to see.
        if (y + 1 < N && mat[i + N] && vol(i) >= FULL - floor[i] - 8) continue;
        top[i] = 1;
      }

  /**
   * The level (voxels) of the water surface in column (x, z) nearest level
   * `L`, looking a couple of layers either side of layer y: water running
   * down a slope steps down a layer every so often, and its surface should
   * carry on smoothly rather than in steps. NaN if none within JOIN.
   */
  function surfaceNear(x, z, L, y, sheet = false) {
    if (x < 0 || z < 0 || x >= N || z >= N) return NaN;
    let best = NaN, bd = Infinity;
    for (let yy = Math.max(0, y - 4); yy <= Math.min(N - 1, y + 4); yy++) {
      const j = I(x, yy, z);
      if (!top[j]) continue;
      const d = Math.abs(level(j, yy) - L);
      const reach = sheet || onGround(j, yy) ? JOIN_SHEET : JOIN;
      if (d < reach && d < bd) { bd = d; best = level(j, yy); }
    }
    return best;
  }

  /** Is cell j (layer y) the top of water lying straight on the ground (a sheet)? */
  function onGround(j, y) {
    return top[j] === 1 && y > 0 && mat[j - N] !== 0;
  }

  /** Height (voxels) at grid corner (cx, cz): average of the surfaces near level L round it; NaN if none. */
  function corner(cx, cz, L, y, sheet = false) {
    let sum = 0, n = 0;
    for (let dz = -1; dz <= 0; dz++)
      for (let dx = -1; dx <= 0; dx++) {
        const h = surfaceNear(cx + dx, cz + dz, L, y, sheet);
        if (h === h) { sum += h; n++; }
      }
    return n ? sum / n : NaN;
  }

  /**
   * Height (voxels) of the ground under the water in column (x, z), the
   * highest not above level L (a little leeway), looking about layer y; NaN
   * if there's none (a drop, or solid all the way).
   */
  function groundNear(x, z, L, y) {
    if (x < 0 || z < 0 || x >= N || z >= N) return NaN;
    let best = NaN;
    for (let yy = Math.max(1, y - 2); yy <= Math.min(N - 1, y + 1); yy++) {
      const j = I(x, yy, z);
      if (mat[j] || !mat[j - N]) continue;
      const g = yy + floor[j] / FULL;
      if (g <= L + 0.2 && !(g <= best)) best = g;
    }
    return best;
  }

  /** Height (voxels) of the ground in column (x, z) nearest g0, within 2.5 voxels; NaN if none. */
  function groundAround(x, z, g0, y) {
    if (x < 0 || z < 0 || x >= N || z >= N) return NaN;
    let best = NaN, bd = 2.5;
    for (let yy = Math.max(1, y - 3); yy <= Math.min(N - 1, y + 3); yy++) {
      const j = I(x, yy, z);
      if (mat[j] || !mat[j - N]) continue;
      const g = yy + floor[j] / FULL;
      if (Math.abs(g - g0) < bd) { bd = Math.abs(g - g0); best = g; }
    }
    return best;
  }

  /**
   * A corner of a sheet of water lying on the ground (cascading down a
   * slope): the ground there plus the water's depth, both averaged over the
   * columns round the corner. The ground is the smooth terrain, the same
   * whichever quad asks, so the sheet follows it smoothly down any slope,
   * however many layers it steps through, with no flat ledges or walls.
   * Returns [height, depth] (voxels).
   */
  function sheetCorner(cx, cz, g0, L, y) {
    let gs = 0, ng = 0, ds = 0, nd = 0;
    for (let dz = -1; dz <= 0; dz++)
      for (let dx = -1; dx <= 0; dx++) {
        const x = cx + dx, z = cz + dz;
        const g = groundAround(x, z, g0, y);
        if (g !== g) continue;
        gs += g; ng++;
        const s = surfaceNear(x, z, L, y, true);
        ds += s === s ? Math.max(0, s - g) : 0;
        nd++;
      }
    if (!ng) return [NaN, 0];
    const g = gs / ng, d = ds / nd;
    return [g + Math.max(SKIN, d), d];
  }

  /** Ground height (voxels) at grid corner (cx, cz): average round it; NaN if none. */
  function cornerGround(cx, cz, L, y) {
    let sum = 0, n = 0;
    for (let dz = -1; dz <= 0; dz++)
      for (let dx = -1; dx <= 0; dx++) {
        const g = groundNear(cx + dx, cz + dz, L, y);
        if (g === g) { sum += g; n++; }
      }
    return n ? sum / n : NaN;
  }

  /**
   * Normal and flow at grid corner (cx, cz), height hc: from the corner
   * heights either side (where there are any), so neighbouring quads agree
   * at shared corners. Flow is downhill along the surface, voxels per voxel.
   */
  function cornerSlope(cx, cz, L, y, hc, sheet = false) {
    const at = (x, z) => {
      const h = corner(x, z, L, y, sheet);
      return h === h ? h : hc;
    };
    const gx = (at(cx - 1, cz) - at(cx + 1, cz)) * 0.5, gz = (at(cx, cz - 1) - at(cx, cz + 1)) * 0.5;
    const l = Math.hypot(gx, 1, gz);
    return [[gx / l, 1 / l, gz / l], [Math.max(-1, Math.min(1, gx)), Math.max(-1, Math.min(1, gz))]];
  }

  /** Flow at cell i: downhill along the surface (voxels per voxel), and whether it's falling. */
  function flowAt(x, y, z) {
    const i = I(x, y, z);
    const L = level(i, y);
    let fx = 0, fz = 0;
    for (const [dx, dz] of SIDES) {
      const j = I(x + dx, y, z + dz);
      let Lj = surfaceNear(x + dx, z + dz, L, y, onGround(i, y));
      if (Lj !== Lj) {
        if (mat[j]) continue;
        Lj = vol(j) ? level(j, y) : y + floor[j] / FULL;
      }
      const d = Math.max(-1, Math.min(1, L - Lj));
      fx += dx * d; fz += dz * d;
    }
    // Falling: nothing but air below (not just a cell that isn't full yet).
    const falling = y > 0 && !mat[i - N] && vol(i - N) < THIN ? 1 : 0;
    return [fx, fz, falling];
  }

  const down = [0, -1, 0];
  for (let z = P; z < P + size; z++)
    for (let y = P; y < P + size; y++)
      for (let x = P; x < P + size; x++) {
        const i = I(x, y, z);

        // ---- the top surface, and its skirt over the ground beside it (the
        // ground's top voxel in the column, with no water above it)
        const skirt = isTerrain(i) && y + 1 < N && !mat[i + N] && !vol(i + N);
        if (top[i] || skirt) {
          const L = top[i] ? level(i, y) : y + 1;
          const sh = onGround(i, y);
          let h00 = corner(x, z, L, y, sh), h10 = corner(x + 1, z, L, y, sh), h11 = corner(x + 1, z + 1, L, y, sh), h01 = corner(x, z + 1, L, y, sh);
          const known = [h00, h10, h11, h01].filter((h) => h === h);
          if (known.length && !top[i]) {
            // A skirt is flat, at the level of the water beside it: tilted,
            // it would catch the sky's reflection differently from the water
            // it carries on.
            h00 = h10 = h11 = h01 = known.reduce((a, b) => a + b, 0) / known.length;
          }
          // A skirt only where the ground rises to meet the water: ground
          // well below the water's level beside it is a slope the water is
          // running down (or soon will), not a shore.
          const ground = y + floor[i] / FULL;
          if (known.length && (top[i] || ground >= (h00 + h10 + h11 + h01) / 4 - SKIRT_BELOW)) {
            const h = [h00, h10, h11, h01];
            const fc = top[i] ? flowAt(x, y, z) : null;
            const running = top[i] && Math.hypot(fc[0], fc[1]) > 0.05;
            const g0 = top[i] ? groundAround(x, z, L - 0.5, y) : NaN;
            // (No ground within reach below: deep water, drawn as a surface.)
            if (top[i] && (fc[2] || (running && g0 === g0 && L - g0 < FILM_VOL / FULL))) {
              // Shallow water running over the ground, or water in mid-air
              // (falling), isn't drawn as a surface: the ground's own shader
              // draws running shallows (waterFilm in waterHeight.js), following
              // the smooth ground exactly, and falling water is gone in a moment.
            } else if (top[i] && sh && Math.hypot(fc[0], fc[1]) > 0.05) {
              // Water running over the ground: the ground plus its depth (see sheetCorner).
              const g0 = y + floor[i] / FULL;
              const at = (cx, cz) => sheetCorner(cx, cz, g0, L, y);
              const ns = [], fs = [], ds = [];
              const corners = [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]];
              for (let k = 0; k < 4; k++) {
                const [cx, cz] = corners[k];
                const [hk, dk] = at(cx, cz);
                h[k] = hk === hk ? hk : h[k];
                ds.push(dk);
                const side = (ax, az) => {
                  const v = at(ax, az)[0];
                  return v === v ? v : h[k];
                };
                const gx = (side(cx - 1, cz) - side(cx + 1, cz)) * 0.5, gz = (side(cx, cz - 1) - side(cx, cz + 1)) * 0.5;
                const l = Math.hypot(gx, 1, gz);
                ns.push([gx / l, 1 / l, gz / l]);
                fs.push([Math.max(-1, Math.min(1, gx)), Math.max(-1, Math.min(1, gz)), fc[2]]);
              }
              topQuad(x, z, h, ns, fs, ds);
            } else if (top[i]) {
              const falling = fc[2];
              const ns = [], fs = [], ds = [];
              // Water in mid-air (falling) shows by how much of it there is: a few drops hardly at all.
              const airDepth = 0.3 * Math.min(1, vol(i) / FULL);
              const corners = [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]];
              for (let k = 0; k < 4; k++) {
                const [cx, cz] = corners[k];
                const [n, f] = cornerSlope(cx, cz, L, y, h[k], sh);
                ns.push(n);
                fs.push([f[0], f[1], falling]);
                // Water running down a slope drapes over the ground (at least
                // SKIN above it). Every corner says how deep the water really
                // is, so thin water can fade in rather than pop. (Still water
                // isn't lifted: its shore would bulge.)
                const g = cornerGround(cx, cz, L, y);
                if (g === g) {
                  // Depth: each column's own water over its own ground, averaged
                  // (the lowest ground round about could be the next ledge down).
                  ds.push(g0 === g0 ? sheetCorner(cx, cz, g0, L, y)[1] : Math.max(0, h[k] - g));
                  if (falling || Math.hypot(f[0], f[1]) > 0.03) h[k] = Math.max(h[k], g + SKIN);
                } else ds.push(falling ? airDepth : 1);
              }
              topQuad(x, z, h, ns, fs, ds);
            } else {
              // The skirt fades out toward the shore as the water over the
              // ground thins, corner by corner (one depth for the whole
              // cell would fade it in squares).
              const up = [0, 1, 0], still = [0, 0, 0];
              const ds = [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]].map(([cx, cz], k) => {
                const g = cornerGround(cx, cz, h[k], y + 1);
                return g === g ? Math.max(0, h[k] - g) : 1;
              });
              topQuad(x, z, h, [up, up, up, up], [still, still, still, still], ds);
            }
          }
        }

        if (mat[i] || vol(i) < THIN) continue;
        const f = flowAt(x, y, z);
        const bottom = y + floor[i] / FULL;

        // ---- walls: against glass, and where a standing body of water (full
        // cells) meets air beside it. Not for water that's moving about (a
        // partly filled top cell: a sheet, a cascade over little ledges):
        // its every step would be a hard-edged square.
        const L = level(i, y);
        const standing = !top[i] || vol(i) >= FULL - floor[i] - 16;
        for (let s = 0; s < 4; s++) {
          const [dx, dz] = SIDES[s];
          const j = I(x + dx, y, z + dz);
          const near = top[i] ? surfaceNear(x + dx, z + dz, L, y, onGround(i, y)) : NaN;
          if (near === near) continue;
          let low;
          if (!mat[j]) {
            if (!standing) continue;
            if (vol(j) && wetAbove(j, y)) continue;
            // Down to the water beside, or to the ground there (which may rise above this water: no wall).
            low = vol(j) >= THIN ? level(j, y) : Math.max(bottom, y + floor[j] / FULL);
          } else if (seeThrough(j)) low = bottom;
          else continue;
          // This cell's level along the shared edge.
          const ex = dx > 0 ? x + 1 : x, ez = dz > 0 ? z + 1 : z;
          let t0, t1, a, b;
          if (dx) {
            a = [ex, 0, z]; b = [ex, 0, z + 1];
          } else {
            a = [x, 0, ez]; b = [x + 1, 0, ez];
          }
          if (top[i]) {
            t0 = corner(a[0], a[2], L, y, onGround(i, y));
            t1 = corner(b[0], b[2], L, y, onGround(i, y));
          } else t0 = t1 = y + 1;
          if (Math.max(t0, t1) <= low + 0.1) continue;
          const n = [dx, 0, dz];
          quad([a[0], Math.min(low, t0), a[2]], [a[0], t0, a[2]], [b[0], t1, b[2]], [b[0], Math.min(low, t1), b[2]], n, f);
        }

        // ---- underside: over air (water about to fall) or glass
        if (y > 0) {
          const j = i - N;
          if ((!mat[j] && !vol(j) && standing) || seeThrough(j)) quad([x, bottom, z], [x + 1, bottom, z], [x + 1, bottom, z + 1], [x, bottom, z + 1], down, f);
        }
      }

  mergeFlat();

  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nrm),
    flow: new Float32Array(flw),
    depth: new Float32Array(dep),
    triangles: pos.length / 9,
  };
}
