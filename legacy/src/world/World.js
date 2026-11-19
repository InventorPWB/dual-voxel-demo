import { Chunk } from './Chunk.js';
import { MAT, HARD } from './materials.js';
import { PAD } from '../mesh/surfaceNets.js';

export const CHUNK_SIZE = 32;

/**
 * Occupancy change per metre across a smooth surface. Below 1 the 0→1 ramp
 * spans several voxels, which gives the mesher a usable gradient instead of
 * stair-stepped slopes.
 */
export const OCC_SLOPE = 0.4;

/**
 * A finite grid of chunks. One representation for everything: terrain and
 * player-built blocks are the same voxels, and edits simply overwrite them.
 */
export class World {
  constructor(nx = 4, ny = 3, nz = 4, size = CHUNK_SIZE) {
    if ((size & (size - 1)) !== 0) throw new Error('chunk size must be a power of two');
    this.size = size;
    this.shift = Math.log2(size);
    this.mask = size - 1;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.sx = nx * size; this.sy = ny * size; this.sz = nz * size;
    this.chunks = [];
    for (let i = 0; i < nx * ny * nz; i++) this.chunks.push(new Chunk(size));
    /** Indices of chunks whose mesh is out of date. */
    this.dirty = new Set();
  }

  chunkIndex(cx, cy, cz) {
    return cx + this.nx * (cy + this.ny * cz);
  }

  chunkCoords(index) {
    const cx = index % this.nx;
    const cy = Math.floor(index / this.nx) % this.ny;
    const cz = Math.floor(index / (this.nx * this.ny));
    return [cx, cy, cz];
  }

  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  /** Occupancy 0..255. Below the world is solid bedrock; beside/above is air. */
  getOcc(x, y, z) {
    if (y < 0) return 255;
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunks[this.chunkIndex(x >> this.shift, y >> this.shift, z >> this.shift)];
    return c.occ[c.index(x & this.mask, y & this.mask, z & this.mask)];
  }

  getMat(x, y, z) {
    if (y < 0) return MAT.STONE;
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunks[this.chunkIndex(x >> this.shift, y >> this.shift, z >> this.shift)];
    return c.mat[c.index(x & this.mask, y & this.mask, z & this.mask)];
  }

  isBlock(x, y, z) {
    return HARD[this.getMat(x, y, z)] === 1;
  }

  /** Solid for gameplay: a block, or terrain above the 0.5 surface level. */
  isSolid(x, y, z) {
    return this.getOcc(x, y, z) >= 128 || this.isBlock(x, y, z);
  }

  /** Write a voxel without marking meshes dirty (use markDirtyBox afterwards). */
  setRaw(x, y, z, occ, mat) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunks[this.chunkIndex(x >> this.shift, y >> this.shift, z >> this.shift)];
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    c.occ[i] = occ;
    // A block voxel keeps its material even where the terrain field is empty.
    c.mat[i] = occ === 0 && !HARD[mat] ? 0 : mat;
  }

  set(x, y, z, occ, mat) {
    this.setRaw(x, y, z, occ, mat);
    this.markDirtyBox(x, y, z, x, y, z);
  }

  /**
   * Mark every chunk whose mesh depends on voxels in the given box.
   * A chunk's mesh reads PAD voxels beyond its own bounds on each side.
   */
  markDirtyBox(x0, y0, z0, x1, y1, z1) {
    const s = this.size;
    const cx0 = Math.max(0, Math.floor((x0 - PAD) / s)), cx1 = Math.min(this.nx - 1, Math.floor((x1 + PAD) / s));
    const cy0 = Math.max(0, Math.floor((y0 - PAD) / s)), cy1 = Math.min(this.ny - 1, Math.floor((y1 + PAD) / s));
    const cz0 = Math.max(0, Math.floor((z0 - PAD) / s)), cz1 = Math.min(this.nz - 1, Math.floor((z1 + PAD) / s));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) this.dirty.add(this.chunkIndex(cx, cy, cz));
  }

  markAllDirty() {
    for (let i = 0; i < this.chunks.length; i++) this.dirty.add(i);
  }

  /**
   * Copy a chunk plus PAD voxels of border from its neighbours, so each chunk
   * can be meshed independently and still produce matching seams.
   */
  buildPadded(cx, cy, cz) {
    const s = this.size;
    const N = s + 2 * PAD;
    const occ = new Uint8Array(N * N * N);
    const mat = new Uint8Array(N * N * N);
    const ox = cx * s, oy = cy * s, oz = cz * s;
    let i = 0;
    let solid = 0;
    let blocks = false;
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++, i++) {
          const gx = ox + x - PAD, gy = oy + y - PAD, gz = oz + z - PAD;
          const o = this.getOcc(gx, gy, gz);
          const m = this.getMat(gx, gy, gz);
          occ[i] = o;
          mat[i] = m;
          if (o >= 128) solid++;
          if (HARD[m]) blocks = true;
        }
      }
    }
    // Terrain that is fully solid or fully empty, with no blocks, has no surface.
    const uniform = !blocks && (solid === 0 || solid === N * N * N);
    return { occ, mat, size: s, origin: [ox, oy, oz], uniform };
  }
}
