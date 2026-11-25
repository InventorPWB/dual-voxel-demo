// Procedural 32×32 pixel-art textures. No image assets needed.

export const TEX_SIZE = 32;

function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Tileable value noise on a period-32 lattice.
function vnoise(x, y, cell, s) {
  const p = TEX_SIZE / cell;
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v = (i, j) => hash(((i % p) + p) % p, ((j % p) + p) % p, s);
  const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
  const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

const jitter = (c, amt, r) => c.map((v) => v + (r - 0.5) * 2 * amt);
const shade = (c, k) => c.map((v) => v * k);

// The leaves on a leaf card: 100 small ellipses scattered over a rounded
// square, denser in the middle, with small holes between them; the leaf
// shapes make the card's edge ragged.
const LEAF_SPRAY = Array.from({ length: 100 }, (_, k) => {
  const sq = (h) => (h - 0.5) * 2;
  // Pulled a little towards the middle, inside the square.
  const pull = (v) => Math.sign(v) * Math.abs(v) ** 1.25;
  const cx = 16 + pull(sq(hash(k, 0, 50))) * 13, cy = 16 + pull(sq(hash(k, 1, 50))) * 13;
  const a = hash(k, 2, 50) * Math.PI;
  const len = 2.8 + 1.2 * hash(k, 5, 50);
  /** Ellipse radius (< 1 inside) of pixel (x, y). */
  const r = (x, y) => {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
    return (u / len) ** 2 + (v / (len * 0.5)) ** 2;
  };
  return { r };
});

/** Which leaf of the card covers pixel (x, y) (the first one drawn), or -1. */
function leafAt(x, y) {
  const dx = Math.abs(x + 0.5 - 16), dy = Math.abs(y + 0.5 - 16);
  if (dx ** 4 + dy ** 4 > 15.5 ** 4) return -1; // rounded square
  for (let k = 0; k < LEAF_SPRAY.length; k++) if (LEAF_SPRAY[k].r(x, y) <= 1) return k;
  return -1;
}

// Each generator returns [r, g, b] or [r, g, b, a] (0..255) for pixel (x, y);
// y = 0 is the top row. Alpha 0 is a hole in cutout textures (glass, plants).
const GENERATORS = {
  grass_top(x, y) {
    const n = vnoise(x, y, 8, 1);
    let c = [88 + 30 * n, 150 + 30 * n, 52 + 12 * n];
    const r = hash(x, y, 2);
    if (r > 0.86) c = shade(c, 0.78);
    else if (r < 0.08) c = shade(c, 1.12);
    return jitter(c, 6, hash(x, y, 3));
  },
  grass_dirt(x, y) {
    const r = hash(x, y, 4);
    if (r > 0.72) return jitter([84, 140, 50], 10, hash(x, y, 5));
    return GENERATORS.dirt(x, y);
  },
  dirt(x, y) {
    const n = vnoise(x, y, 8, 6);
    let c = [128 + 22 * n, 92 + 16 * n, 62 + 10 * n];
    const r = hash(x, y, 7);
    if (r > 0.88) c = shade(c, 0.72);
    else if (r < 0.06) c = shade(c, 1.18);
    return jitter(c, 5, hash(x, y, 8));
  },
  stone(x, y) {
    const n = 0.6 * vnoise(x, y, 16, 9) + 0.4 * vnoise(x, y, 4, 10);
    const g = 104 + 46 * n;
    let c = [g, g, g + 3];
    if (hash(x, y, 11) > 0.93) c = shade(c, 0.8);
    return jitter(c, 5, hash(x, y, 12));
  },
  sand(x, y) {
    const n = vnoise(x, y, 8, 13);
    let c = [214 + 14 * n, 200 + 14 * n, 152 + 10 * n];
    if (hash(x, y, 14) > 0.9) c = shade(c, 0.9);
    return jitter(c, 4, hash(x, y, 15));
  },
  planks(x, y) {
    const row = Math.floor(y / 8);
    const yy = y % 8;
    if (yy === 7) return [92, 68, 40];
    const joint = (row * 13 + 5) % 32;
    if (x === joint) return [104, 78, 46];
    const grain = vnoise(x * 0.25 + row * 7, yy, 2, 16 + row);
    let c = [164 + 24 * grain, 128 + 18 * grain, 76 + 10 * grain];
    if (yy === 0) c = shade(c, 1.08);
    return jitter(c, 4, hash(x, y, 17));
  },
  brick(x, y) {
    const row = Math.floor(y / 8);
    const yy = y % 8;
    const xx = (x + (row % 2) * 8) % 16;
    if (yy === 7 || xx === 15) return jitter([186, 180, 168], 6, hash(x, y, 18));
    const tone = hash(Math.floor((x + (row % 2) * 8) / 16), row, 19);
    let c = [150 + 30 * tone, 62 + 14 * tone, 46 + 8 * tone];
    if (yy === 0 || xx === 0) c = shade(c, 1.1);
    return jitter(c, 7, hash(x, y, 20));
  },
  stone_brick(x, y) {
    const row = Math.floor(y / 16);
    const xx = (x + (row % 2) * 8) % 16;
    const yy = y % 16;
    if (yy === 15 || xx === 15) return [74, 74, 76];
    const n = vnoise(x, y, 8, 21);
    let c = [128 + 22 * n, 128 + 22 * n, 130 + 22 * n];
    if (yy === 0 || xx === 0) c = shade(c, 1.15);
    if (yy === 14 || xx === 14) c = shade(c, 0.85);
    return jitter(c, 5, hash(x, y, 22));
  },
  cobble(x, y) {
    // Tileable Voronoi stones.
    const cell = 8;
    let d1 = 1e9, d2 = 1e9, id = 0;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const wx = ((gx % 4) + 4) % 4, wy = ((gy % 4) + 4) % 4;
        const px = gx * cell + 1 + hash(wx, wy, 23) * (cell - 2);
        const py = gy * cell + 1 + hash(wx, wy, 24) * (cell - 2);
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
        if (d < d1) { d2 = d1; d1 = d; id = wx + wy * 4; }
        else if (d < d2) d2 = d;
      }
    if (d2 - d1 < 1.3) return jitter([66, 66, 68], 6, hash(x, y, 25));
    const t = hash(id, 0, 26);
    let c = [112 + 40 * t, 112 + 40 * t, 114 + 40 * t];
    if (d1 < 2) c = shade(c, 1.12);
    return jitter(c, 6, hash(x, y, 27));
  },
  spring_top(x, y) {
    // A ring of mossy stone round a welling pool: deep blue in the middle,
    // lighter towards its lip, with bubbles breaking the surface.
    const r = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
    if (r < 10.5) {
      const t = r / 10.5;
      let c = [28 + 70 * t * t, 92 + 80 * t * t, 132 + 70 * t * t];
      const b = hash(x, y, 61);
      if ((b > 0.93 && r > 3) || Math.abs(r - 5.5 - 2 * vnoise(x, y, 8, 62)) < 0.6) c = [196, 226, 236];
      return jitter(c, 4, hash(x, y, 63));
    }
    if (r < 12) return jitter([58, 70, 66], 5, hash(x, y, 64)); // its wet lip
    return GENERATORS.spring(x, y);
  },
  spring(x, y) {
    // Weathered stone, mossy and darkened with wet where water runs over it.
    const n = vnoise(x, y, 8, 65), m = vnoise(x, y, 4, 66);
    let c = [118 + 26 * n, 120 + 26 * n, 116 + 24 * n];
    if (m > 0.62) c = [72 + 30 * m, 104 + 34 * m, 58 + 16 * m]; // moss
    const wet = vnoise(x * 0.5, y * 0.12, 4, 67);
    if (wet > 0.55) c = c.map((v, i) => v * (i === 2 ? 0.86 : 0.74));
    if (Math.floor(y) % 11 === 10) c = shade(c, 0.78); // courses
    return jitter(c, 5, hash(x, y, 68));
  },
  bark(x, y) {
    // Vertical ridges with darker furrows between them.
    const ridge = vnoise(x, y * 0.25, 4, 30);
    const fine = vnoise(x, y, 2, 31);
    let c = [96 + 34 * ridge, 70 + 22 * ridge, 46 + 12 * ridge];
    if (ridge < 0.32) c = shade(c, 0.66);
    c = shade(c, 0.9 + 0.2 * fine);
    return jitter(c, 4, hash(x, y, 32));
  },
  log_top(x, y) {
    const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16) + 1.2 * vnoise(x, y, 8, 33);
    if (d > 14.5) return GENERATORS.bark(x, y);
    const ring = 0.5 + 0.5 * Math.cos(d * 1.6);
    const c = [178 + 26 * ring, 140 + 20 * ring, 88 + 12 * ring];
    return jitter(c, 4, hash(x, y, 34));
  },
  log_end(x, y) {
    // End grain without a centre: wavy growth lines that tile, for the faces
    // of an axe's notch (log_top, rings round the middle, is for sawn ends).
    const v = y + 2.5 * Math.sin((x / 32) * Math.PI * 2) + 1.5 * vnoise(x, y, 8, 36);
    const ring = 0.5 + 0.5 * Math.cos((v / 32) * Math.PI * 2 * 5);
    const c = [176 + 26 * ring, 138 + 20 * ring, 88 + 12 * ring];
    return jitter(c, 4, hash(x, y, 37));
  },
  glass(x, y) {
    // Clear, with a couple of glints. (Its frame is drawn along each piece's outline.)
    const k = x + y;
    if ((k === 11 || k === 13) && x > 3 && x < 10) return [236, 244, 248, 255];
    if (k === 15 && x > 4 && x < 9) return [236, 244, 248, 255];
    return [0, 0, 0, 0];
  },
  stained_glass(x, y) {
    const n = vnoise(x, y, 8, 35);
    return [70 + 20 * n, 118 + 26 * n, 196 + 20 * n, 112 + 24 * n];
  },
  grass_blades(x, y) {
    // A tuft: tapering blades rooted on the bottom row, lighter at the tips.
    for (let b = 0; b < 11; b++) {
      const root = 1 + Math.floor(hash(b, 0, 40) * 30);
      const top = 2 + Math.floor(hash(b, 1, 40) * 16);
      const lean = (hash(b, 2, 40) - 0.5) * 10;
      if (y < top) continue;
      const t = (31 - y) / (31 - top); // 0 at the root, 1 at the tip
      const cx = root + lean * t * t;
      const w = 1.4 * (1 - t) + 0.4;
      if (Math.abs(x + 0.5 - cx) > w) continue;
      const tone = hash(b, 3, 40);
      const c = [62 + 50 * t + 20 * tone, 118 + 60 * t + 18 * tone, 38 + 22 * t];
      return [...jitter(c, 5, hash(x, y, 41)), 255];
    }
    return [0, 0, 0, 0];
  },
  flowers(x, y) {
    // Three flowers on stems among a few blades.
    const heads = [[7, 9, [232, 214, 72]], [18, 6, [226, 96, 126]], [26, 12, [232, 226, 206]]];
    for (const [hx, hy, col] of heads) {
      const d = Math.hypot(x + 0.5 - hx, y + 0.5 - hy);
      if (d < 1.3) return [214, 170, 60, 255];
      if (d < 3.1) return [...jitter(col, 8, hash(x, y, 42)), 255];
      if (Math.abs(x + 0.5 - hx) < 0.9 && y > hy) return [70, 128, 50, 255];
    }
    if (y > 20) return GENERATORS.grass_blades(x, y);
    return [0, 0, 0, 0];
  },
  leaves(x, y) {
    // A spray of small leaves (a few centimetres each), varied greens, with
    // small holes between them (see LEAF_SPRAY).
    const k = leafAt(x, y);
    if (k < 0) return [0, 0, 0, 0];
    const { r } = LEAF_SPRAY[k];
    const tone = hash(k, 3, 50);
    const c = shade([52 + 40 * tone, 104 + 46 * tone, 34 + 18 * tone], 1.1 - 0.3 * r(x, y));
    return [...jitter(c, 6, hash(x, y, 51)), 255];
  },
  leaves_rank(x, y) {
    // Per-leaf random rank (red, 0..255) laid over the same leaves: a fading
    // card drops whole leaves in scattered order. Opaque everywhere (it's
    // data, read at full size only).
    const k = leafAt(x, y);
    return [k < 0 ? 0 : Math.round(8 + 247 * hash(k, 4, 50)), 0, 0, 255];
  },
};

