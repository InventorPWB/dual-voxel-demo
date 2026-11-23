import { Chunk } from './Chunk.js';
import { MAT } from './materials.js';
import { packNormal } from './normals.js';
import { PAD } from '../mesh/dualContour.js';

export const CHUNK_SIZE = 32;

/** Edge length of one voxel, in metres. Voxel coords are integers; scene coords are metres. */
export const VOXEL = 0.5;

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * A finite grid of chunks. Every voxel has a material (0 = empty) and a
 * shape state: 0 is smooth terrain, anything else a building piece (cube,
 * wedge, ...; see shapes.js) drawn as its exact geometry.
 *
 * Smooth terrain is hermite data: on every voxel edge where terrain meets a
 * non-terrain voxel, the exact crossing point and normal (edited by exact
 * CSG, see csg.js). Terrain never extends into a building voxel; it stops
 * exactly at its faces. Below the world is solid bedrock; beside and above, air.
 *
 * Empty voxels may hold a plant (grass, leaves, trees' wood; see plants.js).
 * A voxel that becomes solid loses its plant.
 */
export class World {
  constructor(nx = 8, ny = 4, nz = 8, size = CHUNK_SIZE) {
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

  chunkAt(x, y, z) {
    return this.chunks[this.chunkIndex(x >> this.shift, y >> this.shift, z >> this.shift)];
  }

  getMat(x, y, z) {
    if (y < 0) return MAT.STONE;
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunkAt(x, y, z);
    return c.mat[c.index(x & this.mask, y & this.mask, z & this.mask)];
  }

  isSolid(x, y, z) {
    return this.getMat(x, y, z) !== 0;
  }

  /** Shape state (0 = smooth terrain or empty). */
  getShape(x, y, z) {
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunkAt(x, y, z);
    return c.shape[c.index(x & this.mask, y & this.mask, z & this.mask)] & 31;
  }

  /**
   * For a building voxel: its offset (0 or 1 per axis) from the corner of the
   * piece it was placed as, so new pieces can line up with that piece.
   */
  getPieceOffset(x, y, z) {
    if (!this.inBounds(x, y, z)) return [0, 0, 0];
    const c = this.chunkAt(x, y, z);
    const b = c.shape[c.index(x & this.mask, y & this.mask, z & this.mask)];
    return [(b >> 5) & 1, (b >> 6) & 1, (b >> 7) & 1];
  }

  /** Solid smooth terrain (bedrock counts). */
  isTerrain(x, y, z) {
    if (y < 0) return true;
    return this.getMat(x, y, z) !== 0 && this.getShape(x, y, z) === 0;
  }

  /** A building piece voxel. */
  isPiece(x, y, z) {
    return this.getShape(x, y, z) !== 0;
  }

  /**
   * Set a voxel's material and shape state, and for building voxels its
   * offset within the piece (without touching edges or marking meshes dirty).
   */
  setVoxel(x, y, z, mat, shape, offset = null) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    c.mat[i] = mat;
    const off = offset && shape ? (offset[0] & 1) << 5 | (offset[1] & 1) << 6 | (offset[2] & 1) << 7 : 0;
    c.shape[i] = mat ? shape | off : 0;
    if (mat && c.plant) c.plant[i] = 0;
  }

  /** Was voxel (x, y, z)'s +axis edge opened by an edit (a cut surface)? */
  getCut(x, y, z, axis) {
    if (!this.inBounds(x, y, z)) return false;
    const c = this.chunkAt(x, y, z);
    return !!c.cut && ((c.cut[c.index(x & this.mask, y & this.mask, z & this.mask)] >> axis) & 1) === 1;
  }

  /** Mark (or clear) voxel (x, y, z)'s +axis edge as cut. Doesn't mark meshes dirty. */
  setCut(x, y, z, axis, on = true) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    if (!on && !c.cut) return;
    c.ensureCuts();
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    c.cut[i] = on ? c.cut[i] | (1 << axis) : c.cut[i] & ~(1 << axis);
  }

  /** Plant id in voxel (x, y, z) (0 = none). */
  getPlant(x, y, z) {
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunkAt(x, y, z);
    return c.plant ? c.plant[c.index(x & this.mask, y & this.mask, z & this.mask)] : 0;
  }

  /** Put a plant in an empty voxel (0 removes it). Ignored for solid voxels. Doesn't mark meshes dirty. */
  setPlant(x, y, z, plant) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    if (!plant) { if (c.plant) c.plant[i] = 0; return; }
    if (c.mat[i]) return;
    c.ensurePlants();
    c.plant[i] = plant;
  }

  /** 255 if solid, else 0 (handy for trilinear "how solid is it here"). */
  getOcc(x, y, z) {
    return this.getMat(x, y, z) ? 255 : 0;
  }

  /** Set a voxel's material (0 = empty), keeping its shape state; empty clears it. */
  setMat(x, y, z, mat) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    c.mat[i] = mat;
    if (!mat) c.shape[i] = 0;
    else if (c.plant) c.plant[i] = 0;
  }

  /**
   * Read the crossing on voxel (x, y, z)'s edge along `axis` (0/1/2, toward +).
   * Returns false if the voxel has no edge data; else fills out = [t, a, b]
   * (t in 0..1, a/b the packed normal bytes).
   */
  getEdge(x, y, z, axis, out) {
    if (!this.inBounds(x, y, z)) return false;
    const c = this.chunkAt(x, y, z);
    if (!c.t) return false;
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    out[0] = c.t[i * 3 + axis] / 255;
    out[1] = c.n[(i * 3 + axis) * 2];
    out[2] = c.n[(i * 3 + axis) * 2 + 1];
    return true;
  }

  /** Store the crossing on voxel (x, y, z)'s +axis edge: t along it, normal (nx, ny, nz). */
  setEdge(x, y, z, axis, t, nx, ny, nz) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    c.ensureEdges();
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    c.t[i * 3 + axis] = Math.max(0, Math.min(255, Math.round(t * 255)));
    packNormal(nx, ny, nz, c.n, (i * 3 + axis) * 2);
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
   * Copy a chunk plus PAD voxels of border (materials, shapes, edge data and
   * plants; `plant` is null if there are none nearby), so each
   * chunk can be meshed on its own and still produce matching seams. Edges at
   * the world's border, where solid meets the outside, get a crossing halfway
   * with the axis as normal.
   */
  buildPadded(cx, cy, cz) {
    const s = this.size;
    const N = s + 2 * PAD;
    const mat = new Uint8Array(N * N * N);
    const shape = new Uint8Array(N * N * N);
    const off = new Uint8Array(N * N * N); // building voxels: offset in their piece (bit 0 x, 1 y, 2 z)
    const cut = new Uint8Array(N * N * N); // cut edges (bit per axis, see Chunk)
    const et = new Uint8Array(N * N * N * 3);
    const en = new Uint8Array(N * N * N * 6);
    const ox = cx * s, oy = cy * s, oz = cz * s;
    // Plants: only if this chunk or a neighbour within the pad has any.
    let plant = null;
    for (let dz = -1; dz <= 1 && !plant; dz++)
      for (let dy = -1; dy <= 1 && !plant; dy++)
        for (let dx = -1; dx <= 1 && !plant; dx++) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= this.nx || ny >= this.ny || nz >= this.nz) continue;
          if (this.chunks[this.chunkIndex(nx, ny, nz)].plant) plant = new Uint16Array(N * N * N);
        }
    let plants = 0;
    const e = [0, 0, 0];
    let solid = 0, pieces = 0;
    for (let z = 0, i = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++, i++) {
          const gx = ox + x - PAD, gy = oy + y - PAD, gz = oz + z - PAD;
          const m = this.getMat(gx, gy, gz);
          mat[i] = m;
          shape[i] = this.getShape(gx, gy, gz);
          if (shape[i]) {
            const c = this.chunkAt(gx, gy, gz);
            off[i] = c.shape[c.index(gx & this.mask, gy & this.mask, gz & this.mask)] >> 5;
          }
          if (this.inBounds(gx, gy, gz)) {
            const c = this.chunkAt(gx, gy, gz);
            if (c.cut) cut[i] = c.cut[c.index(gx & this.mask, gy & this.mask, gz & this.mask)];
          }
          if (m) solid++;
          if (shape[i]) pieces++;
          if (plant && (plant[i] = this.getPlant(gx, gy, gz))) plants++;
          for (let a = 0; a < 3; a++) {
            const [dx, dy, dz] = AXES[a];
            const inside = this.inBounds(gx, gy, gz) && this.inBounds(gx + dx, gy + dy, gz + dz);
            if (inside && this.getEdge(gx, gy, gz, a, e)) {
              et[i * 3 + a] = Math.round(e[0] * 255);
              en[(i * 3 + a) * 2] = e[1];
              en[(i * 3 + a) * 2 + 1] = e[2];
            } else {
              // Outside the world (or no data): a crossing halfway, normal along the axis.
              const solidHere = this.isTerrain(gx, gy, gz), solidThere = this.isTerrain(gx + dx, gy + dy, gz + dz);
              const sg = solidHere && !solidThere ? 1 : -1;
              et[i * 3 + a] = 128;
              packNormal(dx * sg, dy * sg, dz * sg, en, (i * 3 + a) * 2);
            }
          }
        }
    const uniform = pieces === 0 && plants === 0 && (solid === 0 || solid === N * N * N);
    if (!plants) plant = null;
    return { mat, shape, off, cut, et, en, plant, size: s, origin: [ox, oy, oz], uniform };
  }
}
