import { meshChunk } from './dualContour.js';

let crisp = new Float32Array(256);
let scale = 1;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    crisp = msg.crisp;
    scale = msg.scale;
    return;
  }
  if (msg.type === 'mesh') {
    const t0 = performance.now();
    const out = meshChunk(msg, crisp, scale);
    self.postMessage(
      { type: 'mesh', index: msg.index, version: msg.version, ms: performance.now() - t0, ...out },
      [out.position.buffer, out.normal.buffer, out.material.buffer, out.ao.buffer],
    );
  }
};
