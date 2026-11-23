import { faceKey } from './shapes.js';
import { MAT } from './materials.js';

/**
 * The plant layer: a second value per voxel (16 bits), beside material and
 * shape, for things that grow in the air. Plants only live in empty voxels.
 * Whatever becomes solid loses its plant (World.setMat / setVoxel), and plants
 * that need ground under them go when it does (settlePlants, run after every
 * edit).
 *
 * Small ids are plant definitions:
 *   kind     'cross'  – clumps of crossed cards standing on the ground under
 *                       them, at the exact height of the smooth surface there;
 *            'leaves' – canopy cells, filled with leaf cards (src/mesh/foliage.js).
 *   support  'floor' – needs solid ground directly below; null – none.
 *   soil     materials a floor plant can grow on (grass and dirt: not stone,
 *            sand, wood or brick).
 *   targetable  can be aimed at and removed on its own (leaves); grass and
 *               flowers are looked through.
 *
 * Ids with the top bit set are wood: trees, from trunk to twig, are made of
 * nothing else. A wood voxel records
 *   bits 0-4   which of its 26 neighbours it grows from (its parent, towards
 *              the roots): 1 + the index in DIRS26, or 0 for none. A trunk's
 *              lowest voxel grows from the ground below it. So a tree's wood
 *              forms an exact tree, which the mesher draws as one smooth bark
 *              tube along each chain of voxels (see foliage.js);
 *   bits 5-8   its size: one of WOOD_RADIUS, 16 radii from a 7 cm twig to a
 *              metre-thick trunk, each about a fifth thicker than the last;
 *   bits 9-10  how deep an axe has cut into it (0-3 quarters; see chop.js);
 *   bits 11-12 which side the cut is on (one of 4 compass directions); with
 *              no cut, 1 means what grew on from it was cut off, so it ends
 *              in a flat cut (a stump);
 *   bit 13     it's a loose log (LOOSE): the neighbour in bits 0-4 only says
 *              which way it lies, and it grows from nothing (a log put down
 *              on the ground or a block: see interaction.js);
 *   bit 14     it branches off its parent's side (BRANCH), rather than
 *              carrying its parent's wood on: the wood a voxel's tube carries
 *              on into is its thickest child without this. Generated trees
 *              set it on the first voxel of each side shoot; building sets
 *              it on a piece put against a log that something already
 *              carries on (see interaction.js).
 * Wood at least COLLIDE_RADIUS thick is solid to walk into and stand on, and
 * isn't cleared by digging brushes; thinner wood is walked through. Any
 * wood can be chopped with an axe or broken out voxel by voxel (see chop.js).
 */
const SOIL = [MAT.GRASS, MAT.DIRT];

const DEFS = [
  { id: 0, name: 'None' },
  { id: 1, name: 'Grass', kind: 'cross', texture: 'grass_blades', support: 'floor', soil: SOIL, clumps: 3, height: [0.35, 0.6], width: 0.45 },
  { id: 2, name: 'Flowers', kind: 'cross', texture: 'flowers', support: 'floor', soil: SOIL, clumps: 2, height: [0.3, 0.45], width: 0.4 },
  { id: 3, name: 'Leaves', kind: 'leaves', texture: 'leaves', support: null, targetable: true },
];

export const PLANT = { GRASS: 1, FLOWERS: 2, LEAVES: 3 };

/** The 26 neighbour offsets of a voxel. */
export const DIRS26 = [];
for (let dz = -1; dz <= 1; dz++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) DIRS26.push([dx, dy, dz]);

/** Index in DIRS26 of offset d. */
export function dirIndex(d) {
  const k = d[0] + 1 + 3 * (d[1] + 1) + 9 * (d[2] + 1); // of all 27, the middle (13) left out
  return k > 13 ? k - 1 : k;
}

// ---------------------------------------------------------------------- wood

export const WOOD = 0x8000;
/** Flag: branches off its parent's side (see above). */
export const BRANCH = 0x4000;
/** Flag: a loose log, lying along its neighbour's direction, growing from nothing (see above). */
export const LOOSE = 0x2000;
/** Radii (metres) of the 16 wood sizes. */
export const WOOD_RADIUS = Float32Array.from({ length: 16 }, (_, k) => 0.035 * 1.2 ** k);
/** Wood at least this thick (metres) is solid. */
export const COLLIDE_RADIUS = 0.1;
/** Wood sizes from which it's solid. */
export const SOLID_SIZE = WOOD_RADIUS.findIndex((r) => r >= COLLIDE_RADIUS);

