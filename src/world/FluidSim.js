import { FULL, MAX_VOLUME, FLUID, FLUIDS, fluidVolumeOf, packFluid } from './fluids.js';
import { plantKind } from './plants.js';
import { VOXEL } from './World.js';

/** Simulation steps per second. */
export const TICK_HZ = 20;
/** How steeply a roofed full cell's level rises with overfill (see FluidSim.head). */
const STIFF = 4;
/**
 * Differences below this (volume units, 1/FULL of a voxel: 2 mm) don't flow,
 * so still water settles and sleeps. (Over a wide lake these can add up to a
 * slight tilt, a few centimetres at most; the core of a big lake is a source
 * and holds one level anyway.)
 */
const MIN_FLOW = 2;
/** A cell holding no more than this runs downhill whole, rather than leaving a film. */
const FILM = 24;
/** Water this deep (volume) washes grass and flowers away. */
const UPROOT = FULL / 4;
/** Beyond this far from the player (metres), water moves only every FAR_EVERY ticks. */
const FAR = 48;
const FAR_EVERY = 4;
/** How far displaced water looks for room (voxels). */
const DISPLACE_REACH = 4;

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * The fluid simulation: a mass-conserving cellular automaton on the voxel grid.
 *
 * Each tick, every active cell sends water down into the cell below (as much
 * as fits), then sideways to its four neighbours by the difference in their
 * water level (head: the height of the water's surface, counting how far
 * smooth ground pokes up into the voxel, see World.floorOffset), then up if
 * it's holding more than it can (pressure). Transfers are worked out from the
 * state before the tick and applied together, so the order cells are visited
 * in doesn't matter, and they're whole units, so volume is conserved exactly.
 *
 * Only active cells are visited: a cell stays active while it or a neighbour
 * changed. Flows smaller than MIN_FLOW don't happen, so still water goes to
 * sleep and costs nothing. Edits wake the water around them (World.onEdit).
 *
 * Source cells (`isSource`, the core of large still bodies: see fluidCore.js)
 * hold their level: they give water without losing any, and absorb what
 * flows into them.
 */
export class FluidSim {
  constructor(world) {
    this.world = world;
    const { sx, sy, sz } = world;
    this.queued = new Uint8Array(sx * sy * sz);
    /** Keys (x + sx·(y + sy·z)) of cells to visit next tick. */
    this.queue = [];
    /** (x, y, z) => true where a cell gives without losing (set by FluidCore). */
    this.isSource = () => false;
    /** Called with (x, y, z) when the top of a column's water may have changed. */
    this.onColumn = null;
    this.acc = 0;
    this.maxCells = 20000;
    this.budgetMs = 4;
    this.paused = false;
    this.stats = { active: 0, ms: 0, ticks: 0, dropped: 0 };
    this._me = { k: 1, under: false };
    this._them = { k: 1, under: false };
    world.onEdit = (box) => this.wake(box);
  }

  key(x, y, z) {
    return x + this.world.sx * (y + this.world.sy * z);
  }

