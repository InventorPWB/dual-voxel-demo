/**
 * Fluids: a third value per voxel, beside material and plant, only in empty
 * voxels. Packed into 16 bits:
 *   bits 0-11   volume, in 1/FULL of a voxel. A cell holds FULL when full;
 *               cells deep under water hold a little more (compression), which
 *               is how pressure carries water up the far side of a U-bend.
 *   bits 12-15  fluid type (FLUID.WATER; 0 = none). Lava is reserved.
 * See FluidSim.js for how it moves.
 */

/** Volume of a full voxel. */
export const FULL = 1024;
/** Largest volume a cell can store (bits 0-11). */
export const MAX_VOLUME = 4095;

export const FLUID = { NONE: 0, WATER: 1, LAVA: 2 };

/**
 * Per type:
 *   spread  fraction of a level difference that flows sideways per tick (≤ 0.2)
 *   speed   most volume that moves through one face per tick (the speed cap)
 */
export const FLUIDS = [
  { id: 0, name: 'None' },
  { id: 1, name: 'Water', spread: 0.2, speed: 160 },
  // { id: 2, name: 'Lava', spread: 0.05, speed: 24 }, // reserved
];

export const fluidVolumeOf = (packed) => packed & 4095;
export const fluidTypeOf = (packed) => packed >> 12;
export const packFluid = (type, volume) => (volume <= 0 ? 0 : (type << 12) | Math.min(MAX_VOLUME, volume));