export const isWood = (id) => (id & WOOD) !== 0;
/** Index in DIRS26 of the neighbour a wood voxel grows from (or, loose, lies towards), or -1. */
export const woodParent = (id) => (id & 31) - 1;
/** Is it a loose log, growing from nothing? */
export const isLoose = (id) => (id & LOOSE) !== 0;
/** Index in DIRS26 of the neighbour it actually grows from: -1 for none, or loose. */
export const woodGrowsFrom = (id) => ((id & LOOSE) ? -1 : (id & 31) - 1);
export const woodSize = (id) => (id >> 5) & 15;
export const woodRadius = (id) => WOOD_RADIUS[(id >> 5) & 15];
/** How deep it's been cut, in quarters of its thickness. */
export const woodCut = (id) => (id >> 9) & 3;
/** Which side the cut is on: compass direction k, at angle k·90° from +x towards +z. */
export const woodCutSide = (id) => (id >> 11) & 3;
/** Does it branch off its parent's side, rather than carry its parent on? */
export const isBranch = (id) => (id & BRANCH) !== 0;
export const isSolidWood = (id) => (id & WOOD) !== 0 && ((id >> 5) & 15) >= SOLID_SIZE;

/**
 * A wood voxel of `size` growing from its neighbour at offset `from` (or
 * none), off its side if `branch`; or, `loose`, lying towards it, growing
 * from nothing.
 */
export function woodId(size, from = null, branch = false, loose = false) {
  return WOOD | (branch ? BRANCH : 0) | (loose ? LOOSE : 0) | (size & 15) << 5 | (from ? dirIndex(from) + 1 : 0);
}

/** Was what grew on from this wood voxel cut off (a stump)? */
export const isCutOff = (id) => (id & (15 << 9)) === 1 << 11;

/** The same wood voxel growing from its neighbour at offset `from` instead (not loose), carrying it on (or off its side if `branch`). */
export function withParent(id, from, branch = false) {
  return (id & ~31 & ~BRANCH & ~LOOSE) | (branch ? BRANCH : 0) | (dirIndex(from) + 1);
}

/** The same wood voxel cut `cut` quarters deep on `side`. */
export function withCut(id, cut, side) {
  return (id & ~(15 << 9)) | (side & 3) << 11 | (cut & 3) << 9;
}

/** The wood size nearest `radius` metres. */
export function woodSizeFor(radius) {
  const k = Math.round(Math.log(radius / WOOD_RADIUS[0]) / Math.log(1.2));
  return Math.max(0, Math.min(15, k));
}

const WOOD_DEFS = ['Twig', 'Branch', 'Bough', 'Trunk'].map((name) => ({ name, kind: 'wood', texture: 'bark', support: null, targetable: true }));

/** Definition of any plant id: name, kind ('cross', 'leaves', 'wood'), texture, ... */
export function plantDef(id) {
  if (!isWood(id)) return DEFS[id];
  const r = woodRadius(id);
  return WOOD_DEFS[r < 0.06 ? 0 : r < COLLIDE_RADIUS ? 1 : r < 0.25 ? 2 : 3];
}

/** Kind of plant id: 0 none, 1 cross plant, 2 leaves, 3 wood. */
export function plantKind(id) {
  if (isWood(id)) return 3;
  return id === PLANT.LEAVES ? 2 : id ? 1 : 0;
}

/**
 * Can `plant` (a floor plant) grow in empty voxel (x, y, z)? It needs ground
 * of one of its soil materials right below: terrain, or a piece with a full
 * flat top.
 */
export function supportsPlant(world, x, y, z, plant) {
  if (world.isSolid(x, y, z)) return false;
  const soil = plantDef(plant).soil;
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
        if (!p || plantDef(p).support !== 'floor' || supportsPlant(world, x, y, z, p)) continue;
        world.setPlant(x, y, z, 0);
        n++;
      }
  if (n) world.markDirtyBox(x0, y0, z0, x1, y1, z1);
  return n;
}
