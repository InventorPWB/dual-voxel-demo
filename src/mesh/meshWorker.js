import { meshChunk } from './dualContour.js';
import { meshFoliage, DEFAULT_FOLIAGE_OPTIONS } from './foliage.js';

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
  if (msg.type === 'mesh') {
    const t0 = performance.now();
    const solid = meshChunk(msg, crisp, scale);
    const foliage = meshFoliage(msg, scale, foliageOptions);
    self.postMessage(
      { type: 'mesh', index: msg.index, version: msg.version, ms: performance.now() - t0, solid, foliage },
      [
        solid.position.buffer, solid.normal.buffer, solid.material.buffer, solid.ao.buffer, solid.local.buffer,
        foliage.position.buffer, foliage.normal.buffer, foliage.uvl.buffer, foliage.wind.buffer, foliage.ao.buffer, foliage.seed.buffer, foliage.center.buffer, foliage.axis.buffer,
      ],
    );
  }
};
