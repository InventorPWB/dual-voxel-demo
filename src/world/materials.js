// Material table. Every voxel stores one of these ids plus an occupancy value.
// There's no separate "block" type: crafted materials just mesh with crisper
// edges (`crisp`, 0..1) than natural ones. Texture names refer to generators
// in src/render/textures.js.

export const AIR = 0;

export const MATERIALS = [
  { id: 0, name: 'Air' },
  { id: 1, name: 'Grass', natural: true, crisp: 0, top: 'grass_top', side: 'grass_dirt', bottom: 'dirt' },
  { id: 2, name: 'Dirt', natural: true, crisp: 0, top: 'dirt', side: 'dirt', bottom: 'dirt' },
  { id: 3, name: 'Stone', natural: true, crisp: 0.3, top: 'stone', side: 'stone', bottom: 'stone' },
  { id: 4, name: 'Sand', natural: true, crisp: 0, top: 'sand', side: 'sand', bottom: 'sand' },
  { id: 5, name: 'Planks', natural: false, crisp: 1, top: 'planks', side: 'planks', bottom: 'planks' },
  { id: 6, name: 'Brick', natural: false, crisp: 1, top: 'brick', side: 'brick', bottom: 'brick' },
  { id: 7, name: 'Stone Brick', natural: false, crisp: 1, top: 'stone_brick', side: 'stone_brick', bottom: 'stone_brick' },
  { id: 8, name: 'Cobblestone', natural: false, crisp: 0.8, top: 'cobble', side: 'cobble', bottom: 'cobble' },
];

export const MAT = { GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, PLANKS: 5, BRICK: 6, STONE_BRICK: 7, COBBLE: 8 };

/** Lookup table for the mesher: CRISP[id] in 0..1. */
export const CRISP = new Float32Array(256);
for (const m of MATERIALS) if (m.id) CRISP[m.id] = m.crisp;

/** Building materials, in inventory order. */
export const PALETTE = MATERIALS.slice(1);
