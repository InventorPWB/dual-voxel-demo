import { meshChunk } from './dualContour.js';
import { meshFoliage, DEFAULT_FOLIAGE_OPTIONS } from './foliage.js';
import { meshFluid } from './fluidMesh.js';
import { meshFluidSurface } from './fluidSurface.js';
import { meshSpans } from './spanMesh.js';

let crisp = new Float32Array(256);
let scale = 1;
let foliageOptions = DEFAULT_FOLIAGE_OPTIONS;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    crisp = msg.crisp;
    scale = msg.scale;
    return;
  }
  if (msg.type === 'options') {
    foliageOptions = msg.foliage;
    return;
  }
  if (msg.type === 'fluid' || msg.type === 'spans') {
    const t0 = performance.now();
    // SpanSim's sheet, the contoured surface (FluxSim's water), or the cellular one's.
    const water = msg.type === 'spans' ? meshSpans(msg, scale) : msg.surface ? meshFluidSurface(msg, scale) : meshFluid(msg, scale);
    self.postMessage(
      { type: 'fluid', index: msg.index, version: msg.version, ms: performance.now() - t0, water },
      [water.position.buffer, water.normal.buffer, water.flow.buffer, water.depth.buffer],
    );
    return;
  }
  if (msg.type === 'mesh') {
    const t0 = performance.now();
    const solid = meshChunk(msg, crisp, scale);
    const foliage = meshFoliage(msg, scale, foliageOptions);
    self.postMessage(
      { type: 'mesh', index: msg.index, version: msg.version, ms: performance.now() - t0, solid, foliage },
      [
        solid.position.buffer, solid.normal.buffer, solid.material.buffer, solid.blend.buffer, solid.ao.buffer, solid.local.buffer,
        foliage.position.buffer, foliage.normal.buffer, foliage.uvl.buffer, foliage.wind.buffer, foliage.ao.buffer, foliage.seed.buffer, foliage.center.buffer, foliage.axis.buffer,
        foliage.wood.position.buffer, foliage.wood.cell.buffer,
      ],
    );
  }
};
