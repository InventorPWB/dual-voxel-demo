import { MAX_VOLUME, FLUID, FLUIDS } from './fluids.js';
import { FluidSim, TICK_HZ } from './FluidSim.js';
import { VOXEL } from './World.js';

/**
 * How much of a level difference (volume units) accelerates the flow through
 * a face each tick. With four sideways faces a cell's level can change by
 * up to 4·GAIN of a difference per tick: under ½, so it never overshoots
 * on its own.
 */
const GAIN = 0.1;
/**
 * How much of its flow a face keeps from one tick to the next: the water's
 * momentum. Lively (rivers keep going, a breach surges, ripples cross a pond)
 * but damped, so waves die away within a second or two and a sea stays calm.
 */
const DAMP = 0.88;
/** Most volume through one face in a tick (speed limit). */
const MAX_FLUX = 240;
/** Level differences below this (volume units) start no flow: still water comes to rest. */
const MIN_DIFF = 3;

const AX = [[1, 0], [0, 1]];
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** A cell holding no more than this runs downhill whole (see film). */
const FILM = 24; // the two sideways face axes a cell owns: +x, +z

/**
 * The flux simulation: water with momentum, on the same voxel cells.
 *
 * Volume is held per cell as before (and conserved exactly, in whole units),
 * but each sideways face between two cells also remembers how much flowed
 * through it last tick (Chunk.flux: two per cell, its +x and +z faces). Each
 * tick that flow is kept (DAMP) and pushed on by the difference in level
 * across the face (GAIN): the "virtual pipes" model of shallow water, here
 * in 3D voxels. So water accelerates downhill and carries on, waves travel
 * and fade, and there's a velocity to draw ripples, foam and currents from.
 * Outflows are scaled down so no cell gives more than it holds.
 *
 * Up and down stay as before (FluidSim.flow): water falls into room below
 * at once, and overfill goes up. Sources, sleeping, waking, displacement,
 * deposit and take are all FluidSim's.
 */
export class FluxSim extends FluidSim {
  constructor(world) {
    super(world);
    this.momentum = true;
  }

