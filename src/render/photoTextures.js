// Photographic textures (CC0, from Poly Haven and ambientCG) for the
// realistic look: loaded and installed before the texture arrays are built
// (see boot.js). Ground and building materials get a full set (colour,
// normal, roughness, ambient occlusion, height) at their real size; plants
// get cards composed from photographed grass, flowers and leaves (see
// foliageTextures.js). Anything that fails to load keeps its procedural
// texture, so the demo still runs without them. Credits: public/textures/LICENSE.md.

import { TEX_RES, setPhoto, tileNoise } from './textures.js';
import { buildFoliage } from './foliageTextures.js';

const BASE = `${import.meta.env.BASE_URL}textures/`;

/** A Poly Haven texture's files (1k JPEGs: diffuse, OpenGL normal, AO/rough/metal, displacement). */
const polyHaven = (id) => ({
  albedo: `${id}/${id}_diff_1k.jpg`, normal: `${id}/${id}_nor_gl_1k.jpg`, arm: `${id}/${id}_arm_1k.jpg`, height: `${id}/${id}_disp_1k.jpg`,
});
/** An ambientCG material's files. */
const ambientCG = (id) => {
  const f = (m) => `${id}/${id}_1K-JPG_${m}.jpg`;
  return { albedo: f('Color'), normal: f('NormalGL'), rough: f('Roughness'), ao: f('AmbientOcclusion'), height: f('Displacement') };
};

// Layer → its files, how many metres one tile covers (the photo's real size),
// whether to break up its tiling (natural ground), a CSS filter nudging the
// colour where the photo is off, and optionally a range to squeeze its
// roughness into.
const SOURCES = {
  // (Its roughness map is glossier than grass looks: the sun glitters off it.)
  grass_top: { ...ambientCG('Grass004'), metres: 1.4, stochastic: true, filter: 'hue-rotate(7deg) saturate(1.08)', roughness: [0.72, 0.95] },
  dirt: { ...polyHaven('forest_ground_06'), metres: 2.11, stochastic: true },
  stone: { ...polyHaven('rock_boulder_dry'), metres: 1.8, stochastic: true, filter: 'saturate(0.45) brightness(0.95)' },
  sand: { ...polyHaven('sand_01'), metres: 1.5, stochastic: true, filter: 'saturate(1.1) brightness(1.08)' },
  planks: { ...polyHaven('oak_wood_planks'), metres: 1.2 },
  // Masonry drawn larger than the photos' nominal size, to suit the 1 m
  // blocks it's built from: bricks about 10 cm a course, stones about 40 cm,
  // cobbles about 20 cm.
  brick: { ...polyHaven('castle_brick_07'), metres: 4.0 },
  stone_brick: { ...polyHaven('stone_brick_wall_001'), metres: 4.5, filter: 'brightness(1.3) saturate(0.85)' },
  cobble: { ...polyHaven('cobblestone_floor_01'), metres: 2.0 },
  bark: { ...polyHaven('bark_brown_01'), metres: 1.0, filter: 'brightness(1.05)' },
};

export function loadImage(file) {
  const img = new Image();
  img.src = BASE + file;
  return img.decode().then(() => img);
}

/** An image drawn at TEX_RES², through an optional CSS filter: its RGBA pixels. */
export function pixelsOf(img, filter = '', size = TEX_RES) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  if (filter) g.filter = filter;
  g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

/**
 * One material's colour (ambient occlusion multiplied in, softened: the
 * lighting has none at this scale) and normal/roughness/height texels.
 */
async function loadMaterial(src) {
  const names = ['albedo', 'normal', 'arm', 'rough', 'ao', 'height'].filter((k) => src[k]);
  const imgs = Object.fromEntries(await Promise.all(names.map(async (k) => [k, await loadImage(src[k])])));
  const albedo = pixelsOf(imgs.albedo, src.filter);
  const normal = pixelsOf(imgs.normal);
  const arm = imgs.arm && pixelsOf(imgs.arm);
  const rough = imgs.rough && pixelsOf(imgs.rough);
  const ao = imgs.ao && pixelsOf(imgs.ao);
  const height = pixelsOf(imgs.height);
  const nrh = new Uint8ClampedArray(albedo.length);
  const [r0, r1] = src.roughness || [0, 1];
  for (let i = 0; i < albedo.length; i += 4) {
    const occ = (arm ? arm[i] : ao ? ao[i] : 255) / 255;
    const k = 0.45 + 0.55 * occ;
    albedo[i] *= k; albedo[i + 1] *= k; albedo[i + 2] *= k; albedo[i + 3] = 255;
    nrh[i] = normal[i];
    nrh[i + 1] = normal[i + 1];
    nrh[i + 2] = 255 * r0 + (r1 - r0) * (arm ? arm[i + 1] : rough ? rough[i] : 200);
    nrh[i + 3] = height[i];
  }
  return { albedo, nrh };
}

/** Grass seen from the side: dirt with patches of grass, ragged-edged (both maps). */
function grassOverDirt(dirt, grass) {
  const albedo = new Uint8ClampedArray(dirt.albedo), nrh = new Uint8ClampedArray(dirt.nrh);
  const k = 32 / TEX_RES;
  for (let y = 0; y < TEX_RES; y++)
    for (let x = 0; x < TEX_RES; x++) {
      const u = x * k, v = y * k;
      const n = 0.55 * tileNoise(u, v, 16, 70) + 0.3 * tileNoise(u, v, 4, 71) + 0.15 * tileNoise(u, v, 1, 72);
      const i = (x + y * TEX_RES) * 4;
      // Grass where it stands higher than the soil.
      const t = Math.min(1, Math.max(0, (n + (grass.nrh[i + 3] - dirt.nrh[i + 3]) / 255 * 0.3 - 0.5) / 0.06));
      const m = t * t * (3 - 2 * t);
      for (let c = 0; c < 4; c++) {
        if (c < 3) albedo[i + c] = dirt.albedo[i + c] + (grass.albedo[i + c] - dirt.albedo[i + c]) * m;
        nrh[i + c] = dirt.nrh[i + c] + (grass.nrh[i + c] - dirt.nrh[i + c]) * m;
      }
    }
  return { albedo, nrh };
}

/** Fetch the photo textures and install them. Resolves with how many layers got one. */
export async function loadPhotoTextures() {
  const names = Object.keys(SOURCES);
  const results = await Promise.allSettled(names.map((n) => loadMaterial(SOURCES[n])));
  const got = {};
  results.forEach((r, i) => {
    const name = names[i];
    if (r.status !== 'fulfilled') {
      console.warn(`Texture ${name} failed to load; using the procedural one.`, r.reason);
      return;
    }
    got[name] = r.value;
    setPhoto(name, r.value.albedo, r.value.nrh, { metres: SOURCES[name].metres, stochastic: !!SOURCES[name].stochastic });
  });
  if (got.dirt && got.grass_top) {
    const side = grassOverDirt(got.dirt, got.grass_top);
    setPhoto('grass_dirt', side.albedo, side.nrh, { metres: 1.75, stochastic: true });
  }
  let count = Object.keys(got).length;
  try {
    const cards = await buildFoliage(got.grass_top?.albedo);
    for (const [name, px] of Object.entries(cards)) setPhoto(name, px);
    count += Object.keys(cards).length;
  } catch (e) {
    console.warn('Foliage textures failed to load; using the procedural ones.', e);
  }
  return count;
}
