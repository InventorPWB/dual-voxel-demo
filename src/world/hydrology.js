import { VOXEL } from './World.js';
import { FULL, FLUID, packFluid } from './fluids.js';
import { plantKind } from './plants.js';

/** Sea level, metres. The lowland below it floods. */
export const SEA = 17;
/** The highland lake: radius (m), depth at its middle (m), the band of level it may sit at (m). */
const LAKE_R = 10, LAKE_DEPTH = 2.6, LAKE_MIN = 26, LAKE_MAX = 31;
/** How far below the lake's surface its outlet sill is (m): the depth the river leaves it at. */
const SILL = 0.45;
/** River channel: half-width of its bed (m), width of the banks either side (m), least fall per metre. */
const HALF_W = 1.3, BANK = 2.4, GRADE = 0.012;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Shape the ground for water before the world is filled from it: a bowl for a
 * lake on the mountain's flank, held in by a low rim, and a river channel
 * from the lake down to the sea whose bed falls all the way (so water runs
 * the whole length instead of pooling). Works on H, the ground height (m) of
 * every voxel column, in place.
 *
 * `noise` (3D, -1..1) adds meanders; the river keeps out of `avoid` ({ x, z,
 * r } in metres) if it can. Returns the plan for fillWater, with
 * `wet` (1 per voxel column under the lake, river or its banks: sandy) or
 * null if there's no lowland for a river to reach.
 */
