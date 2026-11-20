import { MATERIALS, PALETTE, MAT } from '../world/materials.js';
import { SHAPES, SHAPE } from '../world/shapes.js';

/**
 * Everything the player can hold. Same rule for every item, as in Minecraft:
 * left mouse breaks or digs, right mouse places or uses.
 *
 *  - Tools reshape the ground with smooth brushes.
 *  - Building items are a material + a shape: right mouse places the shape,
 *    left mouse carves the same shape out, Shift + right mouse repaints.
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

/** Inventory layout: tools, then one row of shapes per material. */
export const INVENTORY = {
  tools: TOOLS,
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
    buildItem(MAT.PLANKS, 'slab'),
    buildItem(MAT.BRICK, 'slope'),
    buildItem(MAT.STONE_BRICK, 'stairs'),
    buildItem(MAT.COBBLE, 'pillar'),
  ];
}
