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
 *            'leaves' – canopy cells, drawn together as a smooth hull with
 *                       leaf cards scattered over it (src/mesh/foliage.js).
 *   support  'floor' – needs solid ground directly below; null – none.
 *   soil     materials a floor plant can grow on (grass and dirt: not stone,
 *            sand, wood or brick).
 *   targetable  can be aimed at and removed on its own (leaves); grass and
 *               flowers are looked through.
 */
const SOIL = [MAT.GRASS, MAT.DIRT];

export const PLANTS = [
  { id: 0, name: 'None' },
  { id: 1, name: 'Grass', kind: 'cross', texture: 'grass_blades', support: 'floor', soil: SOIL, clumps: 3, height: [0.35, 0.6], width: 0.45 },
  { id: 2, name: 'Flowers', kind: 'cross', texture: 'flowers', support: 'floor', soil: SOIL, clumps: 2, height: [0.3, 0.45], width: 0.4 },
  { id: 3, name: 'Leaves', kind: 'leaves', texture: 'leaves', support: null, targetable: true },
];

export const PLANT = { GRASS: 1, FLOWERS: 2, LEAVES: 3 };

/** Lookup tables for the foliage mesher (by plant id): 1 = cross plant, 2 = leaves. */
export const PLANT_KIND = new Uint8Array(256);
for (const p of PLANTS) if (p.id) PLANT_KIND[p.id] = p.kind === 'cross' ? 1 : 2;

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
