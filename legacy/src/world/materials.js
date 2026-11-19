// Material table. Every voxel stores one of these ids plus an occupancy value.
// `hard` materials are "cubified" by the mesher: their vertices snap to exact
// cube corners, so they read as Minecraft-style blocks. Everything else is smooth.
// Texture layer names refer to generators in src/render/textures.js.

export const AIR = 0;

export const MATERIALS = [
  { id: 0, name: 'Air' },
  { id: 1, name: 'Grass', hard: false, top: 'grass_top', side: 'grass_dirt', bottom: 'dirt' },
  { id: 2, name: 'Dirt', hard: false, top: 'dirt', side: 'dirt', bottom: 'dirt' },
  { id: 3, name: 'Stone', hard: false, top: 'stone', side: 'stone', bottom: 'stone' },
  { id: 4, name: 'Sand', hard: false, top: 'sand', side: 'sand', bottom: 'sand' },
  { id: 5, name: 'Planks', hard: true, top: 'planks', side: 'planks', bottom: 'planks' },
  { id: 6, name: 'Brick', hard: true, top: 'brick', side: 'brick', bottom: 'brick' },
  { id: 7, name: 'Stone Brick', hard: true, top: 'stone_brick', side: 'stone_brick', bottom: 'stone_brick' },
  { id: 8, name: 'Cobblestone', hard: true, top: 'cobble', side: 'cobble', bottom: 'cobble' },
];

export const MAT = { GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, PLANKS: 5, BRICK: 6, STONE_BRICK: 7, COBBLE: 8 };

/** Lookup table: HARD[id] === 1 for cubified materials. */
export const HARD = new Uint8Array(256);
for (const m of MATERIALS) if (m.hard) HARD[m.id] = 1;

/** Materials selectable in the hotbar (ids 1..8). */
export const PALETTE = MATERIALS.slice(1);
