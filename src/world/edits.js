import { HARD, MAT } from './materials.js';
import { OCC_SLOPE } from './World.js';

/**
 * World edit rules shared by every tool.
 *
 * Terrain field: the occupancy byte ramps from 0 to 255 over ~2.5 voxels
 * around the surface. Edits must keep that ramp, or the mesher sees hard
 * steps and terrain turns faceted. So terrain edits are smooth CSG with
 * sphere fields of the same slope, and rounding is deterministic (random
 * rounding near the 0.5 level is what used to leave floating specks).
 *
 * Blocks are barriers: brushes only reach voxels connected to the brush
 * through non-block space, so they can't pass through a wall, and they
 * never change the terrain field stored inside a block. Only Build places
 * or removes blocks.
 *
 * Player: brushes and terrain placement never make terrain solid inside
 * the player's box (pass `protect`).
 *
 * Specks: after each edit, tiny disconnected bits of terrain left inside
 * the edited region are dissolved.
 */

/** Radius of the lump added/removed when building with terrain materials. */
export const STAMP_RADIUS = 0.75;

/** Disconnected terrain pieces this many voxels or smaller are removed after edits. */
export const SPECK_MAX_VOXELS = 12;

/** Highest field a protected (player-occupied) voxel can be raised to: just below solid. */
const PROTECT_CAP = 110;

/** Distance from the 0.5 surface to full saturation. */
const RAMP = 0.5 / OCC_SLOPE;

const clampOcc = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Occupancy (0..255) of a sphere of radius R at distance d from its centre. */
export function sphereField(d, R) {
  return clampOcc((0.5 + (R - d) * OCC_SLOPE) * 255);
}

/** Per-tick field step that moves a surface at `speed` metres per second. */
export function stepForSpeed(speed, dt) {
  return speed * OCC_SLOPE * 255 * dt;
}

/** Most common terrain material among solid neighbours (blocks excluded). */
export function terrainMaterialNear(world, x, y, z, fallback = MAT.DIRT) {
  const counts = new Map();
  let best = fallback, bestN = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (world.getOcc(x + dx, y + dy, z + dz) < 128) continue;
        const m = world.getMat(x + dx, y + dy, z + dz);
        if (!m || HARD[m]) continue;
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

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Voxels in `r` reachable from `seed` through non-block voxels (6-connected).
 * Terrain doesn't block a brush; blocks do. Returns a Uint8Array mask.
 */
function reachable(world, r, seed) {
  const mask = new Uint8Array(r.size);
  let [sx, sy, sz] = seed.map(Math.floor);
  if (!r.contains(sx, sy, sz) || world.isBlock(sx, sy, sz)) {
    // Seed sits in a block (e.g. the brush is on a block face): start beside it.
    let found = false;
    for (const [dx, dy, dz] of N6) {
      const x = sx + dx, y = sy + dy, z = sz + dz;
      if (r.contains(x, y, z) && !world.isBlock(x, y, z)) { sx = x; sy = y; sz = z; found = true; break; }
    }
    if (!found) return mask;
  }
  const queue = new Int32Array(r.size * 3);
  let head = 0, tail = 0;
  mask[r.index(sx, sy, sz)] = 1;
  queue[tail++] = sx; queue[tail++] = sy; queue[tail++] = sz;
  while (head < tail) {
    const x = queue[head++], y = queue[head++], z = queue[head++];
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!r.contains(nx, ny, nz)) continue;
      const i = r.index(nx, ny, nz);
      if (mask[i] || world.isBlock(nx, ny, nz)) continue;
      mask[i] = 1;
      queue[tail++] = nx; queue[tail++] = ny; queue[tail++] = nz;
    }
  }
  return mask;
}

/**
 * Dissolve tiny disconnected terrain pieces inside `r`: solid terrain voxels
 * connected (26-way) to nothing but air, with no contact with blocks, bedrock
 * or the region boundary (where they might continue outside).
 */
export function removeSpecks(world, r) {
  if (r.empty) return 0;
  const seen = new Uint8Array(r.size);
  const solid = (x, y, z) => world.getOcc(x, y, z) >= 128 && !world.isBlock(x, y, z);
  let removed = 0;
  const comp = [];
  for (let z = r.z0; z <= r.z1; z++)
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        const i0 = r.index(x, y, z);
        if (seen[i0] || !solid(x, y, z)) continue;
        // Flood one component, stopping early once it's clearly not a speck.
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
                // Touching bedrock or a block counts as supported.
                if (ny < 1 || world.isBlock(nx, ny, nz)) { anchored = true; continue; }
                if (!solid(nx, ny, nz)) continue;
                if (!r.contains(nx, ny, nz)) { anchored = true; continue; }
                const j = r.index(nx, ny, nz);
                if (seen[j]) continue;
                seen[j] = 1;
                stack.push(nx, ny, nz);
              }
        }
        if (anchored || comp.length / 3 > SPECK_MAX_VOXELS) continue;
        for (let k = 0; k < comp.length; k += 3) {
          const cx = comp[k], cy = comp[k + 1], cz = comp[k + 2];
          world.setRaw(cx, cy, cz, Math.min(world.getOcc(cx, cy, cz), 100), world.getMat(cx, cy, cz));
          removed++;
        }
      }
  return removed;
}

