import { FULL, MAX_VOLUME, FLUID, packFluid } from './fluids.js';
import { plantKind } from './plants.js';
import { VOXEL } from './World.js';
import { OPAQUE } from './materials.js';
import { FluidSim, TICK_HZ } from './FluidSim.js';
import { DRY, JOIN as FALL, REC } from '../mesh/spanMesh.js';

/** Speed (m/s) a slope of 1 adds to water each tick: g·Δt. */
const PULL = 9.81 / TICK_HZ;
/**
 * The bed's roughness (Manning's n, s/m^⅓: a natural stream bed). Friction
 * grows with speed and is far stronger in thin water, so a sheet on a slope
 * runs at a realistic pace (a few m/s down a steep chute, under 1 m/s in a
 * gentle river) and thickens rather than racing off thin.
 */
const MANNING = 0.035;
/** Its pull per tick: g·Δt·n². */
const FRICTION = (9.81 / TICK_HZ) * MANNING * MANNING;
/**
 * How much of its speed water keeps each tick besides that (the rest is lost
 * to turbulence). Surges and ripples die down over a second or two; steady
 * flow hardly notices.
 */
const KEEP = 0.985;
/**
 * Water deeper than this (voxels: 2 m) flows as if it were this deep. (Waves
 * run faster the deeper the water; this keeps them within what a tick can
 * carry, so deep water stays calm.)
 */
const HMAX = 4;
/** Fastest water (m/s). */
const UMAX = 8;
/**
 * Slower than this (m/s), water keeps proportionally less of its speed: the
 * last faint ripples on a pond (a centimetre high or less) die out instead of
 * bouncing round it for minutes, so still water settles and sleeps.
 */
const SLOW = 0.02;
/** Flow through a face per tick (voxels³) per m/s of speed and voxel of depth: Δt / VOXEL. */
const PER = 1 / (TICK_HZ * VOXEL);
/** How steeply a roofed span's level rises with overfill (pressure in a tunnel or under a roof). */
const STIFF = 8;
/** Level differences (voxels) below this don't start a flow: still water settles and sleeps. */
const MIN_DIFF = 0.0005;
/** Flows (volume per tick) below this stop. */
const FMIN = 1e-4;
/** Ceiling of a span open to the sky. */
const TOP = 1e6;
/** Water this deep (mirror volume) washes grass and flowers away. */
const UPROOT = FULL / 4;
/** Re-mesh once a span's depth has changed this much (voxels). */
const MARK = 0.004;

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OPP = [1, 0, 3, 2];

/**
 * A span: one run of open voxels in a column (from the ground or a floor up
 * to a roof, or the sky), and the water in it. Its water is a depth, not
 * per-voxel volumes: it sits on the span's floor `lo` (the smooth ground's
 * exact height at the column's centre line) and rises to `lo + d`.
 */
class Span {
  constructor(x, z, ylo, ylast, lo, hi) {
    this.x = x;
    this.z = z;
    this.ylo = ylo; // first open voxel
    this.ylast = ylast; // last open voxel
    this.lo = lo; // floor (voxels)
    this.hi = hi; // roof (voxels; TOP if open to the sky)
    this.d = 0; // water depth (voxels; more than hi - lo is overfill, under pressure)
    /** Per side: [{ t: neighbouring span, f: flow to it last tick (voxels³), u: its speed (m/s) }] */
    this.links = [[], [], [], []];
    this.lv = [-1, -1, -1, -1]; // the neighbour column's version each side's links were made for
    this.q = 0; // queued for next tick
    this.dead = false; // replaced (its column was rebuilt)
    this.md = 0; // depth when last re-meshed
    this.ms = 0; // surface when last mirrored
    this.mtop = -1; // highest voxel the mirror has water in
    this.stamp = -1; // tick h was worked out for
    this.h = 0; // level (head)
    this.k = 1; // how fast the level moves per unit volume
    this.src = false;
    this.out = 0;
    this.K = 1;
    this.touched = false;
  }

  get surface() {
    return this.lo + Math.min(this.d, this.hi - this.lo);
  }
}