  enqueue(x, y, z) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const k = x + w.sx * (y + w.sy * z);
    if (this.queued[k]) return;
    this.queued[k] = 1;
    this.queue.push(k);
  }

  /** Wake the fluid in and around a voxel box (inclusive). */
  wake(box) {
    const w = this.world;
    const x0 = Math.max(0, box[0] - 1), y0 = Math.max(0, box[1] - 1), z0 = Math.max(0, box[2] - 1);
    const x1 = Math.min(w.sx - 1, box[3] + 1), y1 = Math.min(w.sy - 1, box[4] + 1), z1 = Math.min(w.sz - 1, box[5] + 1);
    if (x0 > x1 || y0 > y1 || z0 > z1) return;
    // Nothing to wake unless a chunk there has fluid.
    const s = w.size;
    let any = false;
    for (let cz = z0 >> w.shift; cz <= z1 >> w.shift && !any; cz++)
      for (let cy = y0 >> w.shift; cy <= y1 >> w.shift && !any; cy++)
        for (let cx = x0 >> w.shift; cx <= x1 >> w.shift && !any; cx++) any = w.chunks[w.chunkIndex(cx, cy, cz)].hasFluid;
    if (!any || !s) return;
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) if (w.getFluid(x, y, z)) this.enqueue(x, y, z);
  }

  /** Wake every cell holding fluid (after generation). */
  wakeAll() {
    const w = this.world;
    for (let ci = 0; ci < w.chunks.length; ci++) {
      const c = w.chunks[ci];
      if (!c.hasFluid) continue;
      const [cx, cy, cz] = w.chunkCoords(ci);
      const s = w.size;
      for (let z = 0; z < s; z++)
        for (let y = 0; y < s; y++)
          for (let x = 0; x < s; x++) {
            const gx = cx * s + x, gy = cy * s + y, gz = cz * s + z;
            if (w.getFluid(gx, gy, gz)) this.enqueue(gx, gy, gz);
          }
    }
  }

  /** Volume in a cell (0 if solid or outside). */
  vol(x, y, z) {
    return fluidVolumeOf(this.world.getFluid(x, y, z));
  }

  /** Can fluid be in this cell? */
  open(x, y, z) {
    const w = this.world;
    return w.inBounds(x, y, z) && w.getMat(x, y, z) === 0;
  }

  /** Room in an open cell before it's full (FULL less the ground poking up into it). */
  cap(x, y, z) {
    return FULL - Math.round(this.world.floorOffset(x, y, z) * FULL);
  }

  /** Add d (may be negative) to cell (x, y, z)'s volume now, and wake what that affects. */
  addDelta(x, y, z, d) {
    if (!d) return;
    const w = this.world;
    if (w.getMat(x, y, z)) return;
    const before = this.vol(x, y, z);
    const v = Math.max(0, Math.min(MAX_VOLUME, before + d));
    if (v === before) return;
    w.setFluid(x, y, z, packFluid(FLUID.WATER, v));
    this.changed(x, y, z, before, v);
  }

  /** Advance by dt seconds of real time (fixed ticks, within the frame's time budget). */
  update(dt, focus = null) {
    if (this.paused) return;
    this.focus = focus;
    this.acc = Math.min(this.acc + dt, 3 / TICK_HZ);
    const t0 = performance.now();
    while (this.acc >= 1 / TICK_HZ) {
      this.acc -= 1 / TICK_HZ;
      this.tick();
      if (performance.now() - t0 > this.budgetMs) {
        this.acc = 0;
        break;
      }
    }
    this.compact();
    this.stats.ms += (performance.now() - t0 - this.stats.ms) * 0.1;
  }

  /** One simulation step. */
  tick() {
    const w = this.world;
    const { sx, sy } = w;
    this.redeposit();

    // This tick's cells: all of them, or the nearest maxCells. Water far from
    // the player (beyond FAR) only moves every FAR_EVERY ticks: it flows
    // slower there, but ends up just the same, for a fraction of the cost.
    let batch = this.queue;
    this.queue = [];
    if (this.focus && this.stats.ticks % FAR_EVERY) {
      const fx = this.focus.x / VOXEL, fz = this.focus.z / VOXEL, far2 = (FAR / VOXEL) ** 2;
      const near = [];
      for (const k of batch) {
        const x = k % sx, z = Math.floor(k / (sx * sy));
        if ((x - fx) * (x - fx) + (z - fz) * (z - fz) > far2) this.queue.push(k); // (stays queued)
        else near.push(k);
      }
      batch = near;
    }
    if (batch.length > this.maxCells) {
      if (this.focus) {
        const fx = this.focus.x / VOXEL, fy = this.focus.y / VOXEL, fz = this.focus.z / VOXEL;
        const d2 = (k) => {
          const x = k % sx, t = (k - x) / sx, y = t % sy, z = (t - y) / sy;
          return (x - fx) * (x - fx) + (y - fy) * (y - fy) + (z - fz) * (z - fz);
        };
        batch.sort((a, b) => d2(a) - d2(b));
      }
      for (let n = this.maxCells; n < batch.length; n++) this.queue.push(batch[n]); // stay queued for next tick
      batch = batch.slice(0, this.maxCells);
    }
    for (const k of batch) this.queued[k] = 0;
    this.stats.active = batch.length + this.queue.length;
    this.stats.ticks++;

    // Each cell's transfers happen at once, in the order visited (forwards
    // one tick, backwards the next, so neither way is favoured). Every
    // transfer goes from a higher level to a lower one and never past
    // level, so the water's potential energy only ever falls: it must come
    // to rest, and then sleeps. (Worked out all together from the state
    // before the tick instead, flows can chase each other round for ever.)
    const back = this.stats.ticks & 1;
    for (let n = 0; n < batch.length; n++) {
      const k = batch[back ? batch.length - 1 - n : n];
      const x = k % sx, t = (k - x) / sx, y = t % sy, z = (t - y) / sy;
      this.flow(x, y, z);
    }
  }

  /** A cell's volume changed: wake it and its neighbours, wash away plants, tell FluidCore. */
  changed(x, y, z, before, v) {
    this.enqueue(x, y, z);
    this.enqueue(x + 1, y, z); this.enqueue(x - 1, y, z);
    this.enqueue(x, y + 1, z); this.enqueue(x, y - 1, z);
    this.enqueue(x, y, z + 1); this.enqueue(x, y, z - 1);
    const w = this.world;
    if (v >= UPROOT && before < UPROOT) {
      const p = w.getPlant(x, y, z);
      if (p && plantKind(p) === 1) {
        w.setPlant(x, y, z, 0);
        w.markDirtyBox(x, y, z, x, y, z);
      }
    }
    this.onColumn?.(x, y, z);
  }

  /**
   * Water level of cell (x, y, z) if it held volume v: height × FULL.
   *  - Under more water: the surface of the water column above it, which
   *    presses on it (whether or not it's full itself; the water above
   *    tops it up).
   *  - Otherwise, not full: its own surface (on any ground poking up into it).
   *  - Otherwise (full with nothing above: a roofed tunnel, or the top of a
   *    column about to overflow): a level above its top that rises steeply
   *    (STIFF) with its overfill, which is how a roofed cell pushes back.
   * `k` (out) is how fast its level moves per unit of volume.
   */
  head(x, y, z, v, out) {
    const w = this.world;
    out.k = 1;
    out.under = false;
    if (y + 1 < w.sy && this.open(x, y + 1, z)) {
      let yy = y + 1, a = this.vol(x, yy, z);
      if (a) {
        out.under = true;
        // (Up through any cell not yet topped up, too: the water above fills
        // it within a tick or two, and stopping there would make the level
        // flicker and send water back and forth.)
        while (yy + 1 < w.sy && this.open(x, yy + 1, z)) {
          const b = this.vol(x, yy + 1, z);
          if (!b) break;
          yy++;
          a = b;
        }
        return a < FULL ? yy * FULL + a : yy * FULL + FULL + (a - FULL) * STIFF;
      }
    }
    const cap = this.cap(x, y, z);
    if (v < cap) return y * FULL + (FULL - cap) + v;
    out.k = STIFF;
    return y * FULL + FULL + (v - cap) * STIFF;
  }

  /** Cell (x, y, z)'s outflows, made at once. */
  flow(x, y, z) {
    const w = this.world;
    if (w.getMat(x, y, z)) return;
    const vol = this.vol(x, y, z);
    if (!vol) return;
    const source = this.isSource(x, y, z);
    const speed = FLUIDS[FLUID.WATER].speed;
    let remaining = vol;
    const give = (nx, ny, nz, f) => {
      f = Math.floor(f);
      if (f <= 0) return;
      // Sources hold their level: what flows into one is absorbed (so a
      // river running into the sea doesn't raise it, and the sea's surface
      // never has to ripple out to match).
      if (source && this.isSource(nx, ny, nz)) return;
      if (!this.isSource(nx, ny, nz)) {
        // Never more than the cell can store (so nothing is ever clipped away).
        f = Math.min(f, MAX_VOLUME - this.vol(nx, ny, nz));
        if (f <= 0) return;
        this.addDelta(nx, ny, nz, f);
      }
      // Sources give without losing (and so never run out).
      if (!source) {
        this.addDelta(x, y, z, -f);
        remaining -= f;
      }
    };

    // Down: into whatever room there is below.
    if (y > 0 && this.open(x, y - 1, z)) {
      const room = this.cap(x, y - 1, z) - this.vol(x, y - 1, z);
      // (Onto a source it always drains: the source takes it in.)
      if (!source && this.isSource(x, y - 1, z)) give(x, y - 1, z, Math.min(remaining, speed * 2));
      else if (room > 0) give(x, y - 1, z, Math.min(remaining, room, speed * 2));
      if (remaining <= 0) return;
    }

    // Sideways: by the difference in water level (pressure, for full cells).
    const cap = this.cap(x, y, z);
    const floor = FULL - cap;
    const me = this._me, them = this._them;
    const head = this.head(x, y, z, remaining, me);
    let lowest = -1, lowestFloor = floor;
    for (let s = 0; s < 4; s++) {
      const nx = x + SIDES[s][0], nz = z + SIDES[s][1];
      if (!this.open(nx, y, nz)) continue;
      const nv = this.vol(nx, y, nz);
      const nHead = this.head(nx, y, nz, nv, them);
      // Between two cells both under water, the columns' surfaces even out
      // at the top; flowing at every depth too would move the difference
      // many times over.
      if (me.under && them.under) continue;
      // Where a film would end up lowest (spilling off an edge counts as lowest of all).
      const falls = y > 0 && this.open(nx, y - 1, nz) && this.vol(nx, y - 1, nz) < FULL;
      const nf = falls ? -FULL : nHead - y * FULL;
      if (nf < lowestFloor) { lowestFloor = nf; lowest = s; }
      // A fifth of the difference (less where levels move steeply), at least
      // a unit, so flows never overshoot even when all four sides go at once.
      // Differences under MIN_FLOW don't flow at all: the water comes to rest
      // within a few millimetres and sleeps, rather than trickling for ever.
      const k = Math.max(me.k, them.k);
      const diff = head - y * FULL - (nHead - y * FULL);
      if (diff < MIN_FLOW * k) continue;
      const f = Math.max(1, Math.floor(diff / (k > 1 ? 4 * k : 4)));
      give(nx, y, nz, Math.min(f, remaining, speed));
      if (remaining <= 0) return;
    }

    // A thin film runs on downhill whole, rather than spreading to nothing:
    // only where it would still be lower than this cell's bare floor, so it
    // never comes back (which would keep both cells awake for ever).
    if (remaining > 0 && remaining <= FILM && lowest >= 0 && lowestFloor + remaining < floor && !source && !this.vol(x, y + 1, z)) {
      give(x + SIDES[lowest][0], y, z + SIDES[lowest][1], remaining);
      return;
    }

    // Up: overfill goes up, where it can.
    // (All of it, at once: held back, a cell fed from the side and below can
    // fill faster than it empties.)
    if (remaining > cap && y + 1 < w.sy && this.open(x, y + 1, z)) give(x, y + 1, z, remaining - cap);
  }

  /** Put fluid pushed out of voxels that became solid back into open cells nearby: upwards first. */
  redeposit() {
    const w = this.world;
    const d = w.displaced;
    if (!d.length) return;
    w.displaced = [];
    for (let i = 0; i < d.length; i += 4) {
      const left = this.deposit(d[i], d[i + 1] + 1, d[i + 2], fluidVolumeOf(d[i + 3]));
      if (left > 0) this.stats.dropped += left;
    }
  }

  /**
   * Put `volume` of water into open cells at and around (x, y, z): up the
   * column from there while it has room, then outward, nearest first, and if
   * nothing has room, squeezed into the nearest open cells (pressure spreads
   * it). Returns what couldn't be placed.
   */
  deposit(x, y, z, volume) {
    const w = this.world;
    let left = volume;
    {
      const put = (px, py, pz, all) => {
        if (!this.open(px, py, pz)) return false;
        const have = this.vol(px, py, pz);
        const room = all ? MAX_VOLUME - have : this.cap(px, py, pz) - have;
        if (room <= 0) return true;
        const n = Math.min(room, left);
        w.setFluid(px, py, pz, packFluid(FLUID.WATER, have + n));
        this.changed(px, py, pz, have, have + n);
        left -= n;
        return true;
      };
      // Up the column while it's open.
      for (let py = y; py < w.sy && left > 0; py++) if (!put(x, py, z, false)) break;
      // Then outward, nearest first.
      for (let r = 1; r <= DISPLACE_REACH && left > 0; r++)
        for (let dy = 0; dy <= r && left > 0; dy++)
          for (let dz = -r; dz <= r && left > 0; dz++)
            for (let dx = -r; dx <= r && left > 0; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz), dy) !== r) continue;
              put(x + dx, y + dy, z + dz, false);
            }
      // Nowhere with room: squeeze it into the nearest open cell (pressure spreads it).
      for (let r = 1; r <= DISPLACE_REACH && left > 0; r++)
        for (let dz = -r; dz <= r && left > 0; dz++)
          for (let dy = -r; dy <= r && left > 0; dy++)
            for (let dx = -r; dx <= r && left > 0; dx++) put(x + dx, y + dy, z + dz, true);
    }
    return left;
  }

  /**
   * Take up to `volume` of water from cell (x, y, z) and the water around it,
   * from the top down. Returns how much was taken.
   */
  take(x, y, z, volume, reach = 2) {
    const w = this.world;
    const cells = [];
    for (let dz = -reach; dz <= reach; dz++)
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dy * dy + dz * dz > reach * reach + 1) continue;
          const v = this.vol(x + dx, y + dy, z + dz);
          if (v) cells.push([x + dx, y + dy, z + dz, v, dx * dx + dz * dz]);
        }
    // Highest first, then nearest.
    cells.sort((a, b) => b[1] - a[1] || a[4] - b[4]);
    let got = 0;
    for (const [cx, cy, cz, v] of cells) {
      if (got >= volume) break;
      const n = Math.min(v, volume - got);
      w.setFluid(cx, cy, cz, packFluid(FLUID.WATER, v - n));
      this.changed(cx, cy, cz, v, v - n);
      got += n;
    }
    return got;
  }

  /**
   * Look at up to `n` chunks (round-robin) and store any whose open voxels
   * all hold the same fluid (deep in a lake or the sea) as just that value
   * (Chunk.fluidUniform), dropping its array. An edit or flow there expands
   * it again (Chunk.ensureFluid). Cheap enough to run a little every frame.
   */
  compact(n = 2) {
    const w = this.world;
    const { size, shift } = w;
    for (let k = 0; k < n; k++) {
      const ci = (this.compactAt = ((this.compactAt ?? -1) + 1) % w.chunks.length);
      const c = w.chunks[ci];
      if (!c.fluid) continue;
      const f = c.fluid, mat = c.mat;
      let v = 0, ok = true;
      for (let i = 0; i < f.length && ok; i++) {
        if (mat[i]) continue;
        if (!v) v = f[i];
        if (!f[i] || f[i] !== v) ok = false;
      }
      if (!ok || !v) continue;
      // Not while any of it is still moving.
      const [cx, cy, cz] = w.chunkCoords(ci);
      for (let z = 0; z < size && ok; z++)
        for (let y = 0; y < size && ok; y++)
          for (let x = 0; x < size && ok; x++)
            if (this.queued[this.key((cx << shift) + x, (cy << shift) + y, (cz << shift) + z)]) ok = false;
      if (!ok) continue;
      c.fluid = null;
      c.fluidUniform = v;
    }
  }

  /** Total fluid volume in the world (tests, stats). */
  totalVolume() {
    const w = this.world;
    let sum = 0;
    for (let ci = 0; ci < w.chunks.length; ci++) {
      const c = w.chunks[ci];
      if (c.fluid) for (let i = 0; i < c.fluid.length; i++) sum += c.fluid[i] & 4095;
      else if (c.fluidUniform) for (let i = 0; i < c.mat.length; i++) if (!c.mat[i]) sum += c.fluidUniform & 4095;
    }
    return sum;
  }

  /** Run until nothing's active (or `max` ticks); returns ticks run. For tests and generation. */
  settle(max = 10000) {
    let n = 0;
    while ((this.queue.length || this.world.displaced.length) && n < max) {
      this.tick();
      n++;
    }
    return n;
  }
}
