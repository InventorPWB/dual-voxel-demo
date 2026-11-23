// Plant cards from photographs: the grass, flower and leaf layers of the
// texture array, composed at load time from pieces cut out of Poly Haven's
// CC0 plant atlases (each a colour map plus an alpha mask: separate blades,
// grass clumps, flowers, leafy sprigs).
//
// A piece is one connected patch of the alpha mask. Each card is a seeded
// arrangement of such pieces, drawn as a real plant would stand on its card:
//  - grass_blades: a tuft of long blades fanning out from the ground, with
//    clumps of shorter grass at their feet;
//  - flowers: a sparser tuft with flowers on stems and a few broad leaves;
//  - leaves: sprigs growing out from the middle of the card and loose leaves
//    around them, with leaves_rank giving each piece its own random rank
//    (the shader drops whole pieces in that order as a card turns edge-on).
//
// Grass is colour-matched to the ground grass texture, so blades and the
// ground under them are the same green.

import { TEX_RES } from './textures.js';

const BASE = `${import.meta.env.BASE_URL}textures/foliage/`;

function load(file) {
  const img = new Image();
  img.src = BASE + file;
  return img.decode().then(() => img);
}

function pixels(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

/** A plant atlas: its colour and alpha (1024², the files' own size). */
async function atlas(id) {
  const [diff, alpha] = await Promise.all([load(`${id}_diff.jpg`), load(`${id}_alpha.jpg`)]);
  const size = 1024;
  return { size, diff: pixels(diff, size), alpha: pixels(alpha, size) };
}

/**
 * The connected patches of an atlas's alpha mask inside `region`
 * ([x0, y0, x1, y1]), at least `minArea` pixels: each with its bounding box,
 * area, mean colour, and a sprite (a canvas of just that patch).
 */
function pieces(a, region = [0, 0, a.size, a.size], minArea = 400, erode = 0) {
  const { size, diff, alpha } = a;
  const [x0, y0, x1, y1] = region;
  const lab = new Int32Array(size * size).fill(-1);
  const stack = new Int32Array(size * size);
  const out = [];
  // The mask to label: the alpha mask, or (erode > 0) the mask shrunk by
  // `erode` pixels, which cuts the thin stalks joining leaves to each other.
  const inMask = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) inMask[i] = alpha[i * 4] >= 128 ? 1 : 0;
  let core = inMask;
  if (erode > 0) {
    const tmp = new Uint8Array(size * size);
    core = new Uint8Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let all = 1;
        for (let d = -erode; d <= erode && all; d++) { const q = x + d; if (q < 0 || q >= size || !inMask[y * size + q]) all = 0; }
        tmp[y * size + x] = all;
      }
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let all = 1;
        for (let d = -erode; d <= erode && all; d++) { const q = y + d; if (q < 0 || q >= size || !tmp[q * size + x]) all = 0; }
        core[y * size + x] = all;
      }
  }
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i0 = y * size + x;
      if (lab[i0] >= 0 || !core[i0]) continue;
      const found = { minx: x, miny: y, maxx: x, maxy: y, area: 0, r: 0, g: 0, b: 0 };
      const label = out.length;
      let sp = 0;
      stack[sp++] = i0;
      lab[i0] = label;
      while (sp) {
        const i = stack[--sp];
        const px = i % size, py = (i / size) | 0;
        found.area++;
        found.r += diff[i * 4]; found.g += diff[i * 4 + 1]; found.b += diff[i * 4 + 2];
        if (px < found.minx) found.minx = px; if (px > found.maxx) found.maxx = px;
        if (py < found.miny) found.miny = py; if (py > found.maxy) found.maxy = py;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const qx = px + dx, qy = py + dy;
          if (qx < x0 || qy < y0 || qx >= x1 || qy >= y1) continue;
          const j = qy * size + qx;
          if (lab[j] >= 0 || !core[j]) continue;
          lab[j] = label;
          stack[sp++] = j;
        }
      }
      out.push(found);
    }
  if (erode > 0) {
    // Grow each piece back out over the mask it was shrunk from (not into
    // another's), as far as it was shrunk and a little more.
    let front = [];
    for (let i = 0; i < size * size; i++) if (lab[i] >= 0) front.push(i);
    for (let step = 0; step < erode + 2; step++) {
      const next = [];
      for (const i of front) {
        const px = i % size, py = (i / size) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const qx = px + dx, qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= size || qy >= size) continue;
          const j = qy * size + qx;
          if (lab[j] >= 0 || !inMask[j]) continue;
          lab[j] = lab[i];
          next.push(j);
          const f = out[lab[i]];
          f.area++;
          if (qx < f.minx) f.minx = qx; if (qx > f.maxx) f.maxx = qx;
          if (qy < f.miny) f.miny = qy; if (qy > f.maxy) f.maxy = qy;
        }
      }
      front = next;
    }
  }
  return out
    .map((p, label) => ({ ...p, label }))
    .filter((p) => p.area >= minArea)
    .map((p) => {
      const n = p.area;
      p.mean = [p.r / n, p.g / n, p.b / n];
      p.w = p.maxx - p.minx + 1;
      p.h = p.maxy - p.miny + 1;
      p.sprite = sprite(a, lab, p);
      return p;
    });
}

