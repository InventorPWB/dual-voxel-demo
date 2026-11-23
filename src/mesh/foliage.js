/**
 * Foliage mesher: the plant layer (see world/plants.js) of one padded chunk.
 *
 * Cross plants (grass, flowers) stand on the ground under their voxel. On
 * smooth terrain the exact ground height and slope come from the hermite
 * crossing on the vertical edge below (the same data the terrain is meshed
 * from), so tufts sit on the surface you see, not on the voxel grid. On a
 * building piece they stand on its flat top. Each voxel gets a few clumps of
 * two crossed cards, jittered by a hash of the world position, so re-meshing
 * after an edit nearby puts every tuft back exactly where it was.
 *
 * Leaves are leaf cards through and over the leaf voxels, shaded with a
 * softened leaf field's gradient so each clump shades like one soft volume
 * (see canopy). Wood, trunk to twig, is smooth bark tubes (see wood).
 *
 * Output per vertex: position (metres), normal, uvl (u, v, texture layer),
 * wind (how far it sways: 0 at a plant's root, 1 at the tip), ao, seed (0..1:
 * for a grass clump the distance at which it fades out), and for leaf cards
 * center (the card's centre, metres; the vertex itself elsewhere) and axis
 * (the card's facing; zero elsewhere, which is how the shader tells bark
 * from leaves). Groups:
 * { start, count, materialIndex } with 0 = grass/flowers, 1 = leaves and wood.
 * Also `wood`: the triangles of wood thick enough to be solid (position,
 * and per triangle `cell`, the voxel it belongs to), for collision and aim.
 */

import { unpackNormal } from '../world/normals.js';
import { faceKey } from '../world/shapes.js';
import { PLANT, plantDef, plantKind, isWood, isSolidWood, isCutOff, woodParent, woodRadius, woodCut, woodCutSide, DIRS26 } from '../world/plants.js';
import { TEXTURE_NAMES } from '../render/textures.js';
import { PAD } from './dualContour.js';

const UP = [0, 1, 0];
const layerOf = (id) => TEXTURE_NAMES.indexOf(plantDef(id).texture);
const BARK_LAYER = TEXTURE_NAMES.indexOf('bark');
const CUT_LAYER = TEXTURE_NAMES.indexOf('log_end');
const CARD_LAYER = TEXTURE_NAMES.indexOf('leaves');

/** Hash of integer world coordinates and a salt, in [0, 1). */
export function hash4(x, y, z, k) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440670441) ^ Math.imul(k | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2654435761);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

class Stream {
  constructor() { this.pos = []; this.nrm = []; this.uvl = []; this.wind = []; this.ao = []; this.seed = []; this.center = []; this.axis = []; }
  /** `card`: { center, axis } for a leaf card's vertices. */
  vertex(x, y, z, n, u, v, layer, wind, ao, seed = 0, card = null) {
    this.pos.push(x, y, z);
    this.nrm.push(n[0], n[1], n[2]);
    this.uvl.push(u, v, layer);
    this.wind.push(wind);
    this.ao.push(ao);
    this.seed.push(seed);
    if (card) {
      this.center.push(card.center[0], card.center[1], card.center[2]);
      this.axis.push(card.axis[0], card.axis[1], card.axis[2]);
    } else {
      this.center.push(x, y, z);
      this.axis.push(0, 0, 0);
    }
  }
  /** Triangle a-b-c (each [x, y, z, u, v, wind, ao], and optionally its own normal). */
  tri(a, b, c, n, layer) {
    for (const p of [a, b, c]) this.vertex(p[0], p[1], p[2], p[7] || n, p[3], p[4], layer, p[5], p[6]);
  }
  /** Quad a-b-c-d (each [x, y, z, u, v, wind, ao], and optionally its own normal) as two triangles. */
  quad(a, b, c, d, n, layer, seed = 0, card = null) {
    for (const p of [a, b, c, a, c, d]) this.vertex(p[0], p[1], p[2], p[7] || n, p[3], p[4], layer, p[5], p[6], seed, card);
  }
}

export const DEFAULT_FOLIAGE_OPTIONS = { interiorCards: true };

/**
 * @param {object} p        padded chunk from World.buildPadded (needs `plant`)
 * @param {number} scale    metres per voxel
 * @param {object} options  { interiorCards: sparse cards through the inside of
 *                          each crown, seen through its gaps and from within }
 */
