import { FULL } from './fluids.js';
import { TICK_HZ } from './FluidSim.js';

/**
 * Which water is a source: the core of a large, deep, still body. Derived
 * from the water itself, so a lake the player floods becomes one just like
 * the sea, and one they drain or fill in stops being one.
 *
 * Per column: the top water surface and the depth of water under it (kept
 * up to date for the columns the simulation touches). Per tile (TILE × TILE
 * columns): how many of its columns are deep, and the lowest and highest
 * surface among them. A tile is core when every tile within R of it is deep
 * all over and their surfaces agree within LEVEL_TOL, and have done so for
 * SETTLE seconds: the body, eroded inward by R tiles. So small ponds,
 * streams and rivers never have a core, and a lake ~10 m across does.
 *
 * A cell is a source (FluidSim.isSource) if its column's tile is core and it
 * is below that column's surface. Sources hold their level: they give
 * without losing, and absorb what flows in (so a river running into the sea
 * doesn't raise it, and a big body stays asleep while rivers feed it). The
 * level only changes by edits. Nothing here grows with the size of the body: only
 * tiles near a change are looked at again.
 */

/** Columns per tile side (2 m). */
export const TILE = 4;
/** Tiles each way that must be deep and level around a core tile (2: a 5 × 5 window, 10 m). */
export const R = 2;
/** Depth (voxels) a column needs to count: 1 m. */
export const MIN_DEPTH = 2;
/** Most the surface may differ across the window (voxels): 5 cm. */
export const LEVEL_TOL = 0.1;
/** Seconds a window must stay deep and level before its tile becomes core. */
export const SETTLE = 2;
/** Seconds a core tile must fail before it stops being core (unless edited: then at once). */
export const DEMOTE = 1;
/** How often dirty tiles are looked at again (seconds). */
const EVERY = 0.5;

export class FluidCore {
  constructor(world, sim) {
    this.world = world;
    this.sim = sim;
    const { sx, sz } = world;
    this.tx = Math.ceil(sx / TILE);
    this.tz = Math.ceil(sz / TILE);
    const nCols = sx * sz, nTiles = this.tx * this.tz;
    this.surf = new Float32Array(nCols).fill(-1); // voxels; -1 dry
    this.depth = new Float32Array(nCols);
    this.colDirty = new Uint8Array(nCols);
    this.colList = [];
    this.deep = new Uint8Array(nTiles);
    this.minS = new Float32Array(nTiles);
    this.maxS = new Float32Array(nTiles);
    this.changed = new Float32Array(nTiles); // when the tile's stats last changed (seconds)
    this.core = new Uint8Array(nTiles);
    // The level (voxels) a core tile holds: its lowest surface when it
    // became core, renewed by edits. Water above it isn't source: it drains in.
    this.level = new Float32Array(nTiles);
    this.failing = new Float32Array(nTiles).fill(-1); // since when a core tile has failed (-1: not)
    this.watch = new Set(); // tiles to look at again
    this.edited = new Set(); // tiles changed by an edit since last looked at
    this.lastEval = 0;
    this.coreCount = 0;
    /** Goes up whenever column surfaces are measured again (see WaterHeight). */
    this.version = 0;

    sim.isSource = (x, y, z) => {
      const t = (x / TILE | 0) + this.tx * (z / TILE | 0);
      return this.core[t] === 1 && y < this.level[t] - 0.01;
    };
    // (SpanSim asks for the level itself: a span is a source if it reaches it.)
    sim.sourceLevel = (x, z) => {
      const t = (x / TILE | 0) + this.tx * (z / TILE | 0);
      return this.core[t] === 1 ? this.level[t] : -Infinity;
    };
    const prevColumn = sim.onColumn;
    sim.onColumn = (x, y, z) => {
      prevColumn?.(x, y, z);
      this.touchColumn(x, z);
    };
    const prevEdit = world.onEdit;
    world.onEdit = (box) => {
      prevEdit?.(box);
      this.edit(box);
    };
  }

  /** Simulation time, seconds. */
  get now() {
    return this.sim.stats.ticks / TICK_HZ;
  }

  touchColumn(x, z) {
    const c = x + this.world.sx * z;
    if (this.colDirty[c]) return;
    this.colDirty[c] = 1;
    this.colList.push(c);
  }