/** RGBA pixels of the procedural texture `name` at `size`² (row 0 = top). */
function proceduralPixels(name, size = TEX_SIZE) {
  const gen = GENERATORS[name];
  const k = TEX_SIZE / size; // the generators work on a 32 × 32 grid
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      // (The generators add 0.5 themselves: sample at the pixel's centre.)
      const [r, g, b, a = 255] = gen((x + 0.5) * k - 0.5, (y + 0.5) * k - 0.5);
      const i = (x + y * size) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  return out;
}

// ---- photographic textures ------------------------------------------------------
// Photo textures (see photoTextures.js) replace procedural ones by name. They
// are TEX_RES² each, and once any is installed every layer of the texture
// array is TEX_RES² (the rest are drawn at that size, see `layerPixels`).
//
// Besides its colour, each layer has a second texel in a parallel array
// (`layerNRH`): R, G the tangent-space normal's x and y (OpenGL convention,
// +y = up the image), B the roughness, A the height (0..1, for height-based
// blending between materials). And `layerInfo`: how many metres one tile of
// it covers in the world, and whether the terrain shader should break up its
// tiling (natural ground; not bricks and planks, whose pattern must stay whole).

export const TEX_RES = 1024;
const photos = new Map();

/**
 * Install a photo texture. `nrh`: its normal/roughness/height texels (or null:
 * flat, at the layer's default roughness); `info`: { metres, stochastic }.
 */