export function meshFoliage(p, scale = 1, options = DEFAULT_FOLIAGE_OPTIONS) {
  const cross = new Stream(), leaves = new Stream(), collide = new Collide();
  if (p.plant) {
    crossPlants(p, scale, cross);
    const field = leafField(p);
    if (field) canopy(p, scale, leaves, field, options);
    wood(p, scale, leaves, field, collide);
  }
  const total = cross.ao.length + leaves.ao.length;
  const out = {
    position: new Float32Array(total * 3), normal: new Float32Array(total * 3),
    uvl: new Float32Array(total * 3), wind: new Float32Array(total), ao: new Float32Array(total),
    seed: new Float32Array(total), center: new Float32Array(total * 3), axis: new Float32Array(total * 3), groups: [], triangles: total / 3,
    wood: { position: new Float32Array(collide.pos), cell: new Float32Array(collide.cell), triangles: collide.cell.length / 3 },
  };
  let at = 0;
  [cross, leaves].forEach((s, materialIndex) => {
    const n = s.ao.length;
    if (!n) return;
    out.position.set(s.pos, at * 3);
    out.normal.set(s.nrm, at * 3);
    out.uvl.set(s.uvl, at * 3);
    out.wind.set(s.wind, at);
    out.ao.set(s.ao, at);
    out.seed.set(s.seed, at);
    out.center.set(s.center, at * 3);
    out.axis.set(s.axis, at * 3);
    out.groups.push({ start: at, count: n, materialIndex });
    at += n;
  });
  return out;
}

// ------------------------------------------------------------- cross plants

function crossPlants(p, scale, out) {
  const { mat, shape, et, en, plant, size, origin } = p;
  const N = size + 2 * PAD, NN = N * N;
  const [ox, oy, oz] = origin;
  const n = [0, 1, 0];
  const up = [0, 1, 0];
  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const i = lx + PAD + N * (ly + PAD) + NN * (lz + PAD);
        const id = plant[i];
        if (plantKind(id) !== 1 || mat[i]) continue;
        const below = i - N;
        const gx = ox + lx, gy = oy + ly, gz = oz + lz;
        // Ground height (voxels) under the voxel's centre, and its normal.
        let h0;
        if (mat[below] && !shape[below]) {
          const k = below * 3 + 1;
          unpackNormal(en[k * 2], en[k * 2 + 1], n);
          if (n[1] < 0.5) continue; // too steep to stand on
          h0 = gy - 0.5 + et[k] / 255;
        } else if (shape[below] && faceKey(shape[below], 2) === 'full') {
          n[0] = 0; n[1] = 1; n[2] = 0;
          h0 = gy;
        } else continue;

        const def = plantDef(id);
        const layer = layerOf(id);
        for (let c = 0; c < def.clumps; c++) {
          const r = (s) => hash4(gx, gy, gz, c * 16 + s);
          const px = gx + 0.12 + 0.76 * r(0), pz = gz + 0.12 + 0.76 * r(1);
          // On the tangent plane through the crossing, kept within the voxel's reach.
          let h = h0 - (n[0] * (px - gx - 0.5) + n[2] * (pz - gz - 0.5)) / n[1];
          h = Math.max(h0 - 0.6, Math.min(h0 + 0.6, h)) - 0.04;
          const H = (def.height[0] + (def.height[1] - def.height[0]) * r(2)) / scale;
          const W = def.width * (0.8 + 0.4 * r(3)) / scale;
          const a = r(4) * Math.PI;
          const lean = [(r(5) - 0.5) * 0.25 * H, (r(6) - 0.5) * 0.25 * H];
          const flip = r(7) < 0.5;
          const seed = r(9) * 0.999;
          for (let q = 0; q < 2; q++) {
            const ang = a + q * Math.PI / 2;
            const dx = Math.cos(ang) * W / 2, dz = Math.sin(ang) * W / 2;
            const u0 = flip ? 1 : 0, u1 = 1 - u0;
            const v = (x, y, z, u, vv, w, ao) => [x * scale, y * scale, z * scale, u, vv, w, ao];
            out.quad(
              v(px - dx, h, pz - dz, u0, 0, 0, 0.55),
              v(px + dx, h, pz + dz, u1, 0, 0, 0.55),
              v(px + dx + lean[0], h + H, pz + dz + lean[1], u1, 1, 1, 1),
              v(px - dx + lean[0], h + H, pz - dz + lean[1], u0, 1, 1, 1),
              // Ground normal: tufts shade like the ground they grow from.
              n[1] > 0.999 ? up : n, layer, seed,
            );
          }
        }
      }
}