// ----------------------------------------------------------------- brushes

/**
 * Shared brush driver: visits every reachable, non-block voxel in a box and
 * lets `fn` propose a new (occ, mat). Applies player protection, writes all
 * changes after reading (so neighbour-based brushes see the pre-edit state),
 * cleans up specks and marks meshes dirty.
 */
function brush(world, box, seed, protect, fn) {
  const r = region(world, ...box);
  if (r.empty) return 0;
  const mask = reachable(world, r, seed);
  const writes = [];
  for (let z = r.z0; z <= r.z1; z++)
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (!mask[r.index(x, y, z)]) continue;
        const occ = world.getOcc(x, y, z);
        const mat = world.getMat(x, y, z);
        const out = fn(x, y, z, occ, mat);
        if (!out) continue;
        let [nOcc, nMat] = out;
        // Never grow terrain into the player.
        if (nOcc > occ && protect && protect(x, y, z)) nOcc = Math.max(occ, Math.min(nOcc, PROTECT_CAP));
        if (nOcc !== occ || nMat !== mat) writes.push(x, y, z, nOcc, nMat);
      }
  for (let i = 0; i < writes.length; i += 5) world.setRaw(writes[i], writes[i + 1], writes[i + 2], writes[i + 3], writes[i + 4]);
  if (writes.length) {
    // Check a margin around the edit for specks it may have cut loose.
    removeSpecks(world, region(world, r.x0 - 2, r.y0 - 2, r.z0 - 2, r.x1 + 2, r.y1 + 2, r.z1 + 2));
    world.markDirtyBox(r.x0 - 2, r.y0 - 2, r.z0 - 2, r.x1 + 2, r.y1 + 2, r.z1 + 2);
  }
  return writes.length / 5;
}

/** Newly solid terrain takes the chosen material (or nearby terrain if a block material is chosen). */
function fillMaterial(world, x, y, z, occ, nOcc, mat, material) {
  if (mat !== 0 && !(occ < 128 && nOcc >= 128)) return mat;
  return HARD[material] ? terrainMaterialNear(world, x, y, z) : material;
}

/**
 * Smoothly add ('add') or remove ('sub') a sphere of terrain.
 * Each voxel moves toward the sphere's field by at most `maxStep` (255 = all
 * the way), so held brushes move the surface at a bounded speed.
 *
 * opts.seed: point the brush starts from (defaults to the centre); blocks
 *            between it and a voxel shield that voxel.
 * opts.protect(x, y, z): true for voxels terrain must not become solid in.
 */
export function stampSphere(world, cx, cy, cz, R, mode, maxStep = 255, material = MAT.DIRT, opts = {}) {
  const reach = R + RAMP + 0.5;
  const add = mode === 'add';
  const box = [
    Math.floor(cx - reach), Math.floor(cy - reach), Math.floor(cz - reach),
    Math.floor(cx + reach), Math.floor(cy + reach), Math.floor(cz + reach),
  ];
  return brush(world, box, opts.seed || [cx, cy, cz], opts.protect, (x, y, z, occ, mat) => {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
    if (d > reach) return null;
    const s = sphereField(d, R);
    if (add) {
      if (s <= occ) return null;
      const nOcc = clampOcc(Math.round(Math.min(s, occ + maxStep)));
      return [nOcc, fillMaterial(world, x, y, z, occ, nOcc, mat, material)];
    }
    const t = 255 - s;
    if (t >= occ) return null;
    return [clampOcc(Math.round(Math.max(t, occ - maxStep))), mat];
  });
}

/** Blend the field toward its local average (blocks' stored fields are ignored). */
export function smoothBrush(world, c, r, dt, opts = {}) {
  const box = [Math.floor(c.x - r), Math.floor(c.y - r), Math.floor(c.z - r), Math.floor(c.x + r), Math.floor(c.y + r), Math.floor(c.z + r)];
  return brush(world, box, opts.seed || [c.x, c.y, c.z], opts.protect, (x, y, z, occ, mat) => {
    const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z);
    if (d > r) return null;
    const f = falloff(d / r);
    let sum = 0, n = 0;
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          if (world.isBlock(x + i, y + j, z + k)) continue;
          sum += world.getOcc(x + i, y + j, z + k);
          n++;
        }
    const nOcc = clampOcc(Math.round(occ + (sum / n - occ) * Math.min(1, 8 * dt * f)));
    return [nOcc, fillMaterial(world, x, y, z, occ, nOcc, mat, MAT.DIRT)];
  });
}

