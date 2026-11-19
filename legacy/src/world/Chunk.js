/**
 * A cubic chunk of voxels. Each voxel is two bytes, as in Roblox's terrain:
 *   occ – terrain occupancy 0..255 (>= 128 counts as solid; the surface sits at 0.5)
 *   mat – material id (see materials.js). A block material means the voxel is a
 *         full cube; its occ byte still carries the terrain field through it,
 *         so terrain stays smooth where it meets the block.
 * Voxel (x, y, z) covers the unit cube [x, x+1] × [y, y+1] × [z, z+1].
 */
export class Chunk {
  constructor(size) {
    this.size = size;
    this.occ = new Uint8Array(size * size * size);
    this.mat = new Uint8Array(size * size * size);
  }

  index(x, y, z) {
    return x + this.size * (y + this.size * z);
  }
}