// ------------------------------------------------------------- leaf field

/**
 * The padded chunk's leaf voxels as a 0/1 grid, plus a softened field (part
 * the voxel itself, part its 3×3×3 neighbourhood) for smooth normals and AO.
 * Null if there are no leaves.
 */
function leafField(p) {
  const { plant, size } = p;
  const N = size + 2 * PAD, NN = N * N;
  const LEAF = new Uint8Array(N * N * N);
  let any = false;
  for (let i = 0; i < LEAF.length; i++) if (plant[i] === PLANT.LEAVES) { LEAF[i] = 1; any = true; }
  if (!any) return null;
  const F = new Float32Array(N * N * N);
  for (let z = 1; z < N - 1; z++)
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = x + N * y + NN * z;
        let s = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += LEAF[i + dx + N * dy + NN * dz];
        F[i] = 0.4 * LEAF[i] + 0.6 * s / 27;
      }
  /** Trilinear sample; coordinates are padded indices of voxel centres. */
  const field = (qx, qy, qz) => {
    const m = N - 1.0001;
    qx = Math.max(0, Math.min(m, qx)); qy = Math.max(0, Math.min(m, qy)); qz = Math.max(0, Math.min(m, qz));
    const x0 = qx | 0, y0 = qy | 0, z0 = qz | 0, fx = qx - x0, fy = qy - y0, fz = qz - z0;
    const i = x0 + N * y0 + NN * z0;
    const c00 = F[i] + (F[i + 1] - F[i]) * fx, c10 = F[i + N] + (F[i + N + 1] - F[i + N]) * fx;
    const c01 = F[i + NN] + (F[i + NN + 1] - F[i + NN]) * fx, c11 = F[i + NN + N] + (F[i + NN + N + 1] - F[i + NN + N]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  };
  /** Outward normal (down the field's gradient) into n; returns the AO there. */
  const shadeAt = (qx, qy, qz, n) => {
    let nx = field(qx - 1, qy, qz) - field(qx + 1, qy, qz);
    let ny = field(qx, qy - 1, qz) - field(qx, qy + 1, qz);
    let nz = field(qx, qy, qz - 1) - field(qx, qy, qz + 1);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
    n[0] = nx; n[1] = ny; n[2] = nz;
    // Darker where there's more canopy just outside, and underneath.
    const outside = field(qx + nx * 1.5, qy + ny * 1.5, qz + nz * 1.5);
    return (1 - Math.min(0.5, outside * 1.2)) * (0.72 + 0.28 * (ny * 0.5 + 0.5));
  };
  return { LEAF, F, N, NN, field, shadeAt };
}

/**
 * One leaf card centred on c (padded voxel-centre coordinates) with half-size
 * `half` voxels, facing `facing` tipped up to `tilt` at random and turned in
 * its plane by a quarter turn or more, give or take `spin` radians (a square
 * card stays roughly square to its face's neighbours, so they overlap
 * evenly); `r(k)` gives this card's random numbers. `shadeN` is its
 * shading normal. Its centre and facing go along with it (for the shader's
 * edge-on fade, and tests).
 */
function leafCard(out, c, facing, shadeN, half, ao, r, world, tilt, wobble = Math.PI) {
  let ax = facing[0] + (r(0) - 0.5) * 2 * tilt, ay = facing[1] + (r(1) - 0.5) * 2 * tilt, az = facing[2] + (r(2) - 0.5) * 2 * tilt;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  // Tangent frame around it, spun randomly.
  const ref = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let tx = ref[1] * az - ref[2] * ay, ty = ref[2] * ax - ref[0] * az, tz = ref[0] * ay - ref[1] * ax;
  const tl = Math.hypot(tx, ty, tz);
  tx /= tl; ty /= tl; tz /= tl;
  let bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;
  const spin = Math.floor(r(3) * 4) * Math.PI / 2 + (r(11) - 0.5) * 2 * wobble, cs = Math.cos(spin), sn = Math.sin(spin);
  [tx, ty, tz, bx, by, bz] = [tx * cs + bx * sn, ty * cs + by * sn, tz * cs + bz * sn, bx * cs - tx * sn, by * cs - ty * sn, bz * cs - tz * sn];
  const tag = { center: [world(c[0], 0), world(c[1], 1), world(c[2], 2)], axis: [ax, ay, az] };
  const shade = ao * (0.9 + 0.2 * r(9));
  const corner = (su, sv) => {
    const q = (k) => world(c[k] + ([tx, ty, tz][k] * su + [bx, by, bz][k] * sv) * half, k);
    return [q(0), q(1), q(2), (su + 1) / 2, (sv + 1) / 2, 1, shade];
  };
  out.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), shadeN, CARD_LAYER, 0, tag);
}

