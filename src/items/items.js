import { MATERIALS, PALETTE, MAT } from '../world/materials.js';
import { SHAPES, SHAPE } from '../world/shapes.js';
import { PLANT } from '../world/plants.js';

/**
 * Everything the player can hold. Same rule for every item, as in Minecraft:
 * left mouse breaks or digs, right mouse places or uses.
 *
 *  - Tools reshape the ground with smooth brushes.
 *  - Building items are a material + a shape: right mouse places the shape,
 *    left mouse carves the same shape out, Shift + right mouse repaints.
 *  - Plant items fill the plant layer: Leaves places a 1 m block of leaf
 *    voxels like a building piece; Grass plants (or pulls up) grass under a
 *    small brush.
 * Whatever you hold, left mouse on a leaf you aim at removes it.
 */
export const TOOLS = [
  { kind: 'tool', id: 'pickaxe', name: 'Pickaxe', use: 'Hold left mouse to dig', radius: 1.5 },
  { kind: 'tool', id: 'shovel', name: 'Shovel', use: 'Left mouse digs · right mouse raises ground', radius: 2 },
  { kind: 'tool', id: 'trowel', name: 'Trowel', use: 'Hold to smooth', radius: 2 },
  { kind: 'tool', id: 'level', name: 'Level', use: 'Hold to flatten to the height you clicked', radius: 2.5 },
];

export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

const buildItems = new Map();

/** The building item for a material and shape (one shared object per pair). */
export function buildItem(material, shapeId) {
  const key = `${material}:${shapeId}`;
  let item = buildItems.get(key);
  if (!item) {
    const shape = SHAPE[shapeId];
    item = {
      kind: 'build', id: key, material, shape,
      name: shape.id === 'block' ? MATERIALS[material].name : `${MATERIALS[material].name} ${shape.name}`,
      use: 'Right mouse places · left mouse removes · Shift + right mouse paints',
    };
    buildItems.set(key, item);
  }
  return item;
}

export const PLANT_ITEMS = [
  {
    kind: 'plant', id: 'plant:leaves', name: 'Leaves', plant: PLANT.LEAVES, texture: 'leaves', shape: SHAPE.block,
    use: 'Right mouse places a block of leaves · left mouse removes the leaf you aim at',
  },
  {
    kind: 'plant', id: 'plant:grass', name: 'Grass', plant: PLANT.GRASS, texture: 'grass_blades', radius: 1,
    use: 'Right mouse plants grass · left mouse pulls it up',
  },
];

export const PLANT_ITEM = { leaves: PLANT_ITEMS[0], grass: PLANT_ITEMS[1] };

/** Inventory layout: tools, plants, then one row of shapes per material. */
export const INVENTORY = {
  tools: TOOLS,
  plants: PLANT_ITEMS,
  rows: PALETTE.map((m) => SHAPES.map((s) => buildItem(m.id, s.id))),
};

export const HOTBAR_SIZE = 9;

export function defaultHotbar() {
  return [
    TOOL.pickaxe,
    TOOL.shovel,
    TOOL.trowel,
    TOOL.level,
    buildItem(MAT.PLANKS, 'block'),
    buildItem(MAT.BRICK, 'slope'),
    buildItem(MAT.GLASS, 'block'),
    buildItem(MAT.STAINED_GLASS, 'block'),
    PLANT_ITEM.leaves,
  ];
}