/**
 * Canvas of one patch: its pixels, plus the soft rim of the mask around it
 * (for smooth edges). The rim's colour is bled in from inside the patch, so
 * the photo's black background doesn't show as a dark outline.
 */
function sprite(a, lab, p) {
  const { size, diff, alpha } = a;
  const pad = 3;
  const sx = Math.max(0, p.minx - pad), sy = Math.max(0, p.miny - pad);
  const ex = Math.min(size - 1, p.maxx + pad), ey = Math.min(size - 1, p.maxy + pad);
  const w = ex - sx + 1, h = ey - sy + 1;
  const img = new ImageData(w, h);
  const d = img.data;
  const mine = (x, y) => x >= 0 && y >= 0 && x < size && y < size && lab[y * size + x] === p.label;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ax = sx + x, ay = sy + y, i = ay * size + ax, o = (y * w + x) * 4;
      let keep = mine(ax, ay);
      if (!keep && alpha[i * 4] > 8) {
        for (let dy = -2; dy <= 2 && !keep; dy++) for (let dx = -2; dx <= 2 && !keep; dx++) keep = mine(ax + dx, ay + dy);
      }
      if (!keep) continue;
      d[o] = diff[i * 4]; d[o + 1] = diff[i * 4 + 1]; d[o + 2] = diff[i * 4 + 2]; d[o + 3] = alpha[i * 4];
    }
  // Bleed colour from the solid inside out into the semi-transparent rim,
  // a pixel a pass (rim pixels coloured in one pass count as solid in the next).
  const solid = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) solid[k] = d[k * 4 + 3] >= 230 ? 1 : 0;
  for (let pass = 0; pass < 4; pass++) {
    const was = solid.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = y * w + x, o = k * 4;
        if (was[k] || d[o + 3] === 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const qx = x + dx, qy = y + dy;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h || !was[qy * w + qx]) continue;
            const q = (qy * w + qx) * 4;
            r += d[q]; g += d[q + 1]; b += d[q + 2]; n++;
          }
        if (n) { d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; solid[k] = 1; }
      }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(img, 0, 0);
  // Its root: the middle of its lowest rows.
  let rx = 0, rn = 0;
  for (let y = Math.max(0, h - pad - Math.ceil(p.h * 0.04)); y < h; y++)
    for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] >= 128) { rx += x; rn++; }
  return { canvas: c, w, h, rootX: rn ? rx / rn : w / 2, rootY: h - pad };
}

/** Multiply a sprite's colour by `gain` (per channel). */
function tint(sp, gain) {
  const g = sp.canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, sp.w, sp.h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] *= gain[0]; d[i + 1] *= gain[1]; d[i + 2] *= gain[2]; }
  g.putImageData(img, 0, 0);
}

/** White silhouette of a sprite (for drawing ranks). */
function silhouette(sp) {
  const c = document.createElement('canvas');
  c.width = sp.w; c.height = sp.h;
  const g = c.getContext('2d');
  g.drawImage(sp.canvas, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, sp.w, sp.h);
  return c;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw sprite `sp` (or `img`, a same-size stand-in) with its root at (x, y), turned `angle`, scaled. */
function stamp(g, sp, x, y, angle, sx, sy = sx, img = sp.canvas) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.scale(sx, sy);
  g.drawImage(img, -sp.rootX, -sp.rootY);
  g.restore();
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

const meanOf = (list) => {
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of list) { r += p.mean[0] * p.area; g += p.mean[1] * p.area; b += p.mean[2] * p.area; n += p.area; }
  return [r / n, g / n, b / n];
};

