import { meshChunk } from './surfaceNets.js';

let hard = new Uint8Array(256);

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    hard = msg.hard;
    return;
  }
  if (msg.type === 'mesh') {
    const t0 = performance.now();
    const out = meshChunk(msg.occ, msg.mat, msg.size, msg.origin, hard);
    self.postMessage(
      { type: 'mesh', index: msg.index, version: msg.version, ms: performance.now() - t0, ...out },
      [out.position.buffer, out.normal.buffer, out.material.buffer, out.ao.buffer],
    );
  }
};