/** Push the field toward a horizontal ground plane at height `planeY` (a cylinder of radius r). */
export function flattenBrush(world, c, r, planeY, dt, opts = {}) {
  const box = [Math.floor(c.x - r), Math.floor(planeY - r - 1), Math.floor(c.z - r), Math.floor(c.x + r), Math.floor(planeY + r + 1), Math.floor(c.z + r)];
  return brush(world, box, opts.seed || [c.x, planeY, c.z], opts.protect, (x, y, z, occ, mat) => {
    const d = Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z);
    if (d > r) return null;
    const target = Math.max(0, Math.min(1, 0.5 + (planeY - (y + 0.5)) * OCC_SLOPE)) * 255;
    const nOcc = clampOcc(Math.round(occ + (target - occ) * Math.min(1, 7 * dt * falloff(d / r))));
    return [nOcc, fillMaterial(world, x, y, z, occ, nOcc, mat, MAT.DIRT)];
  });
}

/**
 * Paint: terrain materials recolour reachable terrain; block materials
 * recolour blocks whose faces touch the reachable space.
 */
export function paintBrush(world, c, r, material, opts = {}) {
  const box = [Math.floor(c.x - r), Math.floor(c.y - r), Math.floor(c.z - r), Math.floor(c.x + r), Math.floor(c.y + r), Math.floor(c.z + r)];
  const inSphere = (x, y, z) => Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y, z + 0.5 - c.z) <= r;
  if (!HARD[material]) {
    return brush(world, box, opts.seed || [c.x, c.y, c.z], null, (x, y, z, occ, mat) =>
      inSphere(x, y, z) && occ > 0 && mat !== material ? [occ, material] : null,
    );
  }
  // Blocks are excluded from reachability, so find the blocks bordering reachable space.
  const rg = region(world, ...box);
  if (rg.empty) return 0;
  const mask = reachable(world, rg, opts.seed || [c.x, c.y, c.z]);
  let n = 0;
  for (let z = rg.z0; z <= rg.z1; z++)
    for (let y = rg.y0; y <= rg.y1; y++)
      for (let x = rg.x0; x <= rg.x1; x++) {
        if (!world.isBlock(x, y, z) || !inSphere(x, y, z) || world.getMat(x, y, z) === material) continue;
        const touches = N6.some(([dx, dy, dz]) => rg.contains(x + dx, y + dy, z + dz) && mask[rg.index(x + dx, y + dy, z + dz)]);
        if (!touches) continue;
        world.setRaw(x, y, z, world.getOcc(x, y, z), material);
        n++;
      }
  if (n) world.markDirtyBox(rg.x0, rg.y0, rg.z0, rg.x1, rg.y1, rg.z1);
  return n;
}

function falloff(t) {
  const u = Math.max(0, 1 - t * t);
  return u * u;
}

// ------------------------------------------------------------------- build

/**
 * Field for a block resting on terrain whose voxel below has field `below`:
 * just enough that the ground surface sits 0.1 above the block's base, so
 * there's never a gap under it. Always below 0.5, so a resting block is never
 * mistaken for a buried one.
 */
function footField(below) {
  const a = below / 255;
  return Math.round((a - (a - 0.5) / 0.6) * 255);
}

/** Field that puts the ground surface exactly at the base of the voxel above `below`. */
function groundField(below) {
  return 255 - below;
}

/**
 * Build-tool place. Block materials make an exact cube; the voxel's field is
 * kept, lifted slightly when it rests on the ground. Terrain materials add a
 * small smooth lump (never inside the player, never through blocks).
 */
export function placeAt(world, x, y, z, material, opts = {}) {
  if (y < 1 || !world.inBounds(x, y, z) || world.isBlock(x, y, z)) return false;
  if (HARD[material]) {
    let occ = world.getOcc(x, y, z);
    const below = world.getOcc(x, y - 1, z);
    if (!world.isBlock(x, y - 1, z) && below >= 128) occ = Math.max(occ, footField(below));
    world.set(x, y, z, occ, material);
  } else {
    stampSphere(world, x + 0.5, y + 0.5, z + 0.5, STAMP_RADIUS, 'add', 255, material, { protect: opts.protect });
  }
  return true;
}

/**
 * Build-tool remove.
 *  - A block resting on or above the ground just disappears; its foot lift
 *    is undone so the ground is exactly as before.
 *  - A block buried in terrain leaves a rounded pocket where it was.
 *  - Terrain gets a small smooth dent.
 */
export function removeAt(world, x, y, z) {
  if (y < 1 || !world.isSolid(x, y, z)) return false;
  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
  if (world.isBlock(x, y, z)) {
    const occ = world.getOcc(x, y, z);
    if (occ >= 128) {
      world.setRaw(x, y, z, occ, terrainMaterialNear(world, x, y, z));
      stampSphere(world, cx, cy, cz, STAMP_RADIUS, 'sub');
      world.markDirtyBox(x, y, z, x, y, z);
    } else {
      const below = world.getOcc(x, y - 1, z);
      const nOcc = below >= 128 && !world.isBlock(x, y - 1, z) ? Math.min(occ, groundField(below)) : occ;
      world.set(x, y, z, nOcc, nOcc ? terrainMaterialNear(world, x, y, z) : 0);
    }
  } else {
    stampSphere(world, cx, cy, cz, STAMP_RADIUS, 'sub');
  }
  return true;
}