/** Average colour of an RGBA buffer's opaque pixels (0..255). */
function average(px) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
  }
  return [r / n, g / n, b / n];
}

/** A tuft of grass across the bottom of a card: `blades` long blades and `clumps` short clumps. */
function tuft(g, S, src, rand, { blades, clumps, sprigs, tall = 1 }) {
  const items = [];
  for (let k = 0; k < blades; k++) items.push('blade');
  for (let k = 0; k < clumps; k++) items.push('clump');
  for (let k = 0; k < sprigs; k++) items.push('sprig');
  // Shuffled, so short and tall overlap every which way.
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const pick = (list) => list[Math.floor(rand() * list.length)];
  for (const kind of items) {
    const x = S * (0.06 + 0.88 * rand());
    const flip = rand() < 0.5 ? -1 : 1;
    const lean = (x / S - 0.5) * 0.55 + (rand() - 0.5) * 0.3;
    if (kind === 'blade') {
      const p = rand() < 0.08 && src.dry.length ? pick(src.dry) : pick(src.blades);
      const s = (S * tall * (0.45 + 0.5 * rand())) / p.sprite.h;
      // Narrowed: the photographed blades are broad (a few millimetres wide here).
      stamp(g, p.sprite, x, S + 6, lean, s * flip * (0.38 + 0.2 * rand()), s);
    } else if (kind === 'clump') {
      const p = pick(src.clumps);
      const s = (S * (0.3 + 0.25 * rand())) / p.sprite.w;
      stamp(g, p.sprite, x, S + 4, lean * 0.3, s * flip, s * (1.6 + 0.8 * rand()));
    } else {
      const p = pick(src.sprigs);
      const s = (S * tall * (0.3 + 0.25 * rand())) / p.sprite.h;
      stamp(g, p.sprite, x, S + 4, lean * 0.6, s * flip, s);
    }
  }
}

/** Grass card. */
function grassCard(src, S) {
  const [c, g] = canvas(S);
  tuft(g, S, src, rng(11), { blades: 90, clumps: 5, sprigs: 6 });
  return g.getImageData(0, 0, S, S).data;
}

/** Flower card: a sparser tuft, a few broad leaves, flowers on stems. */
function flowerCard(src, S) {
  const [c, g] = canvas(S);
  const rand = rng(23);
  tuft(g, S, src, rand, { blades: 30, clumps: 2, sprigs: 2, tall: 0.8 });
  // Broad leaves low down, each on a short stalk.
  for (let k = 0; k < 4 && src.leaves.length; k++) {
    const p = src.leaves[Math.floor(rand() * src.leaves.length)];
    const rx = S * (0.15 + 0.7 * rand());
    const lx = rx + (rand() - 0.5) * S * 0.12, ly = S * (0.72 + 0.12 * rand());
    g.beginPath();
    g.moveTo(rx, S + 4);
    g.quadraticCurveTo(rx, (S + ly) / 2, lx, ly);
    g.lineWidth = 5;
    g.strokeStyle = '#55732f';
    g.stroke();
    const s = (S * (0.13 + 0.05 * rand())) / Math.max(p.sprite.h, p.sprite.w);
    const sp = { ...p.sprite, rootX: p.sprite.w / 2, rootY: p.sprite.h * 0.75 };
    stamp(g, sp, lx, ly, (rand() - 0.5) * 0.9, s * (rand() < 0.5 ? -1 : 1), s);
  }
  // Colours: yellow as photographed, white, and mauve.
  const looks = ['', 'saturate(0.1) brightness(1.3)', 'hue-rotate(255deg) saturate(0.5) brightness(0.95)', ''];
  const n = 4;
  for (let k = 0; k < n; k++) {
    const rx = S * (0.15 + 0.7 * (k + rand() * 0.8) / n);
    const hx = rx + (rand() - 0.5) * S * 0.18, hy = S * (0.12 + 0.3 * rand());
    // Stem: a slight curve, darker at the edges.
    const cx = (rx + hx) / 2 + (rand() - 0.5) * S * 0.12, cy = (S + hy) / 2;
    for (const [width, colour] of [[9, '#3c5422'], [6, '#64843a']]) {
      g.beginPath();
      g.moveTo(rx, S + 4);
      g.quadraticCurveTo(cx, cy, hx, hy);
      g.lineWidth = width;
      g.strokeStyle = colour;
      g.lineCap = 'round';
      g.stroke();
    }
    const p = src.flowers[k % src.flowers.length];
    const s = (S * (0.1 + 0.04 * rand())) / Math.max(p.sprite.w, p.sprite.h);
    g.save();
    g.filter = looks[k % looks.length] || 'none';
    g.translate(hx, hy);
    g.rotate(rand() * Math.PI * 2);
    g.scale(s, s);
    g.drawImage(p.sprite.canvas, -p.sprite.w / 2, -p.sprite.h / 2);
    g.restore();
  }
  return g.getImageData(0, 0, S, S).data;
}

