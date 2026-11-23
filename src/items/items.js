import { MATERIALS, PALETTE, MAT } from '../world/materials.js';
import { SHAPES, SHAPE } from '../world/shapes.js';
import { PLANT } from '../world/plants.js';

/**
 * Everything the player can hold. Same rule for every item, as in Minecraft:
 * left mouse breaks or digs, right mouse places or uses.
 *
 *  - Tools reshape the ground with smooth brushes; the axe chops wood.
 *  - Building items are a material + a shape: right mouse places the shape,
 *    left mouse carves the same shape out, Shift + right mouse repaints.
 *  - Plant items fill the plant layer: Leaves places a 1 m block of leaf
 *    voxels like a building piece; the wood items one voxel of tree wood,
 *    growing from what it's put on; Grass plants (or pulls up) grass under a
 *    small brush.
 * Whatever you hold, left mouse on leaves or wood breaks them in its shape;
 * the axe chops wood instead.
 */
export const TOOLS = [
  { kind: 'tool', id: 'pickaxe', name: 'Pickaxe', use: 'Hold left mouse to dig', radius: 1.5 },
  { kind: 'tool', id: 'axe', name: 'Axe', use: 'Hold left mouse on wood to chop it', radius: 0.25 },
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

// Wood, voxel by voxel, in four thicknesses (sizes: see plants.js): build or
// mend a tree by hand, as easily as stacking logs.
for (const [name, wood, across] of [['Trunk', 12, '62 cm'], ['Bough', 9, '36 cm'], ['Branch', 6, '21 cm'], ['Twig', 1, '8 cm']]) {
  PLANT_ITEMS.push({
    kind: 'plant', id: `plant:${name.toLowerCase()}`, name: `${name} wood`, wood, texture: 'bark', shape: SHAPE.small,
    use: `Right mouse grows a piece of ${across} wood from the wood or ground you aim at · left mouse breaks wood`,
  });
}

export const PLANT_ITEM = { leaves: PLANT_ITEMS[0], grass: PLANT_ITEMS[1], trunk: PLANT_ITEMS[2], branch: PLANT_ITEMS[4] };

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
    TOOL.axe,
    TOOL.shovel,
    TOOL.trowel,
    TOOL.level,
    buildItem(MAT.PLANKS, 'block'),
    buildItem(MAT.BRICK, 'slope'),
    PLANT_ITEM.trunk,
    PLANT_ITEM.leaves,
  ];
}