export function planWater(H, sx, sz, noise, { mountain, avoid = [] }) {
  const V = VOXEL;
  const W = sx * V, D = sz * V;
  const hAt = (x, z) => H[Math.min(sx - 1, Math.max(0, Math.floor(x / V))) + sx * Math.min(sz - 1, Math.max(0, Math.floor(z / V)))];

  // Metre grid of the ground, for planning.
  const mx = Math.floor(W), mz = Math.floor(D);
  const G = new Float32Array(mx * mz);
  for (let z = 0; z < mz; z++) for (let x = 0; x < mx; x++) G[x + mx * z] = hAt(x + 0.5, z + 0.5);
  // The sea: the biggest connected stretch of ground below sea level (not a puddle).
  const below = (i) => G[i] < SEA - 0.4;
  const label = new Int32Array(mx * mz).fill(-1);
  let biggest = -1, biggestSize = 0;
  for (let s = 0, id = 0; s < mx * mz; s++) {
    if (!below(s) || label[s] >= 0) continue;
    let size = 0;
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const x = i % mx, z = (i - x) / mx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, j = nx + mx * nz;
        if (nx < 0 || nz < 0 || nx >= mx || nz >= mz || label[j] >= 0 || !below(j)) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    if (size > biggestSize) { biggestSize = size; biggest = id; }
    id++;
  }
  if (biggest < 0) return null;
  const sea = (i) => label[i] === biggest;

  // 1. The lake: the flattest spot in its height band on the mountain's flank, clear of the edges.
  let lake = null, best = Infinity;
  for (let z = LAKE_R + 6; z < mz - LAKE_R - 6; z += 2)
    for (let x = LAKE_R + 6; x < mx - LAKE_R - 6; x += 2) {
      const h = G[x + mx * z];
      if (h < LAKE_MIN || h > LAKE_MAX) continue;
      // Rough ground and steep ground both make for a poor lake bed: sum the rise round it.
      let rough = 0;
      for (let a = 0; a < 8; a++) {
        const dx = Math.round(Math.cos(a * Math.PI / 4) * LAKE_R), dz = Math.round(Math.sin(a * Math.PI / 4) * LAKE_R);
        rough += Math.abs(G[x + dx + mx * (z + dz)] - h);
      }
      const toMountain = Math.hypot(x - mountain.x, z - mountain.z);
      const score = rough + Math.abs(toMountain - 26) * 0.3;
      if (score < best) { best = score; lake = { x: x + 0.5, z: z + 0.5, level: h - 0.4 }; }
    }
  if (!lake) return null;

  // 2. The river's course: cheapest path from the lake to the sea, where
  // climbing costs dear (it'll be dug through, but less is better) and a
  // little noise lets it wander.
  const start = Math.floor(lake.x) + mx * Math.floor(lake.z);
  const cost = new Float32Array(mx * mz).fill(Infinity);
  const from = new Int32Array(mx * mz).fill(-1);
  const heap = new MinHeap();
  cost[start] = 0;
  heap.push(0, start);
  let end = -1;
  while (heap.size) {
    const [c, i] = heap.pop();
    if (c > cost[i]) continue;
    if (sea(i)) { end = i; break; }
    const x = i % mx, z = (i - x) / mx;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        if (nx < 3 || nz < 3 || nx >= mx - 3 || nz >= mz - 3) continue;
        const j = nx + mx * nz;
        const inLake = Math.hypot(nx + 0.5 - lake.x, nz + 0.5 - lake.z) < LAKE_R;
        const step = Math.hypot(dx, dz) * (1 + 0.6 * (noise(nx / 9, 7.7, nz / 9) + 1));
        const climb = inLake ? 0 : Math.max(0, G[j] - G[i]);
        const kept = avoid.some((a) => Math.hypot(nx + 0.5 - a.x, nz + 0.5 - a.z) < a.r) ? 200 : 0;
        const nc = c + step + 40 * climb + kept;
        if (nc < cost[j]) { cost[j] = nc; from[j] = i; heap.push(nc, j); }
      }
  }
  if (end < 0) return null;
  let course = [];
  for (let i = end; i >= 0; i = from[i]) course.push([i % mx + 0.5, Math.floor(i / mx) + 0.5]);
  course.reverse();
  // From the lake's edge on, smoothed (Chaikin) so it bends rather than zigzags.
  course = course.filter(([x, z]) => Math.hypot(x - lake.x, z - lake.z) >= LAKE_R - 1.5);
  for (let k = 0; k < 3; k++) {
    const out = [course[0]];
    for (let i = 0; i + 1 < course.length; i++) {
      const [ax, az] = course[i], [bx, bz] = course[i + 1];
      out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(course[course.length - 1]);
    course = out;
  }
  // Carry it a few metres on into the sea, so the mouth opens into deep water.
  const [lx, lz] = course[course.length - 1], [px, pz] = course[course.length - 2];
  const dl = Math.hypot(lx - px, lz - pz) || 1;
  for (let k = 1; k <= 4; k++) course.push([lx + (lx - px) / dl * k, lz + (lz - pz) / dl * k]);

  // 3. Its bed: from just under the lake's sill, falling every metre, and
  // always a little below the ground it passes through.
  const bed = [];
  let along = 0;
  for (let i = 0; i < course.length; i++) {
    const [x, z] = course[i];
    if (i) along = Math.hypot(x - course[i - 1][0], z - course[i - 1][1]);
    const ground = hAt(x, z);
    const b = i === 0 ? lake.level - SILL : Math.min(bed[i - 1] - GRADE * along, ground - 0.9);
    bed.push(Math.max(b, 1.5));
  }

  // 4. Shape the ground: the lake's bowl and rim, then the channel through it all.
  const wet = new Uint8Array(sx * sz);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const px2 = (x + 0.5) * V, pz2 = (z + 0.5) * V;
      const r = Math.hypot(px2 - lake.x, pz2 - lake.z);
      const c = x + sx * z;
      // The bowl rises to the rim's height at its edge, so the shore is a
      // continuous slope with no step.
      if (r < LAKE_R) {
        H[c] = Math.min(H[c], lake.level + 0.5 - (LAKE_DEPTH + 0.5) * (1 - (r / LAKE_R) ** 4));
        wet[c] = 1;
      }
      // A rim holds it in where the ground falls away.
      if (r >= LAKE_R && r < LAKE_R + 7) H[c] = Math.max(H[c], lake.level + 0.5 - Math.max(0, r - LAKE_R - 1) * 0.45);
      // Where the ground rises (into the mountain), the bank is cut back to a
      // slope rather than a cliff the bowl was dug out of.
      // (Fading out farther off, so it doesn't shave the mountain.)
      if (r >= LAKE_R && r < LAKE_R + 16) {
        const cut = Math.min(H[c], lake.level + 0.5 + (r - LAKE_R) * 0.7);
        H[c] += (cut - H[c]) * smoothstep(LAKE_R + 16, LAKE_R + 8, r);
      }
      if (r < LAKE_R + 1) wet[c] = 1;
    }
  // The channel: per segment, the columns near it take the nearest bed height.
  const dist = new Float32Array(sx * sz).fill(Infinity);
  const bedAt = new Float32Array(sx * sz);
  const reach = HALF_W + BANK + 8;
  for (let i = 0; i + 1 < course.length; i++) {
    const [ax, az] = course[i], [bx, bz] = course[i + 1];
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1e-9;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / V)), x1 = Math.min(sx - 1, Math.floor((Math.max(ax, bx) + reach) / V));
    const z0 = Math.max(0, Math.floor((Math.min(az, bz) - reach) / V)), z1 = Math.min(sz - 1, Math.floor((Math.max(az, bz) + reach) / V));
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const px2 = (x + 0.5) * V, pz2 = (z + 0.5) * V;
        const t = Math.max(0, Math.min(1, ((px2 - ax) * ex + (pz2 - az) * ez) / l2));
        const d = Math.hypot(px2 - ax - ex * t, pz2 - az - ez * t);
        const c = x + sx * z;
        if (d < dist[c]) { dist[c] = d; bedAt[c] = bed[i] + (bed[i + 1] - bed[i]) * t; }
      }
  }
  for (let c = 0; c < sx * sz; c++) {
    if (dist[c] === Infinity) continue;
    const d = dist[c], b = bedAt[c];
    // A rounded bed, then banks rising to the ground: wider where it's cut
    // deep, so they slope (about 40°) rather than stand as cliffs.
    const chan = b + 0.3 * (d / HALF_W) ** 2;
    const bank = Math.max(BANK, (H[c] - chan) * 1.2);
    H[c] = Math.min(H[c], chan + (H[c] - chan) * smoothstep(HALF_W, HALF_W + bank, d));
    if (d < HALF_W + 0.8) wet[c] = 1;
  }
  return { lake, course, bed, wet, dist, bedAt };
}