/** Leaf card, and its rank layer. */
function leafCard(src, S) {
  const [c, g] = canvas(S);
  const [rc, rg] = canvas(S);
  rg.fillStyle = '#000';
  rg.fillRect(0, 0, S, S);
  const rand = rng(37);
  const pick = () => src.leaves[Math.floor(rand() * src.leaves.length)];
  const rankOf = () => 8 + Math.floor(247 * rand());
  // Twigs from the middle outwards, each with leaves along it on
  // alternate sides and one at its tip (a leaf's long axis is its sprite's x).
  const leaves = [];
  const twigs = 7;
  for (let k = 0; k < twigs; k++) {
    const a = (k / twigs) * Math.PI * 2 + (rand() - 0.5) * 0.7;
    const r0 = S * 0.05 * rand(), len = S * (0.27 + 0.12 * rand());
    const bend = (rand() - 0.5) * 0.6;
    const at = (t) => {
      const ang = a + bend * t;
      return [S / 2 + Math.cos(a) * r0 + Math.cos(a + bend * t * 0.5) * len * t, S / 2 + Math.sin(a) * r0 + Math.sin(a + bend * t * 0.5) * len * t, ang];
    };
    const rank = rankOf();
    for (const [gg, col] of [[g, null], [rg, `rgb(${rank},${rank},${rank})`]]) {
      gg.filter = 'none';
      gg.lineCap = 'round';
      for (let s = 0; s < 8; s++) {
        const [x0, y0] = at(s / 8), [x1, y1] = at((s + 1) / 8);
        gg.beginPath();
        gg.moveTo(x0, y0);
        gg.lineTo(x1, y1);
        gg.lineWidth = 7 - s * 0.6;
        gg.strokeStyle = col || '#5a4b36';
        gg.stroke();
      }
    }
    let side = rand() < 0.5 ? 1 : -1;
    for (let t = 0.22; t <= 1.001; t += 0.13 + 0.03 * rand()) {
      const [x, y, ang] = at(Math.min(t, 1));
      const tip = t > 0.93;
      const dir = tip ? ang : ang + side * (0.75 + 0.35 * rand());
      side = -side;
      leaves.push({ x, y, dir });
    }
  }
  // More leaves filling in round the middle.
  for (let k = 0; k < 22; k++) {
    const a = rand() * Math.PI * 2, r = S * 0.3 * Math.sqrt(rand());
    leaves.push({ x: S / 2 + Math.cos(a) * r, y: S / 2 + Math.sin(a) * r, dir: a + (rand() - 0.5) * 1.2 });
  }
  for (let i = leaves.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [leaves[i], leaves[j]] = [leaves[j], leaves[i]];
  }
  for (const l of leaves) {
    const p = pick();
    const length = S * (0.12 + 0.05 * rand());
    const s = length / p.sprite.w;
    // Its base at the twig: the sprite's middle half a leaf out along dir.
    const sp = { ...p.sprite, rootX: p.sprite.w / 2, rootY: p.sprite.h / 2 };
    const cx = l.x + Math.cos(l.dir) * length * 0.45, cy = l.y + Math.sin(l.dir) * length * 0.45;
    const flip = rand() < 0.5 ? -1 : 1;
    g.filter = `brightness(${(0.82 + 0.3 * rand()).toFixed(3)})`;
    stamp(g, sp, cx, cy, l.dir, s, s * flip);
    const rank = rankOf();
    rg.filter = `brightness(${(rank / 255).toFixed(4)})`;
    stamp(rg, sp, cx, cy, l.dir, s, s * flip, p.silhouette);
  }
  const card = g.getImageData(0, 0, S, S).data;
  const rank = rg.getImageData(0, 0, S, S).data;
  for (let i = 0; i < rank.length; i += 4) { rank[i + 1] = 0; rank[i + 2] = 0; rank[i + 3] = 255; }
  return { leaves: card, rank };
}