/**
 * Of the candidate voxels (padded indices with their world coordinates), the
 * one with the lowest hash in each 2×2×2 block. Blocks line up with chunks
 * (their size is even), so every candidate of a block is in one chunk.
 */
function onePerBlock(candidates, salt) {
  const best = new Map();
  for (const c of candidates) {
    const [, gx, gy, gz] = c;
    const key = (gx >> 1) + 65536 * ((gy >> 1) + 65536 * (gz >> 1));
    const h = hash4(gx, gy, gz, salt);
    const b = best.get(key);
    if (!b || h < b[0]) best.set(key, [h, c]);
  }
  return [...best.values()].map((b) => b[1]);
}

// -------------------------------------------------------------------- canopy

/** Leaf card size (metres; each varies from 90% to 120% of it), on 0.5 m voxels. */
const CARD_SIZE = 0.7;
/** Cards per open leaf voxel. */
const CARDS_PER_VOXEL = 2;

/**
 * Leaf cards, and nothing else: no shell, so you can see into a crown.
 *
 * Every open leaf voxel (one with a face against air rather than more
 * leaves, twigs or anything solid) holds two cards, each a bit wider than
 * the voxel, centred inside it give or take a quarter voxel: one turned
 * every which way about the outward direction, one across it, so from any
 * side one of them is turned your way. So the leaves roughly fill
 * the space each voxel takes up: a placed 1 m block is a clump of leaves the
 * size of the block, a wall is a leafy wall with the odd chink of light
 * through it, and breaking voxels out takes their leaves with them. Their
 * different angles keep the voxel grid from showing.
 *
 * Cards turned edge-on to you drop their leaves as they go (keepCard), so
 * there are no streaks; the other cards around fill in.
 *
 * Inside (interiorCards): one card per 2×2×2 block of closed voxels, at any
 * angle and darker, so the inside of a crown is leafy when seen through a
 * gap or from within.
 *
 * Cards shade with the leaf field's gradient (outwards from the leaves as a
 * whole), so a mass of leaves shades as one soft volume, not card by card.
 */
function canopy(p, scale, out, field, { interiorCards = false } = {}) {
  const { size, origin, plant, mat } = p;
  const { LEAF, N, NN, shadeAt } = field;
  const [ox, oy, oz] = origin;
  const world = (q, k) => (q + [ox, oy, oz][k] - PAD + 0.5) * scale;
  const half = CARD_SIZE / scale / 2; // voxels
  const step = [1, -1, N, -N, NN, -NN];
  const n = [0, 0, 0];
  const closed = [];
  for (let lz = 0; lz < size; lz++)
    for (let ly = 0; ly < size; ly++)
      for (let lx = 0; lx < size; lx++) {
        const px = lx + PAD, py = ly + PAD, pz = lz + PAD;
        const i = px + N * py + NN * pz;
        if (!LEAF[i]) continue;
        const gx = ox + lx, gy = oy + ly, gz = oz + lz;
        const open = step.some((d) => !LEAF[i + d] && !mat[i + d] && !isWood(plant[i + d]));
        if (!open) { closed.push([i, gx, gy, gz]); continue; }
        const ao = shadeAt(px, py, pz, n);
        const facing = [n[0], n[1], n[2]];
        for (let k = 0; k < CARDS_PER_VOXEL; k++) {
          const r = (j) => hash4(gx, gy, gz, 100 + k * 16 + j);
          // The first about the outward direction, the second across it, so
          // from any side some card of the voxel is turned your way.
          let f = facing;
          if (k) {
            const q = [r(12) - 0.5, r(13) - 0.5, r(14) - 0.5];
            f = [facing[1] * q[2] - facing[2] * q[1], facing[2] * q[0] - facing[0] * q[2], facing[0] * q[1] - facing[1] * q[0]];
            const l = Math.hypot(f[0], f[1], f[2]) || 1;
            f = f.map((x) => x / l);
          }
          const c = [px + (r(6) - 0.5) * 0.5 + facing[0] * 0.1, py + (r(7) - 0.5) * 0.5 + facing[1] * 0.1, pz + (r(8) - 0.5) * 0.5 + facing[2] * 0.1];
          leafCard(out, c, f, facing, half * (0.9 + 0.3 * r(4)), ao, r, world, k ? 0.4 : 0.8);
        }
      }
  if (interiorCards) {
    for (const [i, gx, gy, gz] of onePerBlock(closed, 300)) {
      const c0 = [i % N, ((i / N) | 0) % N, (i / NN) | 0];
      const r = (k) => hash4(gx, gy, gz, 310 + k);
      const c = [c0[0] + (r(6) - 0.5) * 0.8, c0[1] + (r(7) - 0.5) * 0.8, c0[2] + (r(8) - 0.5) * 0.8];
      const ao = 0.75 * shadeAt(c[0], c[1], c[2], n);
      // The field is flat in here, so its normal means little: shade as lit
      // from above, and turn the card any way at all.
      leafCard(out, c, UP, UP, half * (1.2 + 0.3 * r(4)), ao, r, world, 1.0);
    }
  }
}

