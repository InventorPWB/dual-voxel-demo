import { Chunk } from './Chunk.js';
import { MAT } from './materials.js';
import { packNormal } from './normals.js';
import { PAD } from '../mesh/dualContour.js';

export const CHUNK_SIZE = 32;

/** Edge length of one voxel, in metres. Voxel coords are integers; scene coords are metres. */
export const VOXEL = 0.5;

/** Voxels of border each side of a chunk its water mesh reads (see buildFluidPadded). */
export const FLUID_PAD = 2;

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
    /** Indices of chunks whose water mesh is out of date. */
    this.fluidDirty = new Set();
    /** Fluid pushed out of voxels that became solid: x, y, z, packed, ... (FluidSim puts it back). */
    this.displaced = [];
    /** Called with the box of every edit (markDirtyBox): wakes the water there. */
    this.onEdit = null;
    this._edge = [0, 0, 0];
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
    if (mat && !c.mat[i]) this.displace(c, i, x, y, z);
    // (A chunk stored as all one fluid gets its array back first, so a voxel
    // that opens up starts out dry rather than full.)
    if (!mat && c.mat[i] && c.fluidUniform) c.ensureFluid();
    c.mat[i] = mat;
    const off = offset && shape ? (offset[0] & 1) << 5 | (offset[1] & 1) << 6 | (offset[2] & 1) << 7 : 0;
    c.shape[i] = mat ? shape | off : 0;
    if (mat && c.plant) c.plant[i] = 0;
  }

  /** A voxel becoming solid pushes out the fluid it held (FluidSim puts it back nearby). */
  displace(c, i, x, y, z) {
    if (!c.hasFluid) return;
    const f = c.ensureFluid();
    if (!f[i]) return;
    this.displaced.push(x, y, z, f[i]);
    f[i] = 0;
    this.markFluidDirty(x, y, z);
  }

  // ---- fluid ------------------------------------------------------------------

  /** Packed fluid (see fluids.js) in voxel (x, y, z); 0 outside the world. */
  getFluid(x, y, z) {
    if (!this.inBounds(x, y, z)) return 0;
    const c = this.chunkAt(x, y, z);
    if (c.fluid) return c.fluid[c.index(x & this.mask, y & this.mask, z & this.mask)];
    if (c.fluidUniform && !c.mat[c.index(x & this.mask, y & this.mask, z & this.mask)]) return c.fluidUniform;
    return 0;
  }

  /** Set an empty voxel's packed fluid (ignored for solid voxels). Marks its water meshes dirty. */
  setFluid(x, y, z, packed) {
    if (!this.inBounds(x, y, z)) return;
    const c = this.chunkAt(x, y, z);
    const i = c.index(x & this.mask, y & this.mask, z & this.mask);
    if (c.mat[i]) return;
    if (!packed && !c.hasFluid) return;
    const f = c.ensureFluid();
    if (f[i] === packed) return;
    f[i] = packed;
    this.markFluidDirty(x, y, z);
  }

  /**
   * How far smooth ground below pokes up into empty voxel (x, y, z), in
   * voxels (0..0.5): from the crossing on the vertical edge between the two
   * voxel centres. Water in the voxel sits on top of it.
   */
  floorOffset(x, y, z) {
    if (y < 1 || !this.isTerrain(x, y - 1, z)) return 0;
    if (!this.getEdge(x, y - 1, z, 1, this._edge)) return 0;
    return Math.max(0, this._edge[0] - 0.5);
  }

  /**
   * Height (metres) of the surface of the water in voxel (x, y, z), going up
   * through the water above it; -Infinity if the voxel holds none. (Volume
   * 4095 is the most a cell holds; a full one is 1024: see fluids.js.)
   */
  waterSurface(x, y, z) {
    let v = this.getFluid(x, y, z) & 4095;
    if (v < 24) return -Infinity;
    while (y + 1 < this.sy && (this.getFluid(x, y + 1, z) & 4095) >= 24) {
      y++;
      v = this.getFluid(x, y, z) & 4095;
    }
    return (y + this.floorOffset(x, y, z) + Math.min(v, 1024) / 1024) * VOXEL;
  }

  /** Mark the water meshes that draw voxel (x, y, z) out of date. */
  markFluidDirty(x, y, z) {
    const s = this.size, P = FLUID_PAD;
    const cx0 = Math.max(0, Math.floor((x - P) / s)), cx1 = Math.min(this.nx - 1, Math.floor((x + P) / s));
    const cy0 = Math.max(0, Math.floor((y - P) / s)), cy1 = Math.min(this.ny - 1, Math.floor((y + P) / s));
    const cz0 = Math.max(0, Math.floor((z - P) / s)), cz1 = Math.min(this.nz - 1, Math.floor((z + P) / s));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) this.fluidDirty.add(this.chunkIndex(cx, cy, cz));
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
    if (mat && !c.mat[i]) this.displace(c, i, x, y, z);
    if (!mat && c.mat[i] && c.fluidUniform) c.ensureFluid();
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
        for (let cx = cx0; cx <= cx1; cx++) {
          const i = this.chunkIndex(cx, cy, cz);
          this.dirty.add(i);
          // Water's shoreline follows the ground: its mesh changes too.
          if (this.chunks[i].hasFluid) this.fluidDirty.add(i);
        }
    this.onEdit?.([x0, y0, z0, x1, y1, z1]);
  }

  markAllDirty() {
    for (let i = 0; i < this.chunks.length; i++) {
      this.dirty.add(i);
      this.fluidDirty.add(i);
    }
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
    return { mat, shape, off, et, en, plant, size: s, origin: [ox, oy, oz], uniform };
  }

  /**
   * What a chunk's water mesh needs, padded by FLUID_PAD voxels: materials,
   * shapes, fluid, and `floor`: for each open voxel, how far ground pokes up
   * into it (fluid volume units: see floorOffset); for the ground's top voxel
   * in a column, the height of its surface above the voxel's bottom (the same
   * units). Null if there's no fluid in or around the chunk.
   */
  buildFluidPadded(cx, cy, cz, withSurface = false) {
    let any = false;
    for (let dz = -1; dz <= 1 && !any; dz++)
      for (let dy = -1; dy <= 1 && !any; dy++)
        for (let dx = -1; dx <= 1 && !any; dx++) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= this.nx || ny >= this.ny || nz >= this.nz) continue;
          any = this.chunks[this.chunkIndex(nx, ny, nz)].hasFluid;
        }
    if (!any) return null;
    const s = this.size, P = FLUID_PAD;
    const N = s + 2 * P;
    const mat = new Uint8Array(N * N * N);
    const shape = new Uint8Array(N * N * N);
    const fluid = new Uint16Array(N * N * N);
    const floor = new Uint16Array(N * N * N);
    const ox = cx * s, oy = cy * s, oz = cz * s;
    let wet = 0;
    for (let z = 0, i = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++, i++) {
          const gx = ox + x - P, gy = oy + y - P, gz = oz + z - P;
          mat[i] = this.inBounds(gx, gy, gz) ? this.getMat(gx, gy, gz) : 255; // outside: solid
          if (mat[i]) {
            shape[i] = this.getShape(gx, gy, gz);
            // The ground's top voxel: where its surface is, from the bottom of
            // the voxel (×1024; 0.5 to 1.5 voxels), for the shoreline.
            if (mat[i] !== 255 && !shape[i] && !this.isSolid(gx, gy + 1, gz) && gy + 1 < this.sy) {
              floor[i] = this.getEdge(gx, gy, gz, 1, this._edge) ? Math.round((0.5 + this._edge[0]) * 1024) : 1024;
            }
            continue;
          }
          if ((fluid[i] = this.getFluid(gx, gy, gz))) wet++;
          floor[i] = Math.round(this.floorOffset(gx, gy, gz) * 1024);
        }
    if (!wet) return null;
    const out = { mat, shape, fluid, floor, size: s, pad: P, origin: [ox, oy, oz] };
    if (withSurface) {
      // For the contoured surface (fluidSurface.js): the terrain's crossings
      // (as buildPadded), and FluxSim's flow through each voxel's +x and +z faces.
      const et = new Uint8Array(N * N * N * 3), en = new Uint8Array(N * N * N * 6);
      const flux = new Float32Array(N * N * N * 2);
      for (let z = 0, i = 0; z < N; z++)
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++, i++) {
            const gx = ox + x - P, gy = oy + y - P, gz = oz + z - P;
            if (!this.inBounds(gx, gy, gz)) continue;
            const c = this.chunkAt(gx, gy, gz);
            const li = c.index(gx & this.mask, gy & this.mask, gz & this.mask);
            if (c.flux && fluid[i]) { flux[i * 2] = c.flux[li * 2]; flux[i * 2 + 1] = c.flux[li * 2 + 1]; }
            if (!c.t) continue;
            for (let a = 0; a < 3; a++) {
              const j = a === 0 ? i + 1 : a === 1 ? i + N : i + N * N;
              if (j >= mat.length) continue;
              // Only where terrain meets something that isn't (that's where crossings are).
              const tHere = mat[i] && mat[i] !== 255 && !shape[i], tThere = mat[j] && mat[j] !== 255 && !shape[j];
              if (tHere === tThere) continue;
              et[i * 3 + a] = c.t[li * 3 + a];
              en[(i * 3 + a) * 2] = c.n[(li * 3 + a) * 2];
              en[(i * 3 + a) * 2 + 1] = c.n[(li * 3 + a) * 2 + 1];
            }
          }
      out.et = et;
      out.en = en;
      out.flux = flux;
    }
    return out;
  }
}
