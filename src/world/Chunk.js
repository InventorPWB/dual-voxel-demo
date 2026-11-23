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
 * cut   – per voxel, bits 0-2: its +x, +y, +z edges were opened by an edit
 *         (wood on one end, a voxel that was removed on the other), so the
 *         surface there is a cut (end grain), not the outside (bark).
 *         Allocated on the first cut.
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
    this.cut = null; // Uint8Array(n)
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

  ensureCuts() {
    if (!this.cut) this.cut = new Uint8Array(this.mat.length);
  }

  ensurePlants() {
    if (!this.plant) this.plant = new Uint16Array(this.mat.length);
  }
}