// ---------------------------------------------------------------------- wood

const ROD_SIDES = 8;
/** How far (voxels) a tube growing out of the ground or other solid runs on into it. */
const ROOT_DEPTH = 1.6;
const SNAP = DIRS26.map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; });
/** The 8 compass directions a cut can face (see plants.js). */
const CUT_SIDES = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), 0, Math.sin((k * Math.PI) / 4)]);
/** Padded-index offset of each DIRS26 direction, for a padded chunk N voxels across. */
const dirSteps = (N) => DIRS26.map(([dx, dy, dz]) => dx + N * dy + N * N * dz);

/**
 * A frame [u, w] square to unit direction t: +y turned onto t by the shortest
 * rotation. It depends only on t and changes smoothly with it, so rings with
 * nearly the same direction line up, except near straight down, where it
 * spins: so it's taken about the way wood grows (away from its parent),
 * which is hardly ever down.
 */
function frame(t) {
  const [x, y, z] = t, k = 1 + y;
  if (k < 1e-6) return [[-1, 0, 0], [0, 0, 1]];
  return [[y + (z * z) / k, -x, (-x * z) / k], [(-x * z) / k, -z, y + (x * x) / k]];
}

/**
 * Wood: trees from trunk to twig. Each wood voxel knows the neighbour it
 * grows from (see plants.js), so a tree is an exact tree of voxels, drawn as
 * one continuous eight-sided bark tube along each chain, tapering with the
 * voxels' sizes. A trunk's lowest voxel grows from the ground: there the tube
 * carries on down into it, flaring out, so the trunk spreads into the ground.
 * (Anything else growing out of something solid just sinks into it.)
 *
 * Voxel centres alone make a staircase of 45° and 90° steps, and the sizes
 * steps, so the tube runs through smoothed points with smoothed radii: two
 * rounds of moving each voxel towards the middle of its parent and its main
 * child (its thickest), so a bough runs smoothly on through the forks where
 * side shoots leave it. Consecutive pieces share the ring where they meet,
 * square to the chain's direction there (from parent to main child), so
 * bends have no gaps or creases; a side shoot's last ring sinks into the
 * middle of the thicker wood it joins. Normals are smooth round the tube,
 * and the bark is tiled to the tube's girth and runs on along it. Loose ends
 * are closed with a short point.
 *
 * A voxel an axe has cut into has its ring flattened on the cut's side, as
 * deep as the cut, so the pieces either side of it make a notch, faced with
 * end grain (see chop.js).
 *
 * Solid wood (see plants.js) also goes into `collide`: its triangles,
 * each with the voxel it belongs to, for the player to bump into and stand
 * on, and to aim at.
 *
 * Everything here needs only voxels within three steps, all inside the
 * padding, so neighbouring chunks agree on every shared ring.
 *
 * Owned by the chunk of the child voxel.
 */
