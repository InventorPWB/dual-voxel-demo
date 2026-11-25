// Material table. Every solid voxel stores one of these ids. Natural ones are
// what terrain is made of, and place as terrain; crafted ones are building
// pieces, and mesh with crisper edges (`crisp`, 0..1). (Wood is trees, in the
// plant layer: see plants.js.)
// `render` picks the pass: 'opaque', 'cutout' (alpha-tested, like glass with a
// frame) or 'translucent' (blended, like stained glass). Texture names refer
// to generators in src/render/textures.js.
// `mapping` is how building pieces are textured: 'world' (default) tiles one
// texture per metre of world space, so brick and planks line up across
// pieces; 'piece' maps one texture over each whole piece, following its shape
// (glass in a pillar wraps round it). `frame` (rgba, 0..1) draws a border
// along each piece's outline, as on glass. `hidden` materials aren't in the
// inventory's rows. `icon`: the texture its items show (else its side's).

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
    id: 9, name: 'Glass', natural: false, crisp: 1, render: 'cutout', mapping: 'piece', frame: [0.78, 0.84, 0.86, 1],
    top: 'glass', side: 'glass', bottom: 'glass',
  },
  {
    id: 10, name: 'Stained Glass', natural: false, crisp: 1, render: 'translucent', mapping: 'piece', frame: [0.13, 0.22, 0.4, 0.92],
    top: 'stained_glass', side: 'stained_glass', bottom: 'stained_glass',
  },
  // Water wells up from a spring's top (see SpanSim). Its own items, not a row of shapes.
  { id: 11, name: 'Spring', natural: false, crisp: 1, mapping: 'piece', hidden: true, top: 'spring_top', side: 'spring', bottom: 'spring', icon: 'spring_top' },
];

export const MAT = { GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, PLANKS: 5, BRICK: 6, STONE_BRICK: 7, COBBLE: 8, GLASS: 9, STAINED_GLASS: 10, SPRING: 11 };

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