/**
 * Fill the sea, the lake and the river (after the terrain, trees and grass).
 * The sea floods from the lowland through open voxels below sea level, so
 * caves sealed off from it stay dry; the lake fills its bowl; the river gets
 * a shallow run of water along its bed, which the simulation sets flowing.
 * Grass and flowers under water go.
 */
export function fillWater(world, plan) {
  const V = VOXEL;
  const { sx, sy, sz } = world;
  const wetCells = [];
  const fillTo = (x, y, z, level) => {
    if (world.getMat(x, y, z)) return false;
    const floor = world.floorOffset(x, y, z);
    const v = Math.round(Math.min(1 - floor, level / V - y - floor) * FULL);
    if (v <= 0) return false;
    world.setFluid(x, y, z, packFluid(FLUID.WATER, v));
    wetCells.push(x, y, z);
    return true;
  };
  /** Flood fill through open voxels (6-neighbour) from the seeds, up to `level` (m), within `inside`. */
  const flood = (seeds, level, inside = () => true) => {
    const seen = new Uint8Array(sx * sy * sz);
    const stack = [];
    const push = (x, y, z) => {
      if (!world.inBounds(x, y, z) || y * V >= level || !inside(x, z)) return;
      const k = x + sx * (y + sy * z);
      if (seen[k] || world.getMat(x, y, z)) return;
      seen[k] = 1;
      stack.push(x, y, z);
    };
    for (const [x, y, z] of seeds) push(x, y, z);
    while (stack.length) {
      const z = stack.pop(), y = stack.pop(), x = stack.pop();
      fillTo(x, y, z, level);
      push(x + 1, y, z); push(x - 1, y, z); push(x, y + 1, z); push(x, y - 1, z); push(x, y, z + 1); push(x, y, z - 1);
    }
  };
  const surfaceVoxel = (x, z) => {
    for (let y = sy - 1; y > 0; y--) if (world.isSolid(x, y - 1, z)) return y;
    return 0;
  };

  // The sea: seeded from every column whose ground is below sea level.
  const seeds = [];
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const y = surfaceVoxel(x, z);
      if (y * V < SEA) seeds.push([x, y, z]);
    }
  flood(seeds, SEA);

  if (plan) {
    const { lake, course, bed } = plan;
    // The lake, kept to its bowl.
    const lx = Math.floor(lake.x / V), lz = Math.floor(lake.z / V);
    flood([[lx, surfaceVoxel(lx, lz), lz]], lake.level, (x, z) => Math.hypot((x + 0.5) * V - lake.x, (z + 0.5) * V - lake.z) < LAKE_R + 2);
    // The river: a hand's depth along its bed (the simulation sets it flowing).
    for (let i = 0; i < course.length; i++) {
      const [mx, mz] = course[i];
      if (bed[i] + 0.3 < SEA) continue;
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.floor(mx / V) + dx, z = Math.floor(mz / V) + dz;
          if (!world.inBounds(x, 0, z)) continue;
          const y = surfaceVoxel(x, z);
          if (y * V < bed[i] + 0.3) fillTo(x, y, z, bed[i] + 0.3);
        }
    }
  }

  // Nothing grows under water.
  for (let k = 0; k < wetCells.length; k += 3) {
    const [x, y, z] = [wetCells[k], wetCells[k + 1], wetCells[k + 2]];
    if (plantKind(world.getPlant(x, y, z)) === 1) world.setPlant(x, y, z, 0);
  }
  world.markAllDirty();
  return wetCells.length / 3;
}

/** Binary min-heap of (priority, value). */
class MinHeap {
  constructor() {
    this.p = [];
    this.v = [];
  }

  get size() {
    return this.p.length;
  }

  push(p, v) {
    const { p: P, v: Vs } = this;
    let i = P.length;
    P.push(p); Vs.push(v);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (P[j] <= P[i]) break;
      [P[i], P[j]] = [P[j], P[i]];
      [Vs[i], Vs[j]] = [Vs[j], Vs[i]];
      i = j;
    }
  }

  pop() {
    const { p: P, v: Vs } = this;
    const top = [P[0], Vs[0]];
    const lp = P.pop(), lv = Vs.pop();
    if (P.length) {
      P[0] = lp; Vs[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < P.length && P[l] < P[m]) m = l;
        if (r < P.length && P[r] < P[m]) m = r;
        if (m === i) break;
        [P[i], P[m]] = [P[m], P[i]];
        [Vs[i], Vs[m]] = [Vs[m], Vs[i]];
        i = m;
      }
    }
    return top;
  }
}