/**
 * Water as spans per column: a layered heightfield.
 *
 * Every 0.5 m column of the world is a stack of spans (runs of open voxels
 * between solid ones: the open air over the ground, a cave, the inside of a
 * house), each holding a depth of water. So a stream a centimetre deep on a
 * slope is one continuous sheet, however many voxel layers the ground steps
 * through, and a submerged base is a dry span between two wet ones.
 *
 * Flow is shallow water between spans of neighbouring columns that share
 * open voxels: each link keeps a speed, which the difference in level speeds
 * up and the bed's friction slows (Manning's law: far stronger in thin
 * water), and carries that speed times the depth of water at the face. So
 * water has momentum (it runs on, and ripples cross a pond and fade), a
 * river settles into steady flow at a realistic pace, and water down a steep
 * slope runs as a sheet a few centimetres thick, not a film. No span gives
 * more than it holds, so water is conserved exactly. A span full to
 * its roof is under pressure: its level rises steeply with the water forced
 * into it (tunnels, U-bends, a flooded base). Where a span pours into one
 * far below, that's a waterfall (see snapshot).
 *
 * Still water sleeps; only spans that are moving, or next to ones that are,
 * are visited. Sources (FluidCore) hold their level: they give without
 * losing and absorb what flows in.
 *
 * The voxel fluid layer is kept as a mirror of the spans (each span's water
 * packed from its floor up), so the player, the tools, FluidCore and the
 * renderer's height texture read the water just as they do for the other
 * simulations. What's written there from outside (the bucket, the water
 * brush, displaced water) is taken into the spans through `changed`.
 */
export class SpanSim extends FluidSim {
  constructor(world) {
    super(world);
    const { sx, sz } = world;
    /** Per column (x + sx·z): { ver, spans } once looked at. */
    this.cols = new Array(sx * sz);
    this.ver = 0;
    /** (x, z) => the level a source there holds, or -Infinity (set by FluidCore). */
    this.sourceLevel = null;
    this.maxCells = 40000;
    this._e = [0, 0, 0];
    this._v = [0, 0];
    this._touched = [];
    world.onEdit = (box) => this.edit(box);
  }

  // ---- columns -------------------------------------------------------------------

  /** Column (x, z), built on first use; null outside the world. */
  getColumn(x, z) {
    const w = this.world;
    if (x < 0 || z < 0 || x >= w.sx || z >= w.sz) return null;
    const i = x + w.sx * z;
    let c = this.cols[i];
    if (!c) {
      c = this.cols[i] = { ver: ++this.ver, spans: this.buildSpans(x, z) };
      for (const s of c.spans) {
        s.d = this.readMirror(s);
        s.md = s.d;
        s.ms = s.surface;
        s.mtop = s.d > 0 ? Math.min(s.ylast, Math.floor(s.surface)) : -1;
      }
    }
    return c;
  }

  /** The runs of open voxels in column (x, z), without water. */
  buildSpans(x, z) {
    const w = this.world;
    const spans = [];
    const { sy, size, shift, mask } = w;
    let y = 0;
    let chunk = null, base = -1;
    const solid = (yy) => {
      const cy = yy >> shift;
      if (cy !== base) {
        base = cy;
        chunk = w.chunks[w.chunkIndex(x >> shift, cy, z >> shift)];
      }
      return chunk.mat[(x & mask) + size * ((yy & mask) + size * (z & mask))] !== 0;
    };
    while (y < sy) {
      if (solid(y)) { y++; continue; }
      const y0 = y;
      while (y < sy && !solid(y)) y++;
      spans.push(new Span(x, z, y0, y - 1, this.floorOf(x, y0, z), y < sy ? y : TOP));
    }
    return spans;
  }

  /** Height (voxels) of the floor under open voxel (x, y0, z): the smooth ground's crossing on the column's centre line. */
  floorOf(x, y0, z) {
    const w = this.world;
    if (y0 <= 0) return 0;
    if (w.isTerrain(x, y0 - 1, z) && w.getEdge(x, y0 - 1, z, 1, this._e)) return Math.max(0, y0 - 0.5 + this._e[0]);
    return y0;
  }

  /** A span's water depth from the mirror (its voxels' volumes, packed from the floor up). */
  readMirror(s) {
    let total = 0;
    for (let y = s.ylo; y <= s.ylast; y++) total += this.vol(s.x, y, s.z);
    if (!total) return 0;
    let rem = total / FULL, y = s.ylo, b = Math.max(s.lo, s.ylo);
    while (y <= s.ylast) {
      const room = y + 1 - b;
      if (rem <= room) return b + rem - s.lo;
      rem -= room;
      y++;
      b = y;
    }
    return s.ylast + 1 - s.lo + rem; // overfill
  }