  /** An edit (dig, build, sponge) changed this voxel box: its tiles are judged again at once, without waiting. */
  edit(box) {
    const { sx, sz } = this.world;
    const x0 = Math.max(0, box[0]), z0 = Math.max(0, box[2]), x1 = Math.min(sx - 1, box[3]), z1 = Math.min(sz - 1, box[5]);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.touchColumn(x, z);
    for (let tz = Math.floor(z0 / TILE); tz <= Math.floor(z1 / TILE); tz++)
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) this.edited.add(tx + this.tx * tz);
  }

  /** Top water surface and depth of column (x, z). */
  measure(x, z) {
    const w = this.world, sim = this.sim;
    const c = x + w.sx * z;
    let y = w.sy - 1;
    while (y >= 0 && !sim.vol(x, y, z)) y--;
    if (y < 0) {
      this.surf[c] = -1;
      this.depth[c] = 0;
      return;
    }
    // A thin film on top of fuller water: the surface is in the film's cell.
    const top = y;
    const v = sim.vol(x, top, z);
    const s = top + w.floorOffset(x, top, z) + Math.min(v, FULL) / FULL;
    while (y > 0 && w.getMat(x, y - 1, z) === 0 && sim.vol(x, y - 1, z)) y--;
    this.surf[c] = s;
    this.depth[c] = s - (y + w.floorOffset(x, y, z));
  }

  /** Bring dirty columns and tiles up to date; promote and demote tiles. Call every frame (cheap when idle). */
  update(force = false) {
    const now = this.now;
    if (!force && now - this.lastEval < EVERY && !this.edited.size) return;
    this.lastEval = now;
    const { sx } = this.world;
    // 1. Columns, and the tiles they're in.
    const tiles = new Set();
    if (this.colList.length) this.version++;
    for (const c of this.colList) {
      this.colDirty[c] = 0;
      const x = c % sx, z = (c - x) / sx;
      this.measure(x, z);
      tiles.add((x / TILE | 0) + this.tx * (z / TILE | 0));
    }
    this.colList.length = 0;
    for (const t of tiles) {
      if (this.restat(t) || this.edited.has(t)) this.watchAround(t);
    }
    for (const t of this.edited) this.watchAround(t);
    // 2. Judge watched tiles.
    const done = [];
    for (const t of this.watch) if (this.judge(t, now, force)) done.push(t);
    for (const t of done) this.watch.delete(t);
    this.edited.clear();
  }

  /** Recompute a tile's stats; true if they changed. */
  restat(t) {
    const { sx, sz } = this.world;
    const tx = t % this.tx, tz = (t - tx) / this.tx;
    let deep = 0, mn = Infinity, mx = -Infinity;
    for (let z = tz * TILE; z < Math.min(sz, tz * TILE + TILE); z++)
      for (let x = tx * TILE; x < Math.min(sx, tx * TILE + TILE); x++) {
        const c = x + sx * z;
        if (this.surf[c] < 0 || this.depth[c] < MIN_DEPTH) continue;
        deep++;
        mn = Math.min(mn, this.surf[c]);
        mx = Math.max(mx, this.surf[c]);
      }
    const changed = deep !== this.deep[t] || Math.abs(mn - this.minS[t]) > 0.004 || Math.abs(mx - this.maxS[t]) > 0.004;
    this.deep[t] = deep;
    this.minS[t] = deep ? mn : 0;
    this.maxS[t] = deep ? mx : 0;
    if (changed) this.changed[t] = this.now;
    return changed;
  }

  watchAround(t) {
    const tx = t % this.tx, tz = (t - tx) / this.tx;
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const x = tx + dx, z = tz + dz;
        if (x >= 0 && z >= 0 && x < this.tx && z < this.tz) this.watch.add(x + this.tx * z);
      }
  }

  /**
   * Is tile t's window deep, level and settled? Promote or demote it. Returns
   * true when there's nothing left to wait for (no need to look again).
   */
  judge(t, now, instant) {
    const tx = t % this.tx, tz = (t - tx) / this.tx;
    const full = TILE * TILE;
    let ok = true, settled = true, edited = this.edited.has(t), mn = Infinity, mx = -Infinity;
    for (let dz = -R; dz <= R && ok; dz++)
      for (let dx = -R; dx <= R && ok; dx++) {
        const x = tx + dx, z = tz + dz;
        if (x < 0 || z < 0 || x >= this.tx || z >= this.tz) { ok = false; break; }
        const u = x + this.tx * z;
        if (this.deep[u] < full) { ok = false; break; }
        mn = Math.min(mn, this.minS[u]);
        mx = Math.max(mx, this.maxS[u]);
        if (now - this.changed[u] < SETTLE) settled = false;
        if (this.edited.has(u)) edited = true;
      }
    if (ok && mx - mn > LEVEL_TOL) ok = false;

    if (this.core[t]) {
      if (ok) {
        this.failing[t] = -1;
        // An edit (flooding it higher, say) sets the level it holds anew.
        if (edited) this.level[t] = this.minS[t];
        return true;
      }
      if (edited || instant) return this.setCore(t, 0), true;
      if (this.failing[t] < 0) this.failing[t] = now;
      if (now - this.failing[t] >= DEMOTE) return this.setCore(t, 0), true;
      return false;
    }
    if (!ok) return true;
    if (settled || instant) return this.setCore(t, 1), true;
    return false;
  }

  setCore(t, on) {
    if (this.core[t] === on) return;
    this.core[t] = on;
    if (on) this.level[t] = this.minS[t];
    this.failing[t] = -1;
    this.coreCount += on ? 1 : -1;
    // Its water (at the edge of the core above all) may now flow differently.
    const tx = t % this.tx, tz = (t - tx) / this.tx;
    const x0 = tx * TILE, z0 = tz * TILE;
    let y0 = Infinity, y1 = -Infinity;
    for (let z = z0; z < z0 + TILE; z++)
      for (let x = x0; x < x0 + TILE; x++) {
        const c = x + this.world.sx * z;
        if (this.surf[c] < 0) continue;
        y0 = Math.min(y0, Math.floor(this.surf[c] - this.depth[c]));
        y1 = Math.max(y1, Math.floor(this.surf[c]));
      }
    if (y0 <= y1) this.sim.wake([x0, y0, z0, x0 + TILE - 1, y1, z0 + TILE - 1]);
  }

  /** Measure every column and judge every tile (after generation; `instant`: no waiting to settle). */
  rebuild(instant = true) {
    const { sx, sz } = this.world;
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) this.measure(x, z);
    this.version++;
    for (let t = 0; t < this.tx * this.tz; t++) {
      this.restat(t);
      this.changed[t] = -1e9;
    }
    for (let t = 0; t < this.tx * this.tz; t++) this.judge(t, this.now, instant);
  }
}