/**
 * Build the plant layers: { grass_blades, flowers, leaves, leaves_rank },
 * each TEX_RES² RGBA. `ground`: the ground grass texture's pixels, to match
 * the blades' colour to.
 */
export async function buildFoliage(ground) {
  const [blades, clumps, bermuda, tree, celandine, dandelion] = await Promise.all(
    ['grass_medium_02', 'grass_medium_01', 'grass_bermuda_01', 'tree_small_02_leaves', 'celandine_01', 'dandelion_01'].map(atlas),
  );
  const isDry = (p) => p.mean[0] > p.mean[1] * 0.97;
  const long = pieces(blades, undefined, 2000).filter((p) => p.h > 3 * p.w);
  const src = {
    blades: long.filter((p) => !isDry(p)),
    // (Not the pale broken stalk: it reads as a white bar.)
    dry: long.filter((p) => isDry(p) && p.mean[0] < 170),
    clumps: pieces(clumps, [0, 740, 1024, 1024], 3000).filter((p) => p.w > 100),
    sprigs: pieces(bermuda, undefined, 1500).filter((p) => p.w > 40 && !isDry(p)),
    leaves: [],
    flowers: [],
  };
  // Match the grass to the ground's: same hue, a little brighter (blades
  // stand up into the light; the ground photo is in their shade).
  if (ground) {
    const want = average(ground).map((v) => v * 1.12);
    const have = meanOf([...src.blades, ...src.clumps, ...src.sprigs]);
    const gain = want.map((v, k) => v / have[k]);
    for (const p of [...src.blades, ...src.dry, ...src.clumps, ...src.sprigs]) tint(p.sprite, gain);
  }
  // Celandine: its heart-shaped leaves (cut from their stalks, and from the
  // atlas's stretched filler, which is yellower), and its flowers; dandelion heads.
  const yellow = (p) => p.mean[0] > 150 && p.mean[1] > 110 && p.mean[2] < 90;
  src.leaves = pieces(celandine, [0, 0, 1024, 700], 4000, 7)
    .filter((p) => p.mean[1] > p.mean[0] * 1.25 && p.w > 120 && p.w < 260 && p.h > 120 && p.h < 260);
  src.flowers = [
    ...pieces(celandine, [0, 700, 1024, 1024], 3000).filter((p) => yellow(p) && p.w < 200 && p.h < 200 && p.w > 60),
    ...pieces(dandelion, [560, 0, 1024, 260], 3000).filter(yellow),
  ];
  const S = TEX_RES;
  const grass = grassCard(src, S);
  const flowers = flowerCard(src, S);
  if (ground) {
    // And once more on the finished card (overlaps, the clumps' stretch and
    // the soft rims shift its average): the same gain on the flower card's
    // greens, not on its flowers.
    const want = average(ground).map((v) => v * 0.97);
    const have = average(grass);
    const gain = want.map((v, k) => v / have[k]);
    for (const px of [grass, flowers])
      for (let i = 0; i < px.length; i += 4) {
        if (px === flowers && !(px[i + 1] > px[i] && px[i + 1] > px[i + 2] * 1.2)) continue;
        px[i] *= gain[0]; px[i + 1] *= gain[1]; px[i + 2] *= gain[2];
      }
  }
  // Single leaves, cut from the sprigs they're photographed on (the mask
  // shrunk, so the thin stalks between them part).
  const leafParts = pieces(tree, [0, 0, 1024, 1024], 4000, 9)
    .filter((p) => p.area < 22000 && p.w > p.h * 1.15 && p.w < 240 && p.mean[1] > p.mean[0] * 1.05);
  for (const p of leafParts) p.silhouette = silhouette(p.sprite);
  const { leaves, rank } = leafCard({ leaves: leafParts }, S);
  return { grass_blades: grass, flowers, leaves, leaves_rank: rank };
}