  /** Write a span's water to the mirror. */
  writeMirror(s) {
    const w = this.world;
    const cap = s.hi - s.lo;
    const surf = s.lo + Math.min(s.d, cap);
    const extra = s.d > cap ? s.d - cap : 0;
    const floor = Math.max(s.lo, s.ylo);
    // (Voxels well below both the old and the new surface are full either way.)
    const from = Math.max(s.ylo, Math.floor(Math.min(surf, s.ms)) - 1);
    const to = Math.min(s.ylast, Math.max(s.mtop, Math.floor(surf)));
    let top = from > s.ylo ? from - 1 : -1;
    for (let y = from; y <= to; y++) {
      const b = y === s.ylo ? floor : y;
      let v = Math.round(Math.max(0, Math.min(surf - b, y + 1 - b)) * FULL);
      if (y === s.ylast && extra) v = Math.min(MAX_VOLUME, v + Math.round(extra * FULL));
      if (v) top = y;
      const before = this.vol(s.x, y, s.z);
      if (before === v) continue;
      w.setFluid(s.x, y, s.z, v ? packFluid(FLUID.WATER, v) : 0);
      this.uproot(s.x, y, s.z, before, v);
    }
    s.mtop = top;
    s.ms = surf;
    this.onColumn?.(s.x, Math.max(s.ylo, Math.floor(surf)), s.z);
  }

  uproot(x, y, z, before, v) {
    if (v < UPROOT || before >= UPROOT) return;
    const w = this.world;
    const p = w.getPlant(x, y, z);
    if (p && plantKind(p) === 1) {
      w.setPlant(x, y, z, 0);
      w.markDirtyBox(x, y, z, x, y, z);
    }
  }

  /** The span holding open voxel (x, y, z), or null. */
  spanAt(x, y, z) {
    const c = this.getColumn(x, z);
    if (!c) return null;
    for (const s of c.spans) if (y >= s.ylo && y <= s.ylast) return s;
    return null;
  }

  /**
   * Rebuild column (x, z)'s spans after its voxels changed, keeping its water
   * where it was. Water over a floor that was dug away drops onto the new
   * floor; water where it's now solid is pushed up, into the span above
   * (or the nearest), and spreads from there.
   */
  rebuild(x, z) {
    const w = this.world;
    const i = x + w.sx * z;
    const old = this.cols[i];
    if (!old) return;
    const spans = this.buildSpans(x, z);
    let total = 0, kept = 0, top = -Infinity;
    for (const o of old.spans) {
      total += o.d;
      if (o.d > 0) top = Math.max(top, o.surface);
    }
    for (const n of spans) {
      let d = 0, mtop = -1;
      for (const o of old.spans) {
        const cap = o.hi - o.lo, t = o.lo + Math.min(o.d, cap);
        const a = Math.max(o.lo, n.lo), b = Math.min(t, n.hi);
        if (b > a) d += b - a;
        if (o.d > cap && t >= n.lo && t <= n.hi) d += o.d - cap;
        if (o.ylast >= n.ylo && o.ylo <= n.ylast) mtop = Math.max(mtop, Math.min(o.mtop, n.ylast));
      }
      n.d = d;
      kept += d;
      n.md = -1;
      n.ms = n.lo;
      n.mtop = mtop;
    }
    const lost = total - kept;
    if (lost > 1e-9 && spans.length) {
      const into = spans.find((n) => n.hi >= top) || spans[spans.length - 1];
      into.d += lost;
    }
    for (const o of old.spans) o.dead = true;
    this.cols[i] = { ver: ++this.ver, spans };
    for (const n of spans) {
      this.writeMirror(n);
      if (n.d > 0) this.activate(n);
    }
  }

  /** Links from span s toward side k: the spans of the neighbouring column it shares open voxels with. */
  linksOf(s, k) {
    const n = this.getColumn(s.x + SIDES[k][0], s.z + SIDES[k][1]);
    if (!n) return s.links[k];
    if (s.lv[k] === n.ver) return s.links[k];
    const old = s.links[k], links = [];
    for (const t of n.spans) {
      if (t.ylo > s.ylast || t.ylast < s.ylo) continue;
      // (Keep the flow of a link to the same voxels, across a rebuild.)
      let f = 0, u = 0;
      for (const L of old) if (L.t.ylo === t.ylo && L.t.ylast === t.ylast) { f = L.f; u = L.u; }
      links.push({ t, f, u });
    }
    s.links[k] = links;
    s.lv[k] = n.ver;
    return links;
  }