export function setPhoto(name, pixels, nrh = null, info = null) {
  photos.set(name, { pixels, nrh, info });
  avgCache.delete(name);
}
export const hasPhotos = () => photos.size > 0;

// Generators whose shapes are analytic (not pixel patterns), so they can be
// evaluated between the 32 × 32 pixel centres for crisp detail at TEX_RES.
const SMOOTH = new Set(['leaves', 'leaves_rank', 'grass_blades', 'flowers', 'stained_glass', 'log_top', 'log_end']);

/** Roughness of layers without a roughness map. */
const ROUGHNESS = { glass: 0.06, stained_glass: 0.08, leaves: 0.5, grass_blades: 0.55, flowers: 0.55, log_top: 0.7, log_end: 0.7 };

/** RGBA pixels for one texture, row 0 = top: a photo (TEX_RES²) if one is installed, else the 32² procedural one. */
export function texturePixels(name) {
  return photos.get(name)?.pixels || proceduralPixels(name);
}

/** Normal/roughness/height texels of a layer, `size`² (see above). */
export function layerNRH(name, size) {
  const own = photos.get(name)?.nrh;
  if (own) return own;
  const out = new Uint8ClampedArray(size * size * 4);
  const rough = Math.round(255 * (ROUGHNESS[name] ?? 0.8));
  for (let i = 0; i < out.length; i += 4) { out[i] = 128; out[i + 1] = 128; out[i + 2] = rough; out[i + 3] = 128; }
  return out;
}