function wood(p, scale, out, field, collide) {
  const { plant, mat, size, origin } = p;
  const N = size + 2 * PAD, NN = N * N;
  const [ox, oy, oz] = origin;
  const step = dirSteps(N);
  const world = (q, k) => (q + [ox, oy, oz][k] - PAD + 0.5) * scale;
  const coords = (i) => [i % N, ((i / N) | 0) % N, (i / NN) | 0];

  // Wood voxels with their parent and children (a parent off the array's
  // edge counts as none: it's three voxels from anything drawn here).
  const parentOf = new Map(), children = new Map();
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = x + N * y + NN * z;
        if (!isWood(plant[i])) continue;
        const d = woodParent(plant[i]);
        let par = -1;
        if (d >= 0) {
          const [dx, dy, dz] = DIRS26[d];
          const qx = x + dx, qy = y + dy, qz = z + dz;
          if (qx >= 0 && qy >= 0 && qz >= 0 && qx < N && qy < N && qz < N) par = i + step[d];
        }
        parentOf.set(i, par);
        if (par >= 0) {
          if (!children.has(par)) children.set(par, []);
          children.get(par).push(i);
        }
      }
  if (!parentOf.size) return;
  // Each voxel's main child: its thickest (the first, of equals).
  const main = new Map();
  for (const [i, kids] of children) {
    let best = kids[0];
    for (const c of kids) if (woodRadius(plant[c]) > woodRadius(plant[best])) best = c;
    main.set(i, best);
  }
  const isW = (i) => i >= 0 && parentOf.has(i);

  // Smoothed points and radii along each chain.
  let pts = new Map(), rad = new Map();
  for (const i of parentOf.keys()) { pts.set(i, coords(i)); rad.set(i, woodRadius(plant[i])); }
  const point = (i) => pts.get(i) || coords(i);
  const radius = (i) => rad.get(i) ?? woodRadius(plant[i]);
  for (let round = 0; round < 2; round++) {
    const next = new Map(), nextR = new Map();
    for (const [i, par] of parentOf) {
      const here = point(i);
      if (!isW(par) || !main.has(i)) { next.set(i, here); nextR.set(i, radius(i)); continue; }
      const a = point(par), b = point(main.get(i));
      next.set(i, [0, 1, 2].map((k) => 0.5 * here[k] + 0.25 * (a[k] + b[k])));
      nextR.set(i, 0.5 * radius(i) + 0.25 * (radius(par) + radius(main.get(i))));
    }
    pts = next;
    rad = nextR;
  }
  const unit = (d) => {
    const l = Math.hypot(d[0], d[1], d[2]);
    return l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : null;
  };
  // Where the solid is from a wood voxel growing out of it: the mean
  // direction to the solid voxels within two steps (nearer ones counting
  // more), so its tube heads into the solid's middle, not just into the
  // voxel it was joined to.
  const solidDir = new Map();
  const intoSolid = (i) => {
    if (solidDir.has(i)) return solidDir.get(i);
    const [x, y, z] = coords(i);
    const d = [0, 0, 0];
    for (let dz = -2; dz <= 2; dz++)
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const qx = x + dx, qy = y + dy, qz = z + dz;
          if (!(dx || dy || dz) || qx < 0 || qy < 0 || qz < 0 || qx >= N || qy >= N || qz >= N || !mat[qx + N * qy + NN * qz]) continue;
          const w = 1 / (dx * dx + dy * dy + dz * dz);
          d[0] += dx * w; d[1] += dy * w; d[2] += dz * w;
        }
    const r = unit(d) || unit(DIRS26[woodParent(plant[i])]);
    solidDir.set(i, r);
    return r;
  };
  // The chain's direction through voxel i (towards its parent), or null at
  // a root or tip: from two voxels along on one side to two on the other
  // (as far as the chain goes), so it isn't held to the voxels' 45° steps.
  // Where it grows out of something solid, halfway between the way it comes
  // from and the way into the solid, so the bend there is mitred too.
  const along = (i) => {
    const par = parentOf.get(i);
    if (par < 0 || !main.has(i)) return null;
    const c = main.get(i);
    if (mat[par]) {
      const from = unit(coords(i).map((q, k) => q - coords(main.has(c) ? main.get(c) : c)[k]));
      const into = intoSolid(i);
      return (from && unit(from.map((q, k) => q + into[k]))) || into;
    }
    const gp = parentOf.get(par) ?? -1;
    const a = coords(par), a2 = coords(gp >= 0 ? gp : par);
    const b = coords(c), b2 = coords(main.has(c) ? main.get(c) : c);
    return unit([0, 1, 2].map((k) => a[k] + a2[k] - b[k] - b2[k]));
  };

  // Bark is tiled once a metre: round each ring a whole number of times, and
  // along the tube by distance along the nearest of the 26 directions to its
  // own, so rings shared by two pieces agree and the bark runs on unbroken
  // until the tube turns past 22°. A cut voxel's ring is flattened on the
  // cut's side (`cut` of its id): those vertices are marked, and face that way.
  const ring = (c, t, r, id = 0) => {
    const [u, w] = frame([-t[0], -t[1], -t[2]]);
    const tiles = Math.max(1, Math.round(2 * Math.PI * r));
    const at = [world(c[0], 0), world(c[1], 1), world(c[2], 2)];
    let axis = 0, best = -2;
    for (let k = 0; k < SNAP.length; k++) {
      const q = SNAP[k], dq = q[0] * t[0] + q[1] * t[1] + q[2] * t[2];
      if (dq > best) { best = dq; axis = k; }
    }
    const q = SNAP[axis];
    const v = at[0] * q[0] + at[1] * q[1] + at[2] * q[2];
    // The cut: a plane square to its side (turned into the ring's plane),
    // `depth` eighths of the way through.
    let side = null, limit = 0;
    if (id && woodCut(id)) {
      const s = CUT_SIDES[woodCutSide(id)], st = s[0] * t[0] + s[1] * t[1] + s[2] * t[2];
      side = unit([s[0] - t[0] * st, s[1] - t[1] * st, s[2] - t[2] * st]);
      limit = r * (1 - (2 * woodCut(id)) / 8);
    }
    const verts = [];
    for (let k = 0; k <= ROD_SIDES; k++) {
      const ang = (k / ROD_SIDES) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      const e = [cs * u[0] + sn * w[0], cs * u[1] + sn * w[1], cs * u[2] + sn * w[2]];
      let o = [e[0] * r, e[1] * r, e[2] * r], n = e, cut = false;
      const over = side ? o[0] * side[0] + o[1] * side[1] + o[2] * side[2] - limit : 0;
      if (over > 0) {
        o = [o[0] - side[0] * over, o[1] - side[1] * over, o[2] - side[2] * over];
        n = side;
        cut = true;
      }
      verts.push({ p: [at[0] + o[0], at[1] + o[1], at[2] + o[2]], e: n, u: (k / ROD_SIDES) * tiles, cut });
    }
    return { verts, v, axis };
  };
  // How far a tube growing out of something solid can run on into it: to
  // just short of where it would come out again (through a thin wall, at a
  // steep angle), at most ROOT_DEPTH.
  const solidAt = (q) => {
    const x = Math.round(q[0]), y = Math.round(q[1]), z = Math.round(q[2]);
    return x >= 0 && y >= 0 && z >= 0 && x < N && y < N && z < N && !!mat[x + N * y + NN * z];
  };
  const rootDepth = (a, dir) => {
    let inside = -1;
    for (let s = 0.25; s <= ROOT_DEPTH + 0.5; s += 0.25) {
      const solid = solidAt([a[0] + dir[0] * s, a[1] + dir[1] * s, a[2] + dir[2] * s]);
      if (solid && inside < 0) inside = s;
      if (!solid && inside >= 0) return Math.max(inside + 0.25, Math.min(ROOT_DEPTH, s - 0.5));
    }
    return ROOT_DEPTH;
  };
  const n = [0, 0, 0];
  // Only a little darker inside the leaves.
  const aoAt = (q) => (field ? 1 - 0.35 * (1 - field.shadeAt(q[0], q[1], q[2], n)) : 1);
  // A flat end of end grain at voxel i, square to t (towards its parent).
  const endGrain = (i, t, ao) => {
    const E = ring(point(i), t, radius(i), plant[i]);
    const c = point(i);
    const mid = [world(c[0], 0), world(c[1], 1), world(c[2], 2), 0.5, 0.5, 0, ao, t];
    for (let k = 0; k < ROD_SIDES; k++) {
      const q = (e) => [e.p[0], e.p[1], e.p[2], 0.5 + 0.5 * Math.cos((k + (e === E.verts[k] ? 0 : 1)) * Math.PI / 4), 0.5 + 0.5 * Math.sin((k + (e === E.verts[k] ? 0 : 1)) * Math.PI / 4), 0, ao, t];
      out.tri(mid, q(E.verts[k]), q(E.verts[k + 1]), t, CUT_LAYER);
    }
  };
  for (const [i, par] of parentOf) {
    const [x, y, z] = coords(i);
    if (x < PAD || y < PAD || z < PAD || x >= PAD + size || y >= PAD + size || z >= PAD + size) continue;
    const id = plant[i];
    if (par < 0 && woodParent(id) >= 0) continue; // what it grows from is off the array: not drawn here
    const solid = par >= 0 && !!mat[par];
    if (!solid && !isW(par)) {
      // What it grew from is gone (cut away): the wood ends here, cut flat.
      if (main.has(i)) endGrain(i, along(i) || unit(point(i).map((q, k) => q - point(main.get(i))[k])), aoAt(point(i)));
      continue;
    }
    const a = point(i);
    const into = solid && intoSolid(i);
    // Out of the ground (or other solid): carry straight on into it, rather
    // than bending to the voxel's centre, which may be off to one side.
    const b = into ? [0, 1, 2].map((k) => a[k] + into[k] * rootDepth(a, into)) : point(par);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) continue;
    const dir = [d[0] / len, d[1] / len, d[2] / len];
    const ta = along(i) || dir;
    const tb = into || (main.get(par) === i && along(par)) || dir;
    // Into the ground below: flaring out (a trunk's foot); into anything
    // else solid, tapering away inside it. Into a stem it leaves from the
    // side: narrowing as it sinks to that stem's middle, so its end stays
    // inside it however steeply it leaves.
    const ra = radius(i), solidWood = isSolidWood(id);
    const rb = into ? ra * (into[1] < -0.6 && solidWood ? 1.9 : 0.5) : main.get(par) === i ? radius(par) : 0.7 * Math.min(ra, radius(par));
    const A = ring(a, ta, ra, id), B = ring(b, tb, rb, !solid && main.get(par) === i ? plant[par] : 0);
    const lenM = len * scale;
    let vb = B.v;
    if (A.axis !== B.axis || Math.abs(vb - A.v - lenM) > 0.5 * lenM) vb = A.v + lenM;
    const ao = aoAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    const corner = (q, vv) => [q.p[0], q.p[1], q.p[2], q.u, vv, 0, ao, q.e];
    const cell = [ox + x - PAD, oy + y - PAD, oz + z - PAD];
    for (let k = 0; k < ROD_SIDES; k++) {
      const q = [corner(A.verts[k], A.v), corner(A.verts[k + 1], A.v), corner(B.verts[k + 1], vb), corner(B.verts[k], vb)];
      const cut = A.verts[k].cut || A.verts[k + 1].cut || B.verts[k].cut || B.verts[k + 1].cut;
      out.quad(q[0], q[1], q[2], q[3], A.verts[k].e, cut ? CUT_LAYER : BARK_LAYER);
      if (solidWood) collide.quad(q, cell);
    }
    // Close the ends no other piece shares, so you never see into the tube:
    // where it sinks into something solid, a flat end; at a tip, a short point.
    if (solid) {
      const c = [world(b[0], 0), world(b[1], 1), world(b[2], 2), 0.5, vb, 0, ao, tb];
      for (let k = 0; k < ROD_SIDES; k++) out.tri(c, corner(B.verts[k + 1], vb), corner(B.verts[k], vb), tb, BARK_LAYER);
    }
    const onward = [-dir[0], -dir[1], -dir[2]];
    if (!children.has(i) && solidAt([a[0] + onward[0] * 0.9, a[1] + onward[1] * 0.9, a[2] + onward[2] * 0.9])) {
      // Running into the ground (a root): carry on into it, out of sight.
      const e = [0, 1, 2].map((k) => a[k] + onward[k] * ROOT_DEPTH);
      const C = ring(e, ta, ra * 0.6);
      for (let k = 0; k < ROD_SIDES; k++)
        out.quad(corner(C.verts[k], A.v - lenM), corner(C.verts[k + 1], A.v - lenM), corner(A.verts[k + 1], A.v), corner(A.verts[k], A.v), A.verts[k].e, BARK_LAYER);
    } else if (!children.has(i) && isCutOff(id)) endGrain(i, ta, ao); // a stump: cut flat
    else if (!children.has(i)) {
      const tip = [0, 1, 2].map((k) => a[k] - dir[k] * (ra / scale) * 1.5);
      const back = [-dir[0], -dir[1], -dir[2]];
      const c = [world(tip[0], 0), world(tip[1], 1), world(tip[2], 2), 0.5, A.v - ra * 1.5, 0, ao, back];
      for (let k = 0; k < ROD_SIDES; k++) out.tri(c, corner(A.verts[k], A.v), corner(A.verts[k + 1], A.v), back, BARK_LAYER);
    }
  }
}

/** Triangles of solid wood, each with the voxel it belongs to. */
class Collide {
  constructor() { this.pos = []; this.cell = []; }
  tri(a, b, c, cell) {
    for (const p of [a, b, c]) this.pos.push(p[0], p[1], p[2]);
    this.cell.push(cell[0], cell[1], cell[2]);
  }
  quad(q, cell) {
    this.tri(q[0], q[1], q[2], cell);
    this.tri(q[0], q[2], q[3], cell);
  }
}
