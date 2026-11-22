// Material table. Every solid voxel stores one of these ids. Natural ones are
// what terrain is made of; crafted ones mesh with crisper edges (`crisp`, 0..1).
// `render` picks the pass: 'opaque', 'cutout' (alpha-tested, like glass with a
// frame) or 'translucent' (blended, like stained glass). Texture names refer
// to generators in src/render/textures.js.
// `mapping` is how building pieces are textured: 'world' (default) tiles one
// texture per metre of world space, so brick and planks line up across
// pieces; 'piece' maps one texture over each whole piece, following its shape
// (a log's rings centre on it, bark wraps round a pillar). `frame` (rgba,
// 0..1) draws a border along each piece's outline, as on glass. `worldTop`
// and `worldBottom` replace top and bottom where the material is tiled in
// world space (smooth terrain). `cut` is the material terrain of this one is
// drawn as where an edit has cut into it: the surface across edges marked
// cut (Chunk.cut) is Cut Log, end grain whatever way it faces; the rest of
// the wood stays bark. `hidden` materials aren't in the inventory.

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
  {
    id: 9, name: 'Log', natural: true, crisp: 0, mapping: 'piece', cut: 12,
    top: 'log_top', side: 'bark', bottom: 'log_top', worldTop: 'bark', worldBottom: 'bark',
  },
  {
    id: 10, name: 'Glass', natural: false, crisp: 1, render: 'cutout', mapping: 'piece', frame: [0.78, 0.84, 0.86, 1],
    top: 'glass', side: 'glass', bottom: 'glass',
  },
  {
    id: 11, name: 'Stained Glass', natural: false, crisp: 1, render: 'translucent', mapping: 'piece', frame: [0.13, 0.22, 0.4, 0.92],
    top: 'stained_glass', side: 'stained_glass', bottom: 'stained_glass',
  },
  {
    id: 12, name: 'Cut Log', natural: true, crisp: 0, hidden: true,
    top: 'log_end', side: 'log_end', bottom: 'log_end',
  },
];

export const MAT = { GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, PLANKS: 5, BRICK: 6, STONE_BRICK: 7, COBBLE: 8, LOG: 9, GLASS: 10, STAINED_GLASS: 11, CUT_LOG: 12 };

/** Render passes, in drawing order. */
export const PASS_OPAQUE = 0, PASS_CUTOUT = 1, PASS_TRANSLUCENT = 2;
const PASS_OF = { opaque: PASS_OPAQUE, cutout: PASS_CUTOUT, translucent: PASS_TRANSLUCENT };

/** Lookup tables for the mesher: CRISP[id] in 0..1, PASS[id], OPAQUE[id] (1 if it hides what's behind it). */
export const CRISP = new Float32Array(256);
export const PASS = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
for (const m of MATERIALS) {
  if (!m.id) continue;
  CRISP[m.id] = m.crisp;
  PASS[m.id] = PASS_OF[m.render || 'opaque'];
  OPAQUE[m.id] = PASS[m.id] === PASS_OPAQUE ? 1 : 0;
}

/** Building materials, in inventory order. */
export const PALETTE = MATERIALS.filter((m) => m.id && !m.hidden);

/** CUT_OF[id]: how terrain of material id is drawn where an edit has cut into it (0 = as itself). */
export const CUT_OF = new Uint8Array(256);
for (const m of MATERIALS) if (m.cut) CUT_OF[m.id] = m.cut;
