/**
 * A cubic chunk of voxels:
 *   mat   – material id per voxel; 0 is empty, anything else is solid.
 *   shape – low 5 bits: 0 for smooth terrain, otherwise a building shape
 *           state (cube, wedge, ...; see shapes.js), drawn as exact geometry.
 *           High 3 bits: the voxel's offset within the piece it was placed as.
 * Smooth terrain is stored as hermite data:
 *   edge – for each voxel, its three edges toward +x, +y, +z (voxel centre to
 *          neighbour's centre). Where the surface crosses an edge (solidity
 *          differs at its ends), `t` is where along it (0..1, stored ×255) and
 *          `n` is the surface normal there (2 bytes, packed). Allocated only
 *          once the chunk has any surface.
 * plant – plant id per voxel (16 bits; see plants.js: grass, leaves, wood), only in
 *         empty voxels. Allocated only once the chunk has a plant.
 * fluid – fluid per voxel (16 bits: volume and type, see fluids.js), only in
 *         empty voxels. Allocated only once the chunk has fluid; a chunk
 *         entirely full of one fluid may instead keep just `fluidUniform`
 *         (the packed value every voxel has).
 * Voxel (x, y, z) covers [x, x+1]·VOXEL on each axis, in metres.
 */
export class Chunk {
  constructor(size) {
    this.size = size;
    this.mat = new Uint8Array(size * size * size);
    this.shape = new Uint8Array(size * size * size);
    this.t = null; // Uint8Array(n * 3)
    this.n = null; // Uint8Array(n * 6)
    this.plant = null; // Uint16Array(n)
    this.fluid = null; // Uint16Array(n)
    this.fluidUniform = 0;
    this.flux = null; // Float32Array(n * 2): flow through each voxel's +x and +z faces last tick (FluxSim)
  }

  /** The fluid array, expanding a uniform chunk into one. */
  ensureFluid() {
    if (!this.fluid) {
      this.fluid = new Uint16Array(this.mat.length);
      if (this.fluidUniform) {
        for (let i = 0; i < this.mat.length; i++) if (!this.mat[i]) this.fluid[i] = this.fluidUniform;
        this.fluidUniform = 0;
      }
    }
    return this.fluid;
  }

  /** Does the chunk hold any fluid (or might it)? */
  get hasFluid() {
    return this.fluid !== null || this.fluidUniform !== 0;
  }

  index(x, y, z) {
    return x + this.size * (y + this.size * z);
  }

  ensureEdges() {
    if (!this.t) {
      const n = this.mat.length;
      this.t = new Uint8Array(n * 3);
      this.n = new Uint8Array(n * 6);
    }
  }

  ensurePlants() {
    if (!this.plant) this.plant = new Uint16Array(this.mat.length);
  }
}