  /** Flux (volume per tick, signed: + toward +axis) through cell (x, y, z)'s +x (axis 0) or +z (axis 1) face. */
  getFlux(x, y, z, axis) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return 0;
    const c = w.chunkAt(x, y, z);
    if (!c.flux) return 0;
    return c.flux[c.index(x & w.mask, y & w.mask, z & w.mask) * 2 + axis];
  }

  setFlux(x, y, z, axis, f) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const c = w.chunkAt(x, y, z);
    if (!c.flux) {
      if (!f) return;
      c.flux = new Float32Array(c.mat.length * 2);
    }
    c.flux[c.index(x & w.mask, y & w.mask, z & w.mask) * 2 + axis] = f;
  }

  /**
   * The water's velocity in cell (x, y, z), metres per second along x and z
   * (into out): the flow through its faces, over how much water it holds.
   */
  velocity(x, y, z, out = [0, 0]) {
    const v = this.vol(x, y, z);
    if (v < 8) { out[0] = out[1] = 0; return out; }
    const fx = (this.getFlux(x, y, z, 0) + this.getFlux(x - 1, y, z, 0)) / 2;
    const fz = (this.getFlux(x, y, z, 1) + this.getFlux(x, y, z - 1, 1)) / 2;
    const k = (VOXEL * TICK_HZ) / Math.max(v, 128);
    out[0] = fx * k;
    out[1] = fz * k;
    return out;
  }

  tick() {
    const w = this.world;
    const { sx, sy } = w;
    this.redeposit();
    const batch = this.takeBatch();

    // 1. Up and down, at once, as before.
    for (const k of batch) {
      const x = k % sx, t = (k - x) / sx, y = t % sy, z = (t - y) / sy;
      this.vertical(x, y, z);
    }

    // Levels are looked up many times a tick: once each.
    this.heads = new Map();

    // 2. The sideways faces of every active cell, each once. A face is owned
    // by the cell on its - side (as its +x or +z face) and worked out there if
    // that cell is wet and active this tick; else by the wet cell on its + side.
    // (A dry cell pushes nothing.) The new flow goes straight into Chunk.flux:
    // each face only ever reads its own last flow.
    const inBatch = this.inBatch || (this.inBatch = new Uint8Array(sx * sy * w.sz));
    for (const k of batch) inBatch[k] = 1;
    const faces = []; // x, y, z, axis of each face worked out
    for (const k of batch) {
      const x = k % sx, t = (k - x) / sx, y = t % sy, z = (t - y) / sy;
      if (!this.vol(x, y, z)) continue;
      for (let a = 0; a < 2; a++) {
        this.faceFlux(x, y, z, a, faces);
        const ox = x - AX[a][0], oz = z - AX[a][1];
        if (!this.vol(ox, y, oz) || !inBatch[ox + sx * (y + sy * oz)]) this.faceFlux(ox, y, oz, a, faces);
      }
    }
    for (const k of batch) inBatch[k] = 0;

    // 3. No cell gives more than it holds: each cell's outflows scaled to fit.
    const scale = new Map();
    const scaleOf = (x, y, z) => {
      const key = x + sx * (y + sy * z);
      let s = scale.get(key);
      if (s !== undefined) return s;
      s = 1;
      if (!this.isSource(x, y, z)) {
        const fluxAt = (ox, oz, a) => this.getFlux(ox, y, oz, a);
        // Out through +x and +z (positive), and through -x and -z (the neighbours' faces, negative).
        const out = Math.max(0, fluxAt(x, z, 0)) + Math.max(0, fluxAt(x, z, 1))
          + Math.max(0, -fluxAt(x - 1, z, 0)) + Math.max(0, -fluxAt(x, z - 1, 1));
        const v = this.vol(x, y, z);
        if (out > v) s = out > 0 ? v / out : 0;
      }
      scale.set(key, s);
      return s;
    };

    // (All worked out before any water moves, from the same volumes.)
    for (let n = 0; n < faces.length; n += 4) {
      const x = faces[n], y = faces[n + 1], z = faces[n + 2], a = faces[n + 3];
      scaleOf(x, y, z);
      scaleOf(x + AX[a][0], y, z + AX[a][1]);
    }

    // 4. Move the water: whole units, the same through each face both ways.
    for (let n = 0; n < faces.length; n += 4) {
      const x = faces[n], y = faces[n + 1], z = faces[n + 2], a = faces[n + 3];
      const f0 = this.getFlux(x, y, z, a);
      if (!f0) continue;
      const nx = x + AX[a][0], nz = z + AX[a][1];
      const sc = f0 > 0 ? scaleOf(x, y, z) : scaleOf(nx, y, nz);
      // The flow is kept as it is (so it dies away smoothly); the water moved
      // is whole units: rounded, unless cut back to what the cell holds.
      const fl = f0 * sc;
      this.setFlux(x, y, z, a, fl);
      const f = sc < 1 ? Math.trunc(fl) : Math.round(fl);
      if (!f) continue;
      if (f > 0) this.transfer(x, y, z, nx, y, nz, f);
      else this.transfer(nx, y, nz, x, y, z, -f);
    }

    // 5. A thin film runs on downhill whole (see FluidSim.flow), rather than
    // being left behind on slopes and ledges.
    for (const k of batch) {
      const x = k % sx, t = (k - x) / sx, y = t % sy, z = (t - y) / sy;
      this.film(x, y, z);
    }
  }

  /** If cell (x, y, z) holds only a film, with somewhere lower beside it to go, move it all there. */
  film(x, y, z) {
    const v = this.vol(x, y, z);
    if (!v || v > FILM || this.isSource(x, y, z) || this.vol(x, y + 1, z)) return;
    const floor = this.world.getMat(x, y, z) ? 0 : 1024 - this.cap(x, y, z);
    let best = -1, low = floor - v;
    for (let s = 0; s < 4; s++) {
      const nx = x + SIDES[s][0], nz = z + SIDES[s][1];
      if (!this.open(nx, y, nz)) continue;
      // Spilling off an edge is the lowest way of all. Otherwise only bare
      // ground lower than this cell's (not water lower than this film: the
      // flow through the faces evens that out, and the two would pass the
      // film back and forth for ever).
      // (Real room below: not a cell a few units short of full.)
      const falls = y > 0 && this.open(nx, y - 1, nz) && this.vol(nx, y - 1, nz) < this.cap(nx, y - 1, nz) - 4 * FILM;
      if (!falls && this.vol(nx, y, nz)) continue;
      const h = falls ? -1024 : 1024 - this.cap(nx, y, nz);
      if (h < low) { low = h; best = s; }
    }
    if (best >= 0) this.transfer(x, y, z, x + SIDES[best][0], y, z + SIDES[best][1], v);
  }

  /** Work out the new flux through cell (x, y, z)'s +axis face: stored in Chunk.flux, and the face listed in faces. */
  faceFlux(x, y, z, a, faces) {
    const w = this.world;
    const set = (f) => {
      this.setFlux(x, y, z, a, f);
      faces.push(x, y, z, a);
    };
    const nx = x + AX[a][0], nz = z + AX[a][1];
    // (Volume is 0 in solid cells and outside the world, so this rules those out cheaply too.)
    const va = this.vol(x, y, z), vb = this.vol(nx, y, nz);
    if (!va && !vb) return;
    if (!this.open(x, y, z) || !this.open(nx, y, nz)) {
      if (w.inBounds(x, y, z)) this.setFlux(x, y, z, a, 0);
      return;
    }
    const old = this.getFlux(x, y, z, a);
    const me = this._me, them = this._them;
    const ha = this.headOf(x, y, z, va, me), hb = this.headOf(nx, y, nz, vb, them);
    // Two cells both under water: their columns even out at the top (see
    // FluidSim.flow); pushing every layer too overshoots and never settles.
    if (me.under && them.under) {
      set(0);
      return;
    }
    // Both sources: nothing moves between them.
    if (this.isSource(x, y, z) && this.isSource(nx, y, nz)) {
      set(0);
      return;
    }
    const k = Math.max(me.k, them.k);
    const diff = (ha - hb) / k;
    // Momentum only for free-surface water between ordinary cells: a source
    // is a fixed level (carried past it, water would overfill the cells
    // beside it and pump round for ever), and full cells under pressure
    // (k > 1) just push.
    const keep = this.momentum && k === 1 && !this.isSource(x, y, z) && !this.isSource(nx, y, nz) ? DAMP : 0;
    let f = old * keep + diff * GAIN;
    // Small differences don't start a flow, and a dying one stops.
    if (Math.abs(diff) < MIN_DIFF && Math.abs(f) < 1) f = 0;
    // Not uphill: momentum can carry water on to level, not past it by much.
    if ((f > 0 && diff < -MIN_DIFF * 4) || (f < 0 && diff > MIN_DIFF * 4)) f *= 0.5;
    f = Math.max(-MAX_FLUX, Math.min(MAX_FLUX, f));
    set(f);
  }

  /** As FluidSim's; a cell left dry forgets the flow through its faces (so it gives no stray push when water comes back). */
  addDelta(x, y, z, d) {
    super.addDelta(x, y, z, d);
    if (d < 0 && !this.vol(x, y, z)) {
      this.setFlux(x, y, z, 0, 0);
      this.setFlux(x, y, z, 1, 0);
      this.setFlux(x - 1, y, z, 0, 0);
      this.setFlux(x, y, z - 1, 1, 0);
    }
  }

  /** head(), remembered for the rest of the tick (levels don't change until the water moves). */
  headOf(x, y, z, v, out) {
    const key = this.key(x, y, z);
    const m = this.heads.get(key);
    if (m) {
      out.k = m[1];
      out.under = m[2];
      return m[0];
    }
    const h = this.head(x, y, z, v, out);
    this.heads.set(key, [h, out.k, out.under]);
    return h;
  }

  /** Move `n` from cell a to cell b (sources hold their level: give without losing, absorb). */
  transfer(ax, ay, az, bx, by, bz, n) {
    const srcA = this.isSource(ax, ay, az), srcB = this.isSource(bx, by, bz);
    // Never more than a cell has (rounding could ask for a unit more).
    if (!srcA) n = Math.min(n, this.vol(ax, ay, az));
    if (n <= 0) return;
    if (!srcB) {
      n = Math.min(n, MAX_VOLUME - this.vol(bx, by, bz));
      if (n <= 0) return;
      this.addDelta(bx, by, bz, n);
    }
    if (!srcA) this.addDelta(ax, ay, az, -n);
    // A face still flowing keeps both cells awake.
    this.enqueue(ax, ay, az);
    this.enqueue(bx, by, bz);
  }

  /** Down into room below (or onto a source, which takes it), and overfill up: at once. */
  vertical(x, y, z) {
    const w = this.world;
    if (w.getMat(x, y, z)) return;
    const vol = this.vol(x, y, z);
    if (!vol) return;
    const source = this.isSource(x, y, z);
    // A source holds its level: overfill (pressure) in one would push water
    // out that it never loses, round and round for ever. It just sits full.
    if (source && vol > this.cap(x, y, z)) {
      this.addDelta(x, y, z, this.cap(x, y, z) - vol);
      return;
    }
    const speed = FLUIDS[FLUID.WATER].speed;
    let remaining = vol;
    const give = (nx, ny, nz, f) => {
      f = Math.floor(f);
      if (f <= 0) return;
      if (source && this.isSource(nx, ny, nz)) return;
      if (!this.isSource(nx, ny, nz)) {
        f = Math.min(f, MAX_VOLUME - this.vol(nx, ny, nz));
        if (f <= 0) return;
        this.addDelta(nx, ny, nz, f);
      }
      if (!source) {
        this.addDelta(x, y, z, -f);
        remaining -= f;
      }
    };
    if (y > 0 && this.open(x, y - 1, z)) {
      const room = this.cap(x, y - 1, z) - this.vol(x, y - 1, z);
      if (!source && this.isSource(x, y - 1, z)) give(x, y - 1, z, Math.min(remaining, speed * 2));
      else if (room > 0) give(x, y - 1, z, Math.min(remaining, room, speed * 2));
    }
    const cap = this.cap(x, y, z);
    // (Not from a source: it would never lose the overfill, and pump it up for ever.)
    if (!source && remaining > cap && y + 1 < w.sy && this.open(x, y + 1, z)) give(x, y + 1, z, remaining - cap);
  }
}