  // ---- waking ----------------------------------------------------------------------

  activate(s) {
    if (s.q || s.dead) return;
    s.q = 1;
    this.queue.push(s);
  }

  enqueue(x, y, z) {
    const s = this.spanAt(x, y, z);
    if (s) this.activate(s);
  }

  /** Wake the water in and around a voxel box (inclusive). */
  wake(box) {
    const w = this.world;
    const x0 = Math.max(0, box[0] - 1), z0 = Math.max(0, box[2] - 1);
    const x1 = Math.min(w.sx - 1, box[3] + 1), z1 = Math.min(w.sz - 1, box[5] + 1);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (!this.cols[x + w.sx * z] && !this.columnHasFluid(x, z)) continue;
        for (const s of this.getColumn(x, z).spans) {
          if (s.d > 0 && s.ylast >= box[1] - 1 && s.ylo <= box[4] + 1) this.activate(s);
        }
      }
  }

  /** The world changed in this voxel box: rebuild the columns there, and wake the water around. */
  edit(box) {
    const w = this.world;
    const x0 = Math.max(0, box[0]), z0 = Math.max(0, box[2]);
    const x1 = Math.min(w.sx - 1, box[3]), z1 = Math.min(w.sz - 1, box[5]);
    // Water displaced from columns already in spans is kept by rebuild (from
    // the spans' own depths); only columns not yet looked at put it back
    // through redeposit.
    const d = w.displaced;
    if (d.length) {
      const keep = [];
      for (let n = 0; n < d.length; n += 4) if (!this.cols[d[n] + w.sx * d[n + 2]]) keep.push(d[n], d[n + 1], d[n + 2], d[n + 3]);
      w.displaced = keep;
    }
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (this.cols[x + w.sx * z]) this.rebuild(x, z);
    // Everything wet round about, at any height: water beside a new hole runs in.
    const all = [box[0], 0, box[2], box[3], w.sy, box[5]];
    this.wake(all);
  }

  /** Might column (x, z) hold water (does any chunk in it have fluid)? */
  columnHasFluid(x, z) {
    const w = this.world;
    for (let cy = 0; cy < w.ny; cy++) if (w.chunks[w.chunkIndex(x >> w.shift, cy, z >> w.shift)].hasFluid) return true;
    return false;
  }

  wakeAll() {
    const w = this.world;
    for (let z = 0; z < w.sz; z++)
      for (let x = 0; x < w.sx; x++) {
        if (!this.columnHasFluid(x, z)) continue;
        for (const s of this.getColumn(x, z).spans) if (s.d > 0) this.activate(s);
      }
  }

  /**
   * Fluid written into voxel (x, y, z) from outside (tools, deposit, take):
   * the span holding it gains or loses the difference.
   */
  changed(x, y, z, before, v) {
    const w = this.world;
    const built = !!this.cols[x + w.sx * z];
    const s = this.spanAt(x, y, z); // (a column built now reads the change from the mirror)
    if (!s) return;
    if (built) {
      s.d = Math.max(0, s.d + (v - before) / FULL);
      this.writeMirror(s);
    }
    this.uproot(x, y, z, before, v);
    this.mark(s);
    this.activate(s);
  }

  /** Re-mesh the water around span s. */
  mark(s) {
    s.md = s.d;
    this.world.markFluidDirty(s.x, Math.max(s.ylo, Math.floor(s.surface)), s.z);
  }

  // ---- simulation ----------------------------------------------------------------

  /** Work out span s's source state and level for this tick (once per tick). */
  prep(s, tick) {
    if (s.stamp === tick) return;
    s.stamp = tick;
    const L = this.sourceLevel ? this.sourceLevel(s.x, s.z) : -Infinity;
    s.src = L > s.lo && L <= s.hi && s.lo + s.d >= L - 0.25;
    if (s.src && s.d !== L - s.lo) {
      // A source holds its level.
      s.d = L - s.lo;
      this.touch(s);
    }
    const cap = s.hi - s.lo;
    if (s.d <= cap) {
      s.h = s.lo + s.d;
      s.k = 1;
    } else {
      s.h = s.hi + (s.d - cap) * STIFF;
      s.k = STIFF;
    }
  }

  touch(s) {
    if (s.touched) return;
    s.touched = true;
    this._touched.push(s);
  }

  tick() {
    this.redeposit();
    const tick = ++this.stats.ticks;
    let batch = this.queue;
    this.queue = [];
    if (batch.length > this.maxCells) {
      if (this.focus) {
        const fx = this.focus.x / VOXEL, fz = this.focus.z / VOXEL;
        batch.sort((a, b) => (a.x - fx) ** 2 + (a.z - fz) ** 2 - ((b.x - fx) ** 2 + (b.z - fz) ** 2));
      }
      this.queue = batch.slice(this.maxCells);
      batch = batch.slice(0, this.maxCells);
    }
    for (const s of batch) s.q = 0;
    this.stats.active = batch.length + this.queue.length;

    // 1. Levels, as they are at the start of the tick.
    for (const s of batch) if (!s.dead) this.prep(s, tick);

    // 2. New flows. Each link's water keeps its speed (less friction) and
    //    is sped up by the difference in level; what it carries is that speed
    //    times the depth of water at the face (above the higher of the two
    //    floors, up to the lower roof). None backwards: each side keeps its own.
    for (const s of batch) {
      if (s.dead) continue;
      let out = 0;
      const top = s.lo + Math.min(s.d, s.hi - s.lo);
      for (let k = 0; k < 4; k++) {
        for (const L of this.linksOf(s, k)) {
          const t = L.t;
          this.prep(t, tick);
          if (s.src && t.src) { L.f = 0; continue; }
          const diff = s.h - t.h;
          const face = Math.min(HMAX, Math.max(0, Math.min(top, s.hi, t.hi) - Math.max(s.lo, t.lo)));
          let f = 0;
          if (face > 1e-5) {
            // Speed (m/s): last tick's, plus the pull of the slope.
            let u = L.u * KEEP * Math.min(1, L.u / SLOW) + (PULL * diff) / Math.max(s.k, t.k);
            if (u > 0) {
              // Bed friction (Manning), solved implicitly so it's stable
              // however thin the water: u + a·u² = u₀.
              const a = FRICTION / Math.pow(face * VOXEL, 4 / 3);
              u = Math.min(UMAX, (Math.sqrt(1 + 4 * a * u) - 1) / (2 * a));
              f = u * face * PER;
            }
          }
          if (f <= 0 || (diff < MIN_DIFF && f < FMIN)) f = 0;
          L.f = f;
          L.u = f ? f / (face * PER) : 0;
          out += f;
          // A sleeping neighbour higher up must flow this way.
          if (diff < -MIN_DIFF && t.d > 0) this.activate(t);
        }
      }
      s.out = out;
      // No span gives more than it holds (a source gives without losing).
      s.K = !s.src && out > s.d ? s.d / out : 1;
    }

    // 3. Move the water.
    for (const s of batch) {
      if (s.dead || !s.out) continue;
      const K = s.K;
      for (let k = 0; k < 4; k++)
        for (const L of s.links[k]) {
          if (!L.f) continue;
          const a = L.f * K;
          const t = L.t;
          if (!t.src) {
            t.d += a;
            this.touch(t);
            this.activate(t);
          }
          if (!s.src) s.d -= a;
        }
      if (!s.src) {
        if (s.d < 1e-9) s.d = 0;
        this.touch(s);
      }
      this.activate(s);
    }

    // 4. Mirror what changed, and re-mesh where it shows.
    for (const s of this._touched) {
      s.touched = false;
      if (s.dead) continue;
      this.writeMirror(s);
      if (Math.abs(s.d - s.md) > MARK) this.mark(s);
    }
    this._touched.length = 0;
  }

  /**
   * Flow at span s, m/s along x and z: per face, the speed of the water
   * through it (out minus in, weighted by how much each carries), averaged
   * over the two faces each way.
   */
  flowOf(s, out) {
    let fx = 0, fz = 0;
    for (let k = 0; k < 4; k++) {
      let num = 0, den = 0;
      for (const L of s.links[k]) {
        num += L.f * L.u;
        den += L.f;
        if (L.t.dead) continue;
        for (const L2 of L.t.links[OPP[k]]) if (L2.t === s) { num -= L2.f * L2.u; den += L2.f; }
      }
      if (!den) continue;
      const v = (num / den) * (k & 1 ? -1 : 1) / 2; // along +axis
      if (k < 2) fx += v;
      else fz += v;
    }
    out[0] = fx;
    out[1] = fz;
    return out;
  }

  velocity(x, y, z, out = [0, 0]) {
    const c = this.cols[x + this.world.sx * z];
    out[0] = out[1] = 0;
    if (!c || x < 0 || z < 0 || x >= this.world.sx || z >= this.world.sz) return out;
    for (const s of c.spans) if (y >= s.ylo && y <= s.ylast) return s.d > DRY ? this.flowOf(s, out) : out;
    return out;
  }

  /** Total water in the spans looked at so far (volume units: FULL a voxel). */
  totalVolume() {
    let sum = 0;
    for (const c of this.cols) if (c) for (const s of c.spans) sum += s.d;
    return sum * FULL;
  }

  settle(max = 10000) {
    let n = 0;
    while ((this.queue.length || this.world.displaced.length) && n < max) {
      this.tick();
      n++;
    }
    return n;
  }

  /**
   * What a chunk's water mesh needs (meshSpans in spanMesh.js): the spans of
   * its columns and `pad` columns round it, near its height. Per column
   * (start[c] to start[c + 1]), REC numbers per span: floor, roof, depth,
   * flow x and z (m/s), first open voxel. Also, from its own columns, where water pours over a
   * drop (`falls`: x, z, side, top, bottom, flow, speed) and where it's against a
   * building piece (`glass`: x, z, side, from, to), for the sheet you see
   * through a window. Null if no water shows in it.
   */
  snapshot(cx, cy, cz) {
    const w = this.world, S = w.size, P = 2, N = S + 2 * P;
    const ox = cx * S, oy = cy * S, oz = cz * S;
    const y0 = oy - 4, y1 = oy + S + 4;
    const start = new Uint32Array(N * N + 1);
    const rec = [], falls = [], glass = [];
    const v = this._v;
    let any = false;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        start[i + N * j] = rec.length / REC;
        const x = ox + i - P, z = oz + j - P;
        const col = this.getColumn(x, z);
        if (!col) continue;
        const inside = i >= P && j >= P && i < P + S && j < P + S;
        // (Falls from the columns just round it too: a fall at its edge meets the next one along.)
        const near = i >= P - 1 && j >= P - 1 && i <= P + S && j <= P + S;
        for (const s of col.spans) {
          if (s.hi < y0 || s.lo > y1) continue;
          const top = s.surface, wet = s.d > DRY;
          const ty = Math.floor(top);
          if (wet) {
            this.flowOf(s, v);
            if (ty >= oy - 1 && ty <= oy + S) any = true;
          } else v[0] = v[1] = 0;
          rec.push(s.lo, Math.min(s.hi, TOP), s.d, v[0], v[1], s.ylo);
          if (!near || !wet || ty < oy || ty >= oy + S) continue;
          for (let k = 0; k < 4; k++) {
            for (const L of this.linksOf(s, k)) {
              if (L.f < 0.002) continue;
              const t = L.t, tTop = t.surface;
              if (top - tTop > FALL) falls.push(x, z, k, top, Math.max(tTop, t.lo), L.f, L.u);
            }
            if (!inside) continue;
            // Against a building piece: the water's side, seen through glass.
            const nx = x + SIDES[k][0], nz = z + SIDES[k][1];
            let from = -1;
            const last = Math.min(s.ylast, Math.ceil(top) - 1);
            for (let y = s.ylo; y <= last + 1; y++) {
              // (Only see-through pieces: water against an opaque block is hidden by it.)
              const piece = y <= last && w.isPiece(nx, y, nz) && !OPAQUE[w.getMat(nx, y, nz)];
              if (piece && from < 0) from = y;
              else if (!piece && from >= 0) {
                glass.push(x, z, k, Math.max(from, s.lo), Math.min(y, top));
                from = -1;
              }
            }
          }
        }
      }
    start[N * N] = rec.length / REC;
    if (!any) return null;
    return {
      size: S, pad: P, origin: [ox, oy, oz], start,
      rec: new Float32Array(rec), falls: new Float32Array(falls), glass: new Float32Array(glass),
    };
  }
}
