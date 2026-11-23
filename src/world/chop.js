import { DIRS26, PLANT, isWood, woodParent, woodCut, woodCutSide, withCut } from './plants.js';

/**
 * Cutting trees. Wood voxels form exact trees (each records the voxel it grows
 * from: see plants.js), so what a cut frees is simply everything growing from
 * the voxel cut through, and the leaves left touching no wood.
 *
 * An axe cuts a voxel an eighth of its thickness deeper per stroke, on the
 * side it's struck from (the first stroke picks the side); the mesher draws
 * the cut as a notch faced with end grain. The eighth stroke goes through.
 */

const FACE6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** Does wood voxel (x, y, z) still grow from something: solid ground, or wood? */
export function held(world, x, y, z) {
  const d = woodParent(world.getPlant(x, y, z));
  if (d < 0) return false;
  const [dx, dy, dz] = DIRS26[d];
  return world.isSolid(x + dx, y + dy, z + dz) || isWood(world.getPlant(x + dx, y + dy, z + dz));
}

/**
 * What goes if wood voxels `cells` go: them and all the wood growing from
 * them ({ wood: [[x, y, z, id]] }), the leaves then joined (face to face,
 * through leaves) to no other wood ({ leaves: [[x, y, z]] }), and the box
 * round all of it. Nothing is changed yet (see remove).
 */
export function severed(world, cells) {
  const key = (x, y, z) => x + world.sx * (y + world.sy * z);
  const gone = new Map();
  const stack = cells.filter((c) => isWood(world.getPlant(...c))).map((c) => c.slice());
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  while (stack.length) {
    const [x, y, z] = stack.pop();
    const k = key(x, y, z);
    if (gone.has(k)) continue;
    gone.set(k, [x, y, z, world.getPlant(x, y, z)]);
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.min(box[2], z);
    box[3] = Math.max(box[3], x); box[4] = Math.max(box[4], y); box[5] = Math.max(box[5], z);
    for (const [dx, dy, dz] of DIRS26) {
      const ux = x + dx, uy = y + dy, uz = z + dz;
      const id = world.getPlant(ux, uy, uz);
      if (!isWood(id)) continue;
      const p = DIRS26[woodParent(id)];
      if (p && p[0] === -dx && p[1] === -dy && p[2] === -dz) stack.push([ux, uy, uz]);
    }
  }
  if (!gone.size) return { wood: [], leaves: [], box: null };
  // Leaves near it: each group joined face to face is kept if it touches
  // wood that stays (or reaches past the search, to be safe).
  const R = 8;
  const [x0, y0, z0, x1, y1, z1] = [box[0] - R, box[1] - R, box[2] - R, box[3] + R, box[4] + R, box[5] + R];
  const seen = new Set(), leaves = [];
  for (const [gx, gy, gz] of gone.values())
    for (const [fx, fy, fz] of FACE6) {
      const sx = gx + fx, sy = gy + fy, sz = gz + fz;
      if (world.getPlant(sx, sy, sz) !== PLANT.LEAVES || seen.has(key(sx, sy, sz))) continue;
      const group = [[sx, sy, sz]];
      seen.add(key(sx, sy, sz));
      let kept = false;
      for (let g = 0; g < group.length; g++) {
        const [x, y, z] = group[g];
        for (const [dx, dy, dz] of FACE6) {
          const ux = x + dx, uy = y + dy, uz = z + dz;
          const id = world.getPlant(ux, uy, uz);
          if (isWood(id) && !gone.has(key(ux, uy, uz))) kept = true;
          if (id !== PLANT.LEAVES || seen.has(key(ux, uy, uz))) continue;
          if (ux < x0 || uy < y0 || uz < z0 || ux > x1 || uy > y1 || uz > z1) { kept = true; continue; }
          seen.add(key(ux, uy, uz));
          group.push([ux, uy, uz]);
        }
      }
      if (kept) continue;
      for (const v of group) {
        leaves.push(v);
        box[0] = Math.min(box[0], v[0]); box[1] = Math.min(box[1], v[1]); box[2] = Math.min(box[2], v[2]);
        box[3] = Math.max(box[3], v[0]); box[4] = Math.max(box[4], v[1]); box[5] = Math.max(box[5], v[2]);
      }
    }
  return { wood: [...gone.values()], leaves, box };
}

/**
 * Take a severed set out of the world. Wood it was cut from is left ending
 * in a flat cut, where it had no other wood growing on.
 */
export function remove(world, set) {
  if (!set.box) return;
  for (const [x, y, z] of set.wood) world.setPlant(x, y, z, 0);
  for (const [x, y, z, id] of set.wood) {
    const o = DIRS26[woodParent(id)];
    if (!o) continue;
    const px = x + o[0], py = y + o[1], pz = z + o[2], pid = world.getPlant(px, py, pz);
    if (isWood(pid) && !woodCut(pid)) world.setPlant(px, py, pz, withCut(pid, 0, 1));
  }
  for (const [x, y, z] of set.leaves) world.setPlant(x, y, z, 0);
  world.markDirtyBox(...set.box);
}

/**
 * Wood in the voxel box that no longer grows from anything (the ground under
 * it was dug away, or what it grew from was built over) goes, with all it
 * carried. Returns the severed set (already removed), or null.
 */
export function settleWood(world, box) {
  const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]), z0 = Math.max(0, box[2]);
  const x1 = Math.min(world.sx - 1, box[3]), y1 = Math.min(world.sy - 1, box[4]), z1 = Math.min(world.sz - 1, box[5]);
  const loose = [];
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (isWood(world.getPlant(x, y, z)) && !held(world, x, y, z)) loose.push([x, y, z]);
  if (!loose.length) return null;
  const set = severed(world, loose);
  remove(world, set);
  return set;
}

/** Seconds per eighth an axe takes to cut into wood of `radius` metres. */
export const chopTime = (radius) => 0.08 + radius;

/**
 * One axe stroke on wood voxel (x, y, z), from compass direction `side`
 * (0-7, see plants.js; only the first stroke's counts). Cuts an eighth
 * deeper and returns null, or on the stroke that goes through, returns what
 * that frees (severed, not yet removed).
 */
export function chop(world, x, y, z, side) {
  const id = world.getPlant(x, y, z);
  if (!isWood(id)) return null;
  const depth = woodCut(id) + 1;
  if (depth >= 8) return severed(world, [[x, y, z]]);
  world.setPlant(x, y, z, withCut(id, depth, woodCut(id) ? woodCutSide(id) : side));
  world.markDirtyBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);
  return null;
}

/** Compass direction (0-7) of a horizontal vector. */
export function compass(dx, dz) {
  return (Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8;
}

