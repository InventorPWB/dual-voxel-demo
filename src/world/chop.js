import { DIRS26, PLANT, isWood, woodParent, woodCut, woodCutSide, withCut } from './plants.js';

/**
 * Cutting trees. Wood voxels form exact trees (each records the voxel it grows
 * from: see plants.js), so what a cut frees is simply everything growing on
 * from the voxel cut through, and the leaves hanging from that.
 *
 * An axe cuts a voxel an eighth of its thickness deeper per stroke, on the
 * side it's struck from (the first stroke picks the side); the mesher draws
 * the cut as a notch faced with end grain. The eighth stroke goes through:
 * the voxel stays as the stump's top, cut flat, and everything beyond it
 * goes. (That's where a felled tree's items will come from.)
 *
 * Wood needs no support otherwise: like logs in Minecraft, a tree stays put
 * if the ground under it is dug away, and breaking a voxel of wood by hand
 * takes only that voxel.
 */

const FACE6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The wood voxels growing directly from wood voxel (x, y, z). */
export function woodChildren(world, x, y, z) {
  const out = [];
  for (const [dx, dy, dz] of DIRS26) {
    const id = world.getPlant(x + dx, y + dy, z + dz);
    if (!isWood(id)) continue;
    const p = DIRS26[woodParent(id)];
    if (p && p[0] === -dx && p[1] === -dy && p[2] === -dz) out.push([x + dx, y + dy, z + dz]);
  }
  return out;
}

/**
 * What goes if wood voxels `cells` go: them and all the wood growing on from
 * them ({ wood: [[x, y, z, id]] }), the leaves nearest that wood
 * ({ leaves: [[x, y, z]] }), and the box round all of it. Nothing is changed
 * yet (see remove).
 */
export function severed(world, cells) {
  const key = (x, y, z) => x + world.sx * (y + world.sy * z);
  const gone = new Map();
  const stack = cells.filter((c) => isWood(world.getPlant(...c))).map((c) => c.slice());
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (x, y, z) => {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.min(box[2], z);
    box[3] = Math.max(box[3], x); box[4] = Math.max(box[4], y); box[5] = Math.max(box[5], z);
  };
  while (stack.length) {
    const [x, y, z] = stack.pop();
    const k = key(x, y, z);
    if (gone.has(k)) continue;
    gone.set(k, [x, y, z, world.getPlant(x, y, z)]);
    grow(x, y, z);
    stack.push(...woodChildren(world, x, y, z));
  }
  if (!gone.size) return { wood: [], leaves: [], box: null };
  // Leaves belong to the wood nearest them (within R voxels; crowns of
  // neighbouring trees often run together, so being joined to other wood
  // through leaves says nothing). Spread out from all the wood around at
  // once, face to face, each voxel taking the label of the wood that reaches
  // it first: those reached first from wood that goes, or by none, go too.
  const R = 6;
  const [x0, y0, z0] = [box[0] - R, box[1] - R, box[2] - R];
  const nx = box[3] - box[0] + 2 * R + 1, ny = box[4] - box[1] + 2 * R + 1, nz = box[5] - box[2] + 2 * R + 1;
  const label = new Uint8Array(nx * ny * nz); // 0 none, 1 gone wood, 2 wood that stays
  const at = (x, y, z) => (x - x0) + nx * ((y - y0) + ny * (z - z0));
  let front = [];
  for (let z = z0; z < z0 + nz; z++)
    for (let y = y0; y < y0 + ny; y++)
      for (let x = x0; x < x0 + nx; x++) {
        if (!isWood(world.getPlant(x, y, z))) continue;
        label[at(x, y, z)] = gone.has(key(x, y, z)) ? 1 : 2;
        front.push([x, y, z]);
      }
  for (let d = 0; d < R && front.length; d++) {
    const next = [];
    for (const [x, y, z] of front)
      for (const [dx, dy, dz] of FACE6) {
        const ux = x + dx, uy = y + dy, uz = z + dz;
        if (ux < x0 || uy < y0 || uz < z0 || ux >= x0 + nx || uy >= y0 + ny || uz >= z0 + nz || label[at(ux, uy, uz)]) continue;
        label[at(ux, uy, uz)] = label[at(x, y, z)];
        next.push([ux, uy, uz]);
      }
    front = next;
  }
  const leaves = [];
  for (let z = z0; z < z0 + nz; z++)
    for (let y = y0; y < y0 + ny; y++)
      for (let x = x0; x < x0 + nx; x++)
        if (world.getPlant(x, y, z) === PLANT.LEAVES && label[at(x, y, z)] !== 2) leaves.push([x, y, z]);
  for (const v of leaves) grow(...v);
  return { wood: [...gone.values()], leaves, box };
}

/**
 * Take a severed set out of the world. The wood it grew from is left ending
 * in a flat cut where nothing else grows on from it.
 */
export function remove(world, set) {
  if (!set.box) return;
  for (const [x, y, z] of set.wood) world.setPlant(x, y, z, 0);
  for (const [x, y, z] of set.leaves) world.setPlant(x, y, z, 0);
  for (const [x, y, z, id] of set.wood) {
    const o = DIRS26[woodParent(id)];
    if (!o) continue;
    const px = x + o[0], py = y + o[1], pz = z + o[2], pid = world.getPlant(px, py, pz);
    if (isWood(pid)) world.setPlant(px, py, pz, withCut(pid, 0, 1));
  }
  world.markDirtyBox(...set.box);
}

/** Seconds per eighth an axe takes to cut into wood of `radius` metres. */
export const chopTime = (radius) => 0.08 + radius;

/**
 * One axe stroke on wood voxel (x, y, z), from compass direction `side`
 * (0-7, see plants.js; only the first stroke's counts). Cuts an eighth
 * deeper and returns null; on the stroke that goes through, the voxel is
 * left as a flat-topped stump and what grew on from it is returned (severed,
 * not yet removed).
 */
export function chop(world, x, y, z, side) {
  const id = world.getPlant(x, y, z);
  if (!isWood(id)) return null;
  const depth = woodCut(id) + 1;
  if (depth >= 8) {
    const set = severed(world, woodChildren(world, x, y, z));
    world.setPlant(x, y, z, withCut(id, 0, 1));
    world.markDirtyBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);
    return set;
  }
  world.setPlant(x, y, z, withCut(id, depth, woodCut(id) ? woodCutSide(id) : side));
  world.markDirtyBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);
  return null;
}

/** Compass direction (0-7) of a horizontal vector. */
export function compass(dx, dz) {
  return (Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) + 8) % 8;
}
