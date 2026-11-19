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

// Each generator returns [r, g, b] (0..255) for pixel (x, y); y = 0 is the top row.
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
};

/** RGBA pixels for one texture, row 0 = top. */
export function texturePixels(name) {
  const gen = GENERATORS[name];
  const out = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++)
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g, b] = gen(x, y);
      const i = (x + y * TEX_SIZE) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  return out;
}

/** Draw a texture into a canvas (for HUD swatches). */
export function textureCanvas(name, size = TEX_SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(texturePixels(name), TEX_SIZE, TEX_SIZE), 0, 0);
  canvas.style.width = canvas.style.height = `${size}px`;
  return canvas;
}

export function averageColor(name) {
  const px = texturePixels(name);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  const n = px.length / 4;
  return [r / n / 255, g / n / 255, b / n / 255];
}
