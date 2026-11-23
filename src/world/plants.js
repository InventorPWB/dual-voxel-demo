import { faceKey } from './shapes.js';
import { MAT } from './materials.js';

/**
 * The plant layer: a second value per voxel, beside material and shape, for
 * things that grow in the air (grass, flowers, leaves). Plants are never
 * solid: they only live in empty voxels, don't collide, and terrain and
 * building edits simply overwrite them. Whatever becomes solid loses its plant
 * (World.setMat / setVoxel), and plants that need ground under them go when
 * it does (settlePlants, run after every edit).
 *
 *   kind     'cross'  – clumps of crossed cards standing on the ground under
 *                       them, at the exact height of the smooth surface there;
 *            'leaves' – canopy cells, filled with leaf cards (src/mesh/foliage.js);
 *            'twig'   – thin branches too fine for terrain: each twig voxel is
 *                       joined to its twig neighbours by a thin bark rod of
 *                       `radius` metres.
 *   They're drawn, not collided with, like every plant.
 *   support  'floor' – needs solid ground directly below; null – none.
 *   soil     materials a floor plant can grow on (grass and dirt: not stone,
 *            sand, wood or brick).
 *   targetable  can be aimed at and removed on its own (leaves, twigs); grass
 *               and flowers are looked through.
 */
const SOIL = [MAT.GRASS, MAT.DIRT];

const DEFS = [
  { id: 0, name: 'None' },
  { id: 1, name: 'Grass', kind: 'cross', texture: 'grass_blades', support: 'floor', soil: SOIL, clumps: 3, height: [0.35, 0.6], width: 0.45 },
  { id: 2, name: 'Flowers', kind: 'cross', texture: 'flowers', support: 'floor', soil: SOIL, clumps: 2, height: [0.3, 0.45], width: 0.4 },
  { id: 3, name: 'Leaves', kind: 'leaves', texture: 'leaves', support: null, targetable: true },
  // Wood too thin for terrain, thinnest first (see BRANCH_SIZES): eight
  // sizes, each about a third thicker than the last, which the mesher
  // smooths into an even taper.
  { id: 4, name: 'Twig', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.035 },
  { id: 32, name: 'Twig', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.047 },
  { id: 64, name: 'Branch', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.063 },
  { id: 96, name: 'Branch', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.085 },
  { id: 128, name: 'Branch', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.115 },
  { id: 160, name: 'Bough', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.155 },
  { id: 192, name: 'Bough', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.21 },
  { id: 224, name: 'Bough', kind: 'twig', texture: 'bark', support: null, targetable: true, radius: 0.28 },
];

/** The 26 neighbour offsets of a voxel. */
export const DIRS26 = [];
for (let dz = -1; dz <= 1; dz++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) DIRS26.push([dx, dy, dz]);

/**
 * Plant definitions by id. A twig or branch voxel also records which of its
 * 26 neighbours it grows from (its parent, towards the trunk): its id is the
 * kind's base id + 1 + that direction's index in DIRS26 (the base id alone
 * means no parent). So a tree's twigs form an exact tree, which the mesher
 * draws rod by rod from each voxel to its parent.
 */
export const PLANTS = new Array(256);
for (const d of DEFS) {
  PLANTS[d.id] = d;
  if (d.kind === 'twig') for (let k = 0; k < DIRS26.length; k++) PLANTS[d.id + 1 + k] = d;
}

export const PLANT = { GRASS: 1, FLOWERS: 2, LEAVES: 3, TWIG: 4 };

/** Base ids of the twig kinds, thinnest first, with their radii (metres). */
export const BRANCH_SIZES = DEFS.filter((d) => d.kind === 'twig').map((d) => ({ base: d.id, radius: d.radius }));

/** Base id of the twig kind nearest `radius` metres thick. */
export function branchBase(radius) {
  let best = BRANCH_SIZES[0];
  for (const b of BRANCH_SIZES) if (Math.abs(Math.log(b.radius / radius)) < Math.abs(Math.log(best.radius / radius))) best = b;
  return best.base;
}

/** Id of a twig voxel of `base` (a BRANCH_SIZES base) growing from its neighbour at offset d (or from none). */
export function twigId(base, d = null) {
  if (!d) return base;
  return base + 1 + DIRS26.findIndex((o) => o[0] === d[0] && o[1] === d[1] && o[2] === d[2]);
}

/** Lookup tables for the foliage mesher (by plant id): 1 = cross plant, 2 = leaves, 3 = twig. */
export const PLANT_KIND = new Uint8Array(256);
/** Twig rod radius (metres) by plant id. */
export const TWIG_RADIUS = new Float32Array(256);
/** Index in DIRS26 of the neighbour a twig voxel grows from, or -1. */
export const TWIG_PARENT = new Int8Array(256).fill(-1);
for (let id = 1; id < 256; id++) {
  const d = PLANTS[id];
  if (!d) continue;
  PLANT_KIND[id] = { cross: 1, leaves: 2, twig: 3 }[d.kind];
  if (d.radius) TWIG_RADIUS[id] = d.radius;
  if (d.kind === 'twig' && id > d.id) TWIG_PARENT[id] = id - d.id - 1;
}

/**
 * Can `plant` (a floor plant) grow in empty voxel (x, y, z)? It needs ground
 * of one of its soil materials right below: terrain, or a piece with a full
 * flat top.
 */
export function supportsPlant(world, x, y, z, plant) {
  if (world.isSolid(x, y, z)) return false;
  const soil = PLANTS[plant].soil;
  if (soil && !soil.includes(world.getMat(x, y - 1, z))) return false;
  if (world.isTerrain(x, y - 1, z)) return true;
  return world.isPiece(x, y - 1, z) && faceKey(world.getShape(x, y - 1, z), 2) === 'full';
}

/** Remove plants inside the voxel box that lost what they stand on (or its soil). Returns how many went. */
export function settlePlants(world, box) {
  const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]), z0 = Math.max(0, box[2]);
  const x1 = Math.min(world.sx - 1, box[3]), y1 = Math.min(world.sy - 1, box[4]), z1 = Math.min(world.sz - 1, box[5]);
  let n = 0;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const p = world.getPlant(x, y, z);
        if (!p || PLANTS[p].support !== 'floor' || supportsPlant(world, x, y, z, p)) continue;
        world.setPlant(x, y, z, 0);
        n++;
      }
  if (n) world.markDirtyBox(x0, y0, z0, x1, y1, z1);
  return n;
}