/** { metres, stochastic } of a layer: metres per tile, and whether to break up its tiling. */
export function layerInfo(name) {
  return { metres: 1, stochastic: false, ...photos.get(name)?.info };
}

/** Drop the normal/roughness/height texels once they're in the texture array. */
export function releaseNRH() {
  for (const p of photos.values()) p.nrh = null;
}

/** Pixels of a texture-array layer, `size`² (= TEX_RES with photos, TEX_SIZE without). */
export function layerPixels(name, size) {
  if (photos.has(name)) return photos.get(name).pixels;
  if (size === TEX_SIZE) return proceduralPixels(name);
  if (SMOOTH.has(name)) return proceduralPixels(name, size);
  // Pixel-art textures: blow the 32² up as-is.
  const src = proceduralPixels(name);
  const out = new Uint8ClampedArray(size * size * 4);
  const k = TEX_SIZE / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = (Math.floor(x * k) + Math.floor(y * k) * TEX_SIZE) * 4, d = (x + y * size) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  return out;
}

/** Tileable value noise on the 32-wide lattice (for photoTextures.js). */
export const tileNoise = vnoise;

/** Draw a texture into a canvas (for HUD swatches). */
export function textureCanvas(name, size = TEX_SIZE) {
  const px = texturePixels(name);
  const n = Math.round(Math.sqrt(px.length / 4));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(px, n, n), 0, 0);
  canvas.style.width = canvas.style.height = `${size}px`;
  return canvas;
}

const avgCache = new Map();

/** Average colour of a texture's visible pixels (0..1 each). */
export function averageColor(name) {
  if (avgCache.has(name)) return avgCache.get(name);
  const px = texturePixels(name);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
  }
  n = n || 1;
  const c = [r / n / 255, g / n / 255, b / n / 255];
  avgCache.set(name, c);
  return c;
}

/** Every texture name, in a fixed order. */
export const TEXTURE_NAMES = Object.keys(GENERATORS);
